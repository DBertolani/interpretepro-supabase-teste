import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/Bearer\s+[^\s"'\\]+/gi, "Bearer [REDACTED]")
    .replace(/TEST-[A-Za-z0-9_-]+/g, "[MP_TEST_TOKEN_REDACTED]")
    .replace(/APP_USR-[A-Za-z0-9_-]+/g, "[MP_ACCESS_TOKEN_REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL_REDACTED]");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ status: "Erro", mensagem: "Método não permitido." }, 405);
  }

  let etapaAtual = "inicio_handler";

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    const mpAccessToken = (
      Deno.env.get("MP_ACCESS_TOKEN_TESTE") ||
      Deno.env.get("MP_ACCESS_TOKEN") ||
      ""
    ).trim();

    if (!mpAccessToken) {
      return jsonResponse({
        status: "Erro",
        mensagem: "Secret MP_ACCESS_TOKEN_TESTE não configurado no projeto.",
      });
    }

    // 1. Autenticação do usuário
    etapaAtual = "autenticacao_usuario";
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ status: "Erro", mensagem: "Usuário não autenticado." });
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user || !user.email) {
      return jsonResponse({ status: "Erro", mensagem: "Sessão inválida ou expirada." });
    }

    // 2. Leitura do body
    etapaAtual = "leitura_body_json";
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) {
      return jsonResponse({ status: "Erro", mensagem: "Corpo JSON inválido." });
    }

    const planoId = String(body.planoId || "").trim();
    const requestKey = String(body.chaveRequisicao || crypto.randomUUID()).trim();

    if (!planoId) {
      return jsonResponse({ status: "Erro", mensagem: "Plano não informado." });
    }

    // 3. Consulta do plano ativo no banco de homologação
    etapaAtual = "leitura_validacao_plano";
    const db = createClient(supabaseUrl, supabaseServiceKey);

    const { data: plan, error: planError } = await db
      .from("interpretepro_planos")
      .select("id, nome, meses, valor_total, ativo")
      .eq("id", planoId)
      .eq("ativo", true)
      .maybeSingle();

    if (planError || !plan || Number(plan.valor_total) <= 0) {
      return jsonResponse({ status: "Erro", mensagem: "Plano inválido ou indisponível." });
    }

    // 4. Referência externa no formato exigido pela /v1/orders (apenas a-z, 0-9, _ e -, máx 64 chars)
    const refExterna = \`hom_\${plan.id}_\${requestKey}\`
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 64);

    // Reaproveita ordem Pix já gerada para esta chave de idempotência
    const { data: pgtoExistente } = await db
      .from("interpretepro_pagamentos")
      .select("mp_payment_id, status, payload_resumo")
      .eq("external_reference", refExterna)
      .maybeSingle();

    if (pgtoExistente?.payload_resumo?.qr_code) {
      return jsonResponse({
        status: "Sucesso",
        orderId: String(pgtoExistente.payload_resumo.order_id || ""),
        paymentId: String(pgtoExistente.mp_payment_id || ""),
        qrCodeBase64: String(pgtoExistente.payload_resumo.qr_code_base64 || ""),
        qrCodeTexto: String(pgtoExistente.payload_resumo.qr_code || ""),
        ticketUrl: String(pgtoExistente.payload_resumo.ticket_url || ""),
      });
    }

    // 5. E-mail e nome de aprovação automática do pagador de teste (Sandbox Orders API)
    etapaAtual = "montagem_payload_pix";
    const payerEmail = (
      Deno.env.get("MP_TEST_PAYER_EMAIL") ||
      user.email ||
      "teste_comprador@testuser.com"
    ).trim().toLowerCase();

    const testFirstName = (
      Deno.env.get("MP_TEST_PAYER_FIRST_NAME") ?? "APRO"
    ).trim();

    const valorPix = Number(plan.valor_total).toFixed(2);

    const payloadMp = {
      type: "online",
      external_reference: refExterna,
      total_amount: valorPix,
      payer: {
        email: payerEmail,
        ...(testFirstName ? { first_name: testFirstName } : {}),
      },
      transactions: {
        payments: [
          {
            amount: valorPix,
            payment_method: {
              id: "pix",
              type: "bank_transfer",
            },
          },
        ],
      },
    };

    // 6. Chamada oficial à Orders API do Mercado Pago
    etapaAtual = "chamada_api_mercado_pago";
    const mpRes = await fetch("https://api.mercadopago.com/v1/orders", {
      method: "POST",
      headers: {
        "Authorization": \`Bearer \${mpAccessToken}\`,
        "X-Idempotency-Key": crypto.randomUUID(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payloadMp),
    });

    const mpResponse = await mpRes.json().catch(() => ({}));

    if (!mpRes.ok) {
      const detalhe = sanitizeDiagnosticText(
        JSON.stringify({
          httpStatus: mpRes.status,
          message: mpResponse?.message,
          errors: mpResponse?.errors,
        })
      );
      console.error("[criar-pix-homologacao] Falha MP /v1/orders:", detalhe);

      const msgAmigavel =
        mpResponse?.errors?.[0]?.message ||
        mpResponse?.message ||
        \`Mercado Pago retornou HTTP \${mpRes.status}.\`;

      return jsonResponse({
        status: "Erro",
        mensagem: msgAmigavel,
      });
    }

    // 7. Extração do QR Code e gravação no banco de homologação
    etapaAtual = "validacao_dados_qr_code";
    const payment = mpResponse?.transactions?.payments?.[0];
    const paymentMethod = payment?.payment_method;

    const qrCodeTexto = String(paymentMethod?.qr_code || "");
    const qrCodeBase64 = String(paymentMethod?.qr_code_base64 || "");
    const ticketUrl = String(paymentMethod?.ticket_url || "");
    const mpOrderId = String(mpResponse?.id || "");
    const mpPaymentId = String(payment?.id || mpOrderId);

    if (!qrCodeTexto && !ticketUrl) {
      console.error("[criar-pix-homologacao] Resposta Pix incompleta", {
        possuiOrderId: Boolean(mpOrderId),
        possuiPaymentId: Boolean(mpPaymentId),
        possuiQrCode: Boolean(qrCodeTexto),
        possuiTicketUrl: Boolean(ticketUrl),
      });
      return jsonResponse({
        status: "Erro",
        mensagem: "Mercado Pago não retornou os dados do Pix.",
      });
    }

    const { error: insertError } = await db.from("interpretepro_pagamentos").insert({
      mp_payment_id: mpPaymentId,
      external_reference: refExterna,
      email_usuario: user.email,
      plano_id: plan.id,
      tipo: "pix",
      valor: Number(plan.valor_total),
      status: String(payment?.status || mpResponse?.status || "pending"),
      payload_resumo: {
        order_id: mpOrderId,
        payment_id: mpPaymentId,
        qr_code: qrCodeTexto,
        qr_code_base64: qrCodeBase64,
        ticket_url: ticketUrl,
      },
    });

    if (insertError) {
      console.error("[criar-pix-homologacao] Erro ao gravar pagamento:", insertError.message);
    }

    return jsonResponse({
      status: "Sucesso",
      orderId: mpOrderId,
      paymentId: mpPaymentId,
      qrCodeBase64,
      qrCodeTexto,
      ticketUrl,
    });
  } catch (error) {
    const errorMessage = error instanceof Error
      ? sanitizeDiagnosticText(error.message).slice(0, 500)
      : "Exceção não textual";

    console.error("[criar-pix-homologacao] Exceção capturada", {
      etapa: etapaAtual,
      mensagem: errorMessage,
    });

    return jsonResponse({
      status: "Erro",
      mensagem: \`Erro na etapa \${etapaAtual}: \${errorMessage}\`,
    });
  }
});