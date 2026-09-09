import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { acervo } from './arquivo.service.js';

/**
 * Espelho ao vivo do que o Claude Code está escrevendo.
 *
 * O Claude Code grava cada sessão num JSONL em
 * ~/.claude/projects/<projeto>/<sessao>.jsonl, acrescentando linhas
 * conforme trabalha. Aqui a gente segue o arquivo mais recente e extrai
 * só os blocos de código (Write/Edit) e os comandos (Bash) — o resto da
 * conversa não é lido nem repassado.
 *
 * A leitura é por posição: guarda o offset já lido e pega só o pedaço
 * novo. Sem isso, um arquivo de 7 MB seria reprocessado a cada segundo.
 */

const DIR_PROJETOS = path.join(os.homedir(), '.claude', 'projects');
const INTERVALO_MS = 1000;
const MAX_CODIGO = 40000;

/**
 * Onde o histórico fica guardado.
 *
 * Nada é apagado: cada evento extraído vira uma linha em disco. Assim o
 * feed sobrevive a fechar a janela, encerrar o app e reiniciar o PC.
 * Em memória ficam só os últimos EM_MEMORIA — o resto é lido do arquivo
 * quando você rola para trás.
 */
const DIR_DADOS = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'neon'
);
const ARQ_HISTORICO = path.join(DIR_DADOS, 'historico.jsonl');
const ARQ_POSICOES = path.join(DIR_DADOS, 'posicoes.json');
const EM_MEMORIA = 400;
const ROTACIONAR_EM = 256 * 1024 * 1024;   // 256 MB

export interface EventoCodigoVivo {
  id: string;
  ts: number;
  /**
   * codigo   — arquivo criado ou editado
   * comando  — linha de shell executada
   * fala     — explicação do assistente (o "como funciona")
   * pergunta — o que você pediu, para dar contexto ao trecho
   */
  tipo: 'codigo' | 'comando' | 'fala' | 'pergunta';
  ferramenta?: 'Write' | 'Edit' | 'Bash';
  arquivo?: string;
  nomeCurto?: string;
  linguagem?: string;
  codigo: string;
  linhas: number;
  sessao: string;
}

/** Extensão → id de linguagem do Monaco, para o realce no painel. */
const POR_EXTENSAO: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.py': 'python', '.sh': 'shell', '.bash': 'shell',
  '.html': 'html', '.htm': 'html', '.css': 'css',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
  '.md': 'markdown', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp',
  '.java': 'java', '.go': 'go', '.rs': 'rust', '.rb': 'ruby',
  '.php': 'php', '.pl': 'perl', '.lua': 'lua', '.sql': 'sql',
  '.service': 'ini', '.desktop': 'ini', '.env': 'shell',
};

function linguagemDe(arquivo?: string): string {
  if (!arquivo) return 'plaintext';
  const base = path.basename(arquivo);
  if (base === 'Dockerfile') return 'dockerfile';
  return POR_EXTENSAO[path.extname(base).toLowerCase()] || 'plaintext';
}

/** JSONL da sessão mais recente, em qualquer projeto. */
function transcricaoMaisRecente(): { arquivo: string; mtime: number } | null {
  let melhor: { arquivo: string; mtime: number } | null = null;
  let projetos: string[];
  try {
    projetos = fs.readdirSync(DIR_PROJETOS);
  } catch {
    return null; // Claude Code nunca rodou nesta máquina
  }
  for (const proj of projetos) {
    const dir = path.join(DIR_PROJETOS, proj);
    let arquivos: string[];
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      arquivos = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const nome of arquivos) {
      if (!nome.endsWith('.jsonl')) continue;
      const completo = path.join(dir, nome);
      try {
        const m = fs.statSync(completo).mtimeMs;
        if (!melhor || m > melhor.mtime) melhor = { arquivo: completo, mtime: m };
      } catch { /* sumiu no meio do caminho */ }
    }
  }
  return melhor;
}

class VigiaClaude extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private arquivo: string | null = null;
  private posicao = 0;
  private resto = '';
  private historico: EventoCodigoVivo[] = [];
  private seq = 0;
  /** Byte já processado de cada transcrição, para retomar sem repetir. */
  private posicoes: Record<string, number> = {};
  private totalGravado = 0;
  /** Conteúdo já gravado, para não repetir linha após uma queda. */
  private assinaturas = new Set<string>();

  get estado() {
    return {
      ativo: this.timer !== null,
      arquivo: this.arquivo,
      sessao: this.arquivo ? path.basename(this.arquivo, '.jsonl').slice(0, 8) : null,
      eventos: this.historico.length,
      total: this.totalGravado,
      historico: ARQ_HISTORICO,
    };
  }

  /** Últimos N eventos, para quem acabou de abrir a aba. */
  recentes(n = 60) {
    return this.historico.slice(-n);
  }

  /**
   * Eventos anteriores a um id, lidos do arquivo.
   * É o "carregar mais antigos" — só toca o disco quando pedido.
   */
  anteriores(antesDoId: string, limite = 60): EventoCodigoVivo[] {
    let linhas: string[];
    try {
      linhas = fs.readFileSync(ARQ_HISTORICO, 'utf-8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
    let corte = linhas.length;
    for (let i = linhas.length - 1; i >= 0; i--) {
      if (linhas[i].includes(`"${antesDoId}"`)) { corte = i; break; }
    }
    return linhas.slice(Math.max(0, corte - limite), corte)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean) as EventoCodigoVivo[];
  }

  /**
   * Identidade do evento pelo conteúdo, não pelo id.
   *
   * O id é gerado a cada execução, então não serve para reconhecer um
   * evento já gravado. Se a energia cair entre gravar o histórico e
   * salvar a posição, na volta o mesmo trecho é relido — e é isto que
   * impede a linha repetida.
   */
  private static assinatura(ev: EventoCodigoVivo): string {
    return `${ev.ts}|${ev.tipo}|${ev.arquivo || ''}|${ev.codigo.length}|${ev.codigo.slice(0, 48)}`;
  }

  /**
   * Grava o evento no fim do histórico, com fsync.
   *
   * appendFileSync sozinho entrega os bytes ao cache do sistema, não ao
   * disco: num desligamento abrupto o registro se perderia. O fsync
   * força a descida antes de seguir.
   */
  private gravar(ev: EventoCodigoVivo): boolean {
    const assinatura = VigiaClaude.assinatura(ev);
    if (this.assinaturas.has(assinatura)) return false;   // já está no arquivo

    try {
      fs.mkdirSync(DIR_DADOS, { recursive: true });
      this.rotacionarSePreciso();

      // Se a energia caiu no meio de uma gravação, o arquivo terminou
      // sem quebra de linha. Sem fechar essa linha antes, o próximo
      // registro grudaria nela e os dois se perderiam.
      this.fecharLinhaPendente();

      const fd = fs.openSync(ARQ_HISTORICO, 'a');
      try {
        fs.writeSync(fd, JSON.stringify(ev) + '\n');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      this.assinaturas.add(assinatura);
      if (this.assinaturas.size > 4000) {
        // Mantém a janela recente; repetição só acontece perto do corte.
        this.assinaturas = new Set([...this.assinaturas].slice(-2000));
      }
      this.totalGravado++;
      return true;
    } catch {
      return true; // sem disco, o feed ao menos continua em memória
    }
  }

  /**
   * Descarta uma última linha incompleta, deixando o arquivo pronto
   * para receber o próximo registro.
   *
   * Só corta o pedaço que já era ilegível: tudo antes da última quebra
   * de linha é preservado.
   */
  private fecharLinhaPendente() {
    try {
      const tamanho = fs.statSync(ARQ_HISTORICO).size;
      if (tamanho === 0) return;

      const fd = fs.openSync(ARQ_HISTORICO, 'r');
      let ultimo: string;
      try {
        const b = Buffer.alloc(1);
        fs.readSync(fd, b, 0, 1, tamanho - 1);
        ultimo = b.toString();
      } finally {
        fs.closeSync(fd);
      }
      if (ultimo === '\n') return;

      // Procura a última quebra e corta ali.
      const bruto = fs.readFileSync(ARQ_HISTORICO, 'utf-8');
      const corte = bruto.lastIndexOf('\n');
      fs.truncateSync(ARQ_HISTORICO, corte + 1);   // -1 + 1 = 0: zera o arquivo
    } catch { /* arquivo ainda não existe */ }
  }

  /**
   * Arquiva o histórico quando fica grande.
   * O nome leva carimbo de tempo: nada é sobrescrito, nada some. A
   * versão anterior renomeava sempre para ".1" e destruía o arquivo
   * anterior a cada rotação.
   */
  private rotacionarSePreciso() {
    try {
      if (fs.statSync(ARQ_HISTORICO).size <= ROTACIONAR_EM) return;
      const carimbo = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fs.renameSync(ARQ_HISTORICO, path.join(DIR_DADOS, `historico-${carimbo}.jsonl`));
    } catch { /* ainda não existe, ou nada a fazer */ }
  }

  private carregarDoDisco() {
    try {
      this.posicoes = JSON.parse(fs.readFileSync(ARQ_POSICOES, 'utf-8'));
    } catch {
      this.posicoes = {};   // sem posições: relê do começo, o dedup segura
    }
    try {
      const bruto = fs.readFileSync(ARQ_HISTORICO, 'utf-8');
      const linhas = bruto.split('\n').filter(Boolean);
      const eventos: EventoCodigoVivo[] = [];

      for (const l of linhas) {
        try {
          eventos.push(JSON.parse(l));
        } catch {
          // Última linha incompleta: queda de energia no meio da escrita.
          // Descarta só ela; o resto do arquivo continua válido.
        }
      }
      this.totalGravado = eventos.length;
      this.historico = eventos.slice(-EM_MEMORIA);
      this.assinaturas = new Set(
        eventos.slice(-4000).map((e) => VigiaClaude.assinatura(e))
      );
    } catch {
      this.historico = [];
      this.assinaturas = new Set();
    }
  }

  /**
   * Salva as posições de forma atômica: grava num temporário, sincroniza
   * e só então renomeia por cima. O rename é atômico no sistema de
   * arquivos, então nunca existe um posicoes.json pela metade — que
   * seria pior que não ter nenhum.
   */
  private salvarPosicoes() {
    const tmp = ARQ_POSICOES + '.tmp';
    try {
      fs.mkdirSync(DIR_DADOS, { recursive: true });
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeSync(fd, JSON.stringify(this.posicoes));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, ARQ_POSICOES);
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* nada a limpar */ }
    }
  }

  iniciar() {
    if (this.timer) return;
    this.carregarDoDisco();
    this.trocarArquivo();
    this.timer = setInterval(() => this.tick(), INTERVALO_MS);
  }

  parar() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Aponta para a transcrição mais recente e retoma de onde parou.
   *
   * A posição vem do disco: se o app foi fechado no meio de uma sessão,
   * ele volta e recupera tudo o que aconteceu enquanto esteve fora. Uma
   * transcrição nunca vista é lida desde o início, para o histórico
   * nascer completo em vez de começar do zero.
   */
  private trocarArquivo() {
    const alvo = transcricaoMaisRecente();
    if (!alvo || alvo.arquivo === this.arquivo) return;
    this.arquivo = alvo.arquivo;
    this.resto = '';
    this.posicao = this.posicoes[alvo.arquivo] ?? 0;
    this.emit('sessao', this.estado);
  }

  private tick() {
    // Uma sessão nova (outro projeto, outra janela) passa a valer.
    this.trocarArquivo();
    if (!this.arquivo) return;

    let tamanho: number;
    try {
      tamanho = fs.statSync(this.arquivo).size;
    } catch {
      this.arquivo = null;
      return;
    }
    if (tamanho < this.posicao) this.posicao = 0; // arquivo rotacionou
    if (tamanho === this.posicao) return;

    let pedaco = '';
    try {
      const fd = fs.openSync(this.arquivo, 'r');
      const buf = Buffer.alloc(tamanho - this.posicao);
      fs.readSync(fd, buf, 0, buf.length, this.posicao);
      fs.closeSync(fd);
      pedaco = buf.toString('utf-8');
      this.posicao = tamanho;
    } catch {
      return;
    }

    const texto = this.resto + pedaco;
    const linhas = texto.split('\n');
    this.resto = linhas.pop() || ''; // a última pode estar incompleta

    for (const linha of linhas) {
      if (!linha.trim()) continue;
      let d: any;
      try {
        d = JSON.parse(linha);
      } catch {
        continue;
      }
      for (const ev of this.eventosDaLinha(d)) {
        // Disco primeiro. Se já estava gravado (releitura após queda),
        // gravar devolve false e o evento não vira linha nem bloco novo.
        if (!this.gravar(ev)) continue;
        // Além da linha no histórico, o código vira arquivo de verdade
        // na pasta organizada — é o que permite achar depois.
        if (ev.tipo === 'codigo') {
          acervo.arquivar({
            conteudo: ev.codigo,
            nome: ev.nomeCurto || 'trecho.txt',
            origem: ev.arquivo,
            linguagem: ev.linguagem,
            ts: ev.ts,
            fonte: 'claude',
          });
        }
        this.historico.push(ev);
        if (this.historico.length > EM_MEMORIA) this.historico.shift();
        this.emit('codigo', ev);
      }
    }

    // A posição avança só agora, com tudo já sincronizado em disco. Se a
    // energia cair antes daqui, na volta o trecho é relido e o dedup
    // por assinatura evita a repetição — nunca o contrário, que seria
    // perder eventos.
    this.posicoes[this.arquivo] = this.posicao;
    this.salvarPosicoes();
  }

  /**
   * Converte uma linha da transcrição nos eventos que o painel mostra:
   * a explicação do assistente, o que você pediu e o código produzido —
   * nessa ordem, que é a ordem em que a coisa acontece.
   */
  private eventosDaLinha(d: any): EventoCodigoVivo[] {
    const msg = d?.message;
    if (!msg) return [];
    const eventos: EventoCodigoVivo[] = [];
    const papel = d.type === 'user' ? 'pergunta' : 'fala';

    // Mensagem do usuário pode vir como string pura.
    if (typeof msg.content === 'string') {
      const t = this.limparTexto(msg.content);
      if (t) eventos.push(this.montarTexto(t, papel, d));
      return eventos;
    }
    if (!Array.isArray(msg.content)) return eventos;

    for (const bloco of msg.content) {
      if (bloco?.type === 'text') {
        const t = this.limparTexto(bloco.text || '');
        if (t) eventos.push(this.montarTexto(t, papel, d));
      } else if (bloco?.type === 'tool_use') {
        const ev = this.montarEvento(bloco, d);
        if (ev) eventos.push(ev);
      }
      // tool_result fica de fora: é a saída bruta dos comandos, que já
      // aparece no terminal e só encheria a leitura.
    }
    return eventos;
  }

  /**
   * Tira do texto o que é maquinário e não conversa: lembretes do
   * sistema, blocos de contexto e avisos de ferramenta.
   */
  private limparTexto(texto: string): string {
    let t = texto
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/<ide_[^>]*>[\s\S]*?<\/ide_[^>]*>/g, '')
      .replace(/<local-command-[^>]*>[\s\S]*?<\/local-command-[^>]*>/g, '')
      .replace(/\[SYSTEM NOTIFICATION[\s\S]*$/g, '')
      .trim();
    if (t.length > 12000) t = t.slice(0, 12000) + '\n… (truncado)';
    return t;
  }

  private montarTexto(texto: string, tipo: 'fala' | 'pergunta', linha: any): EventoCodigoVivo {
    return {
      id: `${Date.now()}-${++this.seq}`,
      ts: Date.parse(linha.timestamp) || Date.now(),
      tipo,
      codigo: texto,
      linhas: texto.split('\n').length,
      sessao: path.basename(this.arquivo || '', '.jsonl').slice(0, 8),
    };
  }

  private montarEvento(bloco: any, linha: any): EventoCodigoVivo | null {
    const nome = bloco.name;
    const ent = bloco.input || {};

    let codigo = '';
    let arquivo: string | undefined;

    if (nome === 'Write') {
      arquivo = ent.file_path;
      codigo = ent.content || '';
    } else if (nome === 'Edit') {
      arquivo = ent.file_path;
      codigo = ent.new_string || '';
    } else if (nome === 'Bash') {
      codigo = ent.command || '';
    } else {
      return null; // Read, ToolSearch e afins não produzem código
    }

    if (!codigo.trim()) return null;
    if (codigo.length > MAX_CODIGO) codigo = codigo.slice(0, MAX_CODIGO) + '\n… (truncado)';

    return {
      id: `${Date.now()}-${++this.seq}`,
      ts: Date.parse(linha.timestamp) || Date.now(),
      tipo: nome === 'Bash' ? 'comando' : 'codigo',
      ferramenta: nome,
      arquivo,
      nomeCurto: arquivo ? path.basename(arquivo) : undefined,
      linguagem: nome === 'Bash' ? 'shell' : linguagemDe(arquivo),
      codigo,
      linhas: codigo.split('\n').length,
      sessao: path.basename(this.arquivo || '', '.jsonl').slice(0, 8),
    };
  }
}

export const vigiaClaude = new VigiaClaude();
