import { Router, Request, Response } from 'express';
import { codigo, LINGUAGENS, ChaveLinguagem } from '../services/code.service.js';
import { catalogoApps, abrirApp, APPS, ChaveApp } from '../services/apps.service.js';
import { env } from '../config/env.js';
import { vigiaClaude } from '../services/claudewatch.service.js';

const router = Router();

const linguagemValida = (v: unknown): v is ChaveLinguagem =>
  typeof v === 'string' && v in LINGUAGENS;
const appValido = (v: unknown): v is ChaveApp =>
  typeof v === 'string' && v in APPS;

/** Catálogo de linguagens, com o que é executável nesta máquina. */
router.get('/languages', (_req: Request, res: Response) => {
  res.json({ ok: true, linguagens: codigo.catalogo(), rodando: codigo.rodando });
});

/**
 * Executa o código do editor. Vale o mesmo do terminal: sem filtro de
 * conteúdo, porque a fronteira (loopback + token) é a proteção, e o
 * dono da máquina já pode rodar o que quiser nela.
 */
router.post('/run', (req: Request, res: Response) => {
  if (!env.ENABLE_TERMINAL) {
    res.status(403).json({
      ok: false,
      error: 'Execução desabilitada. Defina ENABLE_TERMINAL=true no .env.',
    });
    return;
  }
  const { linguagem, codigo: fonte } = req.body ?? {};
  if (!linguagemValida(linguagem)) {
    res.status(400).json({ ok: false, error: 'Linguagem desconhecida.' });
    return;
  }
  if (typeof fonte !== 'string' || !fonte.trim()) {
    res.status(400).json({ ok: false, error: 'Nada para executar.' });
    return;
  }
  const r = codigo.executar(linguagem, fonte);
  res.status(r.ok ? 200 : 409).json({ ok: r.ok, error: r.erro });
});

router.post('/stop', (_req: Request, res: Response) => {
  res.json({ ok: codigo.parar() });
});

router.post('/save', (req: Request, res: Response) => {
  const { linguagem, codigo: fonte, nome } = req.body ?? {};
  if (!linguagemValida(linguagem)) {
    res.status(400).json({ ok: false, error: 'Linguagem desconhecida.' });
    return;
  }
  if (typeof fonte !== 'string' || !fonte) {
    res.status(400).json({ ok: false, error: 'Nada para salvar.' });
    return;
  }
  try {
    res.json({ ok: true, arquivo: codigo.salvar(linguagem, fonte, nome) });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

// ─── Aplicativos externos ────────────────────────────────────
router.get('/apps', (_req: Request, res: Response) => {
  res.json({ ok: true, apps: catalogoApps() });
});

router.post('/apps/:chave/open', (req: Request, res: Response) => {
  const { chave } = req.params;
  if (!appValido(chave)) {
    res.status(400).json({ ok: false, error: 'Aplicativo desconhecido.' });
    return;
  }
  const r = abrirApp(chave, req.body?.diretorio);
  res.status(r.ok ? 200 : 404).json(r);
});

// ─── Histórico do espelho ao vivo ────────────────────────────
/** Eventos anteriores a um id — o "carregar mais antigos" do feed. */
router.get('/live/history', (req: Request, res: Response) => {
  const antes = String(req.query.antes || '');
  const limite = Math.min(200, Math.max(1, Number(req.query.limite) || 60));
  if (!antes) {
    res.status(400).json({ ok: false, error: 'Informe "antes" com o id do bloco mais antigo em tela.' });
    return;
  }
  res.json({ ok: true, eventos: vigiaClaude.anteriores(antes, limite), estado: vigiaClaude.estado });
});

export default router;
