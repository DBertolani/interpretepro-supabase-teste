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

function logPixStage(etapa: string, evento: "inicio" | "concluida" | "falha" = "concluida") {
  // Não incluir body, e-mail, tokens, IDs de pagamento ou respostas dos provedores.
  console.info("[criar-pix-homologacao]", { etapa, evento });
}

function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s"'\\]+/gi, "Bearer [REDACTED]")
    .replace(/TEST-[A-Za-z0-9_-]+/g, "[MP_TEST_TOKEN_REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL_REDACTED]")
    .replace(/([?&](?:access_token|token|key|secret|signature)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT_REDACTED]");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflightResponse(req);
  if (req.method !== "POST") {
    return jsonResponse(req, { status: "Erro", mensagem: "Método não permitido." }, 405);
  }

  let etapaAtual = "inicio_handler";
  logPixStage(etapaAtual, "inicio");

  try {
    etapaAtual = "autenticacao_usuario";
    logPixStage(etapaAtual, "inicio");
    const user = await authenticatedUser(req);
    requireEmail(user);
    logPixStage(etapaAtual);

    etapaAtual = "leitura_body_json";
    logPixStage(etapaAtual, "inicio");
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) throw new HttpError(400, "Corpo JSON inválido.", "JSON_INVALIDO");
    logPixStage(etapaAtual);

    etapaAtual = "criacao_cliente_admin";
    logPixStage(etapaAtual, "inicio");
    const db = backendClientHomologacao();
    logPixStage(etapaAtual);

    etapaAtual = "validacao_cliente_teste";
    logPixStage(etapaAtual, "inicio");
    await validateClientLinkHomologacao(db, user);
    logPixStage(etapaAtual);

    etapaAtual = "leitura_validacao_plano";
    logPixStage(etapaAtual, "inicio");
    const plan = await loadActivePlanHomologacao(db, body.planoId);
    logPixStage(etapaAtual);

    etapaAtual = "validacao_chave_idempotencia";
    logPixStage(etapaAtual, "inicio");
    const requestKey = validateRequestKeyHomologacao(body.chaveRequisicao);
    logPixStage(etapaAtual);

    etapaAtual = "validacao_email_pagador_teste";
    logPixStage(etapaAtual, "inicio");
    const payerEmail = (Deno.env.get("MP_TEST_PAYER_EMAIL") ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail)) {
      throw new HttpError(500, "Configure MP_TEST_PAYER_EMAIL com o e-mail de um usuário de teste do Mercado Pago.", "MP_TEST_PAYER_INVALIDO");
    }
    logPixStage(etapaAtual);

    etapaAtual = "validacao_url_webhook";
    logPixStage(etapaAtual, "inicio");
    const notificationUrl = webhookUrlHomologacao();
    logPixStage(etapaAtual);

    etapaAtual = "consulta_ou_criacao_ordem";
    logPixStage(etapaAtual, "inicio");
    const order = await getOrCreateOrderHomologacao(db, user, plan, "pix", requestKey);
    logPixStage(etapaAtual);

    if (order.status === "concluida" || ["cancelada", "expirada"].includes(String(order.status))) {
      throw new HttpError(409, "Esta ordem de teste foi encerrada. Inicie uma nova solicitação.", "ORDEM_ENCERRADA");
    }

    if (order.status === "criada" || order.status === "falha") {
      etapaAtual = "atualizacao_ordem_aguardando_pagamento";
      logPixStage(etapaAtual, "inicio");
      await updateOrderHomologacao(db, order.id, {
        status: "aguardando_pagamento",
        expira_em: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      logPixStage(etapaAtual);
    }

    etapaAtual = "montagem_payload_pix";
    logPixStage(etapaAtual, "inicio");
    const payload = {
      transaction_amount: Number(order.valor),
      description: "IntérpretePro HOMOLOGAÇÃO - " + String(order.plano_nome_snapshot),
      payment_method_id: "pix",
      payer: { email: payerEmail, first_name: "Test", last_name: "User" },
      external_reference: String(order.referencia_externa),
      date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      notification_url: notificationUrl,
    };
    logPixStage(etapaAtual);

    etapaAtual = "chamada_api_mercado_pago";
    logPixStage(etapaAtual, "inicio");
    const payment = await mpRequestHomologacao("/v1/payments", {
      method: "POST",
      headers: { "X-Idempotency-Key": String(order.id) },
      body: JSON.stringify(payload),
    });
    logPixStage(etapaAtual);

    etapaAtual = "validacao_dados_qr_code";
    logPixStage(etapaAtual, "inicio");
    const paymentId = String(payment.id ?? "");
    const transactionData = payment.point_of_interaction?.transaction_data ?? {};
    const qrCodeBase64 = String(transactionData.qr_code_base64 ?? "");
    const qrCodeTexto = String(transactionData.qr_code ?? "");
    if (!paymentId || !qrCodeBase64 || !qrCodeTexto) {
      throw new HttpError(503, "O Mercado Pago não disponibilizou o QR Code de teste. A ordem foi preservada para reconciliação.", "PIX_QR_PENDENTE");
    }
    logPixStage(etapaAtual);

    console.info("[criar-pix-homologacao] Pix de teste criado", {
      etapa: "resposta_pronta",
      possuiPaymentId: true,
      possuiQrCode: true,
    });

    return jsonResponse(req, { status: "Sucesso", paymentId, qrCodeBase64, qrCodeTexto });
  } catch (error) {
    // Logar a etapa e uma versão higienizada; nunca registrar body, e-mail ou tokens.
    const errorName = error instanceof Error ? error.name : typeof error;
    const errorMessage = error instanceof Error
      ? sanitizeDiagnosticText(error.message).slice(0, 500)
      : "Exceção não textual";
    const errorStack = error instanceof Error && error.stack
      ? sanitizeDiagnosticText(error.stack).split("\n").slice(0, 12).join("\n").slice(0, 3000)
      : undefined;

    console.error("[criar-pix-homologacao] Exceção capturada", {
      etapa: etapaAtual,
      nome: errorName,
      mensagem: errorMessage,
      stack: errorStack,
    });

    return errorResponse(req, error);
  }
});
