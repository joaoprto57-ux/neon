import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import {
  perguntar, estadoBot, corrigir, abrir, descobrir, guardarCodigo, ondeFicamAsConversas,
} from '../services/bot.service.js';

const router = Router();

router.get('/state', (_req: Request, res: Response) => {
  res.json({ ok: true, ...estadoBot(), conversas: ondeFicamAsConversas() });
});

/**
 * A conversa de hoje, lida do arquivo.
 *
 * É isto que faz as mensagens sobreviverem a fechar o painel: a tela é
 * descartável, o arquivo é a memória.
 */
router.get('/historico', (_req: Request, res: Response) => {
  const pasta = ondeFicamAsConversas();
  const dia = new Date().toISOString().slice(0, 10);
  const arquivo = path.join(pasta, `conversa-${dia}.txt`);
  try {
    if (!fs.existsSync(arquivo)) {
      res.json({ ok: true, texto: '', pasta });
      return;
    }
    // Só o fim: uma conversa longa não precisa voltar inteira para a tela.
    const bruto = fs.readFileSync(arquivo, 'utf-8');
    res.json({ ok: true, texto: bruto.slice(-40000), pasta, arquivo });
  } catch (e) {
    res.json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * Uma pergunta, uma resposta.
 *
 * Sem histórico no servidor de propósito: o bot já guarda o que
 * importa no banco dele, e a conversa em tela é da própria página.
 */
router.post('/ask', async (req: Request, res: Response) => {
  const pergunta = String(req.body?.pergunta ?? '').trim();
  if (!pergunta) {
    res.status(400).json({ ok: false, error: 'Pergunta vazia.' });
    return;
  }
  if (pergunta.length > 2000) {
    res.status(400).json({ ok: false, error: 'Pergunta longa demais.' });
    return;
  }
  try {
    res.json({ ok: true, ...(await perguntar(pergunta)) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ ok: false, error: msg });
  }
});

/** Cola um código e recebe o diagnóstico: erros, dicas e leitura. */
router.post('/corrigir', async (req: Request, res: Response) => {
  const codigo = String(req.body?.codigo ?? '');
  const linguagem = String(req.body?.linguagem ?? 'python');
  if (!codigo.trim()) {
    res.status(400).json({ ok: false, error: 'Sem código.' });
    return;
  }
  if (codigo.length > 200000) {
    res.status(400).json({ ok: false, error: 'Código grande demais.' });
    return;
  }
  res.json({ ok: true, ...(await corrigir(codigo, linguagem) as object) });
});

/**
 * Abre um arquivo, pasta ou endereço no programa padrão.
 *
 * Só abre — não executa comando. Quem executa é o terminal do painel,
 * onde você vê a linha antes de ela rodar.
 */
router.post('/abrir', (req: Request, res: Response) => {
  const alvo = String(req.body?.alvo ?? '');
  const r = abrir(alvo);
  res.status(r.ok ? 200 : 400).json({ ok: r.ok, alvo: r.alvo, error: r.erro });
});

/** O bot vasculha o que já leu e traz o que ainda não sabe. */
router.post('/descobrir', async (_req: Request, res: Response) => {
  res.json({ ok: true, ...(await descobrir() as object) });
});

/** "Quer que eu aprenda esse código?" — o sim vem para cá. */
router.post('/guardar', async (req: Request, res: Response) => {
  const codigo = String(req.body?.codigo ?? '');
  if (!codigo.trim()) {
    res.status(400).json({ ok: false, error: 'Sem código.' });
    return;
  }
  res.json(await guardarCodigo({
    codigo,
    linguagem: String(req.body?.linguagem ?? 'python'),
    titulo: req.body?.titulo ? String(req.body.titulo) : undefined,
  }) as object);
});

export default router;
