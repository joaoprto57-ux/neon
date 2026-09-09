import { Request, Response, NextFunction } from 'express';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  console.error('Unhandled error:', err);
  
  return res.status(500).json({
    status: 'error',
    message: err.message || 'Internal Server Error',
  });
}
