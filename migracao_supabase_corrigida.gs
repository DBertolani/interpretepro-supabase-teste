
/************************************************************
 * INTÉRPRETEPRO — MIGRAÇÃO GOOGLE SHEETS → SUPABASE
 *
 * 1. Testa a conexão com o Supabase.
 * 2. Lê a planilha Motor.
 * 3. Lê as planilhas da pasta DADOS_CLIENTES.
 * 4. Faz uma simulação antes de gravar.
 *
 * IMPORTANTE:
 * MODO_TESTE = true  → não grava dados.
 * MODO_TESTE = false → permite gravar dados.
 ************************************************************/

// ==========================================================
// 1. CONFIGURAÇÕES
// ==========================================================

const SUPABASE_URL = "https://bvavzgmsiflydrlgeiqf.supabase.co";

// Cole aqui a chave publicável (Publishable key) do projeto.
// Para gravações administrativas com RLS ativo, configure a chave secreta
// do Supabase em Apps Script > Configurações do projeto > Propriedades do script.
// Nome da propriedade: SUPABASE_MIGRATION_KEY. Nunca publique essa chave.
const SUPABASE_KEY = PropertiesService.getScriptProperties().getProperty("SUPABASE_MIGRATION_KEY")
  || "sb_publishable_IgTCeiytetM678AtADKUtQ_n3SL6akf";

const CONFIG_MIGRACAO = {
  MODO_TESTE: true,
  NOME_ABA_CLIENTES: "Clientes",
  NOME_PASTA_CLIENTES: "DADOS_CLIENTES"
};

// ==========================================================
// 2. TESTE DE CONEXÃO
// ==========================================================


function testarConexaoSupabase() {
  Logger.log("Testando acesso à tabela de clientes no Supabase...");

  var url = SUPABASE_URL + "/rest/v1/interpretepro_clientes?select=*&limit=1";

  var opcoes = {
    method: "get",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY
    },
    muteHttpExceptions: true
  };

  try {
    var resposta = UrlFetchApp.fetch(url, opcoes);
    var status = resposta.getResponseCode();

    Logger.log("Status HTTP: " + status);
    Logger.log("Resposta: " + resposta.getContentText());

    if (status >= 200 && status < 300) {
      Logger.log("Acesso à tabela confirmado.");
      return true;
    }

    Logger.log(
      "A conexão funciona, mas o acesso à tabela precisa ser verificado."
    );
    return false;

  } catch (erro) {
    Logger.log("Erro na solicitação: " + erro.message);
    return false;
  }
}


// ==========================================================
// 3. MIGRAÇÃO PRINCIPAL
// ==========================================================

// Migra APENAS a aba Minha_Equipe de cada planilha. Pode ser repetida sem
// duplicar nomes, pois usa a restrição UNIQUE (email_usuario, nome_interprete).
// Antes de gravar com MODO_TESTE=false, configure SUPABASE_MIGRATION_KEY
// com a chave secreta do projeto em Propriedades do script. Não use a chave
// secreta no código nem no GitHub.
function migrarSomenteEquipes() {
  Logger.log("========================================");
  Logger.log("MIGRAÇÃO SOMENTE DA EQUIPE");
  Logger.log("Modo de teste: " + CONFIG_MIGRACAO.MODO_TESTE);
  Logger.log("========================================");

  if (!CONFIG_MIGRACAO.MODO_TESTE) {
    var chaveConfigurada = PropertiesService.getScriptProperties()
      .getProperty("SUPABASE_MIGRATION_KEY");
    if (!chaveConfigurada) {
      throw new Error("Configure SUPABASE_MIGRATION_KEY nas Propriedades do script antes de gravar com RLS ativo.");
    }
  }

  var resumo = { lidos: 0, enviados: 0, simulados: 0, ignorados: 0, erros: 0 };
  var pastas = DriveApp.getFoldersByName(CONFIG_MIGRACAO.NOME_PASTA_CLIENTES);
  if (!pastas.hasNext()) throw new Error("Pasta DADOS_CLIENTES não encontrada.");
  var pasta = pastas.next();
  var arquivos = pasta.getFiles();

  while (arquivos.hasNext()) {
    var arquivo = arquivos.next();
    if (arquivo.getMimeType() !== MimeType.GOOGLE_SHEETS) continue;

    try {
      var emailCliente = extrairEmailDoNome(arquivo.getName());
      if (!emailCliente) {
        Logger.log("IGNORADO: sem e-mail no nome do arquivo " + arquivo.getName());
        resumo.ignorados++;
        continue;
      }

      var ssCliente = SpreadsheetApp.openById(arquivo.getId());
      var abas = ssCliente.getSheets();
      for (var a = 0; a < abas.length; a++) {
        var aba = abas[a];
        var nomeAba = String(aba.getName()).toLowerCase().replace(/\s+/g, "_");
        if (nomeAba !== "minha_equipe" && nomeAba !== "minha_equipe_") continue;
        if (aba.getLastRow() < 2) continue;

        var valores = aba.getDataRange().getValues();
        var cabecalho = valores[0].map(function(v) { return String(v || "").trim().toLowerCase(); });
        var idxNome = cabecalho.findIndex(function(c) {
          return c.includes("nome") || c.includes("intérprete") ||
            c.includes("interprete") || c.includes("membro");
        });
        if (idxNome < 0) {
          Logger.log("ERRO: coluna de nome não encontrada na aba " + aba.getName() +
            " do arquivo " + arquivo.getName());
          resumo.erros++;
          continue;
        }

        for (var r = 1; r < valores.length; r++) {
          var nome = textoSeguro(valores[r][idxNome]);
          if (!nome) { resumo.ignorados++; continue; }

          var payload = {
            email_usuario: normalizarEmail(emailCliente),
            nome_interprete: nome
          };
          resumo.lidos++;
          enviarParaSupabase(
            "interpretepro_equipe",
            payload,
            "email_usuario,nome_interprete",
            resumo
          );
        }
      }
    } catch (erro) {
      resumo.erros++;
      Logger.log("ERRO no arquivo " + arquivo.getName() + ": " + erro.message);
    }
  }

  Logger.log("Equipe lida: " + resumo.lidos);
  Logger.log("Equipe gravada: " + resumo.enviados);
  Logger.log("Simulações: " + resumo.simulados);
  Logger.log("Ignorados: " + resumo.ignorados);
  Logger.log("Erros: " + resumo.erros);
  if (CONFIG_MIGRACAO.MODO_TESTE) {
    Logger.log("SIMULAÇÃO: nenhum dado foi gravado.");
  }
}

// Migração completa original. ATENÇÃO: não execute com MODO_TESTE=false
// sobre tabelas já preenchidas; as tabelas operacionais não têm chave de
// conflito nesta rotina e podem receber duplicatas.
function migrarTudoParaSupabase() {
  Logger.log("========================================");
  Logger.log("INÍCIO DA MIGRAÇÃO INTÉRPRETEPRO");
  Logger.log("Modo de teste: " + CONFIG_MIGRACAO.MODO_TESTE);
  Logger.log("========================================");

  if (!testarConexaoSupabase()) {
    Logger.log(
      "MIGRAÇÃO INTERROMPIDA: não foi possível validar a API."
    );
    return;
  }

  var resumo = {
    lidos: 0,
    enviados: 0,
    simulados: 0,
    ignorados: 0,
    erros: 0
  };

  migrarClientesMotor(resumo);
  migrarDadosClientesNoDrive(resumo);

  Logger.log("========================================");
  Logger.log("RESUMO DA MIGRAÇÃO");
  Logger.log("Registros lidos: " + resumo.lidos);
  Logger.log("Registros enviados: " + resumo.enviados);
  Logger.log("Registros simulados: " + resumo.simulados);
  Logger.log("Registros ignorados: " + resumo.ignorados);
  Logger.log("Erros: " + resumo.erros);

  if (CONFIG_MIGRACAO.MODO_TESTE) {
    Logger.log(
      "SIMULAÇÃO CONCLUÍDA. Nenhum dado foi gravado."
    );
  } else if (resumo.erros > 0) {
    Logger.log(
      "MIGRAÇÃO FINALIZADA COM ERROS. Não considere todos os dados migrados."
    );
  } else {
    Logger.log(
      "Envios concluídos sem erros detectados. Faça a conferência no Supabase."
    );
  }

  Logger.log("========================================");
}

// ==========================================================
// 4. MIGRAR CLIENTES DA PLANILHA MOTOR
// ==========================================================

function migrarClientesMotor(resumo) {
  Logger.log("Lendo clientes da planilha Motor...");

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  if (!ss) {
    Logger.log(
      "ERRO: este script precisa estar vinculado à planilha Motor."
    );
    resumo.erros++;
    return;
  }

  var aba =
    ss.getSheetByName(CONFIG_MIGRACAO.NOME_ABA_CLIENTES) ||
    ss.getSheets()[0];

  if (!aba || aba.getLastRow() < 2) {
    Logger.log("Nenhum cliente encontrado na planilha Motor.");
    return;
  }

  var dados = aba.getDataRange().getValues();
  var cabecalho = dados[0].map(function(valor) {
    return String(valor).trim().toLowerCase();
  });

  var idxEmail = cabecalho.indexOf("email");
  var idxNome = cabecalho.indexOf("nome");
  var idxStatus = cabecalho.indexOf("status");
  var idxExp = cabecalho.indexOf("data expiração");
  var idxPlano = cabecalho.indexOf("plano");

  if (idxEmail === -1) {
    Logger.log(
      "ERRO: não encontrei a coluna 'Email' na aba " + aba.getName()
    );
    resumo.erros++;
    return;
  }

  for (var i = 1; i < dados.length; i++) {
    var linha = dados[i];
    var email = normalizarEmail(linha[idxEmail]);

    if (!email) {
      resumo.ignorados++;
      continue;
    }

    var payload = {
      email_usuario: email,
      nome: idxNome >= 0 ? textoSeguro(linha[idxNome]) : "",
      status: idxStatus >= 0
        ? textoSeguro(linha[idxStatus])
        : "Ativo",
      data_expiracao: idxExp >= 0
        ? formatarData(linha[idxExp])
        : null,
      plano: idxPlano >= 0
        ? textoSeguro(linha[idxPlano])
        : "Trial"
    };

    resumo.lidos++;

    // email_usuario precisa ter uma restrição UNIQUE
    // no Supabase para que o upsert funcione.
    enviarParaSupabase(
      "interpretepro_clientes",
      payload,
      "email_usuario",
      resumo
    );
  }
}

// ==========================================================
// 5. MIGRAR PLANILHAS DA PASTA DADOS_CLIENTES
// ==========================================================

function migrarDadosClientesNoDrive(resumo) {
  Logger.log("Procurando a pasta DADOS_CLIENTES...");

  var pastas = DriveApp.getFoldersByName(
    CONFIG_MIGRACAO.NOME_PASTA_CLIENTES
  );

  if (!pastas.hasNext()) {
    Logger.log(
      "ERRO: pasta '" +
      CONFIG_MIGRACAO.NOME_PASTA_CLIENTES +
      "' não encontrada."
    );
    resumo.erros++;
    return;
  }

  var pasta = pastas.next();

  if (pastas.hasNext()) {
    Logger.log(
      "ATENÇÃO: existem várias pastas com esse nome. " +
      "Será utilizada a primeira encontrada."
    );
  }

  var arquivos = pasta.getFiles();

  while (arquivos.hasNext()) {
    var arquivo = arquivos.next();

    // Ignora PDFs, documentos e outros arquivos.
    if (arquivo.getMimeType() !== MimeType.GOOGLE_SHEETS) {
      continue;
    }

    Logger.log("Processando: " + arquivo.getName());

    try {
      var ssCliente = SpreadsheetApp.openById(arquivo.getId());
      var emailCliente = extrairEmailDoNome(arquivo.getName());
      var abas = ssCliente.getSheets();

      if (!emailCliente) {
        Logger.log(
          "ATENÇÃO: não consegui extrair o e-mail do arquivo " +
          arquivo.getName()
        );
      }

      for (var j = 0; j < abas.length; j++) {
        var aba = abas[j];

        if (aba.getLastRow() < 2) {
          continue;
        }

        var dados = aba.getDataRange().getValues();
        var nomeAba = aba.getName();
        var tabela = identificarTabelaDestino(nomeAba);

        if (!tabela) {
          Logger.log("Aba ignorada: " + nomeAba);
          continue;
        }

        var cabecalho = dados[0];

        for (var k = 1; k < dados.length; k++) {
          var payload = mapearLinhaParaTabela(
            tabela,
            cabecalho,
            dados[k],
            emailCliente
          );

          if (!payload || !payload.email_usuario) {
            resumo.ignorados++;
            continue;
          }

          resumo.lidos++;

          // Sem chave única definida para estas tabelas,
          // cada POST pode criar uma nova linha.
          enviarParaSupabase(
            tabela,
            payload,
            null,
            resumo
          );
        }
      }
    } catch (erro) {
      resumo.erros++;
      Logger.log(
        "ERRO no arquivo " + arquivo.getName() +
        ": " + erro.message
      );
    }
  }
}

// ==========================================================
// 6. IDENTIFICAR TABELA DE DESTINO
// ==========================================================

function identificarTabelaDestino(nomeAba) {
  var nome = String(nomeAba).toLowerCase();

  if (nome.includes("registros") || nome.includes("gerais")) {
    return "interpretepro_registros_gerais";
  }

  if (nome.includes("minha_equipe") || nome.includes("minha equipe") || nome.includes("equipe")) {
    return "interpretepro_equipe";
  }

  if (nome.includes("finais")) {
    return "interpretepro_minhas_empresas_finais";
  }

  if (nome.includes("empresas")) {
    return "interpretepro_minhas_empresas";
  }

  if (
    nome.includes("serviço") ||
    nome.includes("servico") ||
    nome.includes("serviços") ||
    nome.includes("servicos")
  ) {
    return "interpretepro_tipos_servico";
  }

  if (nome.includes("clientes")) {
    return "interpretepro_minhas_empresas_finais";
  }

  return null;
}

// ==========================================================
// 7. EXTRAIR E-MAIL DO NOME DO ARQUIVO
// ==========================================================

function extrairEmailDoNome(nomeArquivo) {
  var regex =
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

  var match = String(nomeArquivo).match(regex);

  return match ? match[0].toLowerCase() : "";
}

// ==========================================================
// 8. MAPEAR COLUNAS DA PLANILHA PARA O SUPABASE
// ==========================================================

function mapearLinhaParaTabela(
  tabela,
  cabecalho,
  linha,
  emailFallback
) {
  var obj = {
    email_usuario: normalizarEmail(emailFallback)
  };

  for (var i = 0; i < cabecalho.length; i++) {
    var coluna = String(cabecalho[i])
      .trim()
      .toLowerCase();

    var valor = linha[i];

    if (valor === "" || valor === null || valor === undefined) {
      continue;
    }

    if (coluna.includes("email")) {
      obj.email_usuario = normalizarEmail(valor) || obj.email_usuario;
      continue;
    }

    if (tabela === "interpretepro_equipe") {
      if (
        coluna.includes("nome") ||
        coluna.includes("intérprete") ||
        coluna.includes("interprete") ||
        coluna.includes("membro")
      ) {
        obj.nome_interprete = textoSeguro(valor);
      }
    } else if (tabela === "interpretepro_registros_gerais") {
      if (coluna.includes("pagamento") && coluna.includes("data")) {
        obj.data_pgto = formatarData(valor);
      } else if (coluna.includes("data")) {
        obj.data_evento = formatarData(valor);
      } else if (coluna.includes("agência") || coluna.includes("agencia")) {
        obj.agencia_intermediaria = textoSeguro(valor);
      } else if (coluna.includes("empresa") || coluna.includes("cliente")) {
        obj.empresa_final = textoSeguro(valor);
      } else if (coluna.includes("início") || coluna.includes("inicio")) {
        obj.horario_inicio = textoSeguro(valor);
      } else if (coluna.includes("fim")) {
        obj.horario_fim = textoSeguro(valor);
      } else if (
        coluna.includes("intérprete") ||
        coluna.includes("interprete") ||
        coluna.includes("membro da equipe") ||
        coluna.includes("quem interpretou") ||
        coluna.includes("quem executou") ||
        coluna.includes("responsável pela interpretação")
      ) {
        obj.interprete = textoSeguro(valor);
      } else if (coluna.includes("tipo")) {
        obj.tipo_servico = textoSeguro(valor);
      } else if (coluna.includes("valor")) {
        obj.valor_servico = limparValorMonetario(valor);
      } else if (coluna.includes("obs")) {
        obj.observacao = textoSeguro(valor);
      } else if (coluna.includes("status")) {
        obj.status_pgto = textoSeguro(valor);
      }
    } else if (tabela === "interpretepro_minhas_empresas") {
      if (coluna.includes("nome") || coluna.includes("agência") || coluna.includes("agencia")) {
        obj.nome_agencia = textoSeguro(valor);
      } else if (coluna.includes("valor")) {
        obj.valor_hora = limparValorMonetario(valor);
      }
    } else if (tabela === "interpretepro_minhas_empresas_finais") {
      if (coluna.includes("nome") || coluna.includes("cliente")) {
        obj.nome_cliente = textoSeguro(valor);
      }
    } else if (tabela === "interpretepro_tipos_servico") {
      if (coluna.includes("tipo") || coluna.includes("serviço") || coluna.includes("servico")) {
        obj.tipo_servico = textoSeguro(valor);
      }
    }
  }

  return obj.email_usuario ? obj : null;
}

// ==========================================================
// 9. ENVIAR REGISTRO AO SUPABASE
// ==========================================================

function enviarParaSupabase(
  tabela,
  payload,
  colunaUnica,
  resumo
) {
  if (CONFIG_MIGRACAO.MODO_TESTE) {
    resumo.simulados++;
    Logger.log(
      "[SIMULAÇÃO] Tabela: " + tabela +
      " | E-mail: " + (payload.email_usuario || "(sem e-mail)")
    );
    return true;
  }

  var url = SUPABASE_URL + "/rest/v1/" + tabela;

  // Upsert somente quando a tabela possui uma coluna UNIQUE
  // compatível com o valor informado em colunaUnica.
  if (colunaUnica) {
    url += "?on_conflict=" + encodeURIComponent(colunaUnica);
  }

  var preferencias = colunaUnica
    ? "resolution=merge-duplicates,return=minimal"
    : "return=minimal";

  var opcoes = {
    method: "post",
    contentType: "application/json",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + SUPABASE_KEY,
      Prefer: preferencias
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    var resposta = UrlFetchApp.fetch(url, opcoes);
    var codigo = resposta.getResponseCode();

    if (codigo >= 200 && codigo < 300) {
      resumo.enviados++;
      return true;
    }

    resumo.erros++;

    Logger.log(
      "ERRO ao enviar para " + tabela +
      " | HTTP " + codigo +
      " | Resposta: " +
      resposta.getContentText().substring(0, 1000)
    );

    return false;

  } catch (erro) {
    resumo.erros++;

    Logger.log(
      "FALHA DE CONEXÃO para " + tabela +
      ": " + erro.message
    );

    return false;
  }
}

// ==========================================================
// 10. FUNÇÕES AUXILIARES
// ==========================================================

function normalizarEmail(valor) {
  if (valor === null || valor === undefined) {
    return "";
  }

  return String(valor).trim().toLowerCase();
}

function textoSeguro(valor) {
  if (valor === null || valor === undefined) {
    return "";
  }

  return String(valor).trim();
}

function limparValorMonetario(valor) {
  if (typeof valor === "number") {
    return valor;
  }

  if (valor === null || valor === undefined || valor === "") {
    return 0;
  }

  var limpo = String(valor)
    .replace(/R\$/gi, "")
    .replace(/\s/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");

  var numero = parseFloat(limpo);

  return isNaN(numero) ? 0 : numero;
}

function formatarData(valor) {
  if (valor === null || valor === undefined || valor === "") {
    return null;
  }

  if (valor instanceof Date && !isNaN(valor.getTime())) {
    return Utilities.formatDate(
      valor,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd"
    );
  }

  var data = new Date(valor);

  if (!isNaN(data.getTime())) {
    return Utilities.formatDate(
      data,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd"
    );
  }

  Logger.log("ATENÇÃO: data não reconhecida: " + valor);
  return null;
}