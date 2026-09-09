// Processo principal em CommonJS de propósito.
//
// O projeto é ESM ("type": "module"), mas num main ESM o especificador
// 'electron' resolve para o pacote npm (que só exporta o caminho do
// binário) em vez do módulo interno, e o app morre com
// "does not provide an export named 'BrowserWindow'". Em CJS o require
// pega o módulo interno corretamente. Os módulos ESM do servidor são
// carregados com import() dinâmico, que funciona normalmente aqui.

const { app, BrowserWindow, Menu, Tray, shell, dialog, nativeImage } = require('electron');
const { randomBytes } = require('crypto');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const RAIZ = path.resolve(__dirname, '..');

/** import() de um arquivo do dist, por URL (exigido em Windows/ASAR). */
const carregar = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);

// ── Configuração, antes de subir o servidor ──────────────────
// O dotenv não sobrescreve o que já está no ambiente, então o que for
// definido aqui tem precedência sobre o .env.
process.env.NEON_RAIZ = RAIZ;
process.env.NEON_PYTHON_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'python')
  : RAIZ;

// Sem token as rotas respondem 503, e num app de desktop não há quem
// digite um. Reaproveita o do .env; senão gera e guarda no perfil.
if (!process.env.NEON_API_TOKEN) {
  let token = '';
  try {
    const linha = fs.readFileSync(path.join(RAIZ, '.env'), 'utf-8')
      .split('\n').find((l) => l.startsWith('NEON_API_TOKEN='));
    if (linha) token = linha.split('=')[1].trim();
  } catch { /* sem .env: segue para o perfil */ }

  const arquivoToken = path.join(app.getPath('userData'), 'token');
  if (token.length < 32) {
    try { token = fs.readFileSync(arquivoToken, 'utf-8').trim(); } catch {}
  }
  if (token.length < 32) {
    token = randomBytes(32).toString('hex');
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(arquivoToken, token, { mode: 0o600 });
    } catch {}
  }
  process.env.NEON_API_TOKEN = token;
}

// O terminal é a razão de existir do painel; vem ligado.
if (!process.env.ENABLE_TERMINAL) process.env.ENABLE_TERMINAL = 'true';
process.env.HOST = '127.0.0.1';

let servidor = null;
let janela = null;
let bandeja = null;
let porta = 0;
// Distingue "fechar a janela" (esconde) de "sair mesmo" (encerra tudo).
let encerrando = false;

// Inicia sem abrir a janela — usado pelo atalho de autostart.
const INICIAR_OCULTO = process.argv.includes('--oculto');

// ── Iniciar com o sistema ────────────────────────────────────
// Escrito à mão em vez de app.setLoginItemSettings: no Linux o
// comportamento varia entre versões do Electron, e aqui o caminho do
// executável precisa ser o do AppImage, não o do binário desempacotado.
const DIR_AUTOSTART = path.join(
  process.env.XDG_CONFIG_HOME || path.join(app.getPath('home'), '.config'),
  'autostart'
);
const ARQ_AUTOSTART = path.join(DIR_AUTOSTART, 'neon.desktop');

/** Caminho estável para reabrir o app: o .AppImage, quando houver. */
function executavel() {
  return process.env.APPIMAGE || process.execPath;
}

const autostartAtivo = () => fs.existsSync(ARQ_AUTOSTART);

/**
 * Ícone para o atalho. Prefere o instalado no tema do sistema: o
 * caminho de dentro do AppImage muda a cada execução (é um ponto de
 * montagem temporário) e não serve para um atalho permanente.
 */
function iconeAtalho() {
  const noTema = path.join(
    app.getPath('home'),
    '.local/share/icons/hicolor/256x256/apps/neon.png'
  );
  return fs.existsSync(noTema) ? 'neon' : path.join(RAIZ, 'build', 'icon.png');
}

function definirAutostart(ligar) {
  try {
    if (!ligar) {
      if (fs.existsSync(ARQ_AUTOSTART)) fs.unlinkSync(ARQ_AUTOSTART);
      return true;
    }
    fs.mkdirSync(DIR_AUTOSTART, { recursive: true });
    fs.writeFileSync(ARQ_AUTOSTART, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Neon',
      'Comment=Painel local de vigilância',
      `Exec=${executavel()} --oculto`,
      `Icon=${iconeAtalho()}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      // Dá tempo da bandeja do sistema existir antes do app aparecer.
      'X-GNOME-Autostart-Delay=8',
      '',
    ].join('\n'));
    return true;
  } catch (e) {
    console.error('[neon] falha ao configurar autostart:', e.message);
    return false;
  }
}

/** Sobe o Express numa porta livre — evita brigar com a 3000 do agy. */
async function iniciarServidor() {
  const { default: expressApp } = await carregar('dist/app.js');
  // Porta fixa por padrão: com porta sorteada, a página aberta perde o
  // endereço a cada reinício do servidor e não tem como se reconectar.
  // Se a porta estiver ocupada, cai para uma sorteada e segue.
  const preferida = Number(process.env.NEON_PORTA) || 8899;

  const tentar = (alvo) => new Promise((resolve, reject) => {
    const s = expressApp.listen(alvo, '127.0.0.1', () => {
      servidor = s;
      porta = s.address().port;
      console.log(`[neon] servidor interno em http://127.0.0.1:${porta}`);
      resolve(porta);
    });
    s.on('error', reject);
  });

  try {
    return await tentar(preferida);
  } catch (e) {
    console.log(`[neon] porta ${preferida} ocupada (${e.code}); sorteando outra`);
    return tentar(0);
  }
}

function criarJanela() {
  janela = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    title: 'Neon',
    icon: path.join(RAIZ, 'build', 'icon.png'),
    // A página vem do próprio processo, em loopback. Ainda assim roda
    // sem Node integrado e com isolamento de contexto: se a interface
    // for comprometida, não ganha nada além do que a API já expõe.
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Necessário para a aba do Gemini, que roda o site num <webview>
      // isolado — o equivalente a uma extensão de navegador aqui dentro.
      // O webview tem processo e sessão próprios; não herda nada do painel.
      webviewTag: true,
    },
    show: false,
  });

  janela.once('ready-to-show', () => {
    if (!INICIAR_OCULTO) janela.show();
  });
  janela.loadURL(`http://127.0.0.1:${porta}/`);

  janela.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Fechar a janela esconde o app; ele continua vigiando pela bandeja.
  // Sair de verdade é pelo menu da bandeja ou Ctrl+Q.
  janela.on('close', (e) => {
    if (encerrando) return;
    e.preventDefault();
    janela.hide();
  });
}

function mostrarJanela() {
  if (!janela) return criarJanela();
  if (janela.isMinimized()) janela.restore();
  janela.show();
  janela.focus();
}

function montarBandeja() {
  const icone = nativeImage
    .createFromPath(path.join(RAIZ, 'build', 'icon-64.png'))
    .resize({ width: 22, height: 22 });

  bandeja = new Tray(icone);
  bandeja.setToolTip('Neon — vigilância local');

  const atualizarMenu = () => {
    bandeja.setContextMenu(Menu.buildFromTemplate([
      { label: 'Abrir painel', click: mostrarJanela },
      { type: 'separator' },
      {
        label: 'Iniciar com o sistema',
        type: 'checkbox',
        checked: autostartAtivo(),
        click: (item) => { definirAutostart(item.checked); atualizarMenu(); },
      },
      {
        label: 'Abrir pasta de relatórios',
        click: () => shell.openPath(path.join(app.getPath('home'), 'neon-relatorios')),
      },
      { type: 'separator' },
      { label: 'Sair do Neon', click: () => { encerrando = true; app.quit(); } },
    ]));
  };

  atualizarMenu();
  bandeja.on('click', mostrarJanela);
}

function montarMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Neon',
      submenu: [
        { label: 'Recarregar painel', accelerator: 'CmdOrCtrl+R', click: () => janela && janela.reload() },
        {
          label: 'Abrir pasta de relatórios',
          click: () => shell.openPath(path.join(app.getPath('home'), 'neon-relatorios')),
        },
        { type: 'separator' },
        { label: 'Ferramentas de desenvolvedor', accelerator: 'F12', click: () => janela && janela.webContents.toggleDevTools() },
        {
          label: 'Iniciar com o sistema',
          type: 'checkbox',
          checked: autostartAtivo(),
          click: (item) => definirAutostart(item.checked),
        },
        { type: 'separator' },
        {
          label: 'Fechar janela (segue na bandeja)',
          accelerator: 'CmdOrCtrl+W',
          click: () => janela && janela.hide(),
        },
        {
          label: 'Sair do Neon',
          accelerator: 'CmdOrCtrl+Q',
          click: () => { encerrando = true; app.quit(); },
        },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Colar' },
        { role: 'selectAll', label: 'Selecionar tudo' },
      ],
    },
    {
      label: 'Exibir',
      submenu: [
        { role: 'zoomIn', label: 'Aumentar zoom' },
        { role: 'zoomOut', label: 'Diminuir zoom' },
        { role: 'resetZoom', label: 'Zoom normal' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Tela cheia' },
      ],
    },
  ]));
}

// Uma instância só: abrir de novo apenas foca a janela existente.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    mostrarJanela();
  });

  app.whenReady().then(async () => {
    try {
      await iniciarServidor();
      montarMenu();
      criarJanela();
      montarBandeja();
    } catch (e) {
      dialog.showErrorBox(
        'Neon não conseguiu iniciar',
        `${e.message}\n\nVerifique se o python3 e o psutil estão instalados:\n` +
          'pip install -r requirements.txt'
      );
      app.quit();
    }
  });
}

// Sem isto o app morreria ao esconder a janela, que é justamente o
// comportamento que queremos evitar: ele fica vigiando na bandeja.
app.on('window-all-closed', () => {
  if (encerrando) app.quit();
});

app.on('activate', mostrarJanela);

/** Encerra os filhos: daemon Python, PTY e scripts em execução. */
app.on('before-quit', async () => {
  try {
    const [{ daemon }, { terminal }, { scripts }] = await Promise.all([
      carregar('dist/services/neon.service.js'),
      carregar('dist/services/terminal.service.js'),
      carregar('dist/services/scripts.service.js'),
    ]);
    try {
      const { vscode } = await carregar('dist/services/vscode.service.js');
      vscode.parar();
    } catch { /* nunca subiu */ }
    daemon.encerrar();
    terminal.reiniciar();
    scripts.pararTodos();
  } catch { /* já encerrado */ }
  if (servidor) servidor.close();
});
