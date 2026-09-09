import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import path from 'path';
import readline from 'readline';

// Em desenvolvimento os .py ficam na raiz do projeto; no app
// empacotado eles vão para resources/python. O Electron informa o
// caminho certo por NEON_PYTHON_DIR.
const PROJECT_DIR =
  process.env.NEON_PYTHON_DIR || path.resolve(import.meta.dirname, '..', '..');

interface Pendente {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Mantém o worker Python vivo e faz o casamento pergunta/resposta por id.
 * Se o processo morrer, é reiniciado na próxima chamada.
 */
class NeonDaemon {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pendentes = new Map<number, Pendente>();
  private proximoId = 1;
  private reiniciando = false;

  private iniciar() {
    if (this.proc) return;

    const proc = spawn('python3', ['-u', 'neon_daemon.py'], {
      cwd: PROJECT_DIR,
      env: { ...process.env, PYTHONPATH: PROJECT_DIR, PYTHONUNBUFFERED: '1' },
    });

    readline.createInterface({ input: proc.stdout }).on('line', (linha) => {
      if (!linha.trim()) return;
      let msg: { id?: number; ok?: boolean; data?: unknown; error?: string };
      try {
        msg = JSON.parse(linha);
      } catch {
        return; // linha não-JSON: ignora
      }
      if (typeof msg.id !== 'number') return;
      const p = this.pendentes.get(msg.id);
      if (!p) return;
      this.pendentes.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error || 'Erro no daemon'));
    });

    // Logs do Python vão para stderr; ecoa prefixado para não confundir.
    readline.createInterface({ input: proc.stderr }).on('line', (l) => {
      if (l.trim()) console.error('[py]', l);
    });

    proc.on('exit', (code) => {
      console.error(`[neon] daemon encerrou (código ${code}); será reiniciado.`);
      this.proc = null;
      for (const [id, p] of this.pendentes) {
        clearTimeout(p.timer);
        p.reject(new Error('Daemon encerrou durante a requisição'));
        this.pendentes.delete(id);
      }
    });

    this.proc = proc;
  }

  /** Envia um comando ao worker e aguarda a resposta correspondente. */
  chamar<T = unknown>(cmd: string, timeoutMs = 20000): Promise<T> {
    this.iniciar();
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error('Daemon indisponível'));

    const id = this.proximoId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendentes.delete(id);
        reject(new Error(`Timeout no comando '${cmd}' (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendentes.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      proc.stdin.write(JSON.stringify({ id, cmd }) + '\n');
    });
  }

  encerrar() {
    this.proc?.kill();
    this.proc = null;
  }

  get vivo() {
    return this.proc !== null && !this.proc.killed;
  }
}

export const daemon = new NeonDaemon();
