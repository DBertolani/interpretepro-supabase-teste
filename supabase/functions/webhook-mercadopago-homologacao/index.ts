import { errorResponse, HttpError, jsonResponse } from "../_shared/http.ts";
import {
  mpRequestHomologacao,
  validarAssinaturaWebhookHomologacao,
} from "../_shared/mercadopago-homologacao.ts";
import { backendClientHomologacao } from "../_shared/supabase-homologacao.ts";

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

async function markWebhookProcessed(
  db: any,
  eventKey: string,
  eventType: string,
  resourceId: string,
  outcome: string,
) {
  const { error } = await db
    .from("eventos_webhook")
    .upsert({
      event_key: eventKey,
      tipo_evento: eventType,
      recurso_id: resourceId,
      status_processamento: "processado",
      processado_em: new Date().toISOString(),
      metadata: { resultado: outcome },
    }, { onConflict: "event_key" });

  if (error) {
    // If the payment RPC already committed, a failed event log must not
    // cause a new license grant: the SQL function is idempotent by payment ID.
    throw new HttpError(503, "O evento foi recebido, mas o registro de auditoria não foi concluído; a notificação pode ser reenviada.", "WEBHOOK_AUDITORIA_PENDENTE");
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const url = new URL(req.url);
    const body = await req.json().catch(() => null) as Record<string, any> | null;
    if (!body) throw new HttpError(400, "JSON inválido.", "JSON_INVALIDO");

    const dataId = url.searchParams.get("data.id") ?? "";
    if (!dataId || !(await validarAssinaturaWebhookHomologacao(req, dataId))) {
      throw new HttpError(401, "Assinatura da notificação de teste inválida.", "WEBHOOK_NAO_AUTENTICADO");
    }

    const eventType = String(
      body.type ??
      url.searchParams.get("type") ??
      url.searchParams.get("topic") ??
      "",
    );
    const resourceId = String(body.data?.id ?? dataId);
    const eventKey = (eventType || "unknown") + ":" + resourceId;
    const db = backendClientHomologacao();

    const { data: priorEvent, error: priorError } = await db
      .from("eventos_webhook")
      .select("status_processamento")
      .eq("event_key", eventKey)
      .maybeSingle();

    if (priorError) {
      throw new HttpError(503, "Não foi possível consultar a idempotência do webhook de teste.", "WEBHOOK_CONSULTA");
    }
    if (priorEvent?.status_processamento === "processado") {
      return jsonResponse(req, { recebido: true, resultado: "duplicado" });
    }

    // Subscription lifecycle notifications never grant a license by themselves.
    if (eventType === "subscription_preapproval" || eventType === "preapproval") {
      const subscription = await mpRequestHomologacao(
        "/preapproval/" + encodeURIComponent(resourceId),
      );
      const orderId = idFromReference(subscription.external_reference);
      if (!orderId) {
        await markWebhookProcessed(db, eventKey, eventType, resourceId, "ignorado_sem_referencia");
        return new Response("Ignored", { status: 200 });
      }

      const { data: order, error: orderError } = await db
        .from("ordens_pagamento")
        .select("*")
        .eq("id", orderId)
        .maybeSingle();

      if (orderError) throw new HttpError(503, "Não foi possível localizar a ordem de teste.", "ORDEM_CONSULTA");
      if (!order || order.modalidade !== "assinatura") {
        await markWebhookProcessed(db, eventKey, eventType, resourceId, "ignorado_sem_ordem_compativel");
        return new Response("Ignored", { status: 200 });
      }

      if (
        String(subscription.external_reference ?? "") !== String(order.referencia_externa) ||
        String(subscription.id ?? "") !== String(order.mp_preapproval_id ?? "")
      ) {
        throw new HttpError(401, "A referência ou o identificador da assinatura não corresponde à ordem de teste.", "ASSINATURA_REFERENCIA_INVALIDA");
      }

      if (["authorized", "active"].includes(String(subscription.status))) {
        const { error } = await db
          .from("ordens_pagamento")
          .update({ status: "assinatura_ativa", atualizado_em: new Date().toISOString() })
          .eq("id", order.id)
          .in("status", ["criada", "aguardando_pagamento", "assinatura_ativa"]);

        if (error) throw new HttpError(503, "Não foi possível atualizar o estado da assinatura de teste.", "ORDEM_ATUALIZACAO");
      }

      await markWebhookProcessed(db, eventKey, eventType, resourceId, "assinatura_verificada");
      return new Response("OK", { status: 200 });
    }

    // Only approved payment notifications or processed Orders can apply a test license.
    const isOrderEvent = eventType === "order" || String(body.action ?? "").startsWith("order.");
    const isPaymentEvent = eventType === "payment" || String(body.action ?? "").startsWith("payment.");
    if (!isOrderEvent && !isPaymentEvent) {
      await markWebhookProcessed(db, eventKey, eventType, resourceId, "ignorado_tipo_evento");
      return new Response("Ignored", { status: 200 });
    }

    let payment: Record<string, any>;
    if (isOrderEvent) {
      const orderResource = await mpRequestHomologacao(
        "/v1/orders/" + encodeURIComponent(resourceId),
      );
      if (String(orderResource.id ?? "") !== resourceId) {
        throw new HttpError(422, "O identificador da ordem consultada não corresponde à notificação.", "ORDER_ID_INVALIDO");
      }

      const orderPayments = orderResource.transactions?.payments;
      const orderPayment = Array.isArray(orderPayments) ? orderPayments[0] : null;
      if (!orderPayment || !orderPayment.id) {
        throw new HttpError(503, "A ordem de teste ainda não contém uma transação consultável.", "ORDER_SEM_PAGAMENTO");
      }

      // No recurso Orders, o status de sucesso é "processed" (não "approved").
      // Exigimos também o detalhe "accredited" antes de encaminhar à RPC de licença.
      const orderPaid = String(orderResource.status) === "processed" &&
        String(orderResource.status_detail) === "accredited" &&
        String(orderPayment.status) === "processed" &&
        String(orderPayment.status_detail) === "accredited";
      payment = {
        id: orderPayment.id,
        status: orderPaid ? "approved" : String(orderPayment.status ?? orderResource.status ?? "pending"),
        external_reference: orderResource.external_reference,
        // Para uma ordem com um único Pix, validar o total efetivamente pago.
        transaction_amount: orderResource.total_paid_amount ?? orderPayment.paid_amount ?? orderPayment.amount,
        currency_id: orderResource.currency_id ?? orderResource.currency,
        // Orders não expõe necessariamente date_approved; last_updated_date só é usado
        // após confirmarmos que a ordem e a transação foram processadas e acreditadas.
        date_approved: orderPayment.date_approved ?? (orderPaid ? orderResource.last_updated_date : null),
        payment_method_id: orderPayment.payment_method?.id,
      };
    } else {
      payment = await mpRequestHomologacao(
        "/v1/payments/" + encodeURIComponent(resourceId),
      );
    }

    if (String(payment.status) !== "approved") {
      // A mesma cobrança pode receber novas notificações quando o estado mudar.
      // Não registrar como "processado": isso bloquearia uma futura aprovação
      // com o mesmo eventKey (tipo + ID do pagamento).
      const { error: pendingError } = await db
        .from("eventos_webhook")
        .upsert({
          event_key: eventKey,
          tipo_evento: eventType,
          recurso_id: resourceId,
          status_processamento: "pendente",
          processado_em: null,
          metadata: { resultado: "pagamento_nao_aprovado", status_mp: String(payment.status ?? "desconhecido") },
        }, { onConflict: "event_key" });

      if (pendingError) {
        throw new HttpError(503, "Não foi possível registrar o estado pendente da notificação de teste.", "WEBHOOK_PENDENTE_AUDITORIA");
      }
      return jsonResponse(req, {
        recebido: true,
        resultado: "aguardando_aprovacao",
      });
    }

    const reference = String(payment.external_reference ?? "");
    const orderId = idFromReference(reference);
    if (!orderId) {
      throw new HttpError(422, "Pagamento de teste aprovado sem referência externa válida.", "REFERENCIA_AUSENTE");
    }

    const { data: order, error: orderError } = await db
      .from("ordens_pagamento")
      .select("*")
      .eq("id", orderId)
      .maybeSingle();

    if (orderError) throw new HttpError(503, "Não foi possível consultar a ordem de teste.", "ORDEM_CONSULTA");
    if (!order) throw new HttpError(404, "Ordem de teste não encontrada.", "ORDEM_NAO_ENCONTRADA");
    if (reference !== order.referencia_externa) {
      throw new HttpError(401, "A referência do pagamento não corresponde à ordem de teste.", "REFERENCIA_INVALIDA");
    }
    if (
      !sameMoney(payment.transaction_amount, order.valor) ||
      String(payment.currency_id) !== "BRL"
    ) {
      throw new HttpError(422, "Valor ou moeda não corresponde à ordem de teste.", "VALOR_INVALIDO");
    }
    if (!payment.date_approved) {
      throw new HttpError(422, "Pagamento aprovado sem data de aprovação.", "DATA_APROVACAO_AUSENTE");
    }

    let preapprovalId: string | null = null;
    if (order.modalidade === "pix") {
      if (String(payment.payment_method_id) !== "pix") {
        throw new HttpError(422, "O meio de pagamento não corresponde à ordem Pix de teste.", "MODALIDADE_INVALIDA");
      }
    } else if (order.modalidade === "assinatura") {
      preapprovalId = String(order.mp_preapproval_id ?? "");
      if (!preapprovalId) {
        throw new HttpError(503, "A assinatura de teste ainda não está vinculada à ordem; o evento pode ser reenviado.", "ASSINATURA_SEM_VINCULO");
      }

      const subscription = await mpRequestHomologacao(
        "/preapproval/" + encodeURIComponent(preapprovalId),
      );
      const recurring = subscription.auto_recurring ?? {};
      if (
        String(subscription.external_reference ?? "") !== String(order.referencia_externa) ||
        !sameMoney(recurring.transaction_amount, order.valor) ||
        String(recurring.currency_id) !== "BRL" ||
        Number(recurring.frequency) !== Number(order.plano_meses_snapshot) ||
        String(recurring.frequency_type) !== "months"
      ) {
        throw new HttpError(422, "A assinatura não corresponde aos dados comerciais da ordem de teste.", "ASSINATURA_INCOMPATIVEL");
      }
    } else {
      throw new HttpError(422, "Modalidade de ordem de teste inválida.", "MODALIDADE_INVALIDA");
    }

    const { data: applied, error: rpcError } = await db.rpc(
      "aplicar_pagamento_homologacao",
      {
        p_ordem_id: order.id,
        p_mp_payment_id: String(payment.id),
        p_status_mp: String(payment.status),
        p_valor_confirmado: Number(payment.transaction_amount),
        p_moeda_confirmada: String(payment.currency_id),
        p_aprovado_em: String(payment.date_approved),
        p_referencia_externa: String(payment.external_reference),
        p_preapproval_id: preapprovalId,
      },
    );

    if (rpcError) {
      throw new HttpError(503, "O processamento interno de homologação não foi concluído; a notificação pode ser reenviada.", "APLICACAO_PENDENTE");
    }

    await markWebhookProcessed(db, eventKey, eventType, resourceId, String(applied?.resultado ?? "processado"));
    return jsonResponse(req, {
      recebido: true,
      resultado: applied?.resultado ?? "processado",
    });
  } catch (error) {
    return errorResponse(req, error);
  }
});
