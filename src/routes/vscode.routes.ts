import { Router, Request, Response } from 'express';
import { vscode } from '../services/vscode.service.js';

const router = Router();

router.get('/state', (_req: Request, res: Response) => {
  res.json({ ok: true, ...vscode.estado });
});

/** Sobe o code-server sob demanda e devolve a URL para o webview. */
router.post('/start', async (req: Request, res: Response) => {
  try {
    const r = await vscode.iniciar(req.body?.pasta);
    res.json({ ...r, estado: vscode.estado });
  } catch (e) {
    res.status(500).json({ ok: false, erro: (e as Error).message });
  }
});

router.post('/stop', (_req: Request, res: Response) => {
  vscode.parar();
  res.json({ ok: true });
});

export default router;
