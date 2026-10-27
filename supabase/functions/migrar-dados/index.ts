import { createClient } from "npm:@supabase/supabase-js@2";

const tabelasPermitidas = new Set([
  "interpretepro_clientes",
  "interpretepro_registros_gerais",
  "interpretepro_minhas_empresas",
  "interpretepro_minhas_empresas_finais",
  "interpretepro_tipos_servico",
  "interpretepro_equipe",
]);

const colunasUnicasPermitidas: Record<string, string> = {
  interpretepro_clientes: "email",
  interpretepro_registros_gerais: "chave_origem",
  interpretepro_minhas_empresas: "chave_origem",
  interpretepro_minhas_empresas_finais: "chave_origem",
  interpretepro_tipos_servico: "chave_origem",
  interpretepro_equipe: "email_usuario,nome_interprete",
};

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Método não permitido", { status: 405 });
  }

  const segredo = Deno.env.get("MIGRATION_SECRET");
  const segredoRecebido = req.headers.get("x-migration-secret");

  if (!segredo || !segredoRecebido || segredoRecebido !== segredo) {
    return Response.json(
      { erro: "Não autorizado" },
      { status: 401 }
    );
  }

  try {
    const { tabela, payload, colunaUnica, ignoreDuplicates } = await req.json();

    if (tabela === "__teste__") {
      return Response.json({
        sucesso: true,
        mensagem: "Função acessível e segredo validado. Nenhum dado foi gravado."
      });
    }

    if (!tabelasPermitidas.has(tabela)) {
      return Response.json(
        { erro: "Tabela não permitida" },
        { status: 400 }
      );
    }

    if (colunaUnica !== colunasUnicasPermitidas[tabela]) {
      return Response.json(
        { erro: "Coluna de conflito inválida" },
        { status: 400 }
      );
    }

    const colunasConflito = String(colunaUnica)
      .split(",")
      .map((coluna) => coluna.trim())
      .filter(Boolean);

    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      colunasConflito.length === 0 ||
      !colunasConflito.every((coluna) =>
        Object.hasOwn(payload, coluna) &&
        payload[coluna] != null &&
        String(payload[coluna]).trim() !== ""
      )
    ) {
      return Response.json(
        { erro: "Dados inválidos ou chave ausente" },
        { status: 400 }
      );
    }

    const url = Deno.env.get("SUPABASE_URL");
    const chave = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!url || !chave) {
      throw new Error("Configuração administrativa ausente no servidor");
    }

    const supabase = createClient(url, chave, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { error } = await supabase
      .from(tabela)
      .upsert(payload, {
        onConflict: colunaUnica,
        ignoreDuplicates: Boolean(ignoreDuplicates)
      });

    if (error) {
      console.error("Erro de gravação:", tabela, error.message);

      return Response.json(
        { erro: "Falha ao gravar registro", detalhe: error.message },
        { status: 500 }
      );
    }

    return Response.json({ sucesso: true });
  } catch (erro) {
    console.error("Erro na função:", erro);

    return Response.json(
      { erro: "Falha no processamento da solicitação" },
      { status: 500 }
    );
  }
});
