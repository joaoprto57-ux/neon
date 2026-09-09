import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Em desenvolvimento os .py ficam na raiz do projeto; no app
// empacotado eles vão para resources/python. O Electron informa o
// caminho certo por NEON_PYTHON_DIR.
const PROJECT_DIR =
  process.env.NEON_PYTHON_DIR || path.resolve(import.meta.dirname, '..', '..');

/**
 * Os bots do cérebro moram na Área de trabalho, não no projeto — foi
 * onde o João os escreveu. O nome da pasta muda com o idioma e com a
 * versão do sistema, então procura-se em vez de adivinhar.
 */
const DIR_BOTS = [
  path.join(os.homedir(), 'Área de trabalho'),
  path.join(os.homedir(), 'Área de Trabalho'),
  path.join(os.homedir(), 'Desktop'),
  os.homedir(),
].find((d) => fs.existsSync(path.join(d, 'cerebro_textos.py'))) ?? os.homedir();

/** Scripts do Neon que podem ser executados a partir do painel. */
export const SCRIPTS = {
  watchdog: {
    nome: 'Vigilância de rede',
    descricao: 'Varredura contínua de conexões e ameaças.',
    args: ['neon_watchdog.py'],
    continuo: true,
  },
  'ai-monitor': {
    nome: 'Monitor de IA',
    descricao: 'Rastreia processos de IA e uso de recursos.',
    args: ['neon_ai_monitor.py'],
    continuo: true,
  },
  interceptor: {
    nome: 'Interceptador de e-mail',
    descricao: 'Uma patrulha IMAP, com a política definida no .env.',
    args: ['neon_interceptor.py', '--uma-vez'],
    continuo: false,
  },
  emails: {
    nome: 'Listar e-mails',
    descricao: 'Mostra as mensagens não lidas da caixa de entrada.',
    args: ['neon_emails.py', 'listar', '-n', '25'],
    continuo: false,
  },
  banco: {
    nome: 'Teste do banco',
    descricao: 'Verifica a conexão com o PostgreSQL.',
    args: ['neon_core.py'],
    continuo: false,
  },

  // ── Os bots do cérebro ────────────────────────────────────
  vigia: {
    nome: '🧠 Vigia — o que lê',
    descricao: 'Relê os arquivos que mudaram e descobre o que ainda não sabe. Grátis.',
    args: ['cerebro_vigia.py', '--intervalo', '600'],
    continuo: true,
    dir: DIR_BOTS,
  },
  guardiao: {
    nome: '🛡️ Guardião — o que grita',
    descricao: 'Vigia sintaxe e código solto. Abre o bloco de notas quando você quebra algo. Grátis.',
    args: ['guardiao.py', '--intervalo', '60'],
    continuo: true,
    dir: DIR_BOTS,
  },
  professor: {
    nome: '📚 Professor — o que ensina de graça',
    descricao: 'Escreve aula na Livraria a partir do que já sabe. Não gasta nada.',
    args: ['professor.py', '--intervalo', '1800'],
    continuo: true,
    dir: DIR_BOTS,
  },
  assistente: {
    nome: '💸 Assistente — o que trabalha sozinho (PAGO)',
    descricao: 'Resolve desafios e escreve aulas com o Opus 5. Respeita o teto de gasto.',
    args: ['assistente.py'],
    continuo: true,
    dir: DIR_BOTS,
  },
  extrato: {
    nome: '💰 Extrato do assistente',
    descricao: 'Quanto já foi gasto com a API, tarefa por tarefa.',
    args: ['assistente.py', '--extrato'],
    continuo: false,
    dir: DIR_BOTS,
  },
} as const;

export type ChaveScript = keyof typeof SCRIPTS;

export interface EventoScript {
  script: ChaveScript;
  tipo: 'inicio' | 'saida' | 'fim' | 'erro';
  texto?: string;
  code?: number;
}

interface Execucao {
  proc: ChildProcessWithoutNullStreams;
  iniciadoEm: number;
}

const LIMITE_LINHAS = 5000;

/**
 * Executa os scripts Python do projeto, mantém o histórico da saída em
 * memória e permite salvá-lo em arquivo. Um script por chave: pedir
 * "iniciar" num que já roda não duplica o processo.
 */
class GerenciadorScripts extends EventEmitter {
  private execucoes = new Map<ChaveScript, Execucao>();
  // A saída sobrevive ao fim do processo: sem isso não dava para
  // salvar o relatório de um script que já terminou.
  private historico = new Map<ChaveScript, string[]>();

  iniciar(chave: ChaveScript): { ok: boolean; motivo?: string } {
    if (this.execucoes.has(chave)) {
      return { ok: false, motivo: 'Este script já está em execução.' };
    }
    const def = SCRIPTS[chave];
    if (!def) return { ok: false, motivo: 'Script desconhecido.' };

    // Cada script roda na SUA pasta: os do Neon no projeto, os bots do
    // cérebro na Área de trabalho, onde ficam o cerebro.db e os módulos
    // que eles importam.
    const dir = (def as { dir?: string }).dir ?? PROJECT_DIR;
    const proc = spawn('python3', ['-u', ...def.args], {
      cwd: dir,
      env: { ...process.env, PYTHONPATH: dir, PYTHONUNBUFFERED: '1' },
    });

    const exec: Execucao = { proc, iniciadoEm: Date.now() };
    this.execucoes.set(chave, exec);
    this.historico.set(chave, []);

    const registrar = (b: Buffer) => {
      const texto = b.toString();
      const acc = this.historico.get(chave)!;
      for (const linha of texto.split('\n')) {
        if (linha) acc.push(linha);
      }
      while (acc.length > LIMITE_LINHAS) acc.shift();
      this.emit('evento', { script: chave, tipo: 'saida', texto } satisfies EventoScript);
    };

    // Os módulos do Neon logam em stderr e emitem dados em stdout;
    // no painel os dois formam uma saída só.
    proc.stdout.on('data', registrar);
    proc.stderr.on('data', registrar);

    proc.on('error', (e) => {
      this.emit('evento', { script: chave, tipo: 'erro', texto: e.message } satisfies EventoScript);
      this.execucoes.delete(chave);
    });

    proc.on('exit', (code) => {
      this.execucoes.delete(chave);
      this.emit('evento', { script: chave, tipo: 'fim', code: code ?? 0 } satisfies EventoScript);
    });

    this.emit('evento', { script: chave, tipo: 'inicio' } satisfies EventoScript);
    return { ok: true };
  }

  parar(chave: ChaveScript): boolean {
    const exec = this.execucoes.get(chave);
    if (!exec) return false;
    exec.proc.kill('SIGTERM');
    // Se ignorar o SIGTERM, encerra à força.
    setTimeout(() => {
      if (this.execucoes.has(chave)) exec.proc.kill('SIGKILL');
    }, 3000).unref();
    return true;
  }

  pararTodos() {
    for (const chave of [...this.execucoes.keys()]) this.parar(chave);
  }

  linhas(chave: ChaveScript): string[] {
    return this.historico.get(chave) ?? [];
  }

  /** Grava a saída acumulada num arquivo e devolve o caminho. */
  salvar(chave: ChaveScript, conteudo: string): string {
    const dir = path.join(os.homedir(), 'neon-relatorios');
    fs.mkdirSync(dir, { recursive: true });
    const carimbo = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const arquivo = path.join(dir, `${chave}-${carimbo}.log`);
    fs.writeFileSync(arquivo, conteudo, 'utf-8');
    return arquivo;
  }

  get estado() {
    return Object.fromEntries(
      (Object.keys(SCRIPTS) as ChaveScript[]).map((k) => {
        const e = this.execucoes.get(k);
        return [k, {
          nome: SCRIPTS[k].nome,
          descricao: SCRIPTS[k].descricao,
          continuo: SCRIPTS[k].continuo,
          rodando: !!e,
          desde: e ? e.iniciadoEm : null,
          linhas: (this.historico.get(k) ?? []).length,
        }];
      })
    );
  }
}

export const scripts = new GerenciadorScripts();
