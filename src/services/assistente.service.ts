import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * O assistente pago, visto pelo painel.
 *
 * O trabalho de verdade é do assistente.py; aqui só se lê e escreve os
 * mesmos arquivos que ele usa. Nada de duplicar a lógica: o Python é o
 * dono do gasto e do teto, o painel é uma janela para ele.
 */

const CASA = os.homedir();
const RAIZ = path.join(CASA, '.neon-assistente');
const GASTOS = path.join(RAIZ, 'gastos.jsonl');
const DESAFIOS = path.join(RAIZ, 'desafios.jsonl');
const CONFIG = path.join(RAIZ, 'config.json');

export interface Desafio {
  id: string;
  texto: string;
  quando: number;
  estado: 'esperando' | 'trabalhando' | 'pronto';
  pagina?: string;
}

interface Gasto {
  quando: number;
  tipo: string;
  custo: number;
  sobre?: string;
  pagina?: string;
}

/** Lê um .jsonl tolerando linha truncada por queda. */
function lerJsonl<T>(arquivo: string): T[] {
  try {
    return fs
      .readFileSync(arquivo, 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as T];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function lerConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf-8'));
  } catch {
    return { modelo: 'claude-opus-5', teto_dolares: 1, esforco: 'low' };
  }
}

export const assistente = {
  get estado() {
    const gastos = lerJsonl<Gasto>(GASTOS);
    const desafios = lerJsonl<Desafio>(DESAFIOS);
    const cfg = lerConfig();
    const total = gastos.reduce((s, g) => s + (g.custo || 0), 0);
    const teto = Number(cfg.teto_dolares ?? 1);
    const pagas = gastos.filter((g) => g.custo > 0);

    return {
      config: cfg,
      gasto: total,
      teto,
      resta: Math.max(0, teto - total),
      chamadas: pagas.length,
      media: pagas.length ? total / pagas.length : 0,
      // Quantas tarefas ainda cabem no teto, pela média até agora.
      cabem: pagas.length ? Math.floor((teto - total) / (total / pagas.length)) : null,
      temChave: fs.existsSync(path.join(CASA, '.neon-segredos', 'chave-anthropic')),
      desafios: desafios.slice().reverse(),
      esperando: desafios.filter((d) => d.estado === 'esperando').length,
      ultimos: pagas.slice(-8).reverse(),
    };
  },

  /** Põe um desafio na fila. O Python pega na próxima volta. */
  desafiar(texto: string): Desafio {
    const limpo = texto.trim();
    if (!limpo) throw new Error('Desafio vazio.');
    const d: Desafio = {
      id: `d${Date.now()}`,
      texto: limpo,
      quando: Date.now() / 1000,
      estado: 'esperando',
    };
    fs.mkdirSync(RAIZ, { recursive: true });
    fs.appendFileSync(DESAFIOS, JSON.stringify(d) + '\n');
    return d;
  },

  /** Reescreve a fila inteira — usado para apagar um desafio. */
  esquecer(id: string): boolean {
    const todos = lerJsonl<Desafio>(DESAFIOS);
    const restam = todos.filter((d) => d.id !== id);
    if (restam.length === todos.length) return false;
    fs.writeFileSync(DESAFIOS, restam.map((d) => JSON.stringify(d)).join('\n') + '\n');
    return true;
  },

  /**
   * Muda o teto de gasto. O assistente relê o config a cada volta, então
   * a mudança vale sem precisar reiniciar nada.
   */
  ajustar(mudancas: Record<string, unknown>): Record<string, unknown> {
    const cfg = { ...lerConfig(), ...mudancas };
    fs.mkdirSync(RAIZ, { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
    return cfg;
  },
};
