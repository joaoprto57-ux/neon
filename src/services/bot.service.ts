import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

/**
 * Conversa com o bot de estudos (cerebro_bot.py) sem sair do painel.
 *
 * O bot é um programa de terminal: ele abre, conversa e fecha. Para o
 * painel falar com ele existe o modo `--responder`, que recebe uma
 * pergunta, imprime a resposta em JSON e encerra. Um processo por
 * pergunta — nada fica de pé entre uma e outra.
 *
 * O banco (cerebro.db) mora ao lado do script, então o processo roda a
 * partir da pasta dele. Rodando de outro lugar, o bot criaria um banco
 * vazio novo e responderia que não sabe nada.
 */

const CANDIDATOS = [
  path.join(os.homedir(), 'Área de trabalho', 'cerebro_bot.py'),
  path.join(os.homedir(), 'Área de Trabalho', 'cerebro_bot.py'),
  path.join(os.homedir(), 'Desktop', 'cerebro_bot.py'),
  path.join(os.homedir(), 'cerebro_bot.py'),
];

export interface RespostaBot {
  tipo: 'ficha' | 'receita' | 'texto' | 'nada';
  pergunta: string;
  resposta?: string;
  titulo?: string;
  codigo?: string;
  explicacao?: string;
  linguagem?: string;
  linguagem_nome?: string;
  fonte?: string;
  secao?: string;
}

function localizar(): string | null {
  for (const c of CANDIDATOS) {
    try {
      fs.accessSync(c, fs.constants.R_OK);
      return c;
    } catch { /* tenta o próximo */ }
  }
  return null;
}

export const botInstalado = () => localizar() !== null;

export function estadoBot() {
  const caminho = localizar();
  return { instalado: caminho !== null, caminho };
}

/**
 * Onde toda conversa com o bot fica guardada.
 *
 * Na Área de trabalho, à vista — o objetivo é você poder abrir, reler e
 * usar como material de estudo sem precisar caçar em pasta escondida.
 * Um arquivo por dia, em texto puro.
 */
function pastaDasConversas(): string {
  const candidatas = ['Área de trabalho', 'Área de Trabalho', 'Desktop'];
  for (const nome of candidatas) {
    const dir = path.join(os.homedir(), nome);
    if (fs.existsSync(dir)) return path.join(dir, 'Conversas do Bot');
  }
  return path.join(os.homedir(), 'Conversas do Bot');
}

function guardarConversa(pergunta: string, resposta: RespostaBot) {
  try {
    const pasta = pastaDasConversas();
    fs.mkdirSync(pasta, { recursive: true });
    const dia = new Date().toISOString().slice(0, 10);
    const hora = new Date().toLocaleTimeString('pt-BR');

    let corpo = `\n[${hora}]  VOCÊ: ${pergunta}\n`;
    if (resposta.tipo === 'receita') {
      corpo += `           BOT : ${resposta.titulo} [${resposta.linguagem_nome}]\n\n`;
      corpo += (resposta.codigo || '').split('\n').map((l) => `    ${l}`).join('\n');
      corpo += `\n\n    ${resposta.explicacao || ''}\n`;
    } else if (resposta.tipo === 'texto') {
      corpo += `           BOT : (do texto ${resposta.fonte} — ${resposta.secao})\n`;
      corpo += (resposta.resposta || '').split('\n').map((l) => `    ${l}`).join('\n') + '\n';
    } else {
      corpo += `           BOT : ${resposta.resposta || ''}\n`;
    }

    fs.appendFileSync(path.join(pasta, `conversa-${dia}.txt`), corpo);
  } catch { /* guardar nunca pode derrubar a resposta */ }
}

export function ondeFicamAsConversas(): string {
  return pastaDasConversas();
}

export async function perguntar(pergunta: string): Promise<RespostaBot> {
  const script = localizar();
  if (!script) {
    return {
      tipo: 'nada',
      pergunta,
      resposta: 'Não achei o cerebro_bot.py. Ele deveria estar na Área de trabalho.',
    };
  }

  // execFile com array de argumentos: sem shell, então a pergunta não
  // vira comando por mais que tenha aspas, ponto e vírgula ou crase.
  const { stdout } = await execFileAsync(
    'python3',
    [path.basename(script), '--responder', pergunta],
    { cwd: path.dirname(script), timeout: 30000, maxBuffer: 4 * 1024 * 1024 }
  );

  // O bot pode imprimir avisos antes do JSON (migração de banco, carga
  // inicial de receitas). O que interessa é a última linha.
  const linhas = stdout.trim().split('\n').filter((l) => l.trim());
  const ultima = linhas[linhas.length - 1] || '';
  let resposta: RespostaBot;
  try {
    resposta = JSON.parse(ultima) as RespostaBot;
  } catch {
    resposta = { tipo: 'nada', pergunta, resposta: stdout.trim() || 'Sem resposta.' };
  }
  guardarConversa(pergunta, resposta);
  return resposta;
}


/**
 * Corrige/analisa um código colado, sem sair do painel.
 *
 * O código vai pela entrada padrão, não por argumento: código tem
 * aspas, cifrão e quebra de linha, e nada disso sobrevive inteiro a uma
 * linha de comando.
 */
export function corrigir(codigo: string, linguagem = 'python'): Promise<unknown> {
  const script = localizar();
  if (!script) return Promise.resolve({ ok: false, erro: 'cerebro_bot.py não encontrado.' });

  return new Promise((resolve) => {
    const proc = spawn('python3', [path.basename(script), '--corrigir', linguagem],
      { cwd: path.dirname(script) });
    let saida = '';
    proc.stdout.on('data', (b) => { saida += b.toString(); });
    proc.on('error', (e) => resolve({ ok: false, erro: e.message }));
    proc.on('close', () => {
      const linhas = saida.trim().split('\n').filter((l) => l.trim());
      try {
        resolve(JSON.parse(linhas[linhas.length - 1] || ''));
      } catch {
        resolve({ ok: false, erro: 'não entendi a resposta do bot', bruto: saida.slice(0, 500) });
      }
    });
    const limite = setTimeout(() => proc.kill('SIGKILL'), 20000);
    proc.on('close', () => clearTimeout(limite));
    proc.stdin.end(codigo);
  });
}

/**
 * Abre um arquivo, pasta ou endereço no programa padrão do sistema.
 *
 * Usa o `xdg-open`, que é quem decide o que abre o quê: PDF no leitor,
 * pasta no gerenciador de arquivos, link no navegador. Deliberadamente
 * NÃO executa comando de shell — para isso existe o terminal do painel,
 * onde você vê o que está rodando. Aqui é só "abrir".
 */
/**
 * Manda o bot procurar sozinho: relê o que mudou e devolve os termos
 * que aparecem muito nos textos e que ele ainda não sabe explicar.
 *
 * Não é o bot "pensando" — é ele comparando o que está nos textos com
 * o que está no cérebro. O que sobra é o que falta aprender.
 */
/** Guarda um código colado como receita nova — o bot aprendendo com você. */
export function guardarCodigo(pedido: {
  codigo: string; linguagem?: string; titulo?: string;
  chaves?: string; explicacao?: string;
}): Promise<unknown> {
  const script = localizar();
  if (!script) return Promise.resolve({ ok: false, erro: 'cerebro_bot.py não encontrado.' });
  return new Promise((resolve) => {
    const proc = spawn('python3', [path.basename(script), '--guardar'],
      { cwd: path.dirname(script) });
    let saida = '';
    proc.stdout.on('data', (b) => { saida += b.toString(); });
    proc.on('error', (e) => resolve({ ok: false, erro: e.message }));
    const limite = setTimeout(() => proc.kill('SIGKILL'), 20000);
    proc.on('close', () => {
      clearTimeout(limite);
      const linhas = saida.trim().split('\n').filter((l) => l.trim());
      try {
        resolve(JSON.parse(linhas[linhas.length - 1] || ''));
      } catch {
        resolve({ ok: false, erro: 'não entendi a resposta do bot' });
      }
    });
    proc.stdin.end(JSON.stringify(pedido));
  });
}

export function descobrir(): Promise<unknown> {
  const script = localizar();
  if (!script) return Promise.resolve({ ok: false, erro: 'cerebro_bot.py não encontrado.' });
  return new Promise((resolve) => {
    const proc = spawn('python3', [path.basename(script), '--descobrir'],
      { cwd: path.dirname(script) });
    let saida = '';
    proc.stdout.on('data', (b) => { saida += b.toString(); });
    proc.on('error', (e) => resolve({ ok: false, erro: e.message }));
    // A varredura relê arquivos: dois minutos é folga, não otimismo.
    const limite = setTimeout(() => proc.kill('SIGKILL'), 120000);
    proc.on('close', () => {
      clearTimeout(limite);
      const linhas = saida.trim().split('\n').filter((l) => l.trim());
      try {
        resolve(JSON.parse(linhas[linhas.length - 1] || ''));
      } catch {
        resolve({ ok: false, erro: 'varredura não terminou a tempo' });
      }
    });
  });
}

export function abrir(alvo: string): { ok: boolean; alvo?: string; erro?: string } {
  const limpo = alvo.trim();
  if (!limpo) return { ok: false, erro: 'Diga o que abrir.' };
  if (limpo.length > 500) return { ok: false, erro: 'Caminho longo demais.' };

  // Um alvo só. Sem isso, "arquivo.txt; rm -rf ~" seria uma frase válida.
  if (/[\n\r\0]/.test(limpo)) return { ok: false, erro: 'Um alvo por vez.' };

  const ehEndereco = /^https?:\/\//i.test(limpo);
  let destino = limpo;

  if (!ehEndereco) {
    destino = limpo.startsWith('~')
      ? path.join(os.homedir(), limpo.slice(1))
      : path.resolve(limpo.startsWith('/') ? limpo : path.join(os.homedir(), limpo));
    if (!fs.existsSync(destino)) {
      return { ok: false, erro: `Não achei "${limpo}" na máquina.` };
    }
  }

  try {
    const proc = spawn('xdg-open', [destino], { detached: true, stdio: 'ignore' });
    proc.unref();
    return { ok: true, alvo: destino };
  } catch (e) {
    return { ok: false, erro: e instanceof Error ? e.message : String(e) };
  }
}
