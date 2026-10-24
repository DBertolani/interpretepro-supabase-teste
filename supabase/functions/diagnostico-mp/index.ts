import { errorResponse, HttpError, jsonResponse, preflightResponse } from "../_shared/http.ts";
import { authenticatedUser, requireEmail } from "../_shared/supabase.ts";

// Diagnóstico temporário, somente leitura: consulta a identidade e não cria ordens/pagamentos.
const MP_IDENTITY_URL = "https://api.mercadolibre.com/users/me";

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

    // Normaliza espaços acidentais; nunca registrar nem devolver o token.
    const token = (Deno.env.get("MP_ACCESS_TOKEN") ?? "").trim();
    if (!token) {
      throw new HttpError(503, "Credencial do Mercado Pago não configurada.", "CONFIGURACAO");
    }

    console.info("[diagnostico-mp] consultando identidade da credencial", {
      host: "api.mercadolibre.com",
      path: "/users/me",
    });

    let response: Response;
    try {
      response = await fetch(MP_IDENTITY_URL, {
        method: "GET",
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      console.error("[diagnostico-mp] falha de rede/timeout", {
        tipo: error instanceof Error ? error.name : typeof error,
      });
      throw new HttpError(503, "Não foi possível consultar a identidade no Mercado Pago.", "MP_INDISPONIVEL");
    }

    console.info("[diagnostico-mp] resposta HTTP", {
      status: response.status,
      ok: response.ok,
    });

    if (!response.ok) {
      // Não registrar headers, token nem corpo completo da resposta externa.
      throw new HttpError(
        response.status >= 500 ? 503 : 502,
        response.status === 401 || response.status === 403
          ? "O Mercado Pago não aceitou a credencial para consultar a identidade."
          : "Não foi possível confirmar a identidade da credencial.",
        response.status === 401 || response.status === 403
          ? "MP_CREDENCIAL_RECUSADA"
          : "MP_IDENTIDADE_INDISPONIVEL",
      );
    }

    let identity: Record<string, unknown>;
    try {
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Formato inesperado");
      }
      identity = payload as Record<string, unknown>;
    } catch {
      throw new HttpError(502, "O Mercado Pago retornou uma resposta inválida.", "RESPOSTA_INVALIDA");
    }

    const id = typeof identity.id === "string" || typeof identity.id === "number"
      ? identity.id
      : null;
    const siteId = typeof identity.site_id === "string" ? identity.site_id : null;

    if (id === null || siteId === null) {
      console.warn("[diagnostico-mp] resposta sem campos de identidade esperados", {
        possuiId: id !== null,
        possuiSiteId: siteId !== null,
      });
      throw new HttpError(502, "O Mercado Pago não retornou os campos de identidade esperados.", "RESPOSTA_INVALIDA");
    }

    console.info("[diagnostico-mp] identidade confirmada", { id, site_id: siteId });
    return jsonResponse(req, {
      status: "OK",
      mensagem: "Credencial reconhecida. Nenhum pagamento foi criado.",
      conta: { id, site_id: siteId },
    });
  } catch (error) {
    return errorResponse(req, error);
  }
});
