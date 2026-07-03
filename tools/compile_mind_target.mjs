/**
 * Phase 3 tracking-target compiler (AR_SYSTEM.md §G).
 *
 * MindAR's target compiler (mind-ar v1.2.5 `Compiler`) only runs in a
 * browser — it needs canvas ImageData and its worker/tfjs pipeline — so
 * this harness spins up a transient localhost server, drives headless
 * Chrome through the compile, and writes the exported buffer to
 * public/assets/bench-target.mind (the manifest's mindTargetUrl).
 *
 * The server is a build tool, not the app server: it binds localhost
 * only, serves exactly three read-only paths (the compile page, the
 * mind-ar dist chunks, the plaque artwork), and exits with the compile.
 * §D's no-source-exposure rule governs the production server; nothing
 * here is reachable off-machine or after the run.
 *
 * Run:  node tools/compile_mind_target.mjs
 * Requires tools/plaque/bench-plaque.png (tools/build_plaque.py).
 */

import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MINDAR_DIST = path.join(repoRoot, 'node_modules/mind-ar/dist');
const PLAQUE_PNG = path.join(repoRoot, 'tools/plaque/bench-plaque.png');
const OUTPUT = path.join(repoRoot, 'public/assets/bench-target.mind');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TIMEOUT_MS = 10 * 60 * 1000;

const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
// Telemetry posts are best-effort: a dropped /progress fetch must never
// abort the compile (its own rejection would otherwise surface as a fatal
// unhandledrejection). Only /result and /error are awaited and decisive.
const post = (route, body) => fetch(route, { method: 'POST', body }).catch(() => {});
window.addEventListener('error', (e) => post('/error', 'window.onerror: ' + e.message));
window.addEventListener('unhandledrejection', (e) => post('/error', 'unhandled rejection: ' + e.reason));
try {
  await post('/progress', 'page loaded');
  const { Compiler } = await import('/dist/mindar-image.prod.js');
  await post('/progress', 'compiler module imported');
  const image = new Image();
  image.src = '/plaque.png';
  await image.decode();
  await post('/progress', 'image decoded ' + image.width + 'x' + image.height);
  const compiler = new Compiler();
  let lastReported = -1;
  await compiler.compileImageTargets([image], (p) => {
    const pct = Math.floor(p);
    if (pct > lastReported) {
      lastReported = pct;
      post('/progress', 'compile ' + pct + '%');
    }
  });
  await post('/progress', 'compiled, exporting');
  const buffer = await compiler.exportData();
  await post('/result', buffer);
} catch (error) {
  await post('/error', String((error && error.stack) || error));
}
</script>`;

function collectBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function main() {
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/compile.html') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(PAGE);
      } else if (request.method === 'GET' && url.pathname.startsWith('/dist/')) {
        // Serve mind-ar dist chunks only — flat directory, no traversal.
        const name = path.basename(url.pathname);
        const body = await readFile(path.join(MINDAR_DIST, name));
        response.writeHead(200, { 'content-type': 'text/javascript' });
        response.end(body);
      } else if (request.method === 'GET' && url.pathname === '/plaque.png') {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(await readFile(PLAQUE_PNG));
      } else if (request.method === 'POST' && url.pathname === '/result') {
        const body = await collectBody(request);
        response.end('ok');
        finish({ ok: true, body });
      } else if (request.method === 'POST' && url.pathname === '/error') {
        const body = await collectBody(request);
        response.end('ok');
        finish({ ok: false, message: body.toString() });
      } else if (request.method === 'POST' && url.pathname === '/progress') {
        const body = await collectBody(request);
        console.log(`[page] ${body.toString()}`);
        response.end('ok');
      } else {
        response.writeHead(404).end();
      }
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  console.log(`harness listening on 127.0.0.1:${port}`);

  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'mind-compile-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    // Software WebGL: tf.js inside the compiler needs a GL context, and
    // plain --disable-gpu removes it entirely in new headless mode.
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-first-run',
    `--user-data-dir=${profileDir}`,
    `http://127.0.0.1:${port}/compile.html`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  chrome.stderr.on('data', (chunk) => process.stderr.write(`[chrome] ${chunk}`));

  const timer = setTimeout(
    () => finish({ ok: false, message: `timed out after ${TIMEOUT_MS / 1000}s` }),
    TIMEOUT_MS,
  );

  const outcome = await done;
  clearTimeout(timer);
  chrome.kill();
  server.close();
  // Best-effort: Chrome may still be flushing profile files as it dies.
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});

  if (!outcome.ok) {
    console.error(`compile failed: ${outcome.message}`);
    process.exit(1);
  }
  if (outcome.body.length < 1024) {
    console.error(`compile produced implausibly small output (${outcome.body.length} bytes)`);
    process.exit(1);
  }
  await writeFile(OUTPUT, outcome.body);
  console.log(`wrote ${OUTPUT} (${outcome.body.length} bytes)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
