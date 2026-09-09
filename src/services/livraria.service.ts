import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Livraria.
 *
 * O acervo (arquivo.service) guarda código solto, um arquivo por bloco.
 * A livraria guarda o que foi *aprendido*: a conversa inteira, com a
 * explicação junto do código, organizada em estantes:
 *
 *   ~/neon-livraria/
 *     seguranca/
 *       imap-do-interceptor.md
 *     esp32/
 *       calibrar-o-mpu6050.md
 *
 * Cada verbete é um .md de verdade, com um cabeçalho simples no topo.
 * Nada de banco: dá para ler, editar e versionar por fora do painel,
 * e o índice é remontado varrendo a pasta — se você mexer nos arquivos
 * à mão, o painel acompanha.
 */

export const RAIZ_LIVRARIA = path.join(os.homedir(), 'neon-livraria');

export interface Verbete {
  id: string;            // nome do arquivo, sem .md — é o identificador
  titulo: string;
  estante: string;       // pasta; "geral" quando não informada
  etiquetas: string[];
  criado: number;
  atualizado: number;
  linhas: number;
  bytes: number;
  blocos: number;        // quantos blocos de código o texto tem
  caminho: string;       // relativo à raiz
}

export interface VerbeteCompleto extends Verbete {
  corpo: string;
}

/** Vira nome de pasta/arquivo: sem acento, sem barra, sem espaço. */
function slug(texto: string, reserva = 'sem-titulo'): string {
  const s = texto
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || reserva;
}

const idValido = (id: string) => /^[a-z0-9][a-z0-9-]{0,79}$/.test(id);

/** Conta ``` de abertura — serve só para mostrar "3 blocos" na lista. */
function contarBlocos(corpo: string): number {
  const m = corpo.match(/^```/gm);
  return m ? Math.floor(m.length / 2) : 0;
}

function montarArquivo(v: {
  titulo: string; estante: string; etiquetas: string[];
  criado: number; atualizado: number; corpo: string;
}): string {
  return [
    '---',
    `titulo: ${v.titulo.replace(/\n/g, ' ')}`,
    `estante: ${v.estante}`,
    `etiquetas: ${v.etiquetas.join(', ')}`,
    `criado: ${new Date(v.criado).toISOString()}`,
    `atualizado: ${new Date(v.atualizado).toISOString()}`,
    '---',
    '',
    v.corpo.replace(/\r\n/g, '\n'),
  ].join('\n');
}

/** Separa cabeçalho e corpo. Arquivo sem cabeçalho ainda é lido. */
function lerArquivo(texto: string): { cab: Record<string, string>; corpo: string } {
  const m = texto.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { cab: {}, corpo: texto };
  const cab: Record<string, string> = {};
  for (const linha of m[1].split('\n')) {
    const p = linha.indexOf(':');
    if (p > 0) cab[linha.slice(0, p).trim()] = linha.slice(p + 1).trim();
  }
  return { cab, corpo: texto.slice(m[0].length).replace(/^\n/, '') };
}

class Livraria {
  private indice: Verbete[] | null = null;

  /** Caminho absoluto conferido: um "../.." não sai da livraria. */
  private dentroDaRaiz(relativo: string): string | null {
    const completo = path.resolve(RAIZ_LIVRARIA, relativo);
    if (completo !== RAIZ_LIVRARIA && !completo.startsWith(RAIZ_LIVRARIA + path.sep)) {
      return null;
    }
    return completo;
  }

  /** Varre a pasta e remonta o índice. Barato: são arquivos pequenos. */
  private varrer(): Verbete[] {
    const achados: Verbete[] = [];
    let estantes: string[];
    try {
      estantes = fs.readdirSync(RAIZ_LIVRARIA, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return achados;      // ainda não existe
    }

    for (const estante of estantes) {
      let arquivos: string[];
      try {
        arquivos = fs.readdirSync(path.join(RAIZ_LIVRARIA, estante))
          .filter((f) => f.endsWith('.md'));
      } catch { continue; }

      for (const arquivo of arquivos) {
        const relativo = path.join(estante, arquivo);
        try {
          const texto = fs.readFileSync(path.join(RAIZ_LIVRARIA, relativo), 'utf-8');
          const { cab, corpo } = lerArquivo(texto);
          const st = fs.statSync(path.join(RAIZ_LIVRARIA, relativo));
          const id = arquivo.slice(0, -3);
          achados.push({
            id,
            titulo: cab.titulo || id,
            estante: cab.estante || estante,
            etiquetas: (cab.etiquetas || '').split(',').map((s) => s.trim()).filter(Boolean),
            criado: cab.criado ? Date.parse(cab.criado) || st.birthtimeMs : st.birthtimeMs,
            atualizado: cab.atualizado ? Date.parse(cab.atualizado) || st.mtimeMs : st.mtimeMs,
            linhas: corpo.split('\n').length,
            bytes: st.size,
            blocos: contarBlocos(corpo),
            caminho: relativo,
          });
        } catch { /* arquivo ilegível: pula só ele */ }
      }
    }
    achados.sort((a, b) => b.atualizado - a.atualizado);
    return achados;
  }

  private carregar(): Verbete[] {
    if (!this.indice) this.indice = this.varrer();
    return this.indice;
  }

  /** Força uma nova varredura — o botão "atualizar" do painel. */
  recarregar(): Verbete[] {
    this.indice = null;
    return this.carregar();
  }

  /**
   * Busca por título, estante ou etiqueta. Com `dentro`, procura também
   * no texto do verbete — custa I/O, então é opt-in.
   */
  listar(busca = '', dentro = false): Verbete[] {
    const todos = this.carregar();
    const b = busca.trim().toLowerCase();
    if (!b) return todos;

    return todos.filter((v) => {
      const cabecalho =
        v.titulo.toLowerCase().includes(b) ||
        v.estante.toLowerCase().includes(b) ||
        v.etiquetas.some((e) => e.toLowerCase().includes(b));
      if (cabecalho || !dentro) return cabecalho;
      try {
        const completo = this.dentroDaRaiz(v.caminho);
        if (!completo) return false;
        return fs.readFileSync(completo, 'utf-8').toLowerCase().includes(b);
      } catch {
        return false;
      }
    });
  }

  ler(id: string): VerbeteCompleto | null {
    if (!idValido(id)) return null;
    const meta = this.carregar().find((v) => v.id === id);
    if (!meta) return null;
    const completo = this.dentroDaRaiz(meta.caminho);
    if (!completo) return null;
    try {
      const { corpo } = lerArquivo(fs.readFileSync(completo, 'utf-8'));
      return { ...meta, corpo };
    } catch {
      return null;
    }
  }

  /**
   * Cria ou atualiza. Sem `id`, cria um a partir do título (com sufixo
   * numérico se já existir). Mudar de estante move o arquivo.
   */
  salvar(dados: {
    id?: string;
    titulo: string;
    estante?: string;
    etiquetas?: string[];
    corpo: string;
  }): Verbete {
    const titulo = (dados.titulo || '').trim() || 'Sem título';
    const estante = slug(dados.estante || 'geral', 'geral');
    const etiquetas = (dados.etiquetas || []).map((e) => e.trim()).filter(Boolean);
    const corpo = dados.corpo ?? '';
    const agora = Date.now();

    const antigo = dados.id ? this.carregar().find((v) => v.id === dados.id) : undefined;
    if (dados.id && !idValido(dados.id)) throw new Error('Identificador inválido.');

    let id = antigo?.id;
    if (!id) {
      const base = slug(titulo);
      id = base;
      let n = 2;
      while (this.carregar().some((v) => v.id === id)) id = `${base}-${n++}`;
    }

    const dir = path.join(RAIZ_LIVRARIA, estante);
    const relativo = path.join(estante, `${id}.md`);
    const completo = this.dentroDaRaiz(relativo);
    if (!completo) throw new Error('Caminho fora da livraria.');

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(completo, montarArquivo({
      titulo, estante, etiquetas,
      criado: antigo?.criado || agora,
      atualizado: agora,
      corpo,
    }), 'utf-8');

    // Trocou de estante: remove o arquivo da prateleira antiga.
    if (antigo && antigo.caminho !== relativo) {
      const anterior = this.dentroDaRaiz(antigo.caminho);
      if (anterior) { try { fs.unlinkSync(anterior); } catch { /* já sumiu */ } }
    }

    this.indice = null;
    return this.carregar().find((v) => v.id === id)!;
  }

  excluir(id: string): boolean {
    if (!idValido(id)) return false;
    const meta = this.carregar().find((v) => v.id === id);
    if (!meta) return false;
    const completo = this.dentroDaRaiz(meta.caminho);
    if (!completo) return false;
    try {
      fs.unlinkSync(completo);
      this.indice = null;
      return true;
    } catch {
      return false;
    }
  }

  abrirPasta(estante?: string): boolean {
    let alvo = RAIZ_LIVRARIA;
    if (estante) {
      const completo = this.dentroDaRaiz(slug(estante, 'geral'));
      if (completo) alvo = completo;
    }
    try {
      fs.mkdirSync(alvo, { recursive: true });
      const p = spawn('xdg-open', [alvo], { detached: true, stdio: 'ignore' });
      p.unref();
      return true;
    } catch {
      return false;
    }
  }

  get resumo() {
    const todos = this.carregar();
    const porEstante: Record<string, number> = {};
    let bytes = 0, blocos = 0;
    for (const v of todos) {
      porEstante[v.estante] = (porEstante[v.estante] || 0) + 1;
      bytes += v.bytes;
      blocos += v.blocos;
    }
    return {
      raiz: RAIZ_LIVRARIA,
      total: todos.length,
      bytes,
      blocos,
      estantes: Object.keys(porEstante).sort(),
      porEstante,
    };
  }
}

export const livraria = new Livraria();
