import type { Request, Response, NextFunction, RequestHandler } from 'express';

// Minimal, dependency-free CORS middleware. Supports a single "*", or a
// comma-separated allowlist (e.g. "https://app.example.com,http://localhost:3000")
// so the same config can cover local dev and production domains at once.
export function createCorsMiddleware(corsOriginEnv: string): RequestHandler {
  const raw = (corsOriginEnv || '*').trim();
  const allowAll = raw === '*';
  const allowedOrigins: string[] = allowAll
    ? []
    : raw.split(',').map((o) => o.trim()).filter(Boolean);

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;

    if (allowAll) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // Lets MindAR/Three.js assets (glTF, textures, .mind, .riv) load correctly
    // when the page is served from a different origin than the asset host.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };
}
