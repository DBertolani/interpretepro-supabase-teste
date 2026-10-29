import { HttpError } from "./http.ts";

const MP_API = "https://api.mercadopago.com";

function testAccessToken(): string {
  const rawToken = Deno.env.get("MP_TEST_ACCESS_TOKEN") ?? "";
  const token = rawToken.trim();

  // Diagnóstico seguro: não registrar nenhum caractere do segredo.
  console.info("[mp-homologacao] diagnóstico da credencial", {
    length: token.length,
    prefixType: token.startsWith("TEST-")
      ? "TEST-"
      : token.startsWith("APP_USR-")
      ? "APP_USR-"
      : "DESCONHECIDO",
    hasLeadingOrTrailingWhitespace: rawToken !== token,
    configured: rawToken.length > 0,
  });

  // O Mercado Pago pode fornecer credenciais de teste com prefixo APP_USR-.
  // Como esse prefixo também pode aparecer em credenciais de produção, só o
  // aceitamos após confirmação explícita da origem no painel de testes.
  // A confirmação é uma barreira operacional; não substitui a verificação humana.
  const testConfirmation = Deno.env.get("MP_TEST_CREDENTIALS_CONFIRMED") ?? "";
  const prefixoAceito = token.startsWith("TEST-") || token.startsWith("APP_USR-");
  if (!prefixoAceito || testConfirmation !== "true") {
    throw new HttpError(
      500,
      "Configure uma credencial verificada de teste (TEST- ou APP_USR-) e MP_TEST_CREDENTIALS_CONFIRMED=true.",
      "MP_TEST_CREDENCIAL_INVALIDA",
    );
  }
  return token;
}

export function webhookUrlHomologacao(): string {
  const value = Deno.env.get("MP_TEST_NOTIFICATION_URL") ?? "";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(500, "Configure MP_TEST_NOTIFICATION_URL para o webhook de homologação.", "MP_TEST_WEBHOOK_URL_AUSENTE");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "bvavzgmsiflydrlgeiqf.supabase.co" ||
    parsed.pathname !== "/functions/v1/webhook-mercadopago-homologacao" ||
    parsed.search
  ) {
    throw new HttpError(500, "MP_TEST_NOTIFICATION_URL deve apontar exclusivamente para o webhook de homologação.", "MP_TEST_WEBHOOK_URL_INVALIDA");
  }
  return parsed.toString();
}

export function backUrlHomologacao(): string {
  return "https://dbertolani.github.io/interpretepro-supabase-teste/";
}

export async function mpRequestHomologacao(
  path: string,
  init: RequestInit = {},
): Promise<Record<string, any>> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new HttpError(400, "Caminho de recurso do Mercado Pago inválido.", "MP_PATH_INVALIDO");
  }
  const token = testAccessToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", "Bearer " + token);
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
    throw new HttpError(503, "Não foi possível confirmar a resposta do Mercado Pago de teste.", "MP_TEST_INDISPONIVEL");
  }

  const text = await response.text();
  let payload: Record<string, any> = {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, any>;
    }
  } catch {
    // Keep non-JSON provider errors generic.
  }

  if (!response.ok) {
    // Registrar campos diagnósticos retornados pelo MP, sem despejar o body inteiro
    // (que pode conter dados pessoais ou valores sensíveis).
    const sanitizeProviderText = (value: unknown, max = 300): string | null => {
      if (typeof value !== "string") return null;
      return value
        .replace(/Bearer\s+[^\s"'\\]+/gi, "Bearer [REDACTED]")
        .replace(/TEST-[A-Za-z0-9_-]+/g, "[MP_TEST_TOKEN_REDACTED]")
        .replace(/APP_USR-[A-Za-z0-9_-]+/g, "[MP_ACCESS_TOKEN_REDACTED]")
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL_REDACTED]")
        .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT_REDACTED]")
        .slice(0, max);
    };
    const causes = Array.isArray(payload.cause)
      ? payload.cause.slice(0, 10).map((item: unknown) => {
        if (!item || typeof item !== "object") return { value: sanitizeProviderText(String(item)) };
        const cause = item as Record<string, unknown>;
        return {
          code: sanitizeProviderText(cause.code, 100),
          description: sanitizeProviderText(cause.description, 300),
          data: sanitizeProviderText(cause.data, 200),
        };
      })
      : [];
    console.warn("[mp-homologacao] requisição recusada", {
      path,
      httpStatus: response.status,
      requestId: response.headers.get("x-request-id") ?? response.headers.get("x-correlation-id"),
      providerError: sanitizeProviderText(payload.error, 150),
      providerMessage: sanitizeProviderText(payload.message, 300),
      providerStatus: sanitizeProviderText(payload.status, 100),
      providerCause: causes,
      bodyIsJsonObject: Object.keys(payload).length > 0,
      bodyLength: text.length,
    });
    throw new HttpError(
      response.status >= 500 ? 503 : 502,
      response.status >= 500
        ? "O Mercado Pago de teste está temporariamente indisponível."
        : "O Mercado Pago recusou a solicitação de teste. Confira os dados de sandbox.",
      response.status >= 500 ? "MP_TEST_INDISPONIVEL" : "MP_TEST_REQUISICAO_RECUSADA",
    );
  }
  return payload;
}

export async function validarAssinaturaWebhookHomologacao(
  req: Request,
  dataId: string,
): Promise<boolean> {
  const secret = (Deno.env.get("MP_TEST_WEBHOOK_SECRET") ?? "").trim();
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
