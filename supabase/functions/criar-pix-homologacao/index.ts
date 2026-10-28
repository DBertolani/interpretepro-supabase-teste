import { errorResponseHomologacao as errorResponse, HttpError, jsonResponseHomologacao as jsonResponse, preflightResponseHomologacao as preflightResponse } from "../_shared/http-homologacao.ts";
import { mpRequestHomologacao, webhookUrlHomologacao } from "../_shared/mercadopago-homologacao.ts";
import {
  getOrCreateOrderHomologacao,
  loadActivePlanHomologacao,
  updateOrderHomologacao,
  validateClientLinkHomologacao,
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

    // Validar a configuração antes de criar/alterar o estado de uma ordem.
    const payerEmail = (Deno.env.get("MP_TEST_PAYER_EMAIL") ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail)) {
      throw new HttpError(500, "Configure MP_TEST_PAYER_EMAIL com o e-mail de um usuário de teste do Mercado Pago.", "MP_TEST_PAYER_INVALIDO");
    }
    const notificationUrl = webhookUrlHomologacao();

    const order = await getOrCreateOrderHomologacao(db, user, plan, "pix", requestKey);

    if (order.status === "concluida" || ["cancelada", "expirada"].includes(String(order.status))) {
      throw new HttpError(409, "Esta ordem de teste foi encerrada. Inicie uma nova solicitação.", "ORDEM_ENCERRADA");
    }

    if (order.status === "criada" || order.status === "falha") {
      await updateOrderHomologacao(db, order.id, {
        status: "aguardando_pagamento",
        expira_em: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
    }

    const payload = {
      transaction_amount: Number(order.valor),
      description: "IntérpretePro HOMOLOGAÇÃO - " + String(order.plano_nome_snapshot),
      payment_method_id: "pix",
      payer: { email: payerEmail, first_name: "Test", last_name: "User" },
      external_reference: String(order.referencia_externa),
      date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      notification_url: notificationUrl,
    };

    const payment = await mpRequestHomologacao("/v1/payments", {
      method: "POST",
      headers: { "X-Idempotency-Key": String(order.id) },
      body: JSON.stringify(payload),
    });

    const paymentId = String(payment.id ?? "");
    const transactionData = payment.point_of_interaction?.transaction_data ?? {};
    const qrCodeBase64 = String(transactionData.qr_code_base64 ?? "");
    const qrCodeTexto = String(transactionData.qr_code ?? "");
    if (!paymentId || !qrCodeBase64 || !qrCodeTexto) {
      throw new HttpError(503, "O Mercado Pago não disponibilizou o QR Code de teste. A ordem foi preservada para reconciliação.", "PIX_QR_PENDENTE");
    }

    console.info("[criar-pix-homologacao] Pix de teste criado", {
      possuiPaymentId: true,
      possuiQrCode: true,
      ordemId: String(order.id),
    });

    return jsonResponse(req, { status: "Sucesso", paymentId, qrCodeBase64, qrCodeTexto });
  } catch (error) {
    return errorResponse(req, error);
  }
});
