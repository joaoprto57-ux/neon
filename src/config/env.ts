import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('3000').transform((val) => parseInt(val, 10)),

  // Loopback por padrão: o painel dá acesso ao shell da máquina e não
  // tem por que estar acessível na rede local.
  HOST: z.string().default('127.0.0.1'),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().optional(),

  // Token obrigatório para tudo além do /api/health. Sem ele, as rotas
  // respondem 503 — o padrão é fechado, nunca aberto.
  NEON_API_TOKEN: z.string().min(32).optional(),

  // CORS restrito. A primeira versão usava cors() aberto, o que permitia
  // a qualquer site chamar as rotas locais.
  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  ENABLE_TERMINAL: z.string().default('false').transform((v) => v === 'true'),

  WIFI_INTERFACE: z.string().default('wlx90916470a8ff'),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error('❌ Variáveis de ambiente inválidas:', z.treeifyError(_env.error));
  throw new Error('Invalid environment variables');
}

export const env = _env.data;

export const corsOrigins = env.CORS_ORIGIN.split(',')
  .map((o) => o.trim())
  .filter(Boolean);
