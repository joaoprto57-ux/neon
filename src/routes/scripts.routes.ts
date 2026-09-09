import { Router, Request, Response } from 'express';
import { scripts, SCRIPTS, ChaveScript } from '../services/scripts.service.js';

const router = Router();

function chaveValida(v: unknown): v is ChaveScript {
  return typeof v === 'string' && v in SCRIPTS;
}

router.get('/', (_req: Request, res: Response) => {
  res.json({ ok: true, scripts: scripts.estado });
});

router.post('/:chave/start', (req: Request, res: Response) => {
  const { chave } = req.params;
  if (!chaveValida(chave)) {
    res.status(400).json({ ok: false, error: 'Script desconhecido.' });
    return;
  }
  const r = scripts.iniciar(chave);
  res.status(r.ok ? 200 : 409).json({ ok: r.ok, error: r.motivo });
});

router.post('/:chave/stop', (req: Request, res: Response) => {
  const { chave } = req.params;
  if (!chaveValida(chave)) {
    res.status(400).json({ ok: false, error: 'Script desconhecido.' });
    return;
  }
  res.json({ ok: scripts.parar(chave) });
});

/** Salva a saída acumulada em ~/neon-relatorios/. */
router.post('/:chave/save', (req: Request, res: Response) => {
  const { chave } = req.params;
  if (!chaveValida(chave)) {
    res.status(400).json({ ok: false, error: 'Script desconhecido.' });
    return;
  }
  const { conteudo } = req.body ?? {};
  const texto = typeof conteudo === 'string' && conteudo
    ? conteudo
    : scripts.linhas(chave).join('\n');

  if (!texto.trim()) {
    res.status(400).json({ ok: false, error: 'Nada para salvar.' });
    return;
  }
  try {
    const arquivo = scripts.salvar(chave, texto);
    res.json({ ok: true, arquivo });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
