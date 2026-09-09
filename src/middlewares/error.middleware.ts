import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  console.error('Unhandled error:', err);

  // Em produção a mensagem interna não vai para o cliente: ela pode
  // conter caminhos, queries e detalhes de infraestrutura.
  const mensagem =
    env.NODE_ENV === 'production'
      ? 'Internal Server Error'
      : err.message || 'Internal Server Error';

  return res.status(500).json({ status: 'error', message: mensagem });
}
