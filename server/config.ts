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

export const NODE_ENV: string = process.env.NODE_ENV || 'development';
export const isProduction: boolean = NODE_ENV === 'production';

export const PORT: number = Number(process.env.PORT) || 3000;
export const HOST: string = process.env.HOST || '0.0.0.0';

// HTTPS only ever applies in development (see server/startServer.ts) —
// production TLS termination happens at the hosting/reverse-proxy layer.
export const ENABLE_HTTPS: boolean = process.env.ENABLE_HTTPS !== 'false';
export const SSL_CERT: string = process.env.SSL_CERT || './localhost.pem';
export const SSL_KEY: string = process.env.SSL_KEY || './localhost-key.pem';

export const CORS_ORIGIN: string = process.env.CORS_ORIGIN || '*';
