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

  console.info("[loadActivePlan] iniciando consulta", {
    tabela: "interpretepro_planos",
    planoId: id,
    instante: new Date().toISOString(),
  });

  let resultado: any;
  try {
    resultado = await db
      .from("interpretepro_planos")
      .select("id, nome, meses, valor_total, ativo")
      .eq("id", id)
      .eq("ativo", true)
      .maybeSingle();

    console.info("[loadActivePlan] consulta concluída", {
      encontrouPlano: Boolean(resultado?.data),
      possuiErro: Boolean(resultado?.error),
      codigoErro: resultado?.error?.code ?? null,
    });
  } catch (error) {
    console.error("[loadActivePlan] exceção na consulta", {
      tipo: error instanceof Error ? error.name : typeof error,
      codigoErro: (error as { code?: string } | null)?.code ?? null,
    });
    throw error;
  }

  const { data, error } = resultado;

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
  let etapa = "validacao_inicial";

  try {
    console.info("[getOrCreateOrder] início", {
      possuiUser: Boolean(user),
      possuiUserId: Boolean(user?.id),
      possuiEmail: Boolean(user?.email),
      possuiPlanoId: Boolean(plan?.id),
      modalidade: modality,
      possuiChaveRequisicao: Boolean(requestKey),
    });

    if (!user?.id) {
      throw new HttpError(401, "Sessão inválida. Entre novamente.", "USUARIO_INVALIDO");
    }
    if (!plan?.id || !requestKey || !["pix", "assinatura"].includes(modality)) {
      throw new HttpError(400, "Dados da ordem de pagamento inválidos.", "ORDEM_DADOS_INVALIDOS");
    }

    etapa = "validar_email";
    const email = requireEmail(user);
    if (!email) {
      throw new HttpError(401, "A conta não possui um e-mail válido.", "EMAIL_INVALIDO");
    }

    etapa = "consultar_ordem_existente";
    console.info("[getOrCreateOrder] antes de consultar ordens_pagamento", {
      etapa,
      possuiUserId: Boolean(user.id),
      possuiChaveRequisicao: Boolean(requestKey),
    });

    const existingResult = await db
      .from("ordens_pagamento")
      .select("*")
      .eq("auth_user_id", user.id)
      .eq("chave_idempotencia", requestKey)
      .maybeSingle();

    const existing = existingResult?.data ?? null;
    const existingError = existingResult?.error ?? null;

    console.info("[getOrCreateOrder] consulta concluída", {
      etapa,
      encontrouOrdem: Boolean(existing),
      possuiErro: Boolean(existingError),
      codigoErro: existingError?.code ?? null,
    });

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
      console.info("[getOrCreateOrder] reutilizando ordem existente", {
        status: existing.status ?? null,
      });
      return existing;
    }

    etapa = "montar_ordem";
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

    etapa = "inserir_ordem";
    console.info("[getOrCreateOrder] antes de inserir em ordens_pagamento", {
      etapa,
      possuiId: Boolean(payload.id),
      possuiUserId: Boolean(payload.auth_user_id),
      possuiEmail: Boolean(payload.email_snapshot),
      possuiPlanoId: Boolean(payload.plano_id),
      modalidade: payload.modalidade,
      possuiValor: Number.isFinite(Number(payload.valor)),
    });

    const createResult = await db
      .from("ordens_pagamento")
      .insert(payload)
      .select("*")
      .single();

    const created = createResult?.data ?? null;
    const createError = createResult?.error ?? null;

    console.info("[getOrCreateOrder] inserção concluída", {
      etapa,
      criouOrdem: Boolean(created),
      possuiErro: Boolean(createError),
      codigoErro: createError?.code ?? null,
    });

    if (!createError && created) return created;

    etapa = "consultar_ordem_concorrente";
    console.info("[getOrCreateOrder] antes de consultar possível ordem concorrente", {
      etapa,
      possuiUserId: Boolean(user.id),
      possuiChaveRequisicao: Boolean(requestKey),
    });

    const raceResult = await db
      .from("ordens_pagamento")
      .select("*")
      .eq("auth_user_id", user.id)
      .eq("chave_idempotencia", requestKey)
      .maybeSingle();

    const raced = raceResult?.data ?? null;
    const raceError = raceResult?.error ?? null;

    console.info("[getOrCreateOrder] consulta concorrente concluída", {
      etapa,
      encontrouOrdem: Boolean(raced),
      possuiErro: Boolean(raceError),
      codigoErro: raceError?.code ?? null,
    });

    if (!raceError && raced) {
      if (String(raced.plano_id) === plan.id && raced.modalidade === modality) {
        return raced;
      }
      throw new HttpError(409, "A chave de requisição já está vinculada a outra operação.", "NOVA_TENTATIVA");
    }

    throw new HttpError(503, "Não foi possível registrar a ordem de pagamento.", "ORDEM_CRIACAO");
  } catch (error) {
    console.error("[getOrCreateOrder] falha", {
      etapa,
      tipo: error instanceof Error ? error.name : typeof error,
      codigo: error instanceof HttpError
        ? error.code ?? null
        : (error as { code?: string } | null)?.code ?? null,
      status: error instanceof HttpError ? error.status : null,
    });

    if (error instanceof HttpError) throw error;

    throw new HttpError(
      503,
      "Não foi possível processar a ordem de pagamento.",
      "ORDEM_PROCESSAMENTO",
    );
  }
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
