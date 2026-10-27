import { errorResponse, HttpError, jsonResponse, preflightResponse } from "../_shared/http.ts";
import {
  backUrlHomologacao,
  mpRequestHomologacao,
  webhookUrlHomologacao,
} from "../_shared/mercadopago-homologacao.ts";
import {
  getOrCreateOrderHomologacao,
  loadActivePlanHomologacao,
  validateClientLinkHomologacao,
  validateMpCheckoutUrlHomologacao,
  validateRequestKeyHomologacao,
} from "../_shared/orders-homologacao.ts";
import { authenticatedUser, requireEmail } from "../_shared/supabase.ts";
import { backendClientHomologacao } from "../_shared/supabase-homologacao.ts";

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

    const db = backendClientHomologacao();
    await validateClientLinkHomologacao(db, user);
    const plan = await loadActivePlanHomologacao(db, body.planoId);
    const requestKey = validateRequestKeyHomologacao(body.chaveRequisicao);
    let order = await getOrCreateOrderHomologacao(db, user, plan, "assinatura", requestKey);

    if (["concluida", "cancelada", "expirada"].includes(String(order.status))) {
      throw new HttpError(409, "Esta ordem de teste já foi encerrada. Inicie uma nova solicitação.", "ORDEM_ENCERRADA");
    }

    if (order.mp_preapproval_id) {
      const current = await mpRequestHomologacao(
        "/preapproval/" + encodeURIComponent(String(order.mp_preapproval_id)),
      );
      return jsonResponse(req, {
        status: "Sucesso",
        url: validateMpCheckoutUrlHomologacao(current.init_point),
      });
    }

    if (order.status === "aguardando_pagamento" || order.status === "assinatura_ativa") {
      throw new HttpError(
        409,
        "A criação da assinatura de teste já foi iniciada, mas ainda não foi vinculada. A ordem precisa ser reconciliada antes de tentar novamente.",
        "ASSINATURA_EM_RECONCILIACAO",
      );
    }

    const previousStatus = String(order.status);
    const { data: claimed, error: claimError } = await db
      .from("ordens_pagamento")
      .update({
        status: "aguardando_pagamento",
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", order.id)
      .eq("status", previousStatus)
      .select("*")
      .maybeSingle();

    if (claimError || !claimed) {
      throw new HttpError(409, "A ordem de teste foi alterada por outra solicitação. Recarregue e tente novamente.", "ORDEM_CONCORRENTE");
    }
    order = claimed;

    const payerEmail = (Deno.env.get("MP_TEST_PAYER_EMAIL") ?? email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail)) {
      throw new HttpError(500, "Configure MP_TEST_PAYER_EMAIL com um e-mail válido de usuário de teste.", "MP_TEST_PAYER_INVALIDO");
    }

    const payload = {
      reason: "IntérpretePro HOMOLOGAÇÃO - " + String(order.plano_nome_snapshot),
      external_reference: String(order.referencia_externa),
      payer_email: payerEmail,
      auto_recurring: {
        frequency: Number(order.plano_meses_snapshot),
        frequency_type: "months",
        transaction_amount: Number(order.valor),
        currency_id: "BRL",
      },
      back_url: backUrlHomologacao(),
      notification_url: webhookUrlHomologacao(),
    };

    let subscription: Record<string, any>;
    try {
      subscription = await mpRequestHomologacao("/preapproval", {
        method: "POST",
        headers: { "X-Idempotency-Key": String(order.id) },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      if (error instanceof HttpError && error.code === "MP_TEST_REQUISICAO_RECUSADA") {
        const { error: updateError } = await db
          .from("ordens_pagamento")
          .update({ status: "falha", atualizado_em: new Date().toISOString() })
          .eq("id", order.id);
        if (updateError) {
          console.error("[criar-assinatura-homologacao] não foi possível marcar falha", {
            ordemId: String(order.id),
          });
        }
      }
      throw error;
    }

    const preapprovalId = String(subscription.id ?? "");
    if (!preapprovalId) {
      throw new HttpError(503, "O Mercado Pago não retornou o identificador da assinatura de teste. A ordem foi preservada para reconciliação.", "ASSINATURA_SEM_ID");
    }

    // Persist the provider ID before validating/returning the checkout URL,
    // so a bad or missing URL does not lose the created subscription reference.
    const { error: linkError } = await db
      .from("ordens_pagamento")
      .update({
        mp_preapproval_id: preapprovalId,
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", order.id);

    if (linkError) {
      throw new HttpError(503, "A assinatura de teste pode ter sido criada no provedor, mas o vínculo interno precisa ser reconciliado. Não repita a solicitação.", "ASSINATURA_SEM_VINCULO");
    }

    // Never return the regular checkout URL from a sandbox endpoint.
    const url = validateMpCheckoutUrlHomologacao(subscription.sandbox_init_point);
    return jsonResponse(req, { status: "Sucesso", url });
  } catch (error) {
    return errorResponse(req, error);
  }
});
