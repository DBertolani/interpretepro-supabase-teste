var dadosFiltradosAtuais = [];
var agenciasGlobais = [], dadosPagosGlobais = [], historicoGlobal = [], equipeGlobal = [], clientesGlobais = [], tiposServicoGlobal = [];
var dadosGeraisRelatorio = [];
let ordemDataHistorico = 'desc';
let origemNavegacao = 'dash';
const servicoCache = new Map();

// --- 1. CONFIGURAÇÃO DA PONTE ---
// const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxLC1WJjrWUPQnUVyonMScINtlwj-VRiPU5aBIxc7kbAnVmI7o_bSR2peINpnPysY0/exec"; // TESTE
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxbYi7t7TjEi0TX750IzWDwy5QGBXKIqcRAOZ8ZLEvMHwqvoyIT_4jfrE2vFSU2EU16/exec"; // PROD

async function chamarGoogle(acao, dadosExtras = {}) {
  const email = localStorage.getItem("user_email");
  try {
    const response = await fetch(SCRIPT_URL, {
      method: "POST",
      body: JSON.stringify({ acao, email, dados: dadosExtras })
    });
    return await response.json();
  } catch (erro) {
    console.error("Erro na chamada Google:", erro);
    mostrarToast("❌ Erro de conexão com o servidor", "erro");
    throw erro;
  }
}

// --- 2. DETECÇÃO DE CONEXÃO OFFLINE ---
window.addEventListener('offline', () => {
  const barra = document.getElementById('barra-offline');
  if (barra) barra.style.display = 'block';
});
window.addEventListener('online', () => {
  const barra = document.getElementById('barra-offline');
  if (barra) barra.style.display = 'none';
});

// --- 2.1 PWA (INSTALACAO + SERVICE WORKER) ---
let deferredInstallPrompt = null;

function atualizarVisibilidadeBotaoPWA(mostrar) {
  const botao = document.getElementById('btn-instalar-app');
  if (!botao) return;
  botao.style.display = mostrar ? 'block' : 'none';
}

function appJaInstalado() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

async function instalarAplicativo() {
  if (!deferredInstallPrompt) {
    mostrarToast("ℹ️ Instalação indisponível neste navegador/dispositivo.", "info");
    return;
  }

  deferredInstallPrompt.prompt();
  const escolha = await deferredInstallPrompt.userChoice;
  if (escolha && escolha.outcome === 'accepted') {
    mostrarToast("✅ Instalação iniciada com sucesso!", "sucesso");
  }
  deferredInstallPrompt = null;
  atualizarVisibilidadeBotaoPWA(false);
}

function inicializarPWA() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js')
        .catch((erro) => console.error('Erro ao registrar service worker:', erro));
    });
  }

  if (appJaInstalado()) {
    atualizarVisibilidadeBotaoPWA(false);
  }

  window.addEventListener('beforeinstallprompt', (evento) => {
    evento.preventDefault();
    deferredInstallPrompt = evento;
    atualizarVisibilidadeBotaoPWA(true);
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    atualizarVisibilidadeBotaoPWA(false);
    mostrarToast("🎉 IntérpretePro instalado no seu dispositivo!", "sucesso");
  });
}

// --- 3. UTILITÁRIOS ---
function formatarMoeda(e) {
  var v = e.value.replace(/\D/g, ''); if (v === "") return;
  v = (v / 100).toFixed(2) + ''; v = v.replace(".", ","); v = v.replace(/(\d)(\d{3})(?=\,)/g, "$1.$2");
  e.value = v;
}

function converterParaFloat(t) {
  if (!t) return 0;
  if (typeof t === 'number') return t;
  let val = String(t).trim().replace("R$", "").trim();
  if (val.includes(",") && val.includes(".")) return parseFloat(val.replace(/\./g, "").replace(",", "."));
  if (val.includes(",")) return parseFloat(val.replace(",", "."));
  return parseFloat(val) || 0;
}

function extrairMesAno(dataStr) {
  if (!dataStr) return "";
  if (dataStr.includes("-")) return dataStr.substring(0, 7);
  if (dataStr.includes("/")) {
    var partes = dataStr.split("/");
    if (partes.length === 3) return partes[2] + "-" + partes[1];
  }
  return "";
}

function mudarAba(aba) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('btn-tab-' + aba).classList.add('active');
  document.getElementById('content-' + aba).classList.add('active');
}

// --- 4. NAVEGAÇÃO E PORTARIA ---
// Adia a transição visual por dois frames para separar o frame atual do próximo layout.
function executarAposDoisFrames(callback) {
  requestAnimationFrame(() => {
    requestAnimationFrame(callback);
  });
}

function validarPortaria(resposta) {
  if (resposta && resposta.liberado === true) {
    localStorage.setItem("user_plano", resposta.plano || "Ativo");
    localStorage.setItem("user_validade", resposta.validade || "Sem data limite");
    montarApp(resposta.dadosIniciais);

  } else if (resposta && resposta.isNovo === true) {
    executarAposDoisFrames(() => {
      const loading = document.getElementById('tela-loading');
      const telaLogin = document.getElementById('tela-login-google');
      const telaTrial = document.getElementById('tela-trial');

      if (loading) loading.style.display = 'none';
      if (telaLogin) telaLogin.style.display = 'none';
      if (telaTrial) telaTrial.style.display = 'flex';
    });

  } else {
    const btnPagar = document.getElementById('btn-pagar');
    if (btnPagar) btnPagar.style.display = 'block';

    const emailEl = document.getElementById('email-bloqueado');
    const motivoEl = document.getElementById('motivo-bloqueio');

    if (emailEl) emailEl.innerText = (resposta && resposta.email) || "não identificado";
    if (motivoEl) motivoEl.innerText = (resposta && resposta.motivo) || "E-mail sem licença ativa.";

    executarAposDoisFrames(() => {
      const loading = document.getElementById('tela-loading');
      const telaBloq = document.getElementById('tela-bloqueio');

      if (loading) loading.style.display = 'none';
      if (telaBloq) telaBloq.style.display = 'flex';
    });
  }
}

async function acessarModoLeitura() {
  document.getElementById('tela-bloqueio').style.display = 'none';
  document.getElementById('tela-loading').style.display = 'flex';
  localStorage.setItem("user_plano", "Vencido");
  localStorage.setItem("user_validade", "Expirado");
  try {
    const res = await chamarGoogle("carregarDadosIniciais");
    if (res && res.dados) {
      montarApp(res.dados);
      mostrarToast("⚠️ Modo Somente Leitura Ativado", "erro");
    } else {
      let msgErro = "Servidor bloqueou os dados.";
      if (res && res.mensagem) msgErro = res.mensagem;
      if (res && res.motivo) msgErro = res.motivo;
      mostrarToast("❌ " + msgErro, "erro");
      throw new Error(msgErro);
    }
  } catch (err) {
    document.getElementById('tela-loading').style.display = 'none';
    document.getElementById('tela-bloqueio').style.display = 'flex';
    document.getElementById('atalho-feedback-fixo').style.display = 'block';
  }
}

async function voltarDashboard() {
  esconderTodasTelas();
  document.getElementById('tela-app').style.display = 'block';
  document.getElementById('valor-pendente').innerText = "⏳ Atualizando...";
  const divDetalhes = document.getElementById('pendente-detalhado');
  if (divDetalhes) divDetalhes.innerHTML = "";
  const res = await chamarGoogle("carregarDadosIniciais");
  if (res && res.dados) {
    document.getElementById('valor-pendente').innerText = "R$ " + res.dados.pendente;
    renderizarPendenteDetalhado(res.dados.pendenteDetalhado);
  } else {
    document.getElementById('valor-pendente').innerText = "R$ --";
  }
}

function montarApp(dados) {
  document.getElementById('valor-pendente').innerText = "R$ " + dados.pendente;
  renderizarPendenteDetalhado(dados.pendenteDetalhado);
  atualizarSelectsFormulario(dados);

  const planoAtual = localStorage.getItem("user_plano");
  const botoesMenu = document.querySelectorAll('.menu-grid .menu-btn');
  const podeCriarServico = planoAtual === "Ativo" || planoAtual === "Trial";

  botoesMenu.forEach(btn => {
    const textoMenu = btn.querySelector('.menu-text')?.textContent || '';

    if (textoMenu.includes("Novo Serviço")) {
      btn.style.display = podeCriarServico ? 'flex' : 'none';
    }
  });

  const emailLogado = localStorage.getItem("user_email");
  const btnAdmin = document.getElementById('btn-tab-admin');
  if (btnAdmin) {
    btnAdmin.style.display = (emailLogado === "danilobertolani@gmail.com") ? 'block' : 'none';
  }
  executarAposDoisFrames(() => {
    const loading = document.getElementById('tela-loading');
    const telaApp = document.getElementById('tela-app');

    if (loading) loading.style.display = 'none';
    esconderTodasTelas();
    if (telaApp) telaApp.style.display = 'block';

    const feedback = document.getElementById('atalho-feedback-fixo');
    if (feedback) feedback.style.display = 'block';
  });
}

let gsiPromise = null;

function carregarGoogleIdentityServices() {
  if (window.google?.accounts?.oauth2) {
    return Promise.resolve();
  }

  if (!gsiPromise) {
    gsiPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;

      script.onload = () => {
        if (window.google?.accounts?.oauth2) {
          resolve();
        } else {
          gsiPromise = null;
          reject(new Error('Google Identity Services não inicializado.'));
        }
      };

      script.onerror = () => {
        gsiPromise = null;
        reject(new Error('Falha ao carregar o login Google.'));
      };

      document.head.appendChild(script);
    });
  }

  return gsiPromise;
}

function mostrarTelaLogin() {
  document.getElementById('tela-home').style.display = 'none';
  document.getElementById('tela-login-google').style.display = 'flex';

  carregarGoogleIdentityServices().catch(() => {
    mostrarToast(
      'Não foi possível carregar o login Google. Verifique sua conexão e tente novamente.',
      'erro'
    );
  });
}

function atualizarSelectsFormulario(d) {
  agenciasGlobais = d.agencias || [];
  equipeGlobal = d.equipe || [];
  clientesGlobais = d.clientes || [];
  tiposServicoGlobal = d.tiposServico || [];

  var selServ = document.getElementById('tipoServico');
  if (selServ) {
    selServ.innerHTML = '<option value="" disabled selected>O que foi feito?</option>';
    tiposServicoGlobal.forEach(s => selServ.innerHTML += `<option value="${s}">${s}</option>`);
  }
  var selAg = document.getElementById('agencia');
  if (selAg) {
    selAg.innerHTML = '<option value="" disabled selected>Escolha...</option>';
    agenciasGlobais.forEach(a => selAg.innerHTML += `<option value="${a.nome}">${a.nome}</option>`);
  }
  var selEq = document.getElementById('interprete');
  if (selEq) {
    selEq.innerHTML = '<option value="" disabled selected>Quem executou?</option>';
    equipeGlobal.forEach(e => selEq.innerHTML += `<option value="${e}">${e}</option>`);
  }
  var dl = document.getElementById('listaEmpresasDatalist');
  if (dl) {
    dl.innerHTML = "";
    clientesGlobais.forEach(c => dl.innerHTML += `<option value="${c}">`);
  }
}

// ============================================================
// --- SISTEMA DE MODAIS — função única e genérica ---
// ============================================================

function fecharModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

// Aliases para compatibilidade com qualquer chamada legada
function fecharModalPlanos() { fecharModal('modal-planos'); }
function fecharModalPix() { fecharModal('modal-pix'); }
function fecharModalTermos() { fecharModal('modal-termos'); }
function fecharModalLogout() { fecharModal('modal-logout'); }
function fecharModalDetalhes() { fecharModal('modal-detalhes-servico'); }

function abrirModalTermos(e) {
  if (e) e.preventDefault();
  const el = document.getElementById('modal-termos');
  if (el) el.style.display = 'flex';
}

function abrirModalFeedback(e) {
  if (e) e.preventDefault();
  const el = document.getElementById('modal-feedback');
  if (el) el.style.display = 'flex';
}

function fecharModalFeedback() { fecharModal('modal-feedback'); }

function logout() {
  const el = document.getElementById('modal-logout');
  if (el) el.style.display = 'flex';
}

// --- MODAL DE PLANOS ---
// Abre o modal imediatamente (com loader), depois busca os planos em background
function abrirModalPlanos() {
  const modal = document.getElementById('modal-planos');
  if (modal) modal.style.display = 'flex';

  const lista = document.getElementById('modal-planos-lista');
  if (lista) {
    lista.innerHTML = '<div class="loader" style="margin:40px auto; border-top-color:#9c27b0;"></div>';
  }
  carregarPlanos();
}

async function carregarPlanos() {
  try {
    const res = await chamarGoogle('buscarPlanosAtivos');
    if (res && res.planos && res.planos.length > 0) {
      renderizarModalPlanos(res.planos);
    } else {
      const lista = document.getElementById('modal-planos-lista');
      if (lista) {
        lista.innerHTML = '<p style="text-align:center;color:#888;padding:30px 0;">Nenhum plano disponível.<br>Entre em contato pelo WhatsApp.</p>';
      }
    }
  } catch (err) {
    const lista = document.getElementById('modal-planos-lista');
    if (lista) {
      lista.innerHTML = '<p style="text-align:center;color:#e53935;padding:30px 0;">❌ Erro ao carregar planos.<br>Tente novamente.</p>';
    }
  }
}

function renderizarModalPlanos(planos) {
  const container = document.getElementById('modal-planos-lista');
  if (!container) return;
  container.innerHTML = '';

  // Plano de 1 mês como base para cálculo de desconto
  const planoBase = planos.find(p => parseInt(p.meses) === 1);
  const valorMensalBase = planoBase ? parseFloat(planoBase.valor_total) : 0;

  planos.sort((a, b) => parseInt(a.meses) - parseInt(b.meses));

  planos.forEach((plano, idx) => {
    const meses = parseInt(plano.meses);
    const valorTotal = parseFloat(plano.valor_total);
    const equivMensal = valorTotal / meses;

    const desconto = (valorMensalBase > 0 && meses > 1)
      ? Math.round((1 - equivMensal / valorMensalBase) * 100)
      : 0;

    const textoPeriodo = meses === 1
      ? 'por mês'
      : meses === 12
        ? 'por mês (cobrado anualmente)'
        : `por mês (cobrado a cada ${meses} meses)`;

    const ehDestaque = idx === Math.floor(planos.length / 2) || plano.destaque === true;
    const fmtBRL = (v) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    let badges = '';
    if (ehDestaque) badges += `<span class="badge-popular">⭐ Mais Popular</span>`;
    if (desconto > 0) badges += `<span class="badge-desconto">-${desconto}%</span>`;

    const card = document.createElement('div');
    card.className = `plano-card${ehDestaque ? ' destaque' : ''}`;
    card.innerHTML = `
      ${badges}
      <p class="plano-nome">${plano.nome}</p>
      <p class="plano-preco-equivalente">R$ ${fmtBRL(equivMensal)}<span>/ mês</span></p>
      <p class="plano-total">${meses > 1 ? `Total: R$ ${fmtBRL(valorTotal)} — ${textoPeriodo}` : textoPeriodo}</p>
      <div class="plano-botoes">
        <button class="btn-plano-cartao" onclick="assinarComCartao('${plano.id}', '${plano.nome}')">💳 Cartão</button>
        <button class="btn-plano-pix"    onclick="assinarComPix('${plano.id}', '${plano.nome}')">📱 PIX</button>
      </div>
    `;
    container.appendChild(card);
  });
}

async function assinarComCartao(idPlano, nomePlano) {
  const btn = event.currentTarget;
  const textoOriginal = btn.innerHTML;
  btn.innerHTML = '⏳ Gerando...';
  btn.disabled = true;

  try {
    const res = await chamarGoogle('gerarLinkAssinatura', { idPlano });
    if (res && res.status === 'Sucesso') {
      mostrarToast(`🚀 Redirecionando para o plano ${nomePlano}...`, 'sucesso');
      setTimeout(() => { window.location.href = res.url; }, 800);
    } else {
      throw new Error(res?.mensagem || 'Erro desconhecido');
    }
  } catch (err) {
    mostrarToast('❌ Erro ao gerar link. Tente novamente.', 'erro');
    btn.innerHTML = textoOriginal;
    btn.disabled = false;
  }
}

async function assinarComPix(idPlano, nomePlano) {
  const btn = event.currentTarget;
  const textoOriginal = btn.innerHTML;
  btn.innerHTML = '⏳ Gerando PIX...';
  btn.disabled = true;

  try {
    const res = await chamarGoogle('gerarPixAvulso', { idPlano });
    if (res && res.status === 'Sucesso') {
      fecharModalPlanos();
      abrirModalPix(res.qrCodeBase64, res.qrCodeTexto, nomePlano);
    } else {
      throw new Error(res?.mensagem || 'Erro desconhecido');
    }
  } catch (err) {
    mostrarToast('❌ Erro ao gerar PIX. Tente novamente.', 'erro');
  } finally {
    btn.innerHTML = textoOriginal;
    btn.disabled = false;
  }
}

// --- MODAL PIX ---
function abrirModalPix(qrCodeBase64, copiaCola, nomePlano) {
  const img = document.getElementById('pix-qrcode-img');
  const texto = document.getElementById('pix-copia-cola-texto');
  if (img) { img.src = 'data:image/png;base64,' + qrCodeBase64; img.alt = `QR Code PIX — ${nomePlano}`; }
  if (texto) texto.textContent = copiaCola;
  window._pixCopiaCola = copiaCola;
  const modal = document.getElementById('modal-pix');
  if (modal) modal.style.display = 'flex';
}

function copiarCodigoPix() {
  if (!window._pixCopiaCola) {
    mostrarToast('⚠️ Código PIX não disponível.', 'erro');
    return;
  }
  navigator.clipboard.writeText(window._pixCopiaCola)
    .then(() => mostrarToast('📋 Código PIX copiado!', 'sucesso'))
    .catch(() => mostrarToast('❌ Selecione e copie o código manualmente.', 'erro'));
}

// Compatibilidade com chamada legada de gerarPagamento
function gerarPagamento() { abrirModalPlanos(); }

// --- 5. REGISTROS ---
function abrirRegistro(linha = "", dados = null) {
  esconderTodasTelas();
  document.getElementById('tela-registro').style.display = 'block';
  document.getElementById('linha-edicao').value = linha;
  const btn = document.getElementById('btnSalvar');
  btn.disabled = false;
  btn.innerText = "Salvar";
  origemNavegacao = (linha === "") ? 'dash' : 'historico';

  if (linha === "") {
    document.getElementById('titulo-form').innerText = "Novo Atendimento";
    document.getElementById('formRegistro').reset();
    document.getElementById('data').valueAsDate = new Date();
    document.getElementById('valor-live-preview').innerText = "R$ 0,00";
    document.getElementById('secao-edicao-financeira').style.display = "none";
    document.getElementById('origem-p').checked = true;
    toggleCamposAgencia();
  } else {
    if (!dados) {
      mostrarToast("❌ Erro ao carregar dados do serviço.", "erro");
      fecharRegistroManual();
      return;
    }
    document.getElementById('titulo-form').innerText = "Editar Atendimento";
    document.getElementById('secao-edicao-financeira').style.display = "block";
    document.getElementById('data').value = dados.dataOriginal || "";
    document.getElementById('empresa').value = dados.empresa || "";
    document.getElementById('inicio').value = dados.inicio || "";
    document.getElementById('fim').value = dados.fim || "";
    document.getElementById('interprete').value = dados.interprete || "";
    document.getElementById('tipoServico').value = dados.tipoServico || "";
    document.getElementById('valor-base').value = (dados.valor || "").replace("R$ ", "").trim();
    document.getElementById('obs').value = dados.obs || "";
    if (dados.agencia === "Particular") {
      document.getElementById('origem-p').checked = true;
    } else {
      document.getElementById('origem-a').checked = true;
      document.getElementById('agencia').value = dados.agencia;
    }
    toggleCamposAgencia();
    document.getElementById('edit-status').value = dados.status;
    document.getElementById('edit-data-pgto').value = dados.dataPgtoOriginal || "";
    toggleDataEdicao();
  }
  calcularTotalLive();
}

function toggleDataEdicao() {
  const status = document.getElementById('edit-status').value;
  document.getElementById('box-data-recebimento-edit').style.display = (status === "Pago") ? "block" : "none";
}

function aoMudarAgencia() {
  var ag = document.getElementById('agencia').value;
  var obj = agenciasGlobais.find(a => a.nome === ag);
  if (obj) {
    var num = converterParaFloat(obj.valor);
    document.getElementById('valor-base').value = num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    calcularTotalLive();
  }
}

function calcularTotalLive() {
  var tipo = document.querySelector('input[name="tipoCobranca"]:checked').value;
  var campoValor = document.getElementById('valor-base');
  var vI = converterParaFloat(campoValor.value);
  var p = document.getElementById('valor-live-preview');
  var hI = document.getElementById('inicio').value;
  var hF = document.getElementById('fim').value;
  var horas = 0;

  if (hI && hF) {
    var dI = new Date(0, 0, 0, hI.split(":")[0], hI.split(":")[1]);
    var dF = new Date(0, 0, 0, hF.split(":")[0], hF.split(":")[1]);
    if (dF < dI) dF.setDate(dF.getDate() + 1);
    horas = (dF - dI) / 3600000;
  }

  var agNome = document.getElementById('agencia').value;
  var objAg = agenciasGlobais.find(a => a.nome === agNome);
  var valorAgencia = objAg ? converterParaFloat(objAg.valor) : 0;

  if (tipo === "hora") {
    if (objAg && vI !== valorAgencia && vI > valorAgencia) {
      vI = valorAgencia;
      campoValor.value = vI.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    p.innerText = "R$ " + (horas * vI).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } else {
    if (objAg && vI === valorAgencia && horas > 0) {
      vI = horas * valorAgencia;
      campoValor.value = vI.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    p.innerText = "R$ " + vI.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}

function verificarBloqueioLeitura() {
  const planoAtual = localStorage.getItem("user_plano");
  if (planoAtual !== "Ativo" && planoAtual !== "Trial") {
    mostrarToast("Plano inativo. O sistema está no Modo Somente Leitura.", "erro");
    return true;
  }
  return false;
}

async function enviarDados(e) {
  e.preventDefault();
  if (verificarBloqueioLeitura()) return;

  const btn = document.getElementById('btnSalvar');
  const linhaId = document.getElementById('linha-edicao').value;
  const valorAgencia = document.getElementById('origem-p').checked
    ? "Particular"
    : document.getElementById('agencia').value;

  const d = {
    tipoServico: document.getElementById('tipoServico').value,
    data: document.getElementById('data').value,
    agencia: valorAgencia,
    empresa: document.getElementById('empresa').value,
    inicio: document.getElementById('inicio').value,
    fim: document.getElementById('fim').value,
    interprete: document.getElementById('interprete').value,
    valorFinal: document.getElementById('valor-live-preview').innerText.replace("R$ ", ""),
    obs: document.getElementById('obs').value,
    status: (linhaId === "") ? "Pendente" : document.getElementById('edit-status').value,
    statusAntigo: (linhaId !== "") ? document.getElementById('edit-status').value : "Pendente",
    dataPgtoAntiga: (linhaId !== "") ? document.getElementById('edit-data-pgto').value : ""
  };

  btn.disabled = true;
  btn.innerText = "⏳ Salvando...";

  try {
    if (linhaId === "") {
      await chamarGoogle("salvarRegistro", d);
      const hI = d.inicio, hF = d.fim;
      const dI = new Date(0, 0, 0, hI.split(":")[0], hI.split(":")[1]);
      let dF = new Date(0, 0, 0, hF.split(":")[0], hF.split(":")[1]);
      if (dF < dI) dF.setDate(dF.getDate() + 1);
      const horas = (dF - dI) / 3600000;
      if (horas > 1.0) {
        mostrarToast("✅ Registro salvo!");
        await perguntarDuplicacao(d);
        return;
      }
      mostrarToast("✅ Salvo com sucesso!");
      voltarDashboard();
    } else {
      await chamarGoogle("atualizarRegistro", { linha: linhaId, dados: d });
      const idNumerico = Number(linhaId);
      const entradaExistente = servicoCache.get(idNumerico) ?? {};
      const entradaAtualizada = {
        ...entradaExistente,
        linha: idNumerico,
        empresa: d.empresa,
        agencia: d.agencia,
        interprete: d.interprete,
        tipoServico: d.tipoServico,
        inicio: d.inicio,
        fim: d.fim,
        obs: d.obs,
        status: d.statusAntigo,
        dataPgto: d.dataPgtoAntiga || entradaExistente.dataPgto || "",
        valor: "R$ " + d.valorFinal,
        valorNum: converterParaFloat(d.valorFinal),
        dataOriginal: d.data,
        data: d.data.split('-').reverse().join('/'),
      };
      servicoCache.set(idNumerico, entradaAtualizada);
      const idx = historicoGlobal.findIndex(s => Number(s.linha) === idNumerico);
      if (idx !== -1) historicoGlobal[idx] = entradaAtualizada;
      mostrarToast("✅ Alteração salva!");
      abrirHistorico();
    }
  } catch (err) {
    btn.disabled = false;
    btn.innerText = "Salvar";
    mostrarToast("❌ Erro ao salvar", "erro");
  }
}

// --- 6. HISTÓRICO ---
async function abrirHistorico() {
  esconderTodasTelas();
  document.getElementById('tela-historico').style.display = 'block';
  document.getElementById('lista-html').innerHTML = '<div class="loader"></div>';

  const hoje = new Date();
  const seisMesesAtras = new Date();
  seisMesesAtras.setMonth(hoje.getMonth() - 6);
  document.getElementById('filtroDataInicio').value = seisMesesAtras.toISOString().split('T')[0];
  document.getElementById('filtroDataFim').value = hoje.toISOString().split('T')[0];

  const resRecentes = await chamarGoogle("buscarServicosRecentes");
  historicoGlobal = resRecentes.dados;
  resRecentes.dados.forEach(s => servicoCache.set(Number(s.linha), s));
  renderizarHistorico(historicoGlobal);

  chamarGoogle("buscarTodosServicos").then(resCompleto => {
    if (resCompleto?.dados) {
      historicoGlobal = resCompleto.dados;
      resCompleto.dados.forEach(s => servicoCache.set(Number(s.linha), s));
    }
  });
}

function renderizarHistorico(l) {
  l.forEach(s => servicoCache.set(Number(s.linha), s));
  l.sort((a, b) => {
    let dA = a.dataOriginal || "", dB = b.dataOriginal || "";
    return ordemDataHistorico === 'desc'
      ? dB.localeCompare(dA) || b.linha - a.linha
      : dA.localeCompare(dB) || a.linha - b.linha;
  });

  var selAgEl = document.getElementById('filtroAgenciaHist');
  var selMemEl = document.getElementById('filtroInterpreteHist');
  var valAg = (selAgEl && selAgEl.value) ? selAgEl.value : 'todas';
  var valMem = (selMemEl && selMemEl.value) ? selMemEl.value : 'todos';

  historicoGlobal = l;
  var c = document.getElementById('lista-html');
  c.innerHTML = "";

  if (selAgEl) {
    selAgEl.innerHTML = '<option value="todas">Todas</option>';
    agenciasGlobais.forEach(a => selAgEl.innerHTML += `<option value="${a.nome.toLowerCase()}">${a.nome}</option>`);
  }
  if (selMemEl) {
    selMemEl.innerHTML = '<option value="todos">Todos</option>';
    equipeGlobal.forEach(m => selMemEl.innerHTML += `<option value="${m.toLowerCase()}">${m}</option>`);
  }

  const itensHtml = l.map(i => {
    var p = (i.status === "Pago");
    let dataPgtoFormatada = "";
    if (p && i.dataPgto) {
      dataPgtoFormatada = i.dataPgto.includes("-")
        ? i.dataPgto.split("-").reverse().join("/")
        : i.dataPgto;
    }
    i.dataExibicaoCompleta = i.data;
    return `
      <div class="item-pendente item-historico"
           onclick="abrirDetalhesServico(${i.linha})"
           style="border-left-color:${p ? '#4CAF50' : '#ff9800'}; cursor:pointer;"
           data-status="${p ? 'pago' : 'pendente'}"
           data-agencia="${String(i.agencia).toLowerCase()}"
           data-empresa="${String(i.empresa).toLowerCase()}"
           data-interprete="${String(i.interprete).toLowerCase()}"
           data-data-iso="${i.dataOriginal}">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong>${i.agencia}</strong>
          <span style="font-size:10px; font-weight:bold; padding:2px 8px; border-radius:10px; background:${p ? '#e8f5e9' : '#fff3e0'}; color:${p ? '#2e7d32' : '#e65100'}">
            ${p ? 'PAGO' : 'PENDENTE'}
          </span>
        </div>
        <span style="font-size:12px; color:#666;">📅 ${i.data} - ${i.empresa}</span><br>
        <span style="font-size:12px; color:#888;">⏱️ ${i.inicio} às ${i.fim}</span>
        ${p && dataPgtoFormatada ? `<div style="font-size:11px; color:#2e7d32; margin-top:3px;">💰 Recebido em: <strong>${dataPgtoFormatada}</strong></div>` : ''}
        <div style="display:flex; justify-content:space-between; margin-top:5px;">
          <strong style="color:#4a148c;">${i.valor}</strong>
          <span style="font-size:11px;">👤 ${i.interprete}</span>
        </div>
      </div>`;
  }).join("");
  c.innerHTML = itensHtml;

  if (selAgEl) selAgEl.value = valAg;
  if (selMemEl) selMemEl.value = valMem;
  filtrarListaHistorico();
}

function alternarOrdemData() {
  ordemDataHistorico = (ordemDataHistorico === 'desc') ? 'asc' : 'desc';
  const btn = document.getElementById('btnOrdenacaoData');
  if (btn) btn.innerHTML = (ordemDataHistorico === 'desc') ? '⬇️ Mais Recentes' : '⬆️ Mais Antigos';
  renderizarHistorico(historicoGlobal);
}

async function abrirDetalhesServico(linha) {
  const idBusca = Number(linha);
  let servico = servicoCache.get(idBusca);
  if (!servico) servico = historicoGlobal.find(s => Number(s.linha) === idBusca);
  if (!servico) {
    mostrarToast("⏳ Carregando dados...");
    try {
      const res = await chamarGoogle("buscarServicoPorLinha", { linha: idBusca });
      if (res?.dados) { servico = res.dados; servicoCache.set(idBusca, servico); }
    } catch (e) { mostrarToast("❌ Não foi possível carregar o registro.", "erro"); return; }
  }
  if (!servico) { mostrarToast("❌ Registro não encontrado.", "erro"); return; }

  const isPago = servico.status === "Pago";
  const éParticular = servico.agencia.toLowerCase() === "particular";
  const modal = document.getElementById('modal-detalhes-servico');

  document.getElementById('detalhe-agencia').innerText = servico.agencia;
  document.getElementById('detalhe-cliente').innerText = servico.empresa;
  document.getElementById('detalhe-data').innerText = servico.data;
  document.getElementById('detalhe-horas').innerText = `${servico.inicio} às ${servico.fim}`;
  document.getElementById('detalhe-interprete').innerText = servico.interprete;
  document.getElementById('detalhe-tipo').innerText = servico.tipoServico || "---";
  document.getElementById('detalhe-valor').innerText = servico.valor;
  document.getElementById('detalhe-obs').innerText = servico.obs || "Sem observações.";
  document.getElementById('box-obs-detalhe').style.display = servico.obs ? "block" : "none";

  const badge = document.getElementById('detalhe-status-badge');
  const header = document.getElementById('detalhe-header');
  const secaoBaixa = document.getElementById('secao-baixa-pagamento');
  header.style.background = isPago ? "#2e7d32" : "#4a148c";

  if (isPago) {
    let dataFormatada = "Data não informada";
    if (servico.dataPgto && servico.dataPgto.includes("-")) {
      dataFormatada = servico.dataPgto.split("-").reverse().join("/");
    } else if (servico.dataPgto) {
      dataFormatada = servico.dataPgto;
    }
    badge.innerText = `✅ RECEBIDO EM ${dataFormatada}`;
    secaoBaixa.style.display = "none";
  } else {
    badge.innerText = éParticular ? "⏳ AGUARDANDO PAGAMENTO DO CLIENTE" : "⏳ AGUARDANDO REPASSE DA AGÊNCIA";
    secaoBaixa.style.display = "block";
    document.getElementById('data-pagamento-modal').valueAsDate = new Date();
  }

  document.getElementById('btn-confirmar-pgto').onclick = () => confirmarBaixaComData(linha);
  document.getElementById('btn-editar-detalhe').onclick = () => { fecharModalDetalhes(); chamarEditar(linha); };
  document.getElementById('btn-excluir-detalhe').onclick = () => { fecharModalDetalhes(); chamarExcluir(linha); };
  modal.style.display = 'flex';
}

async function confirmarBaixaComData(linha) {
  const dataEscolhida = document.getElementById('data-pagamento-modal').value;
  if (!dataEscolhida) return mostrarToast("⚠️ Selecione a data!", "erro");

  const dataFormatada = dataEscolhida.split('-').reverse().join('/');
  document.getElementById('confirm-titulo').innerText = "Confirmar Pagamento";
  document.getElementById('confirm-mensagem').innerHTML = `Você confirma que recebeu este valor no dia <b>${dataFormatada}</b>?`;
  document.getElementById('confirm-icon').innerText = "💰";
  document.getElementById('modal-confirmacao').style.display = 'flex';

  const confirmado = await esperarConfirmacao();
  if (confirmado) {
    fecharModalDetalhes();
    mostrarToast("⏳ Registrando...");
    await chamarGoogle("darBaixaPagamento", { linha: linha, data: dataEscolhida });
    mostrarToast("✅ Pago com sucesso!");
    abrirHistorico();
  }
}

function filtrarListaHistorico() {
  const dIni = document.getElementById('filtroDataInicio').value;
  const dFim = document.getElementById('filtroDataFim').value;
  const st = document.getElementById('filtroStatus').value;
  const ag = document.getElementById('filtroAgenciaHist').value;
  const mem = document.getElementById('filtroInterpreteHist').value;
  const cl = document.getElementById('filtroClienteHist').value.toLowerCase();
  const cards = document.getElementsByClassName('item-historico');

  for (let i = 0; i < cards.length; i++) {
    let card = cards[i];
    let dataISO = card.getAttribute('data-data-iso');
    let okData = true;
    if (dIni && dataISO < dIni) okData = false;
    if (dFim && dataISO > dFim) okData = false;

    let okStatus = (st === 'todos' || card.getAttribute('data-status') === st);
    let okAgencia = (ag === 'todas' || card.getAttribute('data-agencia') === ag);
    let okMembro = (mem === 'todos' || card.getAttribute('data-interprete') === mem);
    let okCliente = (!cl || card.getAttribute('data-empresa').includes(cl));
    card.style.display = (okData && okStatus && okAgencia && okMembro && okCliente) ? 'block' : 'none';
  }
}

async function confirmarBaixa(l) {
  if (verificarBloqueioLeitura()) return;
  var dt = document.getElementById('dataRecebimento').value;
  if (!dt) return mostrarToast("⚠️ Selecione a data!", "erro");
  await chamarGoogle("darBaixaPagamento", { linha: l, data: dt });
  abrirHistorico();
}

async function chamarExcluir(l) {
  if (verificarBloqueioLeitura()) return;
  document.getElementById('confirm-titulo').innerText = "Excluir Atendimento";
  document.getElementById('confirm-mensagem').innerHTML = "Tem certeza que deseja apagar este registro?";
  document.getElementById('confirm-icon').innerText = "🗑️";
  document.getElementById('modal-confirmacao').style.display = 'flex';
  const confirmado = await esperarConfirmacao();
  if (confirmado) {
    mostrarToast("⏳ Excluindo...");
    await chamarGoogle("excluirRegistro", l);
    mostrarToast("✅ Excluído!");
    abrirHistorico();
  }
}

function chamarEditar(l) {
  const idBusca = Number(l);
  let servico = servicoCache.get(idBusca);
  if (!servico) servico = historicoGlobal.find(x => Number(x.linha) === idBusca);
  if (!servico) {
    mostrarToast("⚠️ Dados em sincronização. Tente novamente em 2 segundos.", "erro");
    chamarGoogle("buscarTodosServicos").then(res => {
      if (res?.dados) {
        historicoGlobal = res.dados;
        res.dados.forEach(s => servicoCache.set(Number(s.linha), s));
      }
    });
    return;
  }
  abrirRegistro(l, servico);
}

// --- 7. RELATÓRIOS ---
async function abrirRelatorios() {
  esconderTodasTelas();
  document.getElementById('tela-relatorios').style.display = 'block';
  document.getElementById('lista-relatorio').innerHTML = '<div class="loader"></div>';

  const res = await chamarGoogle("buscarTodosServicos");
  dadosGeraisRelatorio = res.dados;

  var hj = new Date();
  document.getElementById('filtroMesRelatorio').value = hj.getFullYear() + "-" + ("0" + (hj.getMonth() + 1)).slice(-2);

  var sa = document.getElementById('filtroAgenciaRelatorio');
  var sm = document.getElementById('filtroMembroRelatorio');
  sa.innerHTML = '<option value="todas">Todas as Agências</option>';
  sm.innerHTML = '<option value="todos">Todos os Membros</option>';

  var lAg = [], lMem = [];
  res.dados.forEach(i => {
    if (!lAg.includes(i.agencia)) { lAg.push(i.agencia); sa.innerHTML += `<option value="${i.agencia}">${i.agencia}</option>`; }
    if (!lMem.includes(i.interprete)) { lMem.push(i.interprete); sm.innerHTML += `<option value="${i.interprete}">${i.interprete}</option>`; }
  });
  gerarRelatorio();
}

function gerarRelatorio() {
  var tipo = document.getElementById('tipoRelatorio').value;
  var mesFiltro = document.getElementById('filtroMesRelatorio').value;
  var agFiltro = document.getElementById('filtroAgenciaRelatorio').value;
  var memFiltro = document.getElementById('filtroMembroRelatorio').value;
  var container = document.getElementById('lista-relatorio');
  var cFat = document.getElementById('valor-total-relatorio');
  var cHor = document.getElementById('horas-total-relatorio');

  container.innerHTML = "";
  var fTotal = 0, hTotal = 0;

  var filtrados = dadosGeraisRelatorio.filter(i => {
    var mesItem = tipo === 'nf' ? extrairMesAno(i.dataPgto) : extrairMesAno(i.dataOriginal);
    if (tipo === 'nf' && i.status !== "Pago") return false;
    return (mesFiltro === "" || mesItem === mesFiltro) &&
      (agFiltro === "todas" || i.agencia === agFiltro) &&
      (memFiltro === "todos" || i.interprete === memFiltro);
  });

  dadosFiltradosAtuais = filtrados;

  if (filtrados.length === 0) {
    cFat.innerText = "R$ 0,00"; cHor.innerText = "0.00h";
    container.innerHTML = "<p style='text-align:center; color:#666; padding:20px;'>Nenhum dado encontrado.</p>";
    return;
  }

  filtrados.forEach(i => {
    fTotal += i.valorNum;
    if (i.inicio && i.fim) {
      var dI = new Date(0, 0, 0, i.inicio.split(":")[0], i.inicio.split(":")[1]);
      var dF = new Date(0, 0, 0, i.fim.split(":")[0], i.fim.split(":")[1]);
      if (dF < dI) dF.setDate(dF.getDate() + 1);
      hTotal += (dF - dI) / 3600000;
    }
  });

  cFat.innerText = "R$ " + fTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
  cHor.innerText = hTotal.toFixed(2) + "h";

  if (tipo === 'nf') {
    var nfPorM = {};
    filtrados.forEach(it => {
      if (!nfPorM[it.interprete]) nfPorM[it.interprete] = { t: 0, ags: {} };
      if (!nfPorM[it.interprete].ags[it.agencia]) nfPorM[it.interprete].ags[it.agencia] = { t: 0, items: [] };
      nfPorM[it.interprete].t += it.valorNum;
      nfPorM[it.interprete].ags[it.agencia].t += it.valorNum;
      nfPorM[it.interprete].ags[it.agencia].items.push(it);
    });
    Object.keys(nfPorM).forEach(nome => {
      var h = `<div class="item-pendente" style="border-left:5px solid #9c27b0; margin-bottom:12px; padding-bottom:8px;">
        <div style="display:flex; justify-content:space-between;"><strong>👤 ${nome}</strong><strong style="color:#2e7d32;">R$ ${nfPorM[nome].t.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</strong></div>
        <div style="font-size:12px; color:#666; margin-top:4px;">Total a emitir no período</div>`;
      Object.keys(nfPorM[nome].ags).forEach(ag => {
        h += `<details style="margin-top:10px; border-top:1px solid #eee; padding-top:8px;">
          <summary style="font-size:12px; color:#7b1fa2; cursor:pointer; font-weight:600;">🏢 ${ag} ➔ R$ ${nfPorM[nome].ags[ag].t.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} 🔽</summary>
          <div style="margin-top:8px; background:#fafafa; padding:8px; border-radius:6px; border:1px solid #e0e0e0;">`;
        nfPorM[nome].ags[ag].items.forEach(it => {
          h += `<div style="font-size:13px; padding:8px 0; border-bottom:1px dashed #ccc; display:flex; justify-content:space-between;">
            <span>📅 ${it.data} - ${it.empresa}</span>
            <span style="color:#2e7d32; font-weight:bold;">R$ ${it.valorNum.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
          </div>`;
        });
        h += `</div></details>`;
      });
      h += `</div>`;
      container.innerHTML += h;
    });
  } else {
    var pM = {};
    filtrados.forEach(i => {
      if (!pM[i.interprete]) pM[i.interprete] = { h: 0, jobs: 0, fat: 0, list: [] };
      var diff = 0;
      if (i.inicio && i.fim) {
        var dI = new Date(0, 0, 0, i.inicio.split(":")[0], i.inicio.split(":")[1]);
        var dF = new Date(0, 0, 0, i.fim.split(":")[0], i.fim.split(":")[1]);
        if (dF < dI) dF.setDate(dF.getDate() + 1);
        diff = (dF - dI) / 3600000;
      }
      pM[i.interprete].h += diff; pM[i.interprete].jobs++; pM[i.interprete].fat += i.valorNum;
      i.hCalc = diff; pM[i.interprete].list.push(i);
    });
    Object.keys(pM).forEach(nome => {
      var h = `<div class="item-pendente" style="border-left:5px solid #2196F3; margin-bottom:12px; padding-bottom:8px;">
        <div style="display:flex; justify-content:space-between;"><strong>👤 ${nome}</strong><strong style="color:#1a237e;">${pM[nome].h.toFixed(2)}h</strong></div>
        <div style="font-size:12px; color:#666; margin-top:4px; display:flex; justify-content:space-between;">
          <span>${pM[nome].jobs} atendimentos</span>
          <span style="color:#2e7d32; font-weight:bold;">R$ ${pM[nome].fat.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
        </div>
        <details style="margin-top:10px; border-top:1px solid #eee; padding-top:8px;">
          <summary style="font-size:12px; color:#1976d2; cursor:pointer;">Ver Detalhamento 🔽</summary>
          <div style="margin-top:8px; background:#f8f9fa; padding:8px; border-radius:6px; border:1px solid #e0e0e0;">`;
      pM[nome].list.forEach(it => {
        h += `<div style="font-size:13px; padding:8px 0; border-bottom:1px dashed #ccc;">
          <div style="display:flex; justify-content:space-between;"><strong>📅 ${it.data} - ${it.empresa}</strong><span style="color:#d32f2f;">⏱️ ${it.hCalc.toFixed(2)}h</span></div>
          <div style="display:flex; justify-content:space-between; color:#555;"><span>🏢 ${it.agencia}</span><span style="color:#2e7d32;">R$ ${it.valorNum.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span></div>
        </div>`;
      });
      h += `</div></details></div>`;
      container.innerHTML += h;
    });
  }
}

function copiarResumo() {
  var tipo = document.getElementById('tipoRelatorio').value;
  var mes = document.getElementById('filtroMesRelatorio').value;
  var txt = "";
  if (dadosFiltradosAtuais.length === 0) return mostrarToast("⚠️ Nada para copiar!", "erro");

  if (tipo === 'nf') {
    txt += `*RESUMO PARA NOTA FISCAL*\nReferência: ${mes || 'Geral'}\n\n`;
    var nf = {};
    dadosFiltradosAtuais.forEach(i => {
      if (!nf[i.interprete]) nf[i.interprete] = { t: 0, ags: {} };
      if (!nf[i.interprete].ags[i.agencia]) nf[i.interprete].ags[i.agencia] = 0;
      nf[i.interprete].ags[i.agencia] += i.valorNum;
      nf[i.interprete].t += i.valorNum;
    });
    Object.keys(nf).forEach(m => {
      txt += `👤 *${m}*\n💰 Total: R$ ${nf[m].t.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}\n`;
      Object.keys(nf[m].ags).forEach(a => txt += ` 🏢 ${a}: R$ ${nf[m].ags[a].toLocaleString('pt-BR', { minimumFractionDigits: 2 })}\n`);
      txt += `\n`;
    });
  } else {
    txt += `*CONFIRMAÇÃO DE PRODUTIVIDADE*\nPeríodo: ${mes || 'Geral'}\n\n`;
    var p = {};
    dadosFiltradosAtuais.forEach(i => {
      if (!p[i.interprete]) p[i.interprete] = { h: 0, f: 0, items: [] };
      var d = 0;
      if (i.inicio && i.fim) {
        var dI = new Date(0, 0, 0, i.inicio.split(":")[0], i.inicio.split(":")[1]);
        var dF = new Date(0, 0, 0, i.fim.split(":")[0], i.fim.split(":")[1]);
        if (dF < dI) dF.setDate(dF.getDate() + 1);
        d = (dF - dI) / 3600000;
      }
      p[i.interprete].h += d; p[i.interprete].f += i.valorNum;
      p[i.interprete].items.push(`📅 ${i.data} | ${i.inicio}-${i.fim} | ${i.empresa} (${i.agencia}) - R$ ${i.valorNum.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
    });
    Object.keys(p).forEach(m => {
      txt += `👤 *${m}* | ⏱️ ${p[m].h.toFixed(2)}h | R$ ${p[m].f.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}\n`;
      p[m].items.forEach(it => txt += ` ${it}\n`);
      txt += `\n`;
    });
  }
  navigator.clipboard.writeText(txt).then(() => mostrarToast("📋 Copiado para o WhatsApp!"));
}

// Carrega html2canvas somente quando o usuário solicita baixar o relatório.
let html2canvasPromise = null;

function carregarHtml2Canvas() {
  if (typeof window.html2canvas === "function") {
    return Promise.resolve(window.html2canvas);
  }

  if (!html2canvasPromise) {
    html2canvasPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
      script.async = true;

      script.onload = () => {
        if (typeof window.html2canvas === "function") {
          resolve(window.html2canvas);
        } else {
          html2canvasPromise = null;
          reject(new Error("html2canvas não foi inicializado."));
        }
      };

      script.onerror = () => {
        html2canvasPromise = null;
        reject(new Error("Falha ao carregar html2canvas."));
      };

      document.head.appendChild(script);
    });
  }

  return html2canvasPromise;
}

function baixarImagemRelatorio() {
  var btn = document.getElementById('btnBaixarImagem'), orig = btn.innerHTML;
  btn.innerHTML = "⏳ Gerando Foto..."; btn.disabled = true;
  document.querySelectorAll('details').forEach(d => d.open = true);

  carregarHtml2Canvas()
    .then(html2canvas => html2canvas(
      document.querySelector('#tela-relatorios .card'),
      { scale: 2 }
    ))
    .then(canvas => {
      var link = document.createElement('a');
      link.download = `Relatorio_InterpretePro_${document.getElementById('filtroMesRelatorio').value}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      btn.innerHTML = orig;
      btn.disabled = false;
      mostrarToast("🖼️ Imagem salva!");
    })
    .catch(() => {
      btn.innerHTML = orig;
      btn.disabled = false;
      mostrarToast("❌ Erro ao gerar imagem", "erro");
    });
}

// --- 8. CONFIGURAÇÕES ---
function abrirConfiguracoes() {
  carregarDadosConta();
  esconderTodasTelas();
  document.getElementById('tela-configuracoes').style.display = 'block';

  const d = { tiposServico: tiposServicoGlobal, equipe: equipeGlobal, agencias: agenciasGlobais, clientes: clientesGlobais };
  const planoAtual = localStorage.getItem("user_plano");
  const bloqueadoLeitura = (planoAtual !== "Ativo" && planoAtual !== "Trial");

  document.getElementById('formServicos').style.display = bloqueadoLeitura ? 'none' : 'block';
  document.getElementById('formEquipe').style.display = bloqueadoLeitura ? 'none' : 'block';
  document.getElementById('formConfig').style.display = bloqueadoLeitura ? 'none' : 'block';
  document.getElementById('formClientes').style.display = bloqueadoLeitura ? 'none' : 'block';

  var cs = document.getElementById('lista-servicos-ui'); cs.innerHTML = "";
  d.tiposServico.forEach(s => cs.innerHTML += `<div class="item-pendente item-config-flex" style="border-left-color:#546e7a"><strong>${s}</strong>${bloqueadoLeitura ? '' : `<div><button class="btn-acao btn-editar" onclick="editarConfig('servico','${s}')">✏️</button><button class="btn-acao btn-excluir" onclick="excluirConfig('Tipos_Servico','${s}')">🗑️</button></div>`}</div>`);

  var ce = document.getElementById('lista-equipe-ui'); ce.innerHTML = "";
  d.equipe.forEach(n => ce.innerHTML += `<div class="item-pendente item-config-flex" style="border-left-color:#9c27b0"><strong>${n}</strong>${bloqueadoLeitura ? '' : `<div><button class="btn-acao btn-editar" onclick="editarConfig('equipe','${n}')">✏️</button><button class="btn-acao btn-excluir" onclick="excluirConfig('Minha_Equipe','${n}')">🗑️</button></div>`}</div>`);

  var ca = document.getElementById('lista-configuracoes'); ca.innerHTML = "";
  d.agencias.forEach(i => {
    const vf = parseFloat(i.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    ca.innerHTML += `<div class="item-pendente item-config-flex" style="border-left-color:#607d8b;">
      <strong style="font-size:15px; flex-shrink:0;">${i.nome}</strong>
      <span class="valor-tag">R$ ${vf}</span>
      ${bloqueadoLeitura ? '' : `<div style="display:flex; flex-shrink:0;">
        <button class="btn-acao btn-editar" onclick="editarConfig('agencia','${i.nome}','${i.valor}')">✏️</button>
        <button class="btn-acao btn-excluir" onclick="excluirConfig('Minhas_Empresas','${i.nome}')">🗑️</button>
      </div>`}
    </div>`;
  });

  var cl = document.getElementById('lista-clientes-ui'); cl.innerHTML = "";
  d.clientes.forEach(n => cl.innerHTML += `<div class="item-pendente item-config-flex" style="border-left-color:#FF9800"><strong>${n}</strong>${bloqueadoLeitura ? '' : `<div><button class="btn-acao btn-editar" onclick="editarConfig('cliente','${n}')">✏️</button><button class="btn-acao btn-excluir" onclick="excluirConfig('Minhas_Empresas_Finais','${n}')">🗑️</button></div>`}</div>`);

  document.getElementById('atalho-feedback-fixo').style.display = 'block';
}

function editarConfig(tipo, nome, valor = "") {
  if (tipo === 'servico') { document.getElementById('servico-antigo').value = nome; document.getElementById('configServicoNome').value = nome; }
  if (tipo === 'equipe') { document.getElementById('equipe-antigo').value = nome; document.getElementById('configEquipeNome').value = nome; }
  if (tipo === 'cliente') { document.getElementById('cliente-antigo').value = nome; document.getElementById('configClienteNome').value = nome; }
  if (tipo === 'agencia') { document.getElementById('agencia-antigo').value = nome; document.getElementById('configNome').value = nome; document.getElementById('configValor').value = valor; }
  window.scrollTo(0, 0);
}

async function salvarAgencia(e) {
  e.preventDefault();
  if (verificarBloqueioLeitura()) return;
  const nomeNovo = document.getElementById('configNome').value.trim();
  const valorNovo = document.getElementById('configValor').value;
  const nomeAntigo = document.getElementById('agencia-antigo').value;
  mostrarToast("Salvando agência...");
  await chamarGoogle("salvarConfigAgencia", { nome: nomeNovo, valor: valorNovo, antigo: nomeAntigo });
  if (nomeAntigo) {
    const idx = agenciasGlobais.findIndex(a => a.nome === nomeAntigo);
    if (idx !== -1) agenciasGlobais[idx] = { nome: nomeNovo, valor: valorNovo };
  } else {
    if (!agenciasGlobais.find(a => a.nome === nomeNovo)) agenciasGlobais.push({ nome: nomeNovo, valor: valorNovo });
  }
  atualizarSelectAgencias();
  document.getElementById('formConfig').reset();
  document.getElementById('agencia-antigo').value = "";
  mostrarToast("✅ Agência salva!", "sucesso");
  abrirConfiguracoes();
}

async function salvarEquipe(e) {
  e.preventDefault();
  if (verificarBloqueioLeitura()) return;
  const idEdicao = document.getElementById('equipe-id') ? document.getElementById('equipe-id').value : "";
  if (!idEdicao && equipeGlobal.length >= 2) { mostrarToast("Limite máximo de 2 membros atingido.", "erro"); return; }
  const nomeNovo = document.getElementById('configEquipeNome').value.trim();
  const nomeAntigo = document.getElementById('equipe-antigo').value;
  mostrarToast("Salvando membro...");
  await chamarGoogle("salvarMembroEquipe", { nome: nomeNovo, antigo: nomeAntigo });
  if (nomeAntigo) {
    const idx = equipeGlobal.indexOf(nomeAntigo);
    if (idx !== -1) equipeGlobal[idx] = nomeNovo;
  } else {
    if (!equipeGlobal.includes(nomeNovo)) equipeGlobal.push(nomeNovo);
  }
  atualizarSelectInterprete();
  document.getElementById('formEquipe').reset();
  document.getElementById('equipe-antigo').value = "";
  mostrarToast("✅ Membro salvo!", "sucesso");
  abrirConfiguracoes();
}

async function salvarCliente(e) {
  e.preventDefault();
  if (verificarBloqueioLeitura()) return;
  const nomeNovo = document.getElementById('configClienteNome').value.trim();
  const nomeAntigo = document.getElementById('cliente-antigo').value;
  mostrarToast("Salvando cliente...");
  await chamarGoogle("salvarEmpresaFinal", { nome: nomeNovo, antigo: nomeAntigo });
  if (nomeAntigo) {
    const idx = clientesGlobais.indexOf(nomeAntigo);
    if (idx !== -1) clientesGlobais[idx] = nomeNovo;
  } else {
    if (!clientesGlobais.includes(nomeNovo)) clientesGlobais.push(nomeNovo);
  }
  atualizarDatalistEmpresas();
  document.getElementById('formClientes').reset();
  document.getElementById('cliente-antigo').value = "";
  mostrarToast("✅ Cliente salvo!", "sucesso");
  abrirConfiguracoes();
}

async function salvarTipoServico(e) {
  e.preventDefault();
  if (verificarBloqueioLeitura()) return;
  const nomeNovo = document.getElementById('configServicoNome').value.trim();
  const nomeAntigo = document.getElementById('servico-antigo').value;
  mostrarToast("Salvando serviço...");
  await chamarGoogle("salvarTipoServico", { nome: nomeNovo, antigo: nomeAntigo });
  if (nomeAntigo) {
    const idx = tiposServicoGlobal.indexOf(nomeAntigo);
    if (idx !== -1) tiposServicoGlobal[idx] = nomeNovo;
  } else {
    if (!tiposServicoGlobal.includes(nomeNovo)) tiposServicoGlobal.push(nomeNovo);
  }
  atualizarSelectTipoServico();
  document.getElementById('formServicos').reset();
  document.getElementById('servico-antigo').value = "";
  mostrarToast("✅ Serviço salvo!", "sucesso");
  abrirConfiguracoes();
}

async function excluirConfig(aba, valor) {
  if (verificarBloqueioLeitura()) return;
  if (!confirm(`Tem certeza que deseja excluir "${valor}"?`)) return;
  mostrarToast("Excluindo...");
  const res = await chamarGoogle("excluirConfig", { aba, valor });
  if (res.status === "Sucesso") {
    if (aba === "Minhas_Empresas_Finais") { clientesGlobais = clientesGlobais.filter(c => c !== valor); atualizarDatalistEmpresas(); }
    else if (aba === "Minhas_Empresas") { agenciasGlobais = agenciasGlobais.filter(a => a.nome !== valor); atualizarSelectAgencias(); }
    else if (aba === "Minha_Equipe") { equipeGlobal = equipeGlobal.filter(e => e !== valor); atualizarSelectInterprete(); }
    else if (aba === "Tipos_Servico") { tiposServicoGlobal = tiposServicoGlobal.filter(s => s !== valor); atualizarSelectTipoServico(); }
    mostrarToast("✅ Excluído com sucesso");
    abrirConfiguracoes();
  }
}

function atualizarSelectAgencias() {
  const sel = document.getElementById('agencia'); if (!sel) return;
  const va = sel.value;
  sel.innerHTML = '<option value="" disabled selected>Escolha...</option>';
  agenciasGlobais.forEach(a => sel.innerHTML += `<option value="${a.nome}">${a.nome}</option>`);
  if (va) sel.value = va;
}
function atualizarSelectInterprete() {
  const sel = document.getElementById('interprete'); if (!sel) return;
  const va = sel.value;
  sel.innerHTML = '<option value="" disabled selected>Quem executou?</option>';
  equipeGlobal.forEach(e => sel.innerHTML += `<option value="${e}">${e}</option>`);
  if (va) sel.value = va;
}
function atualizarSelectTipoServico() {
  const sel = document.getElementById('tipoServico'); if (!sel) return;
  const va = sel.value;
  sel.innerHTML = '<option value="" disabled selected>O que foi feito?</option>';
  tiposServicoGlobal.forEach(s => sel.innerHTML += `<option value="${s}">${s}</option>`);
  if (va) sel.value = va;
}
function atualizarDatalistEmpresas() {
  const dl = document.getElementById('listaEmpresasDatalist'); if (!dl) return;
  dl.innerHTML = "";
  clientesGlobais.forEach(c => dl.innerHTML += `<option value="${c}">`);
}

// --- UTILITÁRIOS DE UI ---
function mostrarToast(mensagem, tipo = 'sucesso') {
  var container = document.getElementById('toast-container');
  var toast = document.createElement('div');
  toast.className = 'toast ' + tipo;
  toast.innerText = mensagem;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function confirmarLogout() {
  localStorage.clear();
  const fb = document.getElementById('atalho-feedback-fixo');
  if (fb) fb.style.display = 'none';
  location.reload();
}

function esconderTodasTelas() {
  document.querySelectorAll('.container-app > div:not(.feedback-atalho):not(#toast-container):not(#tela-loading)')
    .forEach(div => div.style.display = 'none');
  const feedback = document.getElementById('atalho-feedback-fixo');
  if (feedback && localStorage.getItem("user_email")) feedback.style.display = 'block';
}

function toggleCamposAgencia() {
  const isAgencia = document.getElementById('origem-a').checked;
  const box = document.getElementById('box-agencia');
  const selectAgencia = document.getElementById('agencia');
  if (isAgencia) {
    box.style.display = 'block';
    selectAgencia.setAttribute('required', 'required');
  } else {
    box.style.display = 'none';
    selectAgencia.removeAttribute('required');
    selectAgencia.value = "";
  }
}

// --- MODAIS DE CONFIRMAÇÃO ---
let confirmacaoResolve;

function esperarConfirmacao() {
  return new Promise(resolve => {
    confirmacaoResolve = resolve;
    document.getElementById('btn-confirmar-ok').onclick = () => fecharConfirmacao(true);
  });
}
function fecharConfirmacao(valor) {
  fecharModal('modal-confirmacao');
  if (confirmacaoResolve) confirmacaoResolve(valor);
}

// --- AUTENTICAÇÃO ---
// ✅ window.onload — definição única
window.onload = () => {
  inicializarPWA();

  const token = localStorage.getItem("google_access_token");
  const email = localStorage.getItem("user_email");
  const nomeCompleto = localStorage.getItem("user_name");

  if (token && email) {
    const telaHome = document.getElementById('tela-home');
    if (telaHome) telaHome.style.display = 'none';

    if (nomeCompleto && nomeCompleto !== "Usuário") {
      const spanNome = document.getElementById('nome-usuario-loading');
      if (spanNome) spanNome.innerText = nomeCompleto.split(" ")[0];
    }
    handleSaaSLogin(email);
  }
};

function solicitarAcessoSaaS() {
  const aceito = document.getElementById('aceito-termos').checked;
  if (!aceito) { mostrarToast("⚠️ Você precisa aceitar os Termos para continuar.", "erro"); return; }

  if (!window.google?.accounts?.oauth2) {
    mostrarToast("⏳ O login Google ainda está carregando. Aguarde um instante e tente novamente.", "info");
    carregarGoogleIdentityServices().catch(() => {
      mostrarToast("❌ Não foi possível carregar o login Google. Verifique sua conexão.", "erro");
    });
    return;
  }

  const client = google.accounts.oauth2.initTokenClient({
    client_id: '824713665703-lr9iacceof0mg41c0gb61lm3qia4bpr7.apps.googleusercontent.com',
    scope: 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
    ux_mode: 'popup',
    callback: (tokenResponse) => {
      if (tokenResponse && tokenResponse.access_token) {
        localStorage.setItem("google_access_token", tokenResponse.access_token);
        fetch('https://www.googleapis.com/oauth2/v3/userinfo?access_token=' + tokenResponse.access_token)
          .then(res => res.json())
          .then(data => {
            localStorage.setItem("user_email", data.email);
            localStorage.setItem("user_name", data.name || data.given_name || "Usuário");
            handleSaaSLogin(data.email);
          })
          .catch(() => {
            localStorage.setItem("user_email", "Sem email");
            localStorage.setItem("user_name", "Usuário");
            handleSaaSLogin("Sem email");
          });
      }
    },
    error_callback: () => {
      mostrarToast("❌ Falha no login Google. Tente novamente.", "erro");
    }
  });
  client.requestAccessToken();
}

async function handleSaaSLogin(email) {
  const telaLogin = document.getElementById('tela-login-google');
  if (telaLogin.style.display !== 'none' && telaLogin.style.display !== '') {
    const aceito = document.getElementById('aceito-termos').checked;
    if (!aceito) { mostrarToast("⚠️ Você precisa aceitar os Termos de Uso para entrar.", "erro"); return; }
  }

  const nomeCompleto = localStorage.getItem("user_name");
  if (nomeCompleto && nomeCompleto !== "Usuário") {
    const spanNome = document.getElementById('nome-usuario-loading');
    if (spanNome) spanNome.innerText = nomeCompleto.split(" ")[0];
  }

  executarAposDoisFrames(() => {
    document.querySelectorAll('.container-app > div').forEach(d => d.style.display = 'none');
    const loading = document.getElementById('tela-loading');
    if (loading) loading.style.display = 'flex';
  });
  localStorage.setItem("user_email", email);

  try {
    const res = await chamarGoogle("verificarAcesso");
    validarPortaria(res);
  } catch (e) {
    console.error("Erro no Login:", e);
    mostrarToast("❌ Falha na comunicação.", "erro");
    loading.style.display = 'none';
    document.getElementById('tela-home').style.display = 'block';
  }
}

async function iniciarTesteGratis() {
  document.getElementById('tela-trial').style.display = 'none';
  document.getElementById('tela-loading').style.display = 'flex';
  const nomeReal = localStorage.getItem("user_name") || "Novo Usuário";
  try {
    const res = await chamarGoogle("ativarTesteGratis", { nome: nomeReal });
    if (res && res.liberado) {
      mostrarToast("🎉 Teste de 7 dias ativado!", "sucesso");
      montarApp(res.dadosIniciais);
    } else {
      mostrarToast("❌ Erro ao ativar teste. Fale com o suporte.", "erro");
      location.reload();
    }
  } catch (err) {
    mostrarToast("❌ Erro de conexão.", "erro");
  }
}

// --- ADMIN ---
async function abrirAdmin() {
  esconderTodasTelas();
  document.getElementById('tela-admin').style.display = 'block';
  const container = document.getElementById('lista-clientes-master');
  container.innerHTML = '<div class="loader"></div>';
  try {
    const res = await chamarGoogle("buscarTodosClientes");
    container.innerHTML = "";
    if (res.clientes && res.clientes.length > 0) {
      res.clientes.forEach(c => {
        const corStatus = c.status === 'Ativo' ? '#2e7d32' : '#c62828';
        container.innerHTML += `
          <div class="item-pendente" style="border-left:5px solid ${corStatus}; margin-bottom:10px;">
            <div style="display:flex; justify-content:space-between; align-items:start;">
              <div style="flex:1;">
                <strong style="display:block; font-size:14px;">${c.nome}</strong>
                <span style="font-size:12px; color:#666;">${c.email}</span>
              </div>
              <span style="font-size:10px; padding:3px 8px; border-radius:12px; background:#f0f0f0; font-weight:bold;">${c.status}</span>
            </div>
            <div style="font-size:12px; margin-top:8px; padding-top:8px; border-top:1px solid #f0f0f0;">
              📅 Expira: <strong>${c.vencimento}</strong> | <span style="color:#9c27b0;">${c.plano || 'S/ Plano'}</span>
            </div>
            <div style="margin-top:12px; display:flex; gap:8px;">
              <button onclick="gerenciarAcesso('${c.email}','Ativo')"    style="flex:1;padding:10px;font-size:11px;background:#e8f5e9;color:#2e7d32;border:1px solid #2e7d32;border-radius:6px;cursor:pointer;font-weight:bold;">Ativar/Renovar</button>
              <button onclick="gerenciarAcesso('${c.email}','Suspenso')" style="flex:1;padding:10px;font-size:11px;background:#ffebee;color:#c62828;border:1px solid #c62828;border-radius:6px;cursor:pointer;font-weight:bold;">Bloquear</button>
            </div>
          </div>`;
      });
    } else {
      container.innerHTML = "<p style='text-align:center;color:#666;'>Nenhum cliente encontrado.</p>";
    }
  } catch (err) { mostrarToast("❌ Erro ao carregar painel master.", "erro"); }
}

async function gerenciarAcesso(emailAlvo, novoStatus) {
  document.getElementById('confirm-titulo').innerText = "Alterar Acesso";
  document.getElementById('confirm-mensagem').innerHTML = `Deseja alterar o acesso de <b>${emailAlvo}</b> para <b>${novoStatus}</b>?`;
  document.getElementById('confirm-icon').innerText = novoStatus === 'Ativo' ? "✅" : "🚫";
  document.getElementById('modal-confirmacao').style.display = 'flex';
  const confirmado = await esperarConfirmacao();
  if (confirmado) {
    mostrarToast("⏳ Atualizando...");
    const res = await chamarGoogle("alterarStatusCliente", { emailAlvo, novoStatus });
    if (res.status === "Sucesso") { mostrarToast("✅ Acesso atualizado!"); abrirAdmin(); }
    else mostrarToast("❌ Erro na atualização.", "erro");
  }
}

// --- FEEDBACK ---
async function enviarFeedback(e) {
  e.preventDefault();
  const btn = document.getElementById('btn-feedback');
  const textoOriginal = btn.innerText;
  btn.innerText = "⏳ Enviando...";
  btn.disabled = true;
  const dados = {
    "Organização": document.getElementById('fb-metodo').value,
    "Esqueceu Cobrança?": document.getElementById('fb-perda').value,
    "Tempo Gasto": document.getElementById('fb-tempo').value,
    "Profissionalismo": document.getElementById('fb-status').value,
    "Valor sugerido": document.getElementById('fb-preco').value,
    "O que falta?": document.getElementById('fb-vital').value,
    "Elogios/Sugestões": document.getElementById('fb-obs').value
  };
  try {
    await chamarGoogle("salvarFeedback", dados);
    mostrarToast("✅ Feedback recebido! Obrigado.", "sucesso");
    document.getElementById('formFeedback').reset();
    fecharModalFeedback();
  } catch (err) {
    mostrarToast("❌ Erro ao enviar. Tente novamente.", "erro");
  } finally {
    btn.innerText = textoOriginal;
    btn.disabled = false;
  }
}

// --- PERFIL ---
function carregarDadosConta() {
  document.getElementById('conta-nome').innerText = localStorage.getItem("user_name") || "Usuário";
  document.getElementById('conta-email').innerText = localStorage.getItem("user_email") || "Não identificado";
  document.getElementById('conta-plano').innerText = localStorage.getItem("user_plano") || "Padrão";
  document.getElementById('conta-validade').innerText = localStorage.getItem("user_validade") || "---";
  const foto = localStorage.getItem("user_photo");
  if (foto) aplicarFotoPerfil(foto);
}

function salvarFotoPerfil(input) {
  const file = input.files[0]; if (!file) return;
  if (file.size > 2 * 1024 * 1024) { mostrarToast("⚠️ Imagem muito grande. Use uma menor que 2MB.", "erro"); return; }
  const reader = new FileReader();
  reader.onload = (e) => { localStorage.setItem("user_photo", e.target.result); aplicarFotoPerfil(e.target.result); mostrarToast("✅ Foto atualizada!"); };
  reader.readAsDataURL(file);
}

function removerFotoPerfil() {
  localStorage.removeItem("user_photo");
  const avatar = document.getElementById('avatar-display');
  if (avatar) { avatar.innerHTML = "👤"; avatar.style.backgroundImage = ""; avatar.style.backgroundSize = ""; }
  const btnRemover = document.getElementById('btn-remover-foto');
  if (btnRemover) btnRemover.style.display = "none";
  mostrarToast("Foto removida.");
}

function aplicarFotoPerfil(base64) {
  const avatar = document.getElementById('avatar-display'); if (!avatar) return;
  avatar.innerHTML = "";
  avatar.style.backgroundImage = `url(${base64})`;
  avatar.style.backgroundSize = "cover";
  avatar.style.backgroundPosition = "center";
  const btnRemover = document.getElementById('btn-remover-foto');
  if (btnRemover) btnRemover.style.display = "flex";
}

function ativarEdicaoNome() {
  const nomeCompleto = localStorage.getItem("user_name") || "";
  const partes = nomeCompleto.split(" ");
  document.getElementById('input-nome-perfil').value = partes[0] || "";
  document.getElementById('input-sobrenome-perfil').value = partes.slice(1).join(" ") || "";
  document.getElementById('nome-display-perfil').style.display = "none";
  document.getElementById('nome-edit-perfil').style.display = "flex";
}

function cancelarEdicaoNome() {
  document.getElementById('nome-display-perfil').style.display = "flex";
  document.getElementById('nome-edit-perfil').style.display = "none";
}

function salvarNomePerfil() {
  const nome = document.getElementById('input-nome-perfil').value.trim();
  const sobrenome = document.getElementById('input-sobrenome-perfil').value.trim();
  if (!nome) { mostrarToast("⚠️ Digite ao menos o nome.", "erro"); return; }
  const nomeCompleto = sobrenome ? `${nome} ${sobrenome}` : nome;
  localStorage.setItem("user_name", nomeCompleto);
  document.getElementById('conta-nome').innerText = nomeCompleto;
  const spanLoading = document.getElementById('nome-usuario-loading');
  if (spanLoading) spanLoading.innerText = nome;
  cancelarEdicaoNome();
  mostrarToast("✅ Nome atualizado!");
}

// --- IMPORTAÇÃO ---
let loteGlobalParaImportar = [];

async function prepararImportacaoLink() {
  let url = document.getElementById('input-link-planilha').value.trim();
  if (!url) return mostrarToast("⚠️ Cole o link da planilha.", "erro");
  url = url.replace("output=csv", "output=tsv");
  if (!url.includes("output=tsv")) url += "&output=tsv";
  mostrarToast("⏳ Lendo colunas da planilha...", "info");
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Erro na leitura");
    const texto = await response.text();
    const linhas = texto.split(/\r?\n/);
    if (linhas.length < 2) return mostrarToast("⚠️ Planilha vazia.", "erro");

    const cabecalho = linhas[0].toLowerCase().split('\t');
    const findIdx = (termos) => cabecalho.findIndex(c => termos.some(t => c.includes(t)) && !c.includes("carimbo"));

    const iInterprete = findIdx(["quem interpretou", "intérprete"]);
    const iAgencia = findIdx(["intermediária", "agência", "agencia"]);
    const iEmpresa = findIdx(["empresa final", "cliente"]);
    const iData = findIdx(["data do evento", "data"]);
    const iInicio = findIdx(["horário - início", "início", "inicio"]);
    const iFim = findIdx(["horário - fim", "fim"]);
    const iTema = findIdx(["tema", "link"]);
    const iValor = findIdx(["valor total", "valor final", "valor do serviço"]);
    const iObs = findIdx(["observação", "obs"]);
    const iStatus = findIdx(["status"]);
    const iDataPgto = findIdx(["data de pagamento", "data pgto"]);
    const iTipoServico = findIdx(["tipo de serviço", "tipo do serviço"]);

    loteGlobalParaImportar = [];

    for (let i = 1; i < linhas.length; i++) {
      const cols = linhas[i].split('\t');
      if (cols.length < 5 || !cols[iData]) continue;

      let d = (cols[iData] || "").trim().split("/");
      let dataEUA = d.length === 3 ? `${d[2]}-${d[1]}-${d[0]}` : cols[iData].trim();

      let dataPgtoInfo = "", dataPgtoReal = "";
      if (iDataPgto > -1) {
        let dP = (cols[iDataPgto] || "").trim();
        if (dP && dP.includes("/")) { dataPgtoInfo = ` (Pago em: ${dP})`; dataPgtoReal = dP; }
      }

      let hrInicio = iInicio > -1 ? (cols[iInicio] || "").trim().substring(0, 5) : "";
      let hrFim = iFim > -1 ? (cols[iFim] || "").trim().substring(0, 5) : "";
      let statusLimpo = iStatus > -1 ? ((cols[iStatus] || "").toLowerCase().includes("pago") ? "Pago" : "Pendente") : "Pendente";
      let valorLimpo = padronizarMoedaBR(iValor > -1 ? cols[iValor] : "0");
      let tema = iTema > -1 ? (cols[iTema] || "").trim() : "";
      let obsOrig = iObs > -1 ? (cols[iObs] || "").trim() : "";
      let obsFinal = tema + (obsOrig ? (tema ? " | " : "") + obsOrig : "") + dataPgtoInfo;
      let agenciaLida = iAgencia > -1 ? (cols[iAgencia] || "Particular").trim() : "Particular";
      let tipoServLimpo = iTipoServico > -1 && cols[iTipoServico] ? cols[iTipoServico].trim() : "Geral";

      if (!tipoServLimpo || tipoServLimpo.toLowerCase() === "interpretação" || tipoServLimpo.toLowerCase() === agenciaLida.toLowerCase()) {
        tipoServLimpo = "Geral";
      }

      loteGlobalParaImportar.push({
        interprete: iInterprete > -1 ? (cols[iInterprete] || "Eu") : "Eu",
        agencia: agenciaLida,
        empresa: iEmpresa > -1 ? (cols[iEmpresa] || "Sem Cliente") : "Sem Cliente",
        data: dataEUA,
        inicio: hrInicio,
        fim: hrFim,
        tipoServico: tipoServLimpo,
        valorFinal: valorLimpo,
        obs: obsFinal || "Importado",
        status: statusLimpo,
        dataPgto: dataPgtoReal
      });
    }

    if (loteGlobalParaImportar.length === 0) return mostrarToast("⚠️ Nenhum serviço válido.", "erro");

    const p = loteGlobalParaImportar[0];
    document.getElementById('msg-preview-import').innerHTML = `
      <strong>Total de Serviços Lidos:</strong> ${loteGlobalParaImportar.length} linhas<br><br>
      <strong style="color:#9c27b0;">📌 Exemplo (Linha 1):</strong><br>
      <strong>🏢 Empresa/Agência:</strong> ${p.empresa} / ${p.agencia}<br>
      <strong>📅 Data:</strong> ${p.data} (${p.inicio} às ${p.fim})<br>
      <strong>💰 Valor:</strong> ${p.valorFinal} <strong>(${p.status})</strong><br>
      <strong>ℹ️ Obs:</strong> <span style="font-size:11px;">${p.obs.substring(0, 70)}...</span>
    `;
    document.getElementById('modal-confirmacao-import').style.display = 'flex';
  } catch (e) {
    console.error(e);
    mostrarToast("❌ Falha! Link incorreto ou planilha não publicada.", "erro");
  }
}

function fecharModalImport() {
  document.getElementById('modal-confirmacao-import').style.display = 'none';
  loteGlobalParaImportar = [];
}

async function executarImportacaoLote() {
  const loteSeguro = [...loteGlobalParaImportar];
  fecharModalImport();
  mostrarToast(`🚀 Importando ${loteSeguro.length} serviços...`, "info");
  try {
    const res = await chamarGoogle("importarLoteMassa", { lote: loteSeguro });
    if (res && res.status === "Sucesso") {
      mostrarToast("✅ Importação concluída com sucesso!", "sucesso");
      document.getElementById('input-link-planilha').value = "";
      voltarDashboard();
    } else {
      mostrarToast("❌ Falha ao salvar no banco de dados.", "erro");
    }
  } catch (err) { mostrarToast("❌ Erro de conexão com o banco de dados.", "erro"); }
}

function padronizarMoedaBR(valorBruto) {
  if (!valorBruto) return "R$ 0,00";
  let v = String(valorBruto).trim().replace(/R\$/gi, '').replace(/\s/g, '');
  if (v.includes(',')) { v = v.replace(/\./g, '').replace(',', '.'); }
  let n = parseFloat(v);
  return isNaN(n) ? "R$ 0,00" : "R$ " + n.toFixed(2).replace('.', ',');
}

async function perguntarDuplicacao(dadosOriginais) {
  document.getElementById('confirm-titulo').innerText = "Dividiu este evento?";
  document.getElementById('confirm-icon').innerText = "👥";
  let opcoesEquipe = equipeGlobal.filter(m => m !== dadosOriginais.interprete).map(m => `<option value="${m}">${m}</option>`).join('');
  document.getElementById('confirm-mensagem').innerHTML = `
    Este evento tem mais de 1h de duração.<br><b>Deseja duplicar para outro colega?</b><br><br>
    <select id="selecionar-duplicado" class="input-field" style="margin-top:10px; width:100%; border:1px solid #9c27b0;">
      <option value="">Não, apenas o meu</option>${opcoesEquipe}
    </select>`;
  document.getElementById('modal-confirmacao').style.display = 'flex';

  const btnOk = document.getElementById('btn-confirmar-ok');
  btnOk.onclick = null;
  btnOk.onclick = async () => {
    btnOk.disabled = true;
    const outroMembro = document.getElementById('selecionar-duplicado').value;
    if (outroMembro) {
      mostrarToast(`⏳ Duplicando para ${outroMembro}...`);
      await chamarGoogle("salvarRegistro", { ...dadosOriginais, interprete: outroMembro });
      mostrarToast("✅ Registros duplicados!");
    }
    btnOk.disabled = false;
    fecharConfirmacao(true);
    voltarDashboard();
  };
}

function fecharRegistroManual() {
  if (origemNavegacao === 'historico') abrirHistorico();
  else voltarDashboard();
}

// --- DASHBOARD DETALHADO ---
function renderizarPendenteDetalhado(detalhes) {
  const container = document.getElementById('pendente-detalhado');
  if (!container) return;

  container.style.gap = "10px";
  container.style.marginTop = "12px";

  if (!detalhes || detalhes.length <= 1) {
    container.replaceChildren();
    return;
  }

  const html = detalhes.map(item => `
    <div style="background:#fff; border:1px solid #e0e0e0; border-radius:20px; padding:6px 14px; display:flex; align-items:center; gap:8px; box-shadow:0 2px 4px rgba(0,0,0,0.03);">
      <span style="color:#555; font-size:12px; display:flex; align-items:center; gap:4px;">
        <span style="font-size:10px;">👤</span> <b>${item.nome}</b>
      </span>
      <strong style="color:#4a148c; font-size:13px; border-left:1px solid #eee; padding-left:8px;">R$ ${item.valor}</strong>
    </div>`).join("");

  container.innerHTML = html;
}
