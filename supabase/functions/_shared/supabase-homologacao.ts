import { backendClient } from "./supabase.ts";

// Server-only client. Never import this helper into browser code.
export function backendClientHomologacao() {
  // Every table and RPC operation uses the explicit custom schema.
  return backendClient().schema("homologacao");
}
