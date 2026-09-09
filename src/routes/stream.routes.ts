import { Router, Request, Response } from 'express';
import { daemon } from '../services/neon.service.js';
import { terminal, SaidaTerminal } from '../services/terminal.service.js';
import { scripts, EventoScript } from '../services/scripts.service.js';
import { codigo, EventoCodigo } from '../services/code.service.js';
import { vigiaClaude, EventoCodigoVivo } from '../services/claudewatch.service.js';

const router = Router();

/** Prepara a resposta como fluxo SSE e devolve o emissor de eventos. */
function abrirSSE(req: Request, res: Response) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let vivo = true;
  const enviar = (evento: string, dados: unknown) => {
    if (!vivo) return;
    res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);
  };
  const ping = setInterval(() => vivo && res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    vivo = false;
    clearInterval(ping);
    res.end();
  });

  return { enviar, aoFechar: (fn: () => void) => req.on('close', fn) };
}

/** Telemetria: snapshot de rede + IA em intervalo regular. */
router.get('/telemetry', (req, res) => {
  const intervalo = Math.max(1000, Number(req.query.intervalo) || 3000);
  const { enviar, aoFechar } = abrirSSE(req, res);

  let emVoo = false;
  let parado = false;
  const tick = async () => {
    if (emVoo || parado) return; // não empilha chamadas lentas
    emVoo = true;
    try {
      enviar('snapshot', await daemon.chamar('all'));
    } catch (e) {
      enviar('erro', { error: e instanceof Error ? e.message : String(e) });
    } finally {
      emVoo = false;
    }
  };

  enviar('conectado', { intervalo });
  tick();
  const timer = setInterval(tick, intervalo);
  aoFechar(() => { parado = true; clearInterval(timer); });
});

/** Saída crua do PTY. */
router.get('/terminal', (req, res) => {
  const { enviar, aoFechar } = abrirSSE(req, res);
  const onSaida = (d: SaidaTerminal) => enviar('saida', d);
  terminal.on('saida', onSaida);
  enviar('conectado', terminal.estado);
  aoFechar(() => terminal.off('saida', onSaida));
});

/** Eventos dos scripts do Neon. */
router.get('/scripts', (req, res) => {
  const { enviar, aoFechar } = abrirSSE(req, res);
  const onEvento = (e: EventoScript) => enviar('evento', e);
  scripts.on('evento', onEvento);
  enviar('conectado', scripts.estado);
  aoFechar(() => scripts.off('evento', onEvento));
});

/** Saída do editor de código, ao vivo. */
router.get('/code', (req, res) => {
  const { enviar, aoFechar } = abrirSSE(req, res);
  const onEvento = (e: EventoCodigo) => enviar('evento', e);
  codigo.on('evento', onEvento);
  enviar('conectado', { rodando: codigo.rodando });
  aoFechar(() => codigo.off('evento', onEvento));
});

/**
 * Espelho do que o Claude Code está escrevendo, ao vivo.
 * O vigia só liga quando alguém abre a aba, e continua ligado depois —
 * assim o histórico não some ao trocar de aba.
 */
router.get('/live', (req, res) => {
  const { enviar, aoFechar } = abrirSSE(req, res);
  vigiaClaude.iniciar();

  const onCodigo = (e: EventoCodigoVivo) => enviar('codigo', e);
  const onSessao = (e: unknown) => enviar('sessao', e);
  vigiaClaude.on('codigo', onCodigo);
  vigiaClaude.on('sessao', onSessao);

  enviar('conectado', { estado: vigiaClaude.estado, recentes: vigiaClaude.recentes() });

  aoFechar(() => {
    vigiaClaude.off('codigo', onCodigo);
    vigiaClaude.off('sessao', onSessao);
  });
});

export default router;
