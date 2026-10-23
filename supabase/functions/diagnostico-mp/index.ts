import { errorResponse, HttpError, jsonResponse, preflightResponse } from "../_shared/http.ts";
import { mpRequest } from "../_shared/mercadopago.ts";
import { authenticatedUser, requireEmail } from "../_shared/supabase.ts";

// Diagnóstico temporário, somente leitura: não cria ordens nem pagamentos.
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

    if (!(Deno.env.get("MP_ACCESS_TOKEN") ?? "").trim()) {
      throw new HttpError(503, "Credencial do Mercado Pago não configurada.", "CONFIGURACAO");
    }

    console.info("[diagnostico-mp] consultando identidade da credencial");
    const identity = await mpRequest("/users/me", { method: "GET" });
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
