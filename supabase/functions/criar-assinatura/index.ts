import { errorResponse, HttpError, jsonResponse, preflightResponse } from "../_shared/http.ts";
import { backUrl, mpRequest, webhookUrl } from "../_shared/mercadopago.ts";
import { getOrCreateOrder, loadActivePlan, updateOrder, validateClientLink, validateMpCheckoutUrl, validateRequestKey } from "../_shared/orders.ts";
import { authenticatedUser, backendClient, requireEmail } from "../_shared/supabase.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflightResponse(req);
  if (req.method !== "POST") {
    return jsonResponse(req, { status: "Erro", mensagem: "Método não permitido." }, 405);
  }

  try {
    const user = await authenticatedUser(req);
    const email = requireEmail(user);
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) throw new HttpError(400, "Corpo JSON inválido.", "JSON_INVALIDO");

    console.info("[criar-assinatura] payload recebido", {
      planoId: body.planoId ?? null,
      tipoPlanoId: typeof body.planoId,
      possuiChaveRequisicao: Boolean(body.chaveRequisicao),
      camposRecebidos: Object.keys(body),
    });

    const db = backendClient();
    await validateClientLink(db, user);

    const plan = await loadActivePlan(db, body.planoId);
    const requestKey = validateRequestKey(body.chaveRequisicao);
    let order = await getOrCreateOrder(db, user, plan, "assinatura", requestKey);

    if (order.status === "concluida" || order.status === "cancelada" || order.status === "expirada") {
      throw new HttpError(409, "Esta ordem já foi encerrada. Inicie uma nova solicitação.", "NOVA_TENTATIVA");
    }

    // Se a assinatura já foi criada, recuperar o checkout existente em vez
    // de criar uma segunda assinatura.
    if (order.mp_preapproval_id) {
      const current = await mpRequest("/preapproval/" + encodeURIComponent(String(order.mp_preapproval_id)));
      const url = validateMpCheckoutUrl(current.init_point);
      return jsonResponse(req, { status: "Sucesso", url });
    }

    // Evitar duas criações concorrentes: só uma chamada pode reivindicar
    // a transição para aguardando_pagamento. Se a chamada anterior caiu
    // depois de chegar ao Mercado Pago, não criar outra assinatura às cegas.
    if (order.status === "aguardando_pagamento" || order.status === "assinatura_ativa") {
      throw new HttpError(
        409,
        "A criação da assinatura já foi iniciada, mas ainda não foi vinculada. Não repita a cobrança; a ordem precisa ser reconciliada.",
        "ASSINATURA_EM_RECONCILIACAO",
      );
    }

    const statusAnterior = order.status;
    const { data: claimed, error: claimError } = await db
      .from("ordens_pagamento")
      .update({
        status: "aguardando_pagamento",
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", order.id)
      .eq("status", statusAnterior)
      .select("*")
      .maybeSingle();

    if (claimError || !claimed) {
      throw new HttpError(409, "A ordem foi alterada por outra solicitação. Recarregue e tente novamente.", "ORDEM_CONCORRENTE");
    }
    order = claimed;

    const payerEmail = (Deno.env.get("MP_TEST_PAYER_EMAIL") ?? email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail)) {
      await updateOrder(db, order.id, { status: "falha" });
      throw new HttpError(500, "Configure MP_TEST_PAYER_EMAIL com um e-mail de usuário de teste válido.", "MP_TEST_PAYER_INVALIDO");
    }

    const payload: Record<string, unknown> = {
      reason: "IntérpretePro - " + String(order.plano_nome_snapshot),
      external_reference: String(order.referencia_externa),
      payer_email: payerEmail,
      auto_recurring: {
        frequency: Number(order.plano_meses_snapshot),
        frequency_type: "months",
        transaction_amount: Number(order.valor),
        currency_id: "BRL",
      },
      back_url: backUrl(),
      notification_url: webhookUrl(),
    };

    let subscription: Record<string, any>;
    try {
      subscription = await mpRequest("/preapproval", {
        method: "POST",
        // Header de idempotência enviado como defesa adicional; o controle
        // principal contra concorrência é a reivindicação da ordem no banco.
        headers: { "X-Idempotency-Key": String(order.id) },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      if (error instanceof HttpError && error.code === "MP_REQUISICAO_RECUSADA") {
        await updateOrder(db, order.id, { status: "falha" });
        throw new HttpError(502, error.message, "NOVA_TENTATIVA");
      }
      // Resposta ambígua: manter aguardando_pagamento para impedir duplicação.
      throw error;
    }

    const preapprovalId = String(subscription.id ?? "");
    const url = validateMpCheckoutUrl(subscription.init_point);
    if (!preapprovalId) {
      throw new HttpError(503, "O Mercado Pago não retornou o identificador da assinatura. A ordem foi preservada para reconciliação.", "ASSINATURA_SEM_ID");
    }

    const { error: linkError } = await db
      .from("ordens_pagamento")
      .update({
        mp_preapproval_id: preapprovalId,
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", order.id);

    if (linkError) {
      // Não criar outra assinatura automaticamente: o recurso externo pode existir.
      throw new HttpError(503, "A assinatura foi criada no provedor, mas o vínculo interno precisa ser reconciliado. Não repita a solicitação.", "ASSINATURA_SEM_VINCULO");
    }

    return jsonResponse(req, { status: "Sucesso", url });
  } catch (error) {
    return errorResponse(req, error);
  }
});
