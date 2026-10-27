import type { User } from "https://esm.sh/@supabase/supabase-js@2";
import { HttpError } from "./http.ts";
import { requireEmail } from "./supabase.ts";

export type ModalityHomologacao = "pix" | "assinatura";

export function validateRequestKeyHomologacao(value: unknown): string {
  const key = String(value ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    throw new HttpError(400, "Chave de requisição inválida.", "CHAVE_INVALIDA");
  }
  return key;
}

export async function validateClientLinkHomologacao(db: any, user: User) {
  const email = requireEmail(user);
  const { data, error } = await db
    .from("clientes_teste")
    .select("id, email")
    .eq("email", email)
    .maybeSingle();

  if (error) {
    throw new HttpError(503, "Não foi possível validar o cliente fictício.", "CLIENTE_TESTE_VALIDACAO");
  }
  if (!data) {
    throw new HttpError(
      403,
      "Não há cliente fictício cadastrado para esta conta no ambiente de homologação.",
      "CLIENTE_TESTE_NAO_VINCULADO",
    );
  }
  return data;
}

export async function loadActivePlanHomologacao(db: any, planId: unknown) {
  const id = String(planId ?? "").trim();
  if (!id || id.length > 128) {
    throw new HttpError(400, "Selecione um plano de teste válido.", "PLANO_INVALIDO");
  }

  const { data, error } = await db
    .from("interpretepro_planos")
    .select("id, nome, meses, valor_total, ativo")
    .eq("id", id)
    .eq("ativo", true)
    .maybeSingle();

  if (error || !data) {
    throw new HttpError(400, "O plano de teste não existe ou está indisponível.", "PLANO_TESTE_INDISPONIVEL");
  }

  const meses = Number(data.meses);
  const valor = Number(data.valor_total);
  if (
    !String(data.nome ?? "").trim() ||
    !Number.isInteger(meses) || meses < 1 || meses > 120 ||
    !Number.isFinite(valor) || valor <= 0
  ) {
    throw new HttpError(400, "A configuração do plano de teste é inválida.", "PLANO_TESTE_CONFIG_INVALIDA");
  }

  return {
    id: String(data.id),
    nome: String(data.nome).trim(),
    meses,
    valor_total: Math.round(valor * 100) / 100,
  };
}

export async function getOrCreateOrderHomologacao(
  db: any,
  user: User,
  plan: { id: string; nome: string; meses: number; valor_total: number },
  modalidade: ModalityHomologacao,
  chave: string,
) {
  if (!user.id || !["pix", "assinatura"].includes(modalidade)) {
    throw new HttpError(400, "Dados da ordem de homologação inválidos.", "ORDEM_DADOS_INVALIDOS");
  }
  const email = requireEmail(user);

  const { data: existing, error: existingError } = await db
    .from("ordens_pagamento")
    .select("*")
    .eq("auth_user_id", user.id)
    .eq("chave_idempotencia", chave)
    .maybeSingle();

  if (existingError) {
    throw new HttpError(503, "Não foi possível consultar a ordem de teste.", "ORDEM_CONSULTA");
  }
  if (existing) {
    if (String(existing.plano_id) !== plan.id || existing.modalidade !== modalidade) {
      throw new HttpError(409, "A chave já está vinculada a outra operação de teste.", "CHAVE_REUTILIZADA");
    }
    if (["concluida", "cancelada", "expirada"].includes(String(existing.status))) {
      throw new HttpError(409, "A ordem de teste já foi encerrada. Use uma nova chave.", "ORDEM_ENCERRADA");
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
    modalidade,
    status: "criada",
    referencia_externa: "ordem:" + id,
    chave_idempotencia: chave,
  };

  const { data: created, error: createError } = await db
    .from("ordens_pagamento")
    .insert(payload)
    .select("*")
    .single();

  if (!createError && created) return created;

  // Resolve concorrência pela restrição única (auth_user_id, chave_idempotencia).
  const { data: raced, error: raceError } = await db
    .from("ordens_pagamento")
    .select("*")
    .eq("auth_user_id", user.id)
    .eq("chave_idempotencia", chave)
    .maybeSingle();

  if (!raceError && raced &&
      String(raced.plano_id) === plan.id &&
      raced.modalidade === modalidade) {
    return raced;
  }

  throw new HttpError(503, "Não foi possível registrar a ordem de teste.", "ORDEM_CRIACAO");
}

export async function updateOrderHomologacao(
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
    throw new HttpError(503, "Não foi possível atualizar a ordem de teste.", "ORDEM_ATUALIZACAO");
  }
  return data;
}

export function validateMpCheckoutUrlHomologacao(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new HttpError(502, "O Mercado Pago não retornou uma URL de checkout válida.", "MP_URL_INVALIDA");
  }

  const host = url.hostname.toLowerCase();
  const trustedHost = host === "mercadopago.com.br" ||
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
