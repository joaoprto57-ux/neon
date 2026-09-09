import { Router, Request, Response } from 'express';
import { terminal } from '../services/terminal.service.js';
import { env } from '../config/env.js';

const router = Router();

function habilitado(res: Response): boolean {
  if (env.ENABLE_TERMINAL) return true;
  res.status(403).json({
    ok: false,
    error: 'Terminal desabilitado. Defina ENABLE_TERMINAL=true no .env.',
  });
  return false;
}

/**
 * Escreve teclas cruas no PTY.
 *
 * Não há filtro de conteúdo: o painel escuta só em loopback, exige token
 * e é ferramenta pessoal do dono da máquina. Filtrar texto de terminal
 * barraria distração e nenhum ataque — a proteção é a fronteira.
 */
router.post('/input', (req: Request, res: Response) => {
  if (!habilitado(res)) return;
  const { data } = req.body ?? {};
  if (typeof data !== 'string') {
    res.status(400).json({ ok: false, error: 'Campo "data" é obrigatório.' });
    return;
  }
  terminal.escrever(data);
  res.json({ ok: true });
});

router.post('/resize', (req: Request, res: Response) => {
  if (!habilitado(res)) return;
  const { cols, rows } = req.body ?? {};
  terminal.redimensionar(Number(cols), Number(rows));
  res.json({ ok: true, estado: terminal.estado });
});

/**
 * Encerra o programa em primeiro plano sem derrubar o shell.
 *
 * É o "sair" que faltava no painel: aberto o Claude Code ou o Gemini
 * pelo lançador, o Ctrl+C só cancela a tarefa da vez e não havia como
 * fechar o programa. `sinal` deixa insistir — TERM pede, KILL manda.
 */
router.post('/foreground/close', (req: Request, res: Response) => {
  if (!habilitado(res)) return;
  const sinais = { INT: 'SIGINT', TERM: 'SIGTERM', KILL: 'SIGKILL' } as const;
  const pedido = String(req.body?.sinal ?? 'TERM').toUpperCase();
  const sinal = sinais[pedido as keyof typeof sinais] ?? 'SIGTERM';
  const r = terminal.encerrarPrimeiroPlano(sinal);
  res.status(r.ok ? 200 : 409).json(r);
});

router.post('/reset', (_req: Request, res: Response) => {
  if (!habilitado(res)) return;
  terminal.reiniciar();
  res.json({ ok: true });
});

router.get('/state', (_req: Request, res: Response) => {
  res.json({ ok: true, habilitado: env.ENABLE_TERMINAL, estado: terminal.estado });
});

export default router;
