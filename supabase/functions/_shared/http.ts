const ALLOWED_ORIGINS = new Set([
  "https://dbertolani.github.io",
  "http://127.0.0.1:5500",
]);

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("origin") ?? "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, apikey, content-type, x-client-info",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };

  if (ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

export function jsonResponse(
  req: Request,
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function preflightResponse(req: Request): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(req),
  });
}

export function errorResponse(req: Request, error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonResponse(
      req,
      { status: "Erro", codigo: error.code ?? "REQUISICAO_INVALIDA", mensagem: error.message },
      error.status,
    );
  }

  // Não retornar corpos brutos de provedores, tokens ou detalhes internos.
  return jsonResponse(
    req,
    { status: "Erro", codigo: "ERRO_INTERNO", mensagem: "Não foi possível concluir a operação. Tente novamente." },
    500,
  );
}
