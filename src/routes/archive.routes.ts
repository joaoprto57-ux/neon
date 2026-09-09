import { Router, Request, Response } from 'express';
import { acervo, RAIZ_CODIGOS } from '../services/arquivo.service.js';

const router = Router();

/** Lista o acervo. `conteudo=1` procura dentro dos arquivos. */
router.get('/', (req: Request, res: Response) => {
  const busca = String(req.query.busca || '');
  const noConteudo = req.query.conteudo === '1';
  try {
    const itens = noConteudo && busca.trim()
      ? acervo.buscarConteudo(busca)
      : acervo.listar(busca);
    res.json({ ok: true, itens, resumo: acervo.resumo, raiz: RAIZ_CODIGOS });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

/** Conteúdo de um arquivo do acervo. */
router.get('/file', (req: Request, res: Response) => {
  const caminho = String(req.query.caminho || '');
  if (!caminho) {
    res.status(400).json({ ok: false, error: 'Informe o caminho.' });
    return;
  }
  const r = acervo.ler(caminho);
  if (!r) {
    res.status(404).json({ ok: false, error: 'Arquivo não encontrado no acervo.' });
    return;
  }
  res.json({ ok: true, ...r });
});

/** Abre a pasta no gerenciador de arquivos — o atalho do painel. */
router.post('/open', (req: Request, res: Response) => {
  const sub = req.body?.subpasta ? String(req.body.subpasta) : undefined;
  res.json({ ok: acervo.abrirPasta(sub), raiz: RAIZ_CODIGOS });
});

export default router;
