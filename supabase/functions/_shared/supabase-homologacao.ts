import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { HttpError } from "./http.ts";
import { backendClient } from "./supabase.ts";

// This client is server-only. Do not import it into browser code.
export function backendClientHomologacao() {
  const db = backendClient();
  // Explicitly route all table and RPC operations through the custom schema.
  return db.schema("homologacao");
}

export function assertHomologacaoWebhookMethod(req: Request) {
  if (req.method !== "POST") {
    throw new HttpError(405, "Método não permitido.", "METODO_NAO_PERMITIDO");
  }
}
