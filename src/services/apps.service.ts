import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { terminal } from './terminal.service.js';

/**
 * Aplicativos que o painel sabe abrir.
 *
 * `modo` decide como abrir:
 *  - 'terminal' — é um programa de texto (TUI); vai para o terminal do
 *    painel, no PTY que já existe. Abrir num processo solto seria
 *    inútil: não haveria onde ele desenhar.
 *  - 'gui' — janela própria, processo destacado do Neon.
 */
export const APPS = {
  claude: {
    nome: 'Claude Code',
    descricao: 'Assistente de código da Anthropic, no terminal.',
    modo: 'terminal' as const,
    candidatos: [
      path.join(os.homedir(), '.npm-global/bin/claude'),
      path.join(os.homedir(), '.local/bin/claude'),
      '/usr/local/bin/claude',
      '/usr/bin/claude',
    ],
    comando: 'claude',
  },
  gemini: {
    nome: 'Gemini CLI',
    descricao: 'Assistente do Google, no terminal.',
    modo: 'terminal' as const,
    candidatos: [
      path.join(os.homedir(), '.npm-global/bin/gemini'),
      path.join(os.homedir(), '.local/bin/gemini'),
      '/usr/local/bin/gemini',
      '/usr/bin/gemini',
    ],
    comando: 'gemini',
  },
  antigravity: {
    nome: 'Antigravity',
    descricao: 'IDE com Gemini, do Google.',
    modo: 'gui' as const,
    candidatos: [
      path.join(os.homedir(), '.gemini/bin/agy'),
      '/usr/local/bin/agy',
      '/usr/bin/agy',
    ],
    comando: null,
  },
  vscode: {
    nome: 'VS Code',
    descricao: 'Editor completo.',
    modo: 'gui' as const,
    candidatos: ['/usr/bin/code', '/usr/local/bin/code', '/snap/bin/code'],
    comando: null,
  },
  vigia: {
    nome: 'Vigia do Bot',
    descricao: 'O segundo bot: fica lendo e descobrindo o que falta aprender.',
    modo: 'terminal' as const,
    candidatos: [
      path.join(os.homedir(), 'Área de trabalho/cerebro_vigia.py'),
      path.join(os.homedir(), 'Área de Trabalho/cerebro_vigia.py'),
      path.join(os.homedir(), 'Desktop/cerebro_vigia.py'),
    ],
    comando: 'vigia',
  },
  cerebro: {
    nome: 'Bot Python',
    descricao: 'O bot que lê textos e explica código, no terminal.',
    modo: 'terminal' as const,
    // Não é binário no PATH: é um script. O "candidato" é o próprio
    // arquivo, e o comando roda ele com o python3 da máquina.
    candidatos: [
      path.join(os.homedir(), 'Área de trabalho/cerebro_bot.py'),
      path.join(os.homedir(), 'Área de Trabalho/cerebro_bot.py'),
      path.join(os.homedir(), 'Desktop/cerebro_bot.py'),
      path.join(os.homedir(), 'cerebro_bot.py'),
    ],
    comando: 'cerebro',
  },
} as const;

export type ChaveApp = keyof typeof APPS;

/** Primeiro candidato que existe e é executável, ou o do PATH. */
function localizar(chave: ChaveApp): string | null {
  const def = APPS[chave];
  for (const c of def.candidatos) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch { /* tenta o próximo */ }
  }
  const nome = path.basename(def.candidatos[0]);
  for (const d of (process.env.PATH || '').split(':').filter(Boolean)) {
    try {
      const p = path.join(d, nome);
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* segue */ }
  }
  return null;
}

/**
 * Diretório real onde abrir o aplicativo.
 *
 * NEON_RAIZ não serve: no app empacotado ela aponta para dentro do
 * asar (`/tmp/.mount_Neon…/resources/app.asar`), que existe para o
 * Electron mas não para o shell nem para outros programas — o `cd`
 * falhava com "não é um diretório" e o app nunca abria.
 */
function resolverDiretorio(pedido?: string): string {
  const utilizavel = (p?: string) => {
    if (!p || p.includes('.asar') || p.startsWith('/tmp/.mount_')) return false;
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };

  if (utilizavel(pedido)) return pedido!;
  if (utilizavel(process.env.NEON_DIR_TRABALHO)) return process.env.NEON_DIR_TRABALHO!;
  if (utilizavel(process.env.NEON_RAIZ)) return process.env.NEON_RAIZ!;
  return os.homedir();
}

export function catalogoApps() {
  return Object.fromEntries(
    (Object.keys(APPS) as ChaveApp[]).map((k) => {
      const caminho = localizar(k);
      return [k, {
        nome: APPS[k].nome,
        descricao: APPS[k].descricao,
        modo: APPS[k].modo,
        instalado: caminho !== null,
        caminho,
      }];
    })
  );
}

export function abrirApp(chave: ChaveApp, diretorio?: string): {
  ok: boolean; modo?: string; erro?: string;
} {
  const def = APPS[chave];
  if (!def) return { ok: false, erro: 'Aplicativo desconhecido.' };

  const caminho = localizar(chave);
  if (!caminho) {
    return { ok: false, erro: `${def.nome} não foi encontrado nesta máquina.` };
  }

  const alvo = resolverDiretorio(diretorio);

  if (def.modo === 'terminal') {
    // Script Python não é binário no PATH: roda com o python3, e a
    // partir da própria pasta dele — senão o banco de dados que ele
    // cria ao lado (cerebro.db) apareceria onde o terminal estivesse.
    const linha = caminho.endsWith('.py')
      ? `cd ${JSON.stringify(path.dirname(caminho))} && python3 ${JSON.stringify(path.basename(caminho))}`
      : `cd ${JSON.stringify(alvo)} && ${def.comando}`;

    // Entra no PTY do painel: é lá que um TUI tem onde desenhar.
    terminal.escrever(`${linha}\n`);
    return { ok: true, modo: 'terminal' };
  }

  const proc = spawn(caminho, [alvo], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  proc.unref(); // sobrevive ao Neon
  return { ok: true, modo: 'gui' };
}
