import { authenticatedUser, requireEmail } from "../_shared/supabase.ts";
import { errorResponse, HttpError, jsonResponse, preflightResponse } from "../_shared/http.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflightResponse(req);
  if (req.method !== "POST") {
    return jsonResponse(req, { status: "Erro", mensagem: "Método não permitido." }, 405);
  }

  try {
    const user = await authenticatedUser(req);
    const callerEmail = requireEmail(user);
    const adminEmail = (Deno.env.get("MP_TEST_ACCOUNT_ADMIN_EMAIL") ?? "").trim().toLowerCase();

    if (!adminEmail) {
      throw new HttpError(503, "Diagnóstico não configurado.", "CONFIGURACAO");
    }
    if (callerEmail !== adminEmail) {
      throw new HttpError(403, "Acesso não autorizado.", "ACESSO_NEGADO");
    }

    const token = (Deno.env.get("MP_ACCESS_TOKEN") ?? "").trim();
    if (!token) {
      throw new HttpError(503, "Credencial do Mercado Pago não configurada.", "CONFIGURACAO");
    }

    const response = await fetch("https://api.mercadopago.com/users/test_user", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({ site_id: "MLB" }),
    });

    const responseText = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(responseText) as Record<string, unknown>;
    } catch {
      payload = {};
    }

    if (!response.ok) {
      const safeCause = Array.isArray(payload.cause)
        ? payload.cause.slice(0, 5).map((item: unknown) => {
            const cause = item && typeof item === "object"
              ? item as Record<string, unknown>
              : {};
            return {
              code: typeof cause.code === "string" || typeof cause.code === "number"
                ? cause.code
                : null,
              description: typeof cause.description === "string"
                ? cause.description.slice(0, 200)
                : null,
            };
          })
        : [];

      console.warn("[gerar-conta-teste] Mercado Pago recusou a solicitação", {
        httpStatus: response.status,
        error: typeof payload.error === "string" ? payload.error.slice(0, 120) : null,
        message: typeof payload.message === "string" ? payload.message.slice(0, 250) : null,
        cause: safeCause,
      });
      throw new HttpError(502, "O Mercado Pago não conseguiu gerar a conta de teste. Consulte os logs seguros da função.", "MP_REQUISICAO_RECUSADA");
    }

    const email = typeof payload.email === "string" ? payload.email : "";
    const id = typeof payload.id === "string" || typeof payload.id === "number"
      ? payload.id
      : null;

    if (!email || id === null) {
      console.warn("[gerar-conta-teste] Resposta sem os campos esperados", {
        httpStatus: response.status,
        possuiEmail: Boolean(email),
        possuiId: id !== null,
      });
      throw new HttpError(502, "A resposta do Mercado Pago não trouxe ID e e-mail esperados.", "RESPOSTA_INVALIDA");
    }

    // Nunca registrar o token, cabeçalhos, senha ou corpo integral da API.
    console.info("[gerar-conta-teste] conta de teste criada", {
      id,
      email,
      site_id: "MLB",
      httpStatus: response.status,
    });

    return jsonResponse(req, {
      status: "OK",
      mensagem: "Conta de teste criada. Guarde o e-mail e atualize MP_TEST_PAYER_EMAIL.",
      conta: { id, email, site_id: "MLB" },
    });
  } catch (error) {
    return errorResponse(req, error);
  }
});
