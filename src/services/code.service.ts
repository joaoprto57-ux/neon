import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { acervo, RAIZ_CODIGOS as RAIZ_ACERVO } from './arquivo.service.js';

/**
 * Linguagens do editor.
 *
 * `monaco` é o id do realce de sintaxe — vale para todas, mesmo as que
 * não podem ser executadas aqui. `checar` é o binário que precisa
 * existir para rodar; `script` monta a linha de comando, recebendo o
 * diretório temporário e o arquivo já gravado.
 */
export const LINGUAGENS = {
  python: {
    nome: 'Python', monaco: 'python', ext: 'py', checar: 'python3',
    script: (d: string, f: string) => `cd ${d} && python3 -u ${f}`,
    exemplo: 'print("Olá do Neon")\n',
  },
  javascript: {
    nome: 'JavaScript', monaco: 'javascript', ext: 'mjs', checar: 'node',
    script: (d: string, f: string) => `cd ${d} && node ${f}`,
    exemplo: 'console.log("Olá do Neon");\n',
  },
  typescript: {
    nome: 'TypeScript', monaco: 'typescript', ext: 'ts', checar: 'npx',
    script: (d: string, f: string) => `cd ${d} && npx --yes tsx ${f}`,
    exemplo: 'const msg: string = "Olá do Neon";\nconsole.log(msg);\n',
  },
  bash: {
    nome: 'Bash', monaco: 'shell', ext: 'sh', checar: 'bash',
    script: (d: string, f: string) => `cd ${d} && bash ${f}`,
    exemplo: 'echo "Olá do Neon"\nuname -a\n',
  },
  c: {
    nome: 'C', monaco: 'c', ext: 'c', checar: 'gcc',
    script: (d: string, f: string) => `cd ${d} && gcc ${f} -o prog -lm && ./prog`,
    exemplo: '#include <stdio.h>\n\nint main(void) {\n    printf("Olá do Neon\\n");\n    return 0;\n}\n',
  },
  cpp: {
    nome: 'C++', monaco: 'cpp', ext: 'cpp', checar: 'g++',
    script: (d: string, f: string) => `cd ${d} && g++ -std=c++17 ${f} -o prog && ./prog`,
    exemplo: '#include <iostream>\n\nint main() {\n    std::cout << "Olá do Neon\\n";\n}\n',
  },
  java: {
    nome: 'Java', monaco: 'java', ext: 'java', checar: 'javac',
    // O arquivo é gravado com o nome da classe pública (ver nomeArquivo).
    script: (d: string, f: string) =>
      `cd ${d} && javac ${f} && java -cp ${d} ${path.basename(f, '.java')}`,
    exemplo: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Olá do Neon");\n    }\n}\n',
  },
  go: {
    nome: 'Go', monaco: 'go', ext: 'go', checar: 'go',
    script: (d: string, f: string) => `cd ${d} && go run ${f}`,
    exemplo: 'package main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Olá do Neon")\n}\n',
  },
  rust: {
    nome: 'Rust', monaco: 'rust', ext: 'rs', checar: 'rustc',
    script: (d: string, f: string) => `cd ${d} && rustc ${f} -o prog && ./prog`,
    exemplo: 'fn main() {\n    println!("Olá do Neon");\n}\n',
  },
  php: {
    nome: 'PHP', monaco: 'php', ext: 'php', checar: 'php',
    script: (d: string, f: string) => `cd ${d} && php ${f}`,
    exemplo: '<?php\necho "Olá do Neon\\n";\n',
  },
  ruby: {
    nome: 'Ruby', monaco: 'ruby', ext: 'rb', checar: 'ruby',
    script: (d: string, f: string) => `cd ${d} && ruby ${f}`,
    exemplo: 'puts "Olá do Neon"\n',
  },
  perl: {
    nome: 'Perl', monaco: 'perl', ext: 'pl', checar: 'perl',
    script: (d: string, f: string) => `cd ${d} && perl ${f}`,
    exemplo: 'print "Olá do Neon\\n";\n',
  },
  lua: {
    nome: 'Lua', monaco: 'lua', ext: 'lua', checar: 'lua',
    script: (d: string, f: string) => `cd ${d} && lua ${f}`,
    exemplo: 'print("Olá do Neon")\n',
  },
  sql: {
    nome: 'SQL (SQLite)', monaco: 'sql', ext: 'sql', checar: 'sqlite3',
    script: (d: string, f: string) => `cd ${d} && sqlite3 :memory: < ${f}`,
    exemplo: "SELECT 'Olá do Neon' AS mensagem;\n",
  },
  // Sem execução: servem para escrever, destacar e salvar.
  html: { nome: 'HTML', monaco: 'html', ext: 'html', checar: null, script: null, exemplo: '<h1>Olá do Neon</h1>\n' },
  css: { nome: 'CSS', monaco: 'css', ext: 'css', checar: null, script: null, exemplo: 'body { color: #38bdf8; }\n' },
  json: { nome: 'JSON', monaco: 'json', ext: 'json', checar: null, script: null, exemplo: '{\n  "projeto": "neon"\n}\n' },
  yaml: { nome: 'YAML', monaco: 'yaml', ext: 'yaml', checar: null, script: null, exemplo: 'projeto: neon\n' },
  markdown: { nome: 'Markdown', monaco: 'markdown', ext: 'md', checar: null, script: null, exemplo: '# Olá do Neon\n' },
  dockerfile: { nome: 'Dockerfile', monaco: 'dockerfile', ext: 'Dockerfile', checar: null, script: null, exemplo: 'FROM debian:stable-slim\n' },
} as const;

export type ChaveLinguagem = keyof typeof LINGUAGENS;

export interface EventoCodigo {
  tipo: 'inicio' | 'saida' | 'fim' | 'erro';
  texto?: string;
  code?: number;
  ms?: number;
}

const DIR_TRABALHO = path.join(os.tmpdir(), `neon-code-${process.pid}`);
const DIR_SALVOS = path.join(os.homedir(), 'neon-codigos');
const TIMEOUT_MS = 30000;

/** Cache de "o binário existe?" — evita um which por execução. */
const disponivel = new Map<string, boolean>();

function temBinario(bin: string | null): boolean {
  if (!bin) return false;
  if (disponivel.has(bin)) return disponivel.get(bin)!;
  const dirs = (process.env.PATH || '').split(':').filter(Boolean);
  const achou = dirs.some((d) => {
    try {
      fs.accessSync(path.join(d, bin), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  disponivel.set(bin, achou);
  return achou;
}

/**
 * Nome do arquivo para o código. Em Java o arquivo precisa se chamar
 * como a classe pública, senão o javac recusa a compilar.
 */
function nomeArquivo(chave: ChaveLinguagem, codigo: string): string {
  const def = LINGUAGENS[chave];
  if (chave === 'java') {
    const m = codigo.match(/public\s+class\s+([A-Za-z_$][\w$]*)/);
    return `${m ? m[1] : 'Main'}.java`;
  }
  if (chave === 'dockerfile') return 'Dockerfile';
  return `programa.${def.ext}`;
}

class ExecutorCodigo extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private saida: string[] = [];

  get rodando() {
    return this.proc !== null;
  }

  /** Catálogo para a interface, com o que dá para executar aqui. */
  catalogo() {
    return Object.fromEntries(
      (Object.keys(LINGUAGENS) as ChaveLinguagem[]).map((k) => {
        const d = LINGUAGENS[k];
        return [k, {
          nome: d.nome,
          monaco: d.monaco,
          ext: d.ext,
          exemplo: d.exemplo,
          executavel: d.script !== null,
          disponivel: d.script !== null && temBinario(d.checar),
          requer: d.checar,
        }];
      })
    );
  }

  executar(chave: ChaveLinguagem, codigo: string): { ok: boolean; erro?: string } {
    if (this.proc) return { ok: false, erro: 'Já existe uma execução em andamento.' };

    const def = LINGUAGENS[chave];
    if (!def) return { ok: false, erro: 'Linguagem desconhecida.' };
    if (!def.script) return { ok: false, erro: `${def.nome} não é executável — serve para escrever e salvar.` };
    if (!temBinario(def.checar)) {
      return { ok: false, erro: `${def.nome} precisa de "${def.checar}", que não está instalado nesta máquina.` };
    }

    let arquivo: string;
    try {
      fs.mkdirSync(DIR_TRABALHO, { recursive: true });
      arquivo = path.join(DIR_TRABALHO, nomeArquivo(chave, codigo));
      fs.writeFileSync(arquivo, codigo, 'utf-8');
    } catch (e) {
      return { ok: false, erro: `Falha ao gravar o arquivo: ${(e as Error).message}` };
    }

    const inicio = Date.now();
    this.saida = [];
    this.emit('evento', { tipo: 'inicio' } satisfies EventoCodigo);

    // bash -c porque as linguagens compiladas precisam de "compila && roda".
    // Os caminhos são gerados aqui, não vêm do usuário.
    const proc = spawn('bash', ['-c', def.script(DIR_TRABALHO, arquivo)], {
      cwd: DIR_TRABALHO,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      detached: true, // grupo próprio: permite matar os filhos junto
    });
    this.proc = proc;

    const registrar = (b: Buffer) => {
      const texto = b.toString();
      this.saida.push(texto);
      if (this.saida.length > 2000) this.saida.shift();
      this.emit('evento', { tipo: 'saida', texto } satisfies EventoCodigo);
    };
    proc.stdout.on('data', registrar);
    proc.stderr.on('data', registrar);

    const limite = setTimeout(() => {
      if (this.proc === proc) {
        this.emit('evento', {
          tipo: 'erro',
          texto: `\n[interrompido: passou de ${TIMEOUT_MS / 1000}s]\n`,
        } satisfies EventoCodigo);
        this.parar();
      }
    }, TIMEOUT_MS);

    proc.on('error', (e) => {
      clearTimeout(limite);
      this.proc = null;
      this.emit('evento', { tipo: 'erro', texto: e.message } satisfies EventoCodigo);
    });

    proc.on('exit', (code) => {
      clearTimeout(limite);
      this.proc = null;
      this.emit('evento', {
        tipo: 'fim', code: code ?? 0, ms: Date.now() - inicio,
      } satisfies EventoCodigo);
    });

    return { ok: true };
  }

  parar(): boolean {
    if (!this.proc) return false;
    try {
      // Mata o grupo: o compilador e o binário gerado vão junto.
      process.kill(-this.proc.pid!, 'SIGKILL');
    } catch {
      this.proc.kill('SIGKILL');
    }
    return true;
  }

  /** Salva o código no acervo, junto com o que o Claude escreve. */
  salvar(chave: ChaveLinguagem, codigo: string, nome?: string): string {
    const def = LINGUAGENS[chave];
    const limpo = (nome || '').replace(/[^\w.\-+]/g, '').slice(0, 60);
    const padrao = chave === 'dockerfile' ? 'Dockerfile' : `codigo.${def.ext}`;

    const item = acervo.arquivar({
      conteudo: codigo,
      nome: limpo || padrao,
      linguagem: def.monaco,
      fonte: 'editor',
    });
    if (item) return path.join(RAIZ_ACERVO, item.caminho);

    // Conteúdo idêntico já arquivado: devolve onde ele está.
    const existente = acervo.listar(limpo || padrao, 1)[0];
    return existente
      ? path.join(RAIZ_ACERVO, existente.caminho)
      : path.join(RAIZ_ACERVO, limpo || padrao);
  }
}

export const codigo = new ExecutorCodigo();
