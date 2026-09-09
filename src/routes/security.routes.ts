import { Router, Request, Response } from 'express';
import { daemon } from '../services/neon.service.js';

const router = Router();

/** Envolve um handler assíncrono devolvendo erro padronizado. */
function handler(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (error) {
      const mensagem = error instanceof Error ? error.message : String(error);
      console.error('[security]', mensagem);
      res.status(500).json({ ok: false, error: mensagem });
    }
  };
}

// ─── Conexões de Rede Ativas ─────────────────────────────────
router.get('/connections', handler(async (_req, res) => {
  res.json({ ok: true, data: await daemon.chamar('scan') });
}));

// ─── Ameaças Detectadas ──────────────────────────────────────
router.get('/threats', handler(async (_req, res) => {
  const data = (await daemon.chamar('scan')) as { ameacas?: unknown[] };
  res.json({ ok: true, data: { ameacas: data.ameacas ?? [] } });
}));

// ─── Processos de IA ─────────────────────────────────────────
router.get('/ai-processes', handler(async (_req, res) => {
  res.json({ ok: true, data: await daemon.chamar('ai') });
}));

// ─── Status da Rede ──────────────────────────────────────────
router.get('/network/status', handler(async (_req, res) => {
  res.json({ ok: true, data: await daemon.chamar('status') });
}));

// ─── Snapshot completo (rede + IA numa chamada) ──────────────
router.get('/snapshot', handler(async (_req, res) => {
  res.json({ ok: true, data: await daemon.chamar('all') });
}));

// ─── Controle da Interface ───────────────────────────────────
router.post('/network/suspend', handler(async (_req, res) => {
  res.json({ ok: true, data: await daemon.chamar('suspend') });
}));

router.post('/network/resume', handler(async (_req, res) => {
  res.json({ ok: true, data: await daemon.chamar('resume', 25000) });
}));

export default router;
