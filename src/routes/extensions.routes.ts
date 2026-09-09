import { Router, Request, Response } from 'express';
import { catalogo, instalar, desinstalar } from '../services/extensions.service.js';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json({ ok: true, ...(await catalogo()) });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

/** Instalar leva dezenas de segundos; o cliente aguarda a resposta. */
router.post('/install', async (req: Request, res: Response) => {
  const { id } = req.body ?? {};
  try {
    const saida = await instalar(String(id));
    res.json({ ok: true, saida: saida.trim().split('\n').slice(-3).join(' ') });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

router.post('/uninstall', async (req: Request, res: Response) => {
  const { id } = req.body ?? {};
  try {
    const saida = await desinstalar(String(id));
    res.json({ ok: true, saida: saida.trim().split('\n').slice(-3).join(' ') });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

export default router;
