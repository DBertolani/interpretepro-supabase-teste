import { errorResponse, HttpError, jsonResponse, preflightResponse } from "../_shared/http.ts";
import { mpRequest, webhookUrl } from "../_shared/mercadopago.ts";
import { getOrCreateOrder, loadActivePlan, updateOrder, validateClientLink, validateRequestKey } from "../_shared/orders.ts";
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

    console.info("[criar-pix] payload recebido", {
      planoId: body.planoId ?? null,
      tipoPlanoId: typeof body.planoId,
      possuiChaveRequisicao: Boolean(body.chaveRequisicao),
      camposRecebidos: Object.keys(body),
    });

    const db = backendClient();
    await validateClientLink(db, user);

    console.info("[criar-pix] antes de loadActivePlan");

    const plan = await loadActivePlan(db, body.planoId);

    console.info("[criar-pix] plano carregado", {
      planoId: plan.id,
      meses: plan.meses,
      possuiNome: Boolean(plan.nome),
      possuiValor: Number.isFinite(plan.valor_total),
    });

    let requestKey: string;
    console.info("[criar-pix] antes de validar chave de requisição");
    try {
      requestKey = validateRequestKey(body.chaveRequisicao);
      console.info("[criar-pix] chave de requisição validada");
    } catch (error) {
      console.warn("[criar-pix] chave de requisição rejeitada", {
        tipo: error instanceof Error ? error.name : typeof error,
        codigo: error instanceof HttpError ? error.code ?? null : null,
        status: error instanceof HttpError ? error.status : null,
      });
      return errorResponse(req, error);
    }

    console.info("[criar-pix] antes de getOrCreateOrder");

    const order = await getOrCreateOrder(db, user, plan, "pix", requestKey);

    console.info("[criar-pix] ordem obtida", {
      possuiId: Boolean(order.id),
      status: order.status,
      possuiValor: Number.isFinite(Number(order.valor)),
    });

    if (order.status === "concluida") {
      throw new HttpError(409, "Esta ordem já foi concluída. Inicie uma nova solicitação.", "NOVA_TENTATIVA");
    }
    if (["cancelada", "expirada"].includes(order.status)) {
      throw new HttpError(409, "Esta ordem foi encerrada. Inicie uma nova solicitação.", "NOVA_TENTATIVA");
    }

    if (order.status === "criada" || order.status === "falha") {
      console.info("[criar-pix] antes de atualizar ordem para aguardando_pagamento");
      try {
        await updateOrder(db, order.id, {
          status: "aguardando_pagamento",
          expira_em: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
        console.info("[criar-pix] ordem atualizada para aguardando_pagamento");
      } catch (error) {
        console.error("[criar-pix] falha ao atualizar ordem", {
          tipo: error instanceof Error ? error.name : typeof error,
          codigo: error instanceof HttpError ? error.code ?? null : null,
          status: error instanceof HttpError ? error.status : null,
        });
        throw error;
      }
    }

    console.info("[criar-pix] antes de validar e-mail do pagador", {
      usaEmailTeste: Boolean(Deno.env.get("MP_TEST_PAYER_EMAIL")),
    });
    const payerEmail = (Deno.env.get("MP_TEST_PAYER_EMAIL") ?? email).trim().toLowerCase();
    const payerEmailValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail);
    console.info("[criar-pix] validação de e-mail concluída", { valido: payerEmailValido });
    if (!payerEmailValido) {
      throw new HttpError(500, "Configure MP_TEST_PAYER_EMAIL com um e-mail de usuário de teste válido.", "MP_TEST_PAYER_INVALIDO");
    }

    console.info("[criar-pix] antes de validar URL do webhook");
    const notificationUrl = webhookUrl();
    console.info("[criar-pix] URL do webhook validada");

    // A chave é derivada da ordem persistida. Repetir a mesma ordem reutiliza
    // a mesma chave do provedor, evitando cobranças duplicadas em falhas de rede.
    const payload: Record<string, unknown> = {
      transaction_amount: Number(order.valor),
      description: "IntérpretePro - " + String(order.plano_nome_snapshot),
      payment_method_id: "pix",
      payer: {
        email: payerEmail,
        first_name: "Test",
        last_name: "User",
        identification: {
          type: "CPF",
          number: "19119119100",
        },
      },
      external_reference: String(order.referencia_externa),
      date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      notification_url: notificationUrl,
    };

    let payment: Record<string, any>;
    try {
      // Diagnóstico sem cobrança: identifica a conta vinculada ao token atual.
      // Registrar somente id e site_id; nunca registrar o token ou a resposta completa.
      console.info("[criar-pix] validando identidade da credencial Mercado Pago");
      const mpAccessToken = (Deno.env.get("MP_ACCESS_TOKEN") ?? "").trim();
      if (!mpAccessToken) {
        throw new HttpError(500, "Credencial do Mercado Pago não configurada.", "MP_CREDENCIAL_AUSENTE");
      }

      const identityResponse = await fetch("https://api.mercadolibre.com/users/me", {
        method: "GET",
        headers: { Authorization: `Bearer ${mpAccessToken}` },
      });
      if (!identityResponse.ok) {
        console.warn("[criar-pix] validação de identidade recusada", {
          endpoint: "https://api.mercadolibre.com/users/me",
          status: identityResponse.status,
        });
        throw new HttpError(502, "Não foi possível validar a identidade da credencial do Mercado Pago.", "MP_REQUISICAO_RECUSADA");
      }

      const mpIdentity = await identityResponse.json();
      console.info("[criar-pix] identidade da credencial Mercado Pago", {
        id: mpIdentity.id ?? null,
        site_id: mpIdentity.site_id ?? null,
      });

      console.info("[criar-pix] antes de chamar Mercado Pago", {
        endpoint: "/v1/payments",
        possuiIdempotencyKey: Boolean(order.id),
        possuiValor: Number.isFinite(Number(order.valor)),
      });
      payment = await mpRequest("/v1/payments", {
        method: "POST",
        headers: { "X-Idempotency-Key": String(order.id) },
        body: JSON.stringify(payload),
      });
      console.info("[criar-pix] resposta recebida do Mercado Pago", {
        possuiPaymentId: Boolean(payment?.id),
        possuiDadosTransacao: Boolean(payment?.point_of_interaction?.transaction_data),
      });
    } catch (error) {
      console.error("[criar-pix] chamada ao Mercado Pago falhou", {
        tipo: error instanceof Error ? error.name : typeof error,
        codigo: error instanceof HttpError ? error.code ?? null : null,
        status: error instanceof HttpError ? error.status : null,
      });
      if (error instanceof HttpError && error.code === "MP_REQUISICAO_RECUSADA") {
        await updateOrder(db, order.id, { status: "falha" });
        throw new HttpError(502, error.message, "NOVA_TENTATIVA");
      }
      // Erro de rede/5xx é ambíguo: manter a ordem e repetir com a mesma chave.
      throw error;
    }

    const paymentId = String(payment.id ?? "");
    const transactionData = payment.point_of_interaction?.transaction_data ?? {};
    const qrCodeBase64 = String(transactionData.qr_code_base64 ?? "");
    const qrCodeTexto = String(transactionData.qr_code ?? "");

    if (!paymentId || !qrCodeBase64 || !qrCodeTexto) {
      // A ordem permanece aguardando. Repetir a chamada usa a mesma chave MP.
      throw new HttpError(503, "O Mercado Pago ainda não disponibilizou o QR Code. Tente novamente sem iniciar outra ordem.", "PIX_QR_PENDENTE");
    }

    // Não inserir pagamento pendente em pagamentos_mp nesta etapa:
    // a RPC aplicar_pagamento registra a cobrança aprovada dentro da transação.
    // Pré-inserir aqui faria a RPC atual interpretar a cobrança como duplicada.
    return jsonResponse(req, {
      status: "Sucesso",
      paymentId,
      qrCodeBase64,
      qrCodeTexto,
    });
  } catch (error) {
    return errorResponse(req, error);
  }
});