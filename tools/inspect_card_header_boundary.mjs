/**
 * Renders the Card artboard (CardMachine, isOpen=true) with a short and a
 * long body, each sized to its own natural bounds, and saves both as PNGs
 * for direct visual inspection — simpler and more reliable than a pixel
 * heuristic given Rive's centering/Fit behavior wasn't fully predictable
 * from the outside. See CardPanel.ts for how the resulting boundary
 * (visually read off these two images) is used.
 *
 * Run:  node tools/inspect_card_header_boundary.mjs
 * Output: /tmp/card-header-boundary-short.png, .../-long.png
 */
import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TIMEOUT_MS = 60 * 1000;

const PAGE = `<!doctype html><meta charset="utf-8">
<script src="/rive/rive.js"></script>
<script type="module">
const post = (route, body) => fetch(route, { method: 'POST', body }).catch(() => {});
window.addEventListener('error', (e) => post('/error', 'window.onerror: ' + e.message));
window.addEventListener('unhandledrejection', (e) => post('/error', 'unhandled rejection: ' + e.reason));

const { Rive, RuntimeLoader, EventType } = rive;
RuntimeLoader.setWasmUrl('/rive/rive.wasm');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  document.body.appendChild(c);
  return c;
}

function loadInstance(options) {
  return new Promise((resolve, reject) => {
    const instance = new Rive({ ...options, onLoad: () => resolve(instance) });
    instance.on(EventType.LoadError, () => reject(new Error('LoadError ' + JSON.stringify(options.artboard))));
  });
}

async function renderVariant(bodyText, scale) {
  const probe = makeCanvas(350, 480);
  const probeInstance = await loadInstance({
    src: '/bench-ui.riv', canvas: probe, artboard: 'Card', stateMachines: 'CardMachine', autoplay: true,
  });
  probeInstance.setTextRunValue('title', 'Same Title Every Time');
  probeInstance.setTextRunValue('subtitle', 'Same Subtitle');
  probeInstance.setTextRunValue('body', bodyText);
  probeInstance.stateMachineInputs('CardMachine').find((i) => i.name === 'isOpen').value = true;
  await sleep(1200);
  const bounds = probeInstance.bounds;
  const boundsW = bounds.maxX - bounds.minX;
  const boundsH = bounds.maxY - bounds.minY;

  const W = Math.round(boundsW * scale);
  const H = Math.round(boundsH * scale);
  const canvas = makeCanvas(W, H);
  const instance = await loadInstance({
    src: '/bench-ui.riv', canvas, artboard: 'Card', stateMachines: 'CardMachine', autoplay: true,
  });
  instance.setTextRunValue('title', 'Same Title Every Time');
  instance.setTextRunValue('subtitle', 'Same Subtitle');
  instance.setTextRunValue('body', bodyText);
  instance.stateMachineInputs('CardMachine').find((i) => i.name === 'isOpen').value = true;
  await sleep(1200);
  instance.resizeDrawingSurfaceToCanvas(1);
  await sleep(300);
  return { canvas, boundsW, boundsH, W, H };
}

try {
  const scale = 2;
  const short = await renderVariant('Short body only, one line.', scale);
  const long = await renderVariant(
    ('Ramapo College is a public liberal arts college in Mahwah, New Jersey. ').repeat(40),
    scale
  );

  const shortPng = short.canvas.toDataURL('image/png');
  const longPng = long.canvas.toDataURL('image/png');

  await post('/result', JSON.stringify({
    scale,
    short: { boundsW: short.boundsW, boundsH: short.boundsH, W: short.W, H: short.H, png: shortPng },
    long: { boundsW: long.boundsW, boundsH: long.boundsH, W: long.W, H: long.H, png: longPng },
  }));
} catch (error) {
  await post('/error', String(error && error.stack || error));
}
</script>`;

const routes = {
  '/': { body: PAGE, type: 'text/html' },
  '/rive/rive.js': { file: path.join(repoRoot, 'node_modules/@rive-app/canvas/rive.js'), type: 'text/javascript' },
  '/rive/rive.wasm': { file: path.join(repoRoot, 'node_modules/@rive-app/canvas/rive.wasm'), type: 'application/wasm' },
  '/bench-ui.riv': { file: path.join(repoRoot, 'public/assets/bench-ui.riv'), type: 'application/octet-stream' },
};

let done;
const finished = new Promise((resolve) => { done = resolve; });

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.url === '/error') { console.error('[page error]', body); done(1); }
    if (req.url === '/result') {
      const report = JSON.parse(body);
      const shortB64 = report.short.png.replace(/^data:image\/png;base64,/, '');
      const longB64 = report.long.png.replace(/^data:image\/png;base64,/, '');
      await writeFile('/tmp/card-header-boundary-short.png', Buffer.from(shortB64, 'base64'));
      await writeFile('/tmp/card-header-boundary-long.png', Buffer.from(longB64, 'base64'));
      console.log(JSON.stringify({ scale: report.scale, short: { ...report.short, png: '(saved)' }, long: { ...report.long, png: '(saved)' } }, null, 2));
      done(0);
    }
    res.end('ok');
    return;
  }
  const route = routes[req.url];
  if (!route) { res.statusCode = 404; res.end(); return; }
  const body = route.body ?? (await readFile(route.file));
  res.setHeader('content-type', route.type);
  res.end(body);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
console.error('[harness] serving at', url);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=/tmp/inspect-card-header-boundary-profile', url,
], { stdio: 'ignore' });

const timeout = setTimeout(() => { console.error('[harness] TIMEOUT'); done(2); }, TIMEOUT_MS);
const code = await finished;
clearTimeout(timeout);
chrome.kill('SIGKILL');
server.close();
process.exit(code);
