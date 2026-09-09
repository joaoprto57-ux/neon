import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import routes from './routes/index.js';
import { errorHandler } from './middlewares/error.middleware.js';
import { env, corsOrigins } from './config/env.js';

const app = express();
const PUBLIC_DIR = path.resolve(import.meta.dirname, '..', 'public');

/** Origem servida pela própria máquina (qualquer porta). */
function origemLocal(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

// CORS restrito. Além das origens de CORS_ORIGIN, qualquer origem em
// loopback é aceita — a porta do app é sorteada a cada início, e o
// navegador manda o cabeçalho Origin nos POSTs mesmo quando a página
// veio do próprio servidor. Sem esta regra, a telemetria (GET) chegava
// mas todo POST era barrado: o terminal aceitava digitação e não
// executava nada.
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || corsOrigins.includes(origin) || origemLocal(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`Origem não permitida pelo CORS: ${origin}`));
    },
  })
);

app.use(express.json({ limit: '4mb' }));

/** True para 127.0.0.1, ::1 e a forma mapeada ::ffff:127.0.0.1. */
function ehLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  const limpo = ip.replace(/^::ffff:/, '');
  return limpo === '::1' || limpo.startsWith('127.');
}

function somenteLoopback(req: Request, res: Response, next: NextFunction) {
  if (ehLoopback(req.socket.remoteAddress)) return next();
  res.status(403).send('Painel acessível apenas pela própria máquina.');
}

/**
 * Painel. O token é injetado no HTML servido, então não é preciso
 * digitá-lo — mas só para requisições vindas da própria máquina.
 */
app.get('/', somenteLoopback, (_req: Request, res: Response) => {
  const arquivo = path.join(PUBLIC_DIR, 'dashboard.html');
  if (!fs.existsSync(arquivo)) {
    res.status(404).send('Painel não encontrado em public/dashboard.html');
    return;
  }
  const html = fs
    .readFileSync(arquivo, 'utf-8')
    .replace('__NEON_TOKEN__', env.NEON_API_TOKEN ?? '');
  res.type('html').send(html);
});

// xterm.js e demais estáticos, servidos do próprio disco (sem CDN).
app.use('/vendor', somenteLoopback, express.static(path.join(PUBLIC_DIR, 'vendor')));

app.use('/api', routes);

app.use(errorHandler);

export default app;
