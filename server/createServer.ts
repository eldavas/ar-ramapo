import path from 'path';
import express, { type Express } from 'express';
import * as config from './config.js';
import { createCorsMiddleware } from './cors.js';
import { healthHandler } from './health.js';
import { manifestHandler } from './manifest.js';

// process.cwd() (the repo root — the app is always started from there), not
// __dirname: after compilation this module runs from dist/server/, one
// directory deeper than its source location, so __dirname-relative
// traversal would resolve one level short of the actual repo root.
const PROJECT_ROOT = process.cwd();

// The only directory ever exposed over HTTP. See AR_SYSTEM.md §D — the repo
// root (server source, .env, TLS keys, lockfiles) must never be reachable.
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

export function createApp(): Express {
  const app = express();

  app.use(createCorsMiddleware(config.CORS_ORIGIN));

  app.get('/health', healthHandler);
  app.get('/api/manifest', manifestHandler);

  app.use(express.static(PUBLIC_DIR));
  app.use('/rive', express.static(path.join(PROJECT_ROOT, 'node_modules/@rive-app/canvas')));
  // 8th Wall engine binary, self-hosted (same pattern as /rive): xr.js plus
  // its runtime chunks (xr-slam.js, resources/) load same-origin, so the
  // "no CDN at runtime" rule (AR_SYSTEM.md §C/§F) holds for the tracking
  // engine too. The binary's chunk loader resolves siblings relative to the
  // xr.js script URL, so the whole dist directory must be exposed.
  app.use('/xr', express.static(path.join(PROJECT_ROOT, 'node_modules/@8thwall/engine-binary/dist')));

  return app;
}
