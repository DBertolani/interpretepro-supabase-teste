import { errorResponseHomologacao as errorResponse, HttpError, jsonResponseHomologacao as jsonResponse, preflightResponseHomologacao as preflightResponse } from "../_shared/http-homologacao.ts";
import { mpRequestHomologacao } from "../_shared/mercadopago-homologacao.ts";
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
    .replace(/APP_USR-[A-Za-z0-9_-]+/g, "[MP_ACCESS_TOKEN_REDACTED]")
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

    etapaAtual = "consulta_ou_criacao_ordem";
    logPixStage(etapaAtual, "inicio");
    const order = await getOrCreateOrderHomologacao(db, user, plan, "pix", requestKey);
    logPixStage(etapaAtual);

    if (order.status === "concluida" || ["cancelada", "expirada"].includes(String(order.status))) {
      throw new HttpError(409, "Esta ordem de teste foi encerrada. Inicie uma nova solicitação.", "NOVA_TENTATIVA");
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
    const valorPix = Number(order.valor).toFixed(2);
    const payload = {
      type: "online",
      external_reference: String(order.referencia_externa),
      total_amount: valorPix,
      payer: { first_name: "APRO" },
      transactions: {
        payments: [{
          amount: valorPix,
          payment_method: { id: "pix", type: "bank_transfer" },
        }],
      },
    };
    logPixStage(etapaAtual);

    etapaAtual = "chamada_api_mercado_pago";
    logPixStage(etapaAtual, "inicio");
    const mpOrder = await mpRequestHomologacao("/v1/orders", {
      method: "POST",
      headers: {
        "X-Idempotency-Key": requestKey,
      },
      body: JSON.stringify(payload),
    });
    logPixStage(etapaAtual);

    etapaAtual = "validacao_dados_qr_code";
    logPixStage(etapaAtual, "inicio");
    const mpPayment = mpOrder.transactions?.payments?.[0] ?? {};
    const paymentMethod = mpPayment.payment_method ?? {};
    const orderId = String(mpOrder.id ?? "");
    const paymentId = String(mpPayment.id ?? "");
    const qrCodeBase64 = String(paymentMethod.qr_code_base64 ?? "");
    const qrCodeTexto = String(paymentMethod.qr_code ?? "");
    const ticketUrl = String(paymentMethod.ticket_url ?? "");
    if (!orderId || !paymentId || !qrCodeTexto) {
      throw new HttpError(503, "O Mercado Pago não retornou os dados necessários do Pix de teste. A ordem foi preservada para reconciliação.", "PIX_QR_PENDENTE");
    }
    logPixStage(etapaAtual);

    console.info("[criar-pix-homologacao] Pix de teste criado", {
      etapa: "resposta_pronta",
      possuiOrderId: true,
      possuiPaymentId: true,
      possuiQrCode: true,
      possuiQrCodeBase64: Boolean(qrCodeBase64),
    });

    return jsonResponse(req, {
      status: "Sucesso",
      orderId,
      paymentId,
      qrCodeBase64,
      qrCodeTexto,
      ticketUrl,
    });
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
