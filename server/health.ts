import type { Request, Response } from 'express';
import { NODE_ENV } from './config.js';

export function healthHandler(_req: Request, res: Response): void {
  res.json({ status: 'ok', env: NODE_ENV });
}
