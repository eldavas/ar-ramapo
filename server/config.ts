import path from 'path';

// Loads .env into process.env for local dev. Node's built-in loader (>=20.12)
// throws if the file is missing — that's expected in production, where the
// hosting platform injects env vars directly and no .env file exists.
//
// Resolved from process.cwd() (the repo root, since the app is always
// started from there) rather than __dirname: after compilation this file
// runs from dist/server/, one directory deeper than its source location, so
// __dirname-relative traversal would silently point at the wrong directory.
try {
  process.loadEnvFile(path.join(process.cwd(), '.env'));
} catch {
  // no .env file — fall back to whatever the environment already provides
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const NODE_ENV: string = process.env.NODE_ENV || 'development';
export const isProduction: boolean = NODE_ENV === 'production';

export const PORT: number = parsePort(process.env.PORT, 3000);
export const HOST: string = process.env.HOST || '0.0.0.0';

// No hardcoded file-path fallback on purpose: a machine with no .env and no
// local certs must still resolve these to "" and boot cleanly on HTTP (see
// server/startServer.ts's orchestration rule) rather than pointing at a path
// that only ever existed on one developer's laptop.
export const HTTPS_KEY_PATH: string = process.env.HTTPS_KEY_PATH ?? '';
export const HTTPS_CERT_PATH: string = process.env.HTTPS_CERT_PATH ?? '';

export const CORS_ORIGIN: string = process.env.CORS_ORIGIN || '*';
