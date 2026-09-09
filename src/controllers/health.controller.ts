import { Request, Response } from 'express';
import { getSystemHealth } from '../services/health.service.js';

export function getHealthStatus(_req: Request, res: Response) {
  const healthInfo = getSystemHealth();
  return res.json(healthInfo);
}

