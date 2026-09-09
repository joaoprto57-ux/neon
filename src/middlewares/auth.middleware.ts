import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { env } from '../config/env.js';

/**
 * Compara dois tokens em tempo constante, evitando vazamento por
 * diferença de tempo de resposta.
 */
function tokensIguais(recebido: string, esperado: string): boolean {
  const a = Buffer.from(recebido);
  const b = Buffer.from(esperado);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Exige um bearer token válido. Se NEON_API_TOKEN não estiver
 * configurado, a rota responde 503 — o padrão é fechado, nunca aberto.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const esperado = env.NEON_API_TOKEN;

  if (!esperado) {
    res.status(503).json({
      ok: false,
      error:
        'NEON_API_TOKEN não configurado. Gere um com "openssl rand -hex 32" ' +
        'e defina no .env para habilitar as rotas de segurança.',
    });
    return;
  }

  const header = req.get('authorization') || '';
  const recebido = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!recebido || !tokensIguais(recebido, esperado)) {
    res.status(401).json({ ok: false, error: 'Token ausente ou inválido.' });
    return;
  }

  next();
}
