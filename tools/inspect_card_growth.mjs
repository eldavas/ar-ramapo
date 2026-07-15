// Card artboard growth probe (troubleshooting doc §12): shows the Card
// artboard's Hug height tracking content length, and the default
// Fit.Contain letterboxing the grown artboard horizontally inside a fixed
// 700x960 canvas (the pre-fix CardPanel condition). Healthy post-fix
// behavior lives in the app itself — this probe documents the raw asset +
// runtime interaction in isolation. Expected output: short content ->
// bounds 350x~408, raster solid 0-699; long content -> bounds 350x~604,
// raster solid ~72-627 (the letterbox this repo's CardPanel now corrects).
// Same transient-localhost + headless-Chrome pattern as inspect_rive_ui.mjs.
//
// Run:  node tools/inspect_card_growth.mjs
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
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

// Solid-pixel horizontal extents (alpha>200) + a mid-height row scan.
function solidExtents(canvas) {
  const { width: cw, height: ch } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, cw, ch).data;
  let minX = cw, maxX = -1;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      if (data[(y * cw + x) * 4 + 3] > 200) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
    }
  }
  const midY = Math.floor(ch / 2);
  let rowLo = -1, rowHi = -1;
  for (let x = 0; x < cw; x++) {
    if (data[(midY * cw + x) * 4 + 3] > 200) { if (rowLo === -1) rowLo = x; rowHi = x; }
  }
  return { solidMinX: minX, solidMaxX: maxX, midRowLo: rowLo, midRowHi: rowHi };
}

const SHORT = 'Paragraph';
const LONG = 'Agnatem hitaquia sintem ea dolut aut re etur senimus accatet pos ' +
  'sapidellaut faccae int lab ium inus modit, vent qui tem voloritatur? ' +
  'Ihitae nesti occusto remquaecus. Il maionse ditatiam voluptam ex et ' +
  'volorem. Otatiis eum simi, sam et, suntusam etesed undit aplhitae ' +
  'nesti occusto remquaecus. Otatiis eum simi sam et untusa.';

try {
  const canvas = document.createElement('canvas');
  canvas.width = 700; canvas.height = 960;   // CardPanel: 350x480 * backingScale 2
  document.body.appendChild(canvas);

  const card = await new Promise((resolve, reject) => {
    const instance = new Rive({
      src: '/bench-ui.riv', canvas, artboard: 'Card', stateMachines: 'CardMachine',
      autoplay: true, onLoad: () => resolve(instance),
    });
    instance.on(EventType.LoadError, () => reject(new Error('LoadError')));
  });

  const internals = card; // private handles, same cast RiveController uses
  const artboard = internals.artboard;
  const report = { initial: { bounds: card.bounds, artboardWH: [artboard.width, artboard.height] } };

  card.stateMachineInputs('CardMachine').find((i) => i.name === 'isOpen').value = true;
  await sleep(400);

  for (const [label, text] of [['short', SHORT], ['long', LONG], ['short_again', SHORT]]) {
    card.setTextRunValue('title', 'Domino Building');
    card.setTextRunValue('subtitle', '1922');
    card.setTextRunValue('body', text);
    await sleep(600);
    const bounds = card.bounds;
    report[label] = {
      bounds: { w: bounds.maxX - bounds.minX, h: bounds.maxY - bounds.minY },
      artboardWH: [artboard.width, artboard.height],
      raster: solidExtents(canvas),
    };
  }
  await post('/result', JSON.stringify(report, null, 2));
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
    if (req.url === '/result') { console.log(body); done(0); }
    res.end('ok');
    return;
  }
  const route = routes[req.url];
  if (!route) { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', route.type);
  res.end(route.body ?? (await readFile(route.file)));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--user-data-dir=/tmp/artboard-growth-profile', url,
], { stdio: 'ignore' });
const timeout = setTimeout(() => { console.error('TIMEOUT'); done(2); }, TIMEOUT_MS);
const code = await finished;
clearTimeout(timeout);
chrome.kill('SIGKILL');
server.close();
process.exit(code);
