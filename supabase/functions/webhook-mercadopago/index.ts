import { errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import { mpRequest, validarAssinaturaWebhook } from "../_shared/mercadopago.ts";
import { backendClient } from "../_shared/supabase.ts";

function idFromReference(reference: unknown): string | null {
  const value = String(reference ?? "");
  const match = value.match(/^ordem:([0-9a-f-]{36})$/i);
  return match ? match[1] : null;
}

function sameMoney(a: unknown, b: unknown): boolean {
  const left = Number(a);
  const right = Number(b);
  return Number.isFinite(left) && Number.isFinite(right) &&
    Math.round(left * 100) === Math.round(right * 100);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const url = new URL(req.url);
    const body = await req.json().catch(() => null) as Record<string, any> | null;
    if (!body) throw new HttpError(400, "JSON inválido.", "JSON_INVALIDO");

    // A assinatura do Mercado Pago usa data.id da query string, x-request-id
    // e x-signature. Não confiar apenas no corpo da notificação.
    const dataId = url.searchParams.get("data.id") ?? "";
    if (!dataId || !(await validarAssinaturaWebhook(req, dataId))) {
      throw new HttpError(401, "Assinatura da notificação inválida.", "WEBHOOK_NAO_AUTENTICADO");
    }

    const eventType = String(body.type ?? url.searchParams.get("type") ?? url.searchParams.get("topic") ?? "");
    const resourceId = String(body.data?.id ?? dataId);
    const db = backendClient();

    // Eventos de assinatura só atualizam o estado da ordem; não concedem
    // licença. A licença depende de um evento de pagamento aprovado.
    if (eventType === "subscription_preapproval" || eventType === "preapproval") {
      const subscription = await mpRequest("/preapproval/" + encodeURIComponent(resourceId));
      const orderId = idFromReference(subscription.external_reference);
      if (!orderId) return new Response("Ignored", { status: 200 });

      const { data: order, error: orderError } = await db
        .from("ordens_pagamento")
        .select("*")
        .eq("id", orderId)
        .maybeSingle();

      if (orderError) throw new HttpError(503, "Não foi possível localizar a ordem.", "ORDEM_CONSULTA");
      if (!order || order.modalidade !== "assinatura") return new Response("Ignored", { status: 200 });

      if (String(subscription.external_reference) !== String(order.referencia_externa)) {
        throw new HttpError(401, "A referência da assinatura não corresponde à ordem.", "REFERENCIA_INVALIDA");
      }

      // Só marca a assinatura como ativa quando o provedor a autorizar.
      // Isso não altera a licença; a licença depende do pagamento aprovado.
      if (["authorized", "active"].includes(String(subscription.status))) {
        const { error } = await db
          .from("ordens_pagamento")
          .update({ status: "assinatura_ativa", atualizado_em: new Date().toISOString() })
          .eq("id", order.id)
          .in("status", ["criada", "aguardando_pagamento", "assinatura_ativa"]);

        if (error) throw new HttpError(503, "Não foi possível atualizar o estado da assinatura.", "ORDEM_ATUALIZACAO");
      }

      // Cancelamento da assinatura não revoga período já pago. O estado de
      // cancelamento será tratado numa etapa própria, sem bloquear pagamentos
      // aprovados que possam ter sido notificados fora de ordem.
      return new Response("OK", { status: 200 });
    }

    // Somente eventos de pagamento podem conceder ou renovar uma licença.
    if (!(eventType === "payment" || String(body.action ?? "").startsWith("payment."))) {
      return new Response("Ignored", { status: 200 });
    }

    const payment = await mpRequest("/v1/payments/" + encodeURIComponent(resourceId));
    if (String(payment.status) !== "approved") {
      // Não gravar pagamentos pendentes neste caminho. A RPC registra o
      // pagamento aprovado e a licença na mesma transação.
      return new Response("OK", { status: 200 });
    }

    const reference = String(payment.external_reference ?? "");
    const orderId = idFromReference(reference);
    if (!orderId) {
      throw new HttpError(422, "Pagamento aprovado sem referência externa válida.", "REFERENCIA_AUSENTE");
    }

    const { data: order, error: orderError } = await db
      .from("ordens_pagamento")
      .select("*")
      .eq("id", orderId)
      .maybeSingle();

    if (orderError) throw new HttpError(503, "Não foi possível consultar a ordem.", "ORDEM_CONSULTA");
    if (!order) throw new HttpError(404, "Ordem não encontrada.", "ORDEM_NAO_ENCONTRADA");
    if (reference !== order.referencia_externa) {
      throw new HttpError(401, "A referência do pagamento não corresponde à ordem.", "REFERENCIA_INVALIDA");
    }
    if (!sameMoney(payment.transaction_amount, order.valor) || String(payment.currency_id) !== "BRL") {
      throw new HttpError(422, "Valor ou moeda do pagamento não corresponde à ordem.", "VALOR_INVALIDO");
    }
    if (!payment.date_approved) {
      throw new HttpError(422, "Pagamento aprovado sem data de aprovação.", "DATA_APROVACAO_AUSENTE");
    }

    let preapprovalId: string | null = null;
    if (order.modalidade === "pix") {
      if (String(payment.payment_method_id) !== "pix") {
        throw new HttpError(422, "O meio de pagamento não corresponde à ordem Pix.", "MODALIDADE_INVALIDA");
      }
    } else if (order.modalidade === "assinatura") {
      preapprovalId = String(order.mp_preapproval_id ?? "");
      if (!preapprovalId) {
        throw new HttpError(503, "A assinatura ainda não está vinculada à ordem. O evento pode ser reprocessado.", "ASSINATURA_SEM_VINCULO");
      }

      const subscription = await mpRequest("/preapproval/" + encodeURIComponent(preapprovalId));
      const recurring = subscription.auto_recurring ?? {};
      if (
        String(subscription.external_reference ?? "") !== String(order.referencia_externa) ||
        !sameMoney(recurring.transaction_amount, order.valor) ||
        String(recurring.currency_id) !== "BRL" ||
        Number(recurring.frequency) !== Number(order.plano_meses_snapshot) ||
        String(recurring.frequency_type) !== "months"
      ) {
        throw new HttpError(422, "A assinatura não corresponde aos dados comerciais da ordem.", "ASSINATURA_INCOMPATIVEL");
      }
    } else {
      throw new HttpError(422, "Modalidade de ordem inválida.", "MODALIDADE_INVALIDA");
    }

    const { data: applied, error: rpcError } = await db.rpc("aplicar_pagamento", {
      p_ordem_id: order.id,
      p_mp_payment_id: String(payment.id),
      p_status_mp: String(payment.status),
      p_valor_confirmado: Number(payment.transaction_amount),
      p_moeda_confirmada: String(payment.currency_id),
      p_aprovado_em: String(payment.date_approved),
      p_referencia_externa: String(payment.external_reference),
      p_preapproval_id: preapprovalId,
    });

    if (rpcError) {
      // Retornar 5xx permite ao Mercado Pago reenviar a notificação.
      throw new HttpError(503, "O processamento interno não foi concluído; a notificação pode ser reprocessada.", "APLICACAO_PENDENTE");
    }

    return jsonResponse(req, {
      recebido: true,
      resultado: applied?.resultado ?? "processado",
    });
  } catch (error) {
    return errorResponse(req, error);
  }
});
