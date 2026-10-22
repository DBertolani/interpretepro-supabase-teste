import { HttpError } from "./http.ts";

const MP_API = "https://api.mercadopago.com";

function accessToken(): string {
  const token = (Deno.env.get("MP_ACCESS_TOKEN") ?? "").trim();
  if (!token) {
    throw new HttpError(
      500,
      "Configure MP_ACCESS_TOKEN nos Secrets da homologação.",
      "MP_ACCESS_TOKEN_AUSENTE",
    );
  }
  return token;
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
  try {
    response = await fetch(MP_API + path, {
      ...init,
      headers,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new HttpError(503, "Não foi possível confirmar a resposta do Mercado Pago. A ordem foi preservada para recuperação segura.", "MP_INDISPONIVEL");
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const status = response.status;
    // Não expor resposta completa da API ou dados de cobrança ao navegador.
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
