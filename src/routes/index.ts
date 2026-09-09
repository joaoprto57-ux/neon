import { Router } from 'express';
import healthRoutes from './health.routes.js';
import securityRoutes from './security.routes.js';
import terminalRoutes from './terminal.routes.js';
import scriptsRoutes from './scripts.routes.js';
import streamRoutes from './stream.routes.js';
import codeRoutes from './code.routes.js';
import extensionsRoutes from './extensions.routes.js';
import archiveRoutes from './archive.routes.js';
import libraryRoutes from './library.routes.js';
import assistenteRoutes from './assistente.routes.js';
import vscodeRoutes from './vscode.routes.js';
import botRoutes from './bot.routes.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

const router = Router();

// Pública: serve para checar se o servidor está de pé.
router.use('/', healthRoutes);

// Tudo abaixo exige bearer token.
router.use('/security', requireAuth, securityRoutes);
router.use('/terminal', requireAuth, terminalRoutes);
router.use('/scripts', requireAuth, scriptsRoutes);
router.use('/code', requireAuth, codeRoutes);
router.use('/extensions', requireAuth, extensionsRoutes);
router.use('/archive', requireAuth, archiveRoutes);
router.use('/library', requireAuth, libraryRoutes);
router.use('/assistente', requireAuth, assistenteRoutes);
router.use('/vscode', requireAuth, vscodeRoutes);
router.use('/bot', requireAuth, botRoutes);
router.use('/stream', requireAuth, streamRoutes);

export default router;
