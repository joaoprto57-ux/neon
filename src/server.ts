import app from './app.js';
import { env } from './config/env.js';
import { daemon } from './services/neon.service.js';
import { terminal } from './services/terminal.service.js';

const server = app.listen(env.PORT, env.HOST, () => {
  console.log(`🚀 Neon rodando em http://${env.HOST}:${env.PORT}`);
  console.log(`🖥️  Painel:      http://${env.HOST}:${env.PORT}/`);
  console.log(`📡 Healthcheck: http://${env.HOST}:${env.PORT}/api/health`);
  if (!env.NEON_API_TOKEN) {
    console.warn('⚠️  NEON_API_TOKEN ausente: /api/security, /api/terminal e /api/stream respondem 503.');
  }
  if (!env.ENABLE_TERMINAL) {
    console.log('ℹ️  Terminal desabilitado (ENABLE_TERMINAL=false).');
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `❌ Porta ${env.PORT} já está em uso. Troque PORT no .env ` +
        `(o Antigravity costuma ocupar a 3000).`
    );
    process.exit(1);
  }
  throw err;
});

// Encerra os processos filhos junto com o servidor; sem isso o daemon
// Python e o bash ficariam órfãos a cada reinício.
function encerrar(sinal: string) {
  console.log(`\n${sinal} recebido, encerrando...`);
  daemon.encerrar();
  terminal.reiniciar();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => encerrar('SIGINT'));
process.on('SIGTERM', () => encerrar('SIGTERM'));
