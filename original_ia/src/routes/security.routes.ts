import { Router, Request, Response } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);
const router = Router();

const PROJECT_DIR = path.resolve(import.meta.dirname, '..', '..');

/**
 * Executa um script Python e retorna o JSON resultante.
 */
async function runPythonFunction(moduleName: string, functionName: string): Promise<unknown> {
  const cmd = `python3 -c "
import sys, json
sys.path.insert(0, '${PROJECT_DIR}')
from ${moduleName} import ${functionName}
resultado = ${functionName}()
print(json.dumps(resultado, ensure_ascii=False, default=str))
"`;

  const { stdout, stderr } = await execAsync(cmd, { timeout: 15000 });
  if (stderr && !stdout) {
    throw new Error(stderr);
  }
  return JSON.parse(stdout.trim());
}

// ─── Conexões de Rede Ativas ─────────────────────────────────
router.get('/connections', async (_req: Request, res: Response) => {
  try {
    const data = await runPythonFunction('neon_watchdog', 'executar_varredura');
    res.json({ ok: true, data });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

// ─── Ameaças Detectadas ──────────────────────────────────────
router.get('/threats', async (_req: Request, res: Response) => {
  try {
    const data = await runPythonFunction('neon_watchdog', 'executar_varredura');
    res.json({ ok: true, data: { ameacas: (data as { ameacas: unknown[] }).ameacas } });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

// ─── Processos de IA ─────────────────────────────────────────
router.get('/ai-processes', async (_req: Request, res: Response) => {
  try {
    const data = await runPythonFunction('neon_ai_monitor', 'obter_relatorio_ia');
    res.json({ ok: true, data });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

// ─── Suspender Rede ──────────────────────────────────────────
router.post('/network/suspend', async (_req: Request, res: Response) => {
  try {
    const { stdout } = await execAsync('nmcli device disconnect wlx90916470a8ff', { timeout: 10000 });
    res.json({ ok: true, message: 'Rede suspensa com sucesso.', output: stdout.trim() });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

// ─── Reativar Rede ───────────────────────────────────────────
router.post('/network/resume', async (_req: Request, res: Response) => {
  try {
    const { stdout } = await execAsync('nmcli device connect wlx90916470a8ff', { timeout: 15000 });
    res.json({ ok: true, message: 'Rede reativada com sucesso.', output: stdout.trim() });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

// ─── Terminal: Executar Comando ──────────────────────────────
router.post('/terminal/execute', async (req: Request, res: Response) => {
  const { command } = req.body;
  if (!command || typeof command !== 'string') {
    res.status(400).json({ ok: false, error: 'Campo "command" é obrigatório.' });
    return;
  }

  // Bloquear comandos perigosos
  const forbidden = ['rm -rf /', 'mkfs', ':(){:|:&};:', 'dd if=/dev/zero'];
  if (forbidden.some(f => command.includes(f))) {
    res.status(403).json({ ok: false, error: 'Comando bloqueado por segurança.' });
    return;
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: 30000,
      cwd: PROJECT_DIR,
    });
    res.json({ ok: true, stdout: stdout || '', stderr: stderr || '' });
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string; code?: number };
    res.json({
      ok: false,
      stdout: execError.stdout || '',
      stderr: execError.stderr || String(error),
      exitCode: execError.code,
    });
  }
});

// ─── Status da Rede ──────────────────────────────────────────
router.get('/network/status', async (_req: Request, res: Response) => {
  try {
    const data = await runPythonFunction('neon_watchdog', 'obter_status_rede');
    res.json({ ok: true, data });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

export default router;
