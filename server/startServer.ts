import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import os from 'os';
import type { Server as HttpServer } from 'http';
import type { Server as HttpsServer } from 'https';
import * as config from './config.js';
import { createApp } from './createServer.js';

function getLocalNetworkIPs(): string[] {
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const iface of entries ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

interface CertPaths {
  certPath: string;
  keyPath: string;
}

// Certs only count as "present" when both env vars are actually set (no
// empty-string path ever resolves to something on disk) and both files
// exist on this machine. Never a bare fs.readFileSync with no existence
// check — a missing cert must fall back to HTTP, not crash with ENOENT.
function resolveCertPaths(): CertPaths | null {
  if (!config.HTTPS_KEY_PATH || !config.HTTPS_CERT_PATH) {
    return null;
  }

  const keyPath = path.resolve(config.HTTPS_KEY_PATH);
  const certPath = path.resolve(config.HTTPS_CERT_PATH);
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { certPath, keyPath };
  }
  return null;
}

function logStartup(mode: 'SECURE HTTPS PORT' | 'HTTP PROXY MODE', protocol: 'http' | 'https'): void {
  const { PORT, NODE_ENV } = config;
  console.log(`\nAR prototype server ready [${mode}]`);
  console.log(`  environment : ${NODE_ENV}`);
  console.log(`  local       : ${protocol}://localhost:${PORT}`);
  for (const ip of getLocalNetworkIPs()) {
    console.log(`  network     : ${protocol}://${ip}:${PORT}  (phone, same WiFi)`);
  }
  console.log('');
}

/**
 * Orchestration rule:
 *  - Development, with both HTTPS_KEY_PATH/HTTPS_CERT_PATH present on disk:
 *    boot native HTTPS (required for camera access when testing on a real
 *    phone — see AR_SYSTEM.md).
 *  - Production, OR certs missing/unset for any reason: boot plain HTTP.
 *    In production this is by design — TLS termination is delegated to the
 *    hosting/reverse-proxy layer (Cloudflare, Nginx, a PaaS edge), never to
 *    local .pem files. Node is completely agnostic to certificate paths in
 *    that mode.
 */
export function startServer(): HttpServer | HttpsServer {
  const app = createApp();
  const { PORT, HOST, isProduction } = config;

  if (!isProduction) {
    const certs = resolveCertPaths();
    if (certs) {
      const server = https.createServer(
        {
          key: fs.readFileSync(certs.keyPath),
          cert: fs.readFileSync(certs.certPath),
        },
        app
      );
      server.listen(PORT, HOST, () => logStartup('SECURE HTTPS PORT', 'https'));
      return server;
    }

    console.warn(
      `[ar-ramapo] HTTPS_KEY_PATH (${config.HTTPS_KEY_PATH || '(unset)'}) or HTTPS_CERT_PATH ` +
        `(${config.HTTPS_CERT_PATH || '(unset)'}) not found — falling back to HTTP.\n` +
        '  MindAR/WebXR camera access requires a secure context on real devices, so AR\n' +
        '  testing on a phone will not work over plain HTTP. To fix: run\n' +
        '    mkcert localhost <your-lan-ip>\n' +
        '  and point HTTPS_KEY_PATH / HTTPS_CERT_PATH in .env at the generated files.'
    );
  }

  const server = http.createServer(app);
  server.listen(PORT, HOST, () => logStartup('HTTP PROXY MODE', 'http'));
  return server;
}
