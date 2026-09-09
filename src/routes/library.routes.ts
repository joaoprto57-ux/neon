import { Router, Request, Response } from 'express';
import { livraria, RAIZ_LIVRARIA } from '../services/livraria.service.js';
import { acervo } from '../services/arquivo.service.js';

const router = Router();

/** Lista os verbetes. `conteudo=1` procura também dentro do texto. */
router.get('/', (req: Request, res: Response) => {
  const busca = String(req.query.busca || '');
  const dentro = req.query.conteudo === '1';
  const estante = String(req.query.estante || '');
  try {
    if (req.query.recarregar === '1') livraria.recarregar();
    let itens = livraria.listar(busca, dentro);
    if (estante) itens = itens.filter((v) => v.estante === estante);
    res.json({ ok: true, itens, resumo: livraria.resumo, raiz: RAIZ_LIVRARIA });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

/** Um verbete inteiro, com o texto. */
router.get('/entry', (req: Request, res: Response) => {
  const id = String(req.query.id || '');
  const v = id && livraria.ler(id);
  if (!v) {
    res.status(404).json({ ok: false, error: 'Verbete não encontrado.' });
    return;
  }
  res.json({ ok: true, verbete: v });
});

/** Cria (sem id) ou atualiza (com id). */
router.post('/entry', (req: Request, res: Response) => {
  const { id, titulo, estante, etiquetas, corpo } = req.body ?? {};
  if (typeof titulo !== 'string' || !titulo.trim()) {
    res.status(400).json({ ok: false, error: 'O verbete precisa de um título.' });
    return;
  }
  if (typeof corpo !== 'string') {
    res.status(400).json({ ok: false, error: 'Texto ausente.' });
    return;
  }
  try {
    const v = livraria.salvar({
      id: id ? String(id) : undefined,
      titulo,
      estante: estante ? String(estante) : undefined,
      etiquetas: Array.isArray(etiquetas)
        ? etiquetas.map(String)
        : String(etiquetas || '').split(',').map((s) => s.trim()).filter(Boolean),
      corpo,
    });
    res.json({ ok: true, verbete: v });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e as Error).message });
  }
});

router.post('/entry/delete', (req: Request, res: Response) => {
  const id = String(req.body?.id || '');
  res.json({ ok: livraria.excluir(id) });
});

/**
 * Guarda um bloco de código da livraria no acervo — é o "não copiar do
 * zero da próxima vez": o mesmo bloco passa a aparecer na aba Arquivo.
 */
router.post('/snippet', (req: Request, res: Response) => {
  const { codigo, nome, linguagem, origem } = req.body ?? {};
  if (typeof codigo !== 'string' || !codigo.trim()) {
    res.status(400).json({ ok: false, error: 'Nada para guardar.' });
    return;
  }
  const item = acervo.arquivar({
    conteudo: codigo,
    nome: String(nome || 'trecho.txt'),
    linguagem: String(linguagem || 'plaintext'),
    origem: origem ? String(origem) : 'livraria',
    fonte: 'editor',
  });
  res.json({
    ok: true,
    item,
    jaExistia: item === null,
  });
});

router.post('/open', (req: Request, res: Response) => {
  const estante = req.body?.estante ? String(req.body.estante) : undefined;
  res.json({ ok: livraria.abrirPasta(estante), raiz: RAIZ_LIVRARIA });
});

export default router;
