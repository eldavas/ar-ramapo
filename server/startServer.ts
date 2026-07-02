import fs from 'fs';
import path from 'path';
import https from 'https';
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

function resolveCertPaths(): CertPaths | null {
  const certPath = path.resolve(config.SSL_CERT);
  const keyPath = path.resolve(config.SSL_KEY);
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { certPath, keyPath };
  }
  return null;
}

function logStartup(protocol: string, ssl: boolean): void {
  const { PORT, NODE_ENV } = config;
  console.log('\nAR prototype server ready');
  console.log(`  environment : ${NODE_ENV}`);
  console.log(`  ssl         : ${ssl ? 'enabled' : 'disabled'}`);
  console.log(`  local       : ${protocol}://localhost:${PORT}`);
  for (const ip of getLocalNetworkIPs()) {
    console.log(`  network     : ${protocol}://${ip}:${PORT}  (phone, same WiFi)`);
  }
  console.log('');
}

export function startServer(): HttpServer | HttpsServer {
  const app = createApp();
  const { PORT, HOST, isProduction, ENABLE_HTTPS } = config;

  // Production: TLS termination happens at the hosting layer (reverse proxy,
  // load balancer, or platform edge — Vercel/Render/Railway/Fly/etc). The app
  // only ever speaks plain HTTP internally.
  if (isProduction) {
    return app.listen(PORT, HOST, () => logStartup('http', false));
  }

  if (ENABLE_HTTPS) {
    const certs = resolveCertPaths();
    if (certs) {
      const server = https.createServer(
        {
          key: fs.readFileSync(certs.keyPath),
          cert: fs.readFileSync(certs.certPath),
        },
        app
      );
      server.listen(PORT, HOST, () => logStartup('https', true));
      return server;
    }

    console.warn(
      `[ar-ramapo] SSL_CERT (${config.SSL_CERT}) or SSL_KEY (${config.SSL_KEY}) not found — falling back to HTTP.\n` +
        '  MindAR/WebXR camera access requires a secure context on real devices, so AR\n' +
        '  testing on a phone will not work over plain HTTP. To fix: run\n' +
        '    mkcert localhost <your-lan-ip>\n' +
        '  and point SSL_CERT / SSL_KEY in .env at the generated files.'
    );
  }

  return app.listen(PORT, HOST, () => logStartup('http', false));
}
