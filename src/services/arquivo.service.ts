import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Arquivo de códigos.
 *
 * Todo bloco de código que passa pelo espelho ao vivo vira também um
 * arquivo de verdade em disco, organizado por dia:
 *
 *   ~/neon-codigos/
 *     2026-09-04/
 *       22-15-30_dashboard.html
 *       22-16-02_claudewatch.service.ts
 *     indice.jsonl
 *
 * O índice é o que permite buscar depois sem varrer o disco inteiro.
 */

export const RAIZ_CODIGOS = path.join(os.homedir(), 'neon-codigos');
const ARQ_INDICE = path.join(RAIZ_CODIGOS, 'indice.jsonl');

export interface ItemArquivo {
  caminho: string;      // relativo à raiz, é o identificador
  nome: string;         // nome original do arquivo
  origem?: string;      // caminho completo de onde veio
  ts: number;
  data: string;         // AAAA-MM-DD
  linguagem: string;
  linhas: number;
  bytes: number;
  hash: string;         // conteúdo, para não guardar a mesma coisa duas vezes
  fonte: 'claude' | 'editor';
}

/** Nome de arquivo seguro: nada de barra, nem nome vazio, nem gigante. */
function limparNome(nome: string): string {
  const limpo = path.basename(nome).replace(/[^\w.\-+]/g, '_').slice(0, 80);
  return limpo || 'sem-nome.txt';
}

const doisDigitos = (n: number) => String(n).padStart(2, '0');

class ArquivoCodigos {
  private indice: ItemArquivo[] = [];
  private hashes = new Set<string>();
  private carregado = false;

  private carregar() {
    if (this.carregado) return;
    this.carregado = true;
    try {
      const linhas = fs.readFileSync(ARQ_INDICE, 'utf-8').split('\n').filter(Boolean);
      for (const l of linhas) {
        try {
          const item = JSON.parse(l) as ItemArquivo;
          this.indice.push(item);
          this.hashes.add(item.hash);
        } catch { /* linha truncada por queda: ignora só ela */ }
      }
    } catch { /* ainda não existe */ }
  }

  /**
   * Guarda um código. Devolve o item criado, ou null se o conteúdo
   * idêntico já estiver arquivado — reescrever o mesmo arquivo dez
   * vezes não deve virar dez cópias iguais.
   */
  arquivar(opcoes: {
    conteudo: string;
    nome: string;
    origem?: string;
    linguagem?: string;
    ts?: number;
    fonte?: 'claude' | 'editor';
  }): ItemArquivo | null {
    this.carregar();
    const { conteudo, origem, linguagem = 'plaintext', fonte = 'claude' } = opcoes;
    if (!conteudo.trim()) return null;

    const hash = crypto.createHash('sha1').update(conteudo).digest('hex').slice(0, 16);
    if (this.hashes.has(hash)) return null;

    const quando = new Date(opcoes.ts || Date.now());
    const data = `${quando.getFullYear()}-${doisDigitos(quando.getMonth() + 1)}-${doisDigitos(quando.getDate())}`;
    const hora = `${doisDigitos(quando.getHours())}-${doisDigitos(quando.getMinutes())}-${doisDigitos(quando.getSeconds())}`;
    const nome = limparNome(opcoes.nome);

    const dirDia = path.join(RAIZ_CODIGOS, data);
    let relativo = path.join(data, `${hora}_${nome}`);
    let completo = path.join(RAIZ_CODIGOS, relativo);

    try {
      fs.mkdirSync(dirDia, { recursive: true });
      // Dois blocos no mesmo segundo: acrescenta um sufixo.
      let n = 2;
      while (fs.existsSync(completo)) {
        relativo = path.join(data, `${hora}_${n}_${nome}`);
        completo = path.join(RAIZ_CODIGOS, relativo);
        n++;
      }
      fs.writeFileSync(completo, conteudo, 'utf-8');
    } catch {
      return null;
    }

    const item: ItemArquivo = {
      caminho: relativo,
      nome,
      origem,
      ts: quando.getTime(),
      data,
      linguagem,
      linhas: conteudo.split('\n').length,
      bytes: Buffer.byteLength(conteudo),
      hash,
      fonte,
    };

    try {
      fs.appendFileSync(ARQ_INDICE, JSON.stringify(item) + '\n');
    } catch { /* o arquivo em si já está salvo, que é o que importa */ }

    this.indice.push(item);
    this.hashes.add(hash);
    return item;
  }

  /** Busca no índice por nome, linguagem ou data. Mais recentes primeiro. */
  listar(busca = '', limite = 200): ItemArquivo[] {
    this.carregar();
    const b = busca.trim().toLowerCase();
    const filtrados = b
      ? this.indice.filter((i) =>
          i.nome.toLowerCase().includes(b) ||
          i.linguagem.toLowerCase().includes(b) ||
          i.data.includes(b) ||
          (i.origem || '').toLowerCase().includes(b))
      : this.indice;
    return filtrados.slice(-limite).reverse();
  }

  /** Busca dentro do conteúdo. Custa I/O, então é opt-in e limitada. */
  buscarConteudo(termo: string, limite = 60): ItemArquivo[] {
    this.carregar();
    const t = termo.toLowerCase();
    const achados: ItemArquivo[] = [];
    for (let i = this.indice.length - 1; i >= 0 && achados.length < limite; i--) {
      const item = this.indice[i];
      try {
        const texto = fs.readFileSync(path.join(RAIZ_CODIGOS, item.caminho), 'utf-8');
        if (texto.toLowerCase().includes(t)) achados.push(item);
      } catch { /* arquivo removido à mão */ }
    }
    return achados;
  }

  /**
   * Lê um arquivo do acervo.
   * O caminho é resolvido e conferido contra a raiz: um "../.." não sai
   * da pasta de códigos.
   */
  ler(relativo: string): { conteudo: string; item?: ItemArquivo } | null {
    this.carregar();
    const completo = path.resolve(RAIZ_CODIGOS, relativo);
    if (completo !== RAIZ_CODIGOS && !completo.startsWith(RAIZ_CODIGOS + path.sep)) {
      return null;
    }
    try {
      return {
        conteudo: fs.readFileSync(completo, 'utf-8'),
        item: this.indice.find((i) => i.caminho === relativo),
      };
    } catch {
      return null;
    }
  }

  /** Abre a pasta no gerenciador de arquivos do sistema. */
  abrirPasta(subpasta?: string): boolean {
    let alvo = RAIZ_CODIGOS;
    if (subpasta) {
      const completo = path.resolve(RAIZ_CODIGOS, subpasta);
      if (completo.startsWith(RAIZ_CODIGOS)) alvo = completo;
    }
    try {
      fs.mkdirSync(RAIZ_CODIGOS, { recursive: true });
      const p = spawn('xdg-open', [alvo], { detached: true, stdio: 'ignore' });
      p.unref();
      return true;
    } catch {
      return false;
    }
  }

  get resumo() {
    this.carregar();
    const porDia: Record<string, number> = {};
    const porLinguagem: Record<string, number> = {};
    let bytes = 0;
    for (const i of this.indice) {
      porDia[i.data] = (porDia[i.data] || 0) + 1;
      porLinguagem[i.linguagem] = (porLinguagem[i.linguagem] || 0) + 1;
      bytes += i.bytes;
    }
    return { raiz: RAIZ_CODIGOS, total: this.indice.length, bytes, porDia, porLinguagem };
  }
}

export const acervo = new ArquivoCodigos();
