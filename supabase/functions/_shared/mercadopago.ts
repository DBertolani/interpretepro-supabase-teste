import { HttpError } from "./http.ts";

const MP_API = "https://api.mercadopago.com";

function accessToken(): string {
  // A credencial é configurada pelo responsável nos Secrets do projeto.
  // Não validar prefixo nem registrar o conteúdo do token.
  return Deno.env.get("MP_ACCESS_TOKEN") ?? "";
}

export function webhookUrl(): string {
  const value = Deno.env.get("MP_NOTIFICATION_URL") ?? "";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(500, "Configure MP_NOTIFICATION_URL para a Edge Function de homologação.", "MP_WEBHOOK_URL_AUSENTE");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "bvavzgmsiflydrlgeiqf.supabase.co" ||
    parsed.pathname !== "/functions/v1/webhook-mercadopago"
  ) {
    throw new HttpError(500, "MP_NOTIFICATION_URL deve apontar somente para o webhook do projeto de homologação.", "MP_WEBHOOK_URL_INVALIDA");
  }
  return parsed.toString();
}

export function backUrl(): string {
  // Retorno exclusivo para o frontend de homologação; nunca redirecionar à produção.
  return "https://dbertolani.github.io/interpretepro-supabase-teste/";
}

export async function mpRequest(
  path: string,
  init: RequestInit = {},
): Promise<Record<string, any>> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Bearer " + accessToken());
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");

  let response: Response;
  console.info("[mpRequest] iniciando chamada", { path, method: init.method ?? "GET" });
  try {
    response = await fetch(MP_API + path, {
      ...init,
      headers,
      signal: AbortSignal.timeout(15000),
    });
    console.info("[mpRequest] resposta HTTP recebida", {
      path,
      status: response.status,
      ok: response.ok,
    });
  } catch (error) {
    console.error("[mpRequest] falha de rede/timeout", {
      path,
      tipo: error instanceof Error ? error.name : typeof error,
    });
    throw new HttpError(503, "Não foi possível confirmar a resposta do Mercado Pago. A ordem foi preservada para recuperação segura.", "MP_INDISPONIVEL");
  }

  const responseText = await response.text();
  let payload: Record<string, any> = {};
  try {
    const parsed = JSON.parse(responseText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, any>;
    }
  } catch {
    // Respostas não-JSON não devem impedir o tratamento seguro do erro HTTP.
  }

  if (!response.ok) {
    const status = response.status;

    // Registrar somente campos de diagnóstico selecionados; nunca headers,
    // token, e-mail, payload enviado ou corpo completo da resposta.
    const safeCause = Array.isArray(payload.cause)
      ? payload.cause.slice(0, 10).map((item: unknown) => {
        const cause = item && typeof item === "object"
          ? item as Record<string, unknown>
          : {};
        return {
          code: typeof cause.code === "string" || typeof cause.code === "number"
            ? cause.code
            : null,
          description: typeof cause.description === "string"
            ? cause.description.slice(0, 300)
            : null,
        };
      })
      : [];

    console.info("[mpRequest] detalhe seguro do erro Mercado Pago", {
      path,
      httpStatus: status,
      message: typeof payload.message === "string" ? payload.message.slice(0, 500) : null,
      error: typeof payload.error === "string" ? payload.error.slice(0, 200) : null,
      status: typeof payload.status === "string" || typeof payload.status === "number"
        ? payload.status
        : null,
      cause: safeCause,
    });

    // O detalhe fica nos logs do servidor; a resposta ao frontend permanece genérica.
    throw new HttpError(
      status >= 500 ? 503 : 502,
      status >= 500
        ? "O Mercado Pago está temporariamente indisponível."
        : "O Mercado Pago recusou a solicitação. Confira a configuração de teste.",
      status >= 500 ? "MP_INDISPONIVEL" : "MP_REQUISICAO_RECUSADA",
    );
  }

  return payload as Record<string, any>;
}

export async function validarAssinaturaWebhook(
  req: Request,
  dataId: string,
): Promise<boolean> {
  const secret = Deno.env.get("MP_WEBHOOK_SECRET") ?? "";
  const signature = req.headers.get("x-signature") ?? "";
  const requestId = req.headers.get("x-request-id") ?? "";

  if (!secret || !signature || !requestId || !dataId) return false;

  const fields = Object.fromEntries(
    signature.split(",").map((part) => {
      const idx = part.indexOf("=");
      return idx > 0
        ? [part.slice(0, idx).trim(), part.slice(idx + 1).trim()]
        : ["", ""];
    }).filter(([key]) => key),
  );

  const ts = fields.ts;
  const receivedV1 = fields.v1;
  if (!ts || !receivedV1 || !/^[a-f0-9]{64}$/i.test(receivedV1)) return false;

  // Manifesto HMAC documentado pelo Mercado Pago.
  const manifest = "id:" + dataId.toLowerCase() +
    ";request-id:" + requestId +
    ";ts:" + ts + ";";

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(manifest),
  );
  const expected = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  if (expected.length !== receivedV1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ receivedV1.toLowerCase().charCodeAt(i);
  }
  return diff === 0;
}