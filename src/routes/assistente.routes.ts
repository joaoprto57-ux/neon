import { Router, Request, Response } from 'express';
import { assistente } from '../services/assistente.service.js';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json({ ok: true, ...assistente.estado });
});

router.post('/desafio', (req: Request, res: Response) => {
  try {
    res.json({ ok: true, desafio: assistente.desafiar(String(req.body?.texto ?? '')) });
  } catch (e) {
    res.status(400).json({ ok: false, error: (e as Error).message });
  }
});

router.post('/desafio/delete', (req: Request, res: Response) => {
  res.json({ ok: assistente.esquecer(String(req.body?.id ?? '')) });
});

/** Só o que é seguro mexer pelo painel — nada de trocar a chave por aqui. */
router.post('/config', (req: Request, res: Response) => {
  const permitido = ['teto_dolares', 'esforco', 'intervalo', 'max_tokens', 'linhas_alvo'];
  const mudancas: Record<string, unknown> = {};
  for (const campo of permitido) {
    if (req.body?.[campo] !== undefined) mudancas[campo] = req.body[campo];
  }
  if (!Object.keys(mudancas).length) {
    res.status(400).json({ ok: false, error: 'Nada para mudar.' });
    return;
  }
  res.json({ ok: true, config: assistente.ajustar(mudancas) });
});

export default router;
