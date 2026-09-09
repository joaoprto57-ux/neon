import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface ProgramaEmFoco {
  /** Grupo de processos que tem o terminal — quem receberia um Ctrl+C. */
  pgid: number;
  nome: string;
}

export interface SaidaTerminal {
  tipo: 'dados' | 'sistema' | 'fim';
  /** Bytes crus do PTY em base64 — preserva ANSI e UTF-8 parcial. */
  b64?: string;
  texto?: string;
  code?: number;
}

/**
 * Campos de /proc/<pid>/stat depois do `comm`.
 *
 * O `comm` vem entre parênteses e pode conter espaços e parênteses
 * ("(Web Content)"), então dividir a linha inteira por espaço erra a
 * conta. Cortar no último ')' é o jeito certo: dali para a frente os
 * campos são posicionais — [0] estado, [1] ppid, [2] pgrp, [3] sessão,
 * [4] tty, [5] tpgid.
 */
/**
 * Onde as sessões ficam gravadas.
 *
 * Tudo que passa pelo PTY é escrito num arquivo por dia. É assim que a
 * aba de gravações consegue mostrar o que o Gemini CLI respondeu: ele
 * não guarda a conversa em disco como o Claude Code guarda, mas o
 * painel enxerga cada byte que ele escreve na tela.
 *
 * Os códigos de cor ANSI são retirados na gravação — servem para pintar
 * a tela, e no arquivo só atrapalham a leitura e a busca.
 */
const DIR_GRAVACOES = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'neon', 'terminais'
);

/** Tira cores, movimentos de cursor e o resto do controle de tela. */
export function semAnsi(texto: string): string {
  return texto
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')   // títulos de janela
    .replace(/\x1b[@-Z\\-_]/g, '')                      // sequências curtas
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')            // CSI: cor, cursor…
    .replace(/\r(?!\n)/g, '\n')                         // carriage return solto
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');  // controles restantes
}

function camposDoStat(pid: number): string[] | null {
  try {
    const bruto = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const fim = bruto.lastIndexOf(')');
    if (fim < 0) return null;
    return bruto.slice(fim + 2).split(' ');
  } catch {
    return null;
  }
}

function filhosDe(pid: number): number[] {
  try {
    return fs
      .readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf-8')
      .trim().split(/\s+/).filter(Boolean).map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** Nome legível de um processo: `node …/bin/claude` vira "claude". */
function nomeDoProcesso(pid: number): string {
  const base = (p: string) => p.split('/').pop() || p;
  try {
    const partes = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').filter(Boolean);
    const primeiro = base(partes[0] || '');
    // Interpretadores dizem pouco: o que interessa é o script que rodam.
    if (/^(node|nodejs|bun|deno|python3?|npx|sh|bash|zsh)$/.test(primeiro) && partes[1]) {
      return base(partes[1]);
    }
    if (primeiro) return primeiro;
  } catch { /* processo já saiu */ }
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf-8').trim() || String(pid);
  } catch {
    return String(pid);
  }
}

/**
 * Terminal com PTY real.
 *
 * A versão anterior escrevia num `bash` ligado a pipes: sem TTY, nada de
 * cores, sem Ctrl+C de verdade e aplicações de tela cheia (vim, htop,
 * top, less) simplesmente travavam.
 *
 * Aqui o PTY vem do `script` do util-linux, que aloca um /dev/pts de
 * verdade. Vantagem sobre o node-pty: nenhum módulo nativo para compilar
 * e nenhum electron-rebuild para manter.
 */
class SessaoTerminal extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private cols = 100;
  private rows = 30;
  private arquivoGravacao: string | null = null;
  private restoLinha = '';

  /**
   * Grava no disco tudo que sai do terminal, já sem os códigos ANSI.
   *
   * Um arquivo por dia, em texto puro. É isto que permite reler depois o
   * que o Gemini CLI respondeu, ou mandar a sessão inteira para o bot
   * aprender — o painel vira a memória do que aconteceu ali.
   */
  private gravar(b: Buffer) {
    try {
      if (!this.arquivoGravacao) {
        fs.mkdirSync(DIR_GRAVACOES, { recursive: true });
        const dia = new Date().toISOString().slice(0, 10);
        this.arquivoGravacao = path.join(DIR_GRAVACOES, `terminal-${dia}.txt`);
      }
      // Guarda o pedaço incompleto: um UTF-8 cortado no meio viraria
      // caractere quebrado no arquivo.
      const texto = this.restoLinha + b.toString('utf-8');
      const corte = texto.lastIndexOf('\n');
      if (corte < 0) {
        this.restoLinha = texto.length > 8192 ? '' : texto;
        return;
      }
      this.restoLinha = texto.slice(corte + 1);
      const limpo = semAnsi(texto.slice(0, corte + 1));
      if (limpo.trim()) fs.appendFileSync(this.arquivoGravacao, limpo);
    } catch { /* gravação nunca pode derrubar o terminal */ }
  }

  /** O arquivo onde esta sessão está sendo gravada agora. */
  get gravacao(): string | null {
    return this.arquivoGravacao;
  }

  private iniciar() {
    if (this.proc) return;

    const shell = process.env.SHELL || '/bin/bash';
    const proc = spawn(
      'script',
      ['-qfc', `${shell} --login -i`, '/dev/null'],
      {
        cwd: os.homedir(),
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          COLUMNS: String(this.cols),
          LINES: String(this.rows),
        },
      }
    );

    // stdout e stderr do PTY vêm juntos; repassa os bytes intactos.
    const repassar = (b: Buffer) => {
      this.gravar(b);
      this.emit('saida', { tipo: 'dados', b64: b.toString('base64') } satisfies SaidaTerminal);
    };

    proc.stdout.on('data', repassar);
    proc.stderr.on('data', repassar);

    proc.on('exit', (code) => {
      this.proc = null;
      this.emit('saida', {
        tipo: 'fim',
        code: code ?? 0,
        texto: `\r\n\x1b[35m[sessão encerrada — a próxima tecla abre um shell novo]\x1b[0m\r\n`,
      } satisfies SaidaTerminal);
    });

    this.proc = proc;
    // Ajusta o tamanho assim que o shell estiver de pé.
    setTimeout(() => this.redimensionar(this.cols, this.rows), 250);
  }

  /** Escreve bytes crus no PTY (teclas, colagem, Ctrl+C, setas…). */
  escrever(dados: string) {
    this.iniciar();
    this.proc?.stdin.write(dados);
  }

  /**
   * Informa o novo tamanho ao terminal.
   *
   * O `script` não repassa SIGWINCH, então o ajuste vai pelo próprio
   * PTY via `stty`, que o shell executa como um comando comum.
   */
  redimensionar(cols: number, rows: number) {
    this.cols = Math.max(20, Math.min(500, Math.floor(cols) || 100));
    this.rows = Math.max(5, Math.min(200, Math.floor(rows) || 30));
    if (!this.proc) return;
    this.proc.stdin.write(`stty rows ${this.rows} cols ${this.cols} 2>/dev/null\n`);
  }

  /**
   * O programa que está em primeiro plano no PTY, quando não é o shell.
   *
   * O kernel guarda no `tpgid` do shell qual grupo de processos é dono
   * do terminal — exatamente quem receberia um Ctrl+C. Se esse grupo é
   * outro que não o do próprio shell, tem um programa rodando por cima
   * dele: o Claude Code, o Gemini, um `top`.
   */
  primeiroPlano(): ProgramaEmFoco | null {
    if (!this.proc?.pid) return null;
    // O filho do `script` é o shell — é ele que fica no /dev/pts.
    const shell = filhosDe(this.proc.pid)[0];
    if (!shell) return null;

    const campos = camposDoStat(shell);
    if (!campos) return null;
    const pgrp = Number(campos[2]);
    const tpgid = Number(campos[5]);
    if (!Number.isInteger(tpgid) || tpgid <= 0 || tpgid === pgrp) return null;

    // Cinto de segurança: o PTY vive em outra sessão, então isto nunca
    // deveria bater no grupo do Neon. Se bater, é sinal de que a leitura
    // saiu errada — melhor não mandar sinal nenhum.
    const meu = camposDoStat(process.pid);
    if (meu && Number(meu[2]) === tpgid) return null;

    return { pgid: tpgid, nome: nomeDoProcesso(tpgid) };
  }

  /**
   * Encerra o programa em primeiro plano e devolve o shell ao usuário.
   *
   * O sinal vai para o grupo inteiro (`-pgid`) porque um TUI costuma ter
   * filhos; matar só o líder deixaria órfãos segurando o terminal. E vai
   * de SIGTERM, não SIGINT: as TUIs de IA tratam o Ctrl+C como "cancela
   * a tarefa", não como "feche o programa" — é justamente por isso que
   * não dava para sair delas pelo painel.
   */
  encerrarPrimeiroPlano(sinal: NodeJS.Signals = 'SIGTERM'): {
    ok: boolean; nome?: string; erro?: string;
  } {
    const alvo = this.primeiroPlano();
    if (!alvo) return { ok: false, erro: 'Nada rodando por cima do shell.' };
    try {
      process.kill(-alvo.pgid, sinal);
      return { ok: true, nome: alvo.nome };
    } catch (e) {
      return { ok: false, erro: (e as Error).message };
    }
  }

  /** Descarta a sessão; a próxima escrita abre um shell limpo. */
  reiniciar() {
    this.proc?.kill('SIGKILL');
    this.proc = null;
  }

  get estado() {
    return {
      ativo: this.proc !== null,
      cols: this.cols,
      rows: this.rows,
      primeiroPlano: this.primeiroPlano(),
    };
  }
}

export const terminal = new SessaoTerminal();
