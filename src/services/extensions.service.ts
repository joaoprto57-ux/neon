import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

/**
 * Gerencia extensões do VS Code pela CLI `code`.
 *
 * O painel não instala extensões "dele mesmo": ele opera as do VS Code,
 * que é onde Claude Code e Antigravity de fato rodam como extensão.
 */

/** Sugestões prontas, para não precisar decorar o id de cada uma. */
export const SUGERIDAS = [
  { id: 'anthropic.claude-code', nome: 'Claude Code', grupo: 'IA', descricao: 'Assistente da Anthropic dentro do editor.' },
  { id: 'google.google-antigravity', nome: 'Antigravity (Gemini)', grupo: 'IA', descricao: 'Assistente do Google no editor.' },
  { id: 'google.geminicodeassist', nome: 'Gemini Code Assist', grupo: 'IA', descricao: 'Complemento e chat do Gemini.' },
  { id: 'continue.continue', nome: 'Continue', grupo: 'IA', descricao: 'Assistente aberto, funciona com modelo local.' },
  { id: 'ms-python.python', nome: 'Python', grupo: 'Linguagens', descricao: 'Suporte a Python.' },
  { id: 'ms-vscode.cpptools', nome: 'C/C++', grupo: 'Linguagens', descricao: 'Suporte a C e C++.' },
  { id: 'redhat.java', nome: 'Java', grupo: 'Linguagens', descricao: 'Suporte a Java.' },
  { id: 'golang.go', nome: 'Go', grupo: 'Linguagens', descricao: 'Suporte a Go.' },
  { id: 'rust-lang.rust-analyzer', nome: 'Rust', grupo: 'Linguagens', descricao: 'Suporte a Rust.' },
  { id: 'esbenp.prettier-vscode', nome: 'Prettier', grupo: 'Ferramentas', descricao: 'Formatador de código.' },
  { id: 'eamodio.gitlens', nome: 'GitLens', grupo: 'Ferramentas', descricao: 'Histórico e autoria no editor.' },
  { id: 'ms-azuretools.vscode-docker', nome: 'Docker', grupo: 'Ferramentas', descricao: 'Gerência de contêineres.' },
];

/** Um id de extensão é "publicador.nome" — nada além disso passa. */
const ID_VALIDO = /^[A-Za-z0-9][\w-]*\.[A-Za-z0-9][\w-]*$/;

function acharCode(): string | null {
  const candidatos = ['/usr/bin/code', '/usr/local/bin/code', '/snap/bin/code'];
  for (const c of candidatos) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* segue */ }
  }
  for (const d of (process.env.PATH || '').split(':').filter(Boolean)) {
    try {
      const p = path.join(d, 'code');
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* segue */ }
  }
  return null;
}

export const codeDisponivel = () => acharCode() !== null;

async function code(args: string[], timeout = 180000) {
  const bin = acharCode();
  if (!bin) throw new Error('O comando "code" do VS Code não foi encontrado.');
  // execFile com array: sem shell, então o id não vira injeção.
  const { stdout, stderr } = await execFileAsync(bin, args, {
    timeout, maxBuffer: 4 * 1024 * 1024,
  });
  return (stdout || '') + (stderr || '');
}

export async function listar(): Promise<{ id: string; versao: string }[]> {
  const saida = await code(['--list-extensions', '--show-versions'], 60000);
  return saida.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => {
      const i = l.lastIndexOf('@');
      return i > 0
        ? { id: l.slice(0, i), versao: l.slice(i + 1) }
        : { id: l, versao: '' };
    });
}

export async function instalar(id: string) {
  if (!ID_VALIDO.test(id)) throw new Error(`Id inválido: "${id}". Use publicador.nome.`);
  return code(['--install-extension', id, '--force']);
}

export async function desinstalar(id: string) {
  if (!ID_VALIDO.test(id)) throw new Error(`Id inválido: "${id}".`);
  return code(['--uninstall-extension', id]);
}

/** Sugestões + estado de instalação, para a interface. */
export async function catalogo() {
  let instaladas: { id: string; versao: string }[] = [];
  let erro: string | null = null;
  try {
    instaladas = await listar();
  } catch (e) {
    erro = (e as Error).message;
  }
  const mapa = new Map(instaladas.map((e) => [e.id.toLowerCase(), e.versao]));

  return {
    disponivel: codeDisponivel(),
    erro,
    instaladas,
    sugeridas: SUGERIDAS.map((s) => ({
      ...s,
      instalada: mapa.has(s.id.toLowerCase()),
      versao: mapa.get(s.id.toLowerCase()) || '',
    })),
  };
}
