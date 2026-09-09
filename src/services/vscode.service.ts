import { spawn, ChildProcess, execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

/**
 * VS Code dentro do painel, via code-server.
 *
 * É o VS Code (OSS) servido por HTTP — árvore de arquivos, terminal e
 * extensões — carregado num webview. Diferente da aba Editor, que usa
 * só o Monaco (o núcleo de edição, sem o resto da IDE).
 *
 * Como o acesso é protegido
 * -------------------------
 * O code-server escuta num **socket Unix**, não numa porta TCP: não
 * existe endereço de rede para alcançá-lo, nem mesmo em loopback. Na
 * frente dele fica um proxy que só repassa quem apresenta um segredo
 * gerado a cada subida.
 *
 * A versão anterior abria uma porta TCP com `--auth none`, e qualquer
 * processo local entrava no editor sem pedir licença.
 *
 * O proxy existe (em vez de servir sob um subcaminho do painel) porque
 * o code-server assume estar na raiz; atrás de um prefixo, os caminhos
 * dos recursos e do WebSocket quebram.
 */

const DIR_DADOS = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'neon', 'code-server'
);
const DIR_CONFIG = path.join(DIR_DADOS, 'config');
const DIR_USER = path.join(DIR_DADOS, 'user-data');
const DIR_EXT = path.join(DIR_DADOS, 'extensions');
const SOCKET = path.join(os.tmpdir(), `neon-vscode-${process.pid}.sock`);

const COOKIE = 'neon_vs';
const ROTA_AUTH = '/__neon-entrar';

/** Extensões instaladas na primeira subida. */
const EXTENSOES_PADRAO = ['anthropic.claude-code', 'google.geminicodeassist'];

function localizar(): string | null {
  const candidatos = [
    path.join(os.homedir(), '.local/bin/code-server'),
    path.join(os.homedir(), '.local/lib/code-server/bin/code-server'),
    path.join(os.homedir(), '.npm-global/bin/code-server'),
    '/usr/local/bin/code-server',
    '/usr/bin/code-server',
  ];
  for (const c of candidatos) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* segue */ }
  }
  for (const d of (process.env.PATH || '').split(':').filter(Boolean)) {
    try {
      const p = path.join(d, 'code-server');
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* segue */ }
  }
  return null;
}

function lerCookie(cabecalho: string | undefined, nome: string): string | null {
  if (!cabecalho) return null;
  for (const parte of cabecalho.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nome) return v.join('=');
  }
  return null;
}

/** Comparação em tempo constante, para o segredo não vazar por timing. */
function iguais(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

class ServidorVSCode {
  private proc: ChildProcess | null = null;
  private proxy: http.Server | null = null;
  private porta = 0;
  private segredo = '';
  private subindo: Promise<Resultado> | null = null;
  private pronto = false;
  private log: string[] = [];

  get instalado() {
    return localizar() !== null;
  }

  get estado() {
    return {
      instalado: this.instalado,
      rodando: this.pronto && this.proc !== null,
      porta: this.porta,
      // A URL leva o segredo: é ela que instala o cookie no webview.
      url: this.pronto ? `http://127.0.0.1:${this.porta}${ROTA_AUTH}?t=${this.segredo}` : null,
      pasta: this.pastaValida(),
      socket: SOCKET,
      log: this.log.slice(-12),
    };
  }

  async iniciar(pasta?: string): Promise<Resultado> {
    if (this.pronto && this.proc) {
      return { ok: true, porta: this.porta, url: this.estado.url! };
    }
    if (this.subindo) return this.subindo;
    this.subindo = this.subir(pasta).finally(() => { this.subindo = null; });
    return this.subindo;
  }

  private async subir(pasta?: string): Promise<Resultado> {
    const bin = localizar();
    if (!bin) {
      return { ok: false, erro: 'code-server não encontrado. Instale-o para usar esta aba.' };
    }

    const alvo = this.pastaValida(pasta);
    for (const d of [DIR_CONFIG, DIR_USER, DIR_EXT]) fs.mkdirSync(d, { recursive: true });
    try { fs.unlinkSync(SOCKET); } catch { /* não existia */ }

    // Socket Unix em vez de porta: sem endereço de rede, o editor não é
    // alcançável por outro processo via TCP. O modo de acesso do arquivo
    // ainda limita quem consegue abri-lo.
    const proc = spawn(bin, [
      '--socket', SOCKET,
      '--socket-mode', '600',
      '--auth', 'none',          // a barreira é o proxy, não a senha
      '--disable-telemetry',
      '--disable-update-check',
      '--disable-workspace-trust',
      '--user-data-dir', DIR_USER,
      '--extensions-dir', DIR_EXT,
      '--config', path.join(DIR_CONFIG, 'config.yaml'),
      alvo,
    ], { env: this.ambienteLimpo(), stdio: ['ignore', 'pipe', 'pipe'] });

    const registrar = (b: Buffer) => {
      for (const l of b.toString().split('\n')) if (l.trim()) this.log.push(l.trim());
      while (this.log.length > 60) this.log.shift();
    };
    proc.stdout?.on('data', registrar);
    proc.stderr?.on('data', registrar);
    proc.on('exit', (code) => {
      this.log.push(`[code-server encerrou com código ${code}]`);
      this.proc = null;
      this.pronto = false;
      this.fecharProxy();
    });
    this.proc = proc;

    if (!(await this.esperarSocket())) {
      return { ok: false, erro: 'code-server não subiu a tempo.', log: this.log.slice(-6) };
    }

    this.segredo = crypto.randomBytes(24).toString('hex');
    try {
      this.porta = await this.abrirProxy();
    } catch (e) {
      return { ok: false, erro: `falha ao abrir o proxy: ${(e as Error).message}` };
    }

    this.pronto = true;
    this.garantirExtensoes();
    return { ok: true, porta: this.porta, url: this.estado.url! };
  }

  /** Proxy autenticado: cookie válido, ou 401. */
  private abrirProxy(): Promise<number> {
    return new Promise((resolve, reject) => {
      const servidor = http.createServer((req, res) => {
        const url = req.url || '/';

        // Entrada: troca o segredo da URL por um cookie e redireciona.
        if (url.startsWith(ROTA_AUTH)) {
          const t = new URL(url, 'http://x').searchParams.get('t') || '';
          if (!this.segredo || !iguais(t, this.segredo)) {
            res.writeHead(401).end('Segredo inválido.');
            return;
          }
          res.writeHead(302, {
            'Set-Cookie': `${COOKIE}=${this.segredo}; Path=/; HttpOnly; SameSite=Lax`,
            Location: '/',
          }).end();
          return;
        }

        if (!this.autorizado(req)) {
          res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
             .end('Acesso ao VS Code só pelo painel do Neon.');
          return;
        }

        const alvo = http.request(
          { socketPath: SOCKET, path: url, method: req.method, headers: req.headers },
          (resp) => {
            res.writeHead(resp.statusCode || 502, resp.headers);
            resp.pipe(res);
          }
        );
        alvo.on('error', () => { if (!res.headersSent) res.writeHead(502).end('code-server fora do ar'); });
        req.pipe(alvo);
      });

      // O VS Code usa WebSocket para tudo; sem repassar o upgrade a
      // janela abre e fica em branco.
      servidor.on('upgrade', (req, socket, head) => {
        if (!this.autorizado(req)) { socket.destroy(); return; }
        const alvo = net.connect(SOCKET, () => {
          const cabecalhos = Object.entries(req.headers)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
            .join('\r\n');
          alvo.write(`${req.method} ${req.url} HTTP/1.1\r\n${cabecalhos}\r\n\r\n`);
          if (head?.length) alvo.write(head);
          alvo.pipe(socket);
          socket.pipe(alvo);
        });
        alvo.on('error', () => socket.destroy());
        socket.on('error', () => alvo.destroy());
      });

      servidor.on('error', reject);
      servidor.listen(0, '127.0.0.1', () => {
        this.proxy = servidor;
        resolve((servidor.address() as net.AddressInfo).port);
      });
    });
  }

  private autorizado(req: http.IncomingMessage): boolean {
    const c = lerCookie(req.headers.cookie, COOKIE);
    return !!c && !!this.segredo && iguais(c, this.segredo);
  }

  /**
   * Ambiente sem as variáveis do Neon.
   * O code-server obedece PORT e BIND_ADDR do ambiente, e o app carrega
   * PORT=3100 do .env — ele tentava subir na porta do painel e morria
   * com EADDRINUSE, ignorando o endereço que eu passei.
   */
  private ambienteLimpo(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: DIR_CONFIG };
    for (const chave of [
      'PORT', 'BIND_ADDR', 'PASSWORD', 'HASHED_PASSWORD', 'CODE_SERVER_CONFIG',
      'HOST', 'ELECTRON_RUN_AS_NODE',
      'NEON_API_TOKEN', 'EMAIL_USER', 'EMAIL_PASS', 'DATABASE_URL',
    ]) delete env[chave];
    return env;
  }

  /** Só diretórios reais; nada de caminho de dentro do pacote. */
  private pastaValida(pedida?: string): string {
    const testar = (p?: string) => {
      if (!p || p.includes('.asar') || p.startsWith('/tmp/.mount_')) return false;
      try { return fs.statSync(p).isDirectory(); } catch { return false; }
    };
    if (testar(pedida)) return pedida!;
    if (testar(process.env.NEON_DIR_TRABALHO)) return process.env.NEON_DIR_TRABALHO!;
    return os.homedir();
  }

  /** Espera o socket existir e aceitar conexão. */
  private async esperarSocket(tentativas = 60): Promise<boolean> {
    for (let i = 0; i < tentativas; i++) {
      if (!this.proc) return false;
      if (fs.existsSync(SOCKET)) {
        const ok = await new Promise<boolean>((resolve) => {
          const s = net.connect(SOCKET);
          s.on('connect', () => { s.destroy(); resolve(true); });
          s.on('error', () => resolve(false));
          setTimeout(() => { s.destroy(); resolve(false); }, 400);
        });
        if (ok) return true;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  private async garantirExtensoes() {
    const bin = localizar();
    if (!bin) return;
    for (const id of EXTENSOES_PADRAO) {
      try {
        const jaTem = fs.readdirSync(DIR_EXT)
          .some((d) => d.toLowerCase().startsWith(id.toLowerCase()));
        if (jaTem) continue;
        this.log.push(`instalando extensão ${id}…`);
        await execFileAsync(bin, ['--extensions-dir', DIR_EXT, '--install-extension', id],
          { timeout: 180000, env: this.ambienteLimpo() });
        this.log.push(`extensão ${id} instalada`);
      } catch (e) {
        this.log.push(`falhou ${id}: ${(e as Error).message.split('\n')[0]}`);
      }
    }
  }

  private fecharProxy() {
    try { this.proxy?.close(); } catch { /* já fechado */ }
    this.proxy = null;
    this.segredo = '';
    this.porta = 0;
  }

  parar() {
    this.proc?.kill('SIGTERM');
    this.proc = null;
    this.pronto = false;
    this.fecharProxy();
    try { fs.unlinkSync(SOCKET); } catch { /* já removido */ }
  }
}

interface Resultado {
  ok: boolean;
  porta?: number;
  url?: string;
  erro?: string;
  log?: string[];
}

export const vscode = new ServidorVSCode();
