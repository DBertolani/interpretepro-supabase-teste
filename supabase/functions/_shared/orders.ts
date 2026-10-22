import type { User } from "https://esm.sh/@supabase/supabase-js@2";
import { HttpError } from "./http.ts";
import { requireEmail } from "./supabase.ts";

export type Modality = "pix" | "assinatura";

export function validateRequestKey(value: unknown): string {
  const key = String(value ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    throw new HttpError(400, "Chave de requisição inválida.", "CHAVE_INVALIDA");
  }
  return key;
}

export async function loadActivePlan(db: any, planId: unknown) {
  const id = String(planId ?? "").trim();
  console.info("[loadActivePlan] planoId recebido:", id || "(vazio)");

  if (!id || id.length > 128) {
    throw new HttpError(400, "Selecione um plano válido.", "PLANO_INVALIDO");
  }

  const { data, error } = await db
    .from("interpretepro_planos")
    .select("id, nome, meses, valor_total, ativo")
    .eq("id", id)
    .eq("ativo", true)
    .maybeSingle();

  if (error || !data) {
    throw new HttpError(400, "O plano não existe ou está indisponível.", "PLANO_INDISPONIVEL");
  }

  const months = Number(data.meses);
  const amount = Number(data.valor_total);
  // Validação temporariamente simplificada para diagnosticar a configuração do plano.
  // Mantém os bloqueios mínimos contra nome, duração ou preço ausentes/inválidos.
  const cents = Math.round(amount * 100);
  const validName = Boolean(String(data.nome ?? "").trim());
  const validMonths =
    Number.isInteger(months) && months >= 1 && months <= 120;
  const validAmount = Number.isFinite(amount) && amount > 0;

  if (!validName || !validMonths || !validAmount) {
    console.error("[loadActivePlan] PLANO_CONFIG_INVALIDA", {
      id: String(data.id),
      validName,
      validMonths,
      validAmount,
      mesesRecebido: data.meses,
      valorTotalRecebido: data.valor_total,
    });

    throw new HttpError(
      400,
      "A configuração do plano é inválida.",
      "PLANO_CONFIG_INVALIDA",
    );
  }

  return {
    id: String(data.id),
    nome: String(data.nome).trim(),
    meses: months,
    valor_total: cents / 100,
  };
}

export async function validateClientLink(db: any, user: User) {
  const { data, error } = await db
    .from("interpretepro_clientes")
    .select("auth_user_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (error) {
    throw new HttpError(503, "Não foi possível validar o vínculo do cliente.", "CLIENTE_VALIDACAO");
  }
  if (!data) {
    throw new HttpError(403, "A conta não possui um vínculo de cliente válido.", "CLIENTE_NAO_VINCULADO");
  }
}

export async function getOrCreateOrder(
  db: any,
  user: User,
  plan: { id: string; nome: string; meses: number; valor_total: number },
  modality: Modality,
  requestKey: string,
) {
  const email = requireEmail(user);

  const { data: existing, error: existingError } = await db
    .from("ordens_pagamento")
    .select("*")
    .eq("auth_user_id", user.id)
    .eq("chave_idempotencia", requestKey)
    .maybeSingle();

  if (existingError) {
    throw new HttpError(503, "Não foi possível consultar a ordem de pagamento.", "ORDEM_CONSULTA");
  }

  if (existing) {
    if (
      String(existing.plano_id) !== plan.id ||
      existing.modalidade !== modality
    ) {
      throw new HttpError(409, "A chave de requisição já está vinculada a outra operação.", "NOVA_TENTATIVA");
    }
    if (["concluida", "cancelada", "expirada"].includes(existing.status)) {
      throw new HttpError(409, "Esta ordem já foi encerrada. Inicie uma nova solicitação.", "NOVA_TENTATIVA");
    }
    return existing;
  }

  const id = crypto.randomUUID();
  const payload = {
    id,
    auth_user_id: user.id,
    email_snapshot: email,
    plano_id: plan.id,
    plano_nome_snapshot: plan.nome,
    plano_meses_snapshot: plan.meses,
    valor: plan.valor_total,
    moeda: "BRL",
    modalidade: modality,
    status: "criada",
    referencia_externa: "ordem:" + id,
    chave_idempotencia: requestKey,
  };

  const { data: created, error: createError } = await db
    .from("ordens_pagamento")
    .insert(payload)
    .select("*")
    .single();

  if (!createError && created) return created;

  // Concorrência: se outra chamada inseriu a mesma chave, reutilizar a ordem.
  const { data: raced, error: raceError } = await db
    .from("ordens_pagamento")
    .select("*")
    .eq("auth_user_id", user.id)
    .eq("chave_idempotencia", requestKey)
    .maybeSingle();

  if (!raceError && raced) {
    if (String(raced.plano_id) === plan.id && raced.modalidade === modality) return raced;
    throw new HttpError(409, "A chave de requisição já está vinculada a outra operação.", "NOVA_TENTATIVA");
  }

  throw new HttpError(503, "Não foi possível registrar a ordem de pagamento.", "ORDEM_CRIACAO");
}

export async function updateOrder(
  db: any,
  orderId: string,
  updates: Record<string, unknown>,
) {
  const { data, error } = await db
    .from("ordens_pagamento")
    .update({ ...updates, atualizado_em: new Date().toISOString() })
    .eq("id", orderId)
    .select("*")
    .single();

  if (error || !data) {
    throw new HttpError(503, "Não foi possível atualizar a ordem de pagamento.", "ORDEM_ATUALIZACAO");
  }
  return data;
}

export function validateMpCheckoutUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new HttpError(502, "O Mercado Pago não retornou uma URL de checkout válida.", "MP_URL_INVALIDA");
  }

  const host = url.hostname.toLowerCase();
  const trustedHost =
    host === "mercadopago.com.br" ||
    host.endsWith(".mercadopago.com.br") ||
    host === "mercadopago.com" ||
    host.endsWith(".mercadopago.com") ||
    host === "mercadolibre.com" ||
    host.endsWith(".mercadolibre.com");

  if (url.protocol !== "https:" || !trustedHost) {
    throw new HttpError(502, "A URL de checkout retornada não é confiável.", "MP_URL_INVALIDA");
  }
  return url.toString();
}
