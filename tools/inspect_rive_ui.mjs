/**
 * Rive UI asset inspector (troubleshooting doc §11).
 *
 * Loads public/assets/bench-ui.riv in headless Chrome with the exact
 * @rive-app/canvas runtime the app bundles, then:
 *   1. enumerates the file's REAL contents (artboards / state machines /
 *      inputs / animations) — the ground truth the asset-authoring-guide
 *      contract is checked against;
 *   2. instantiates Card+CardMachine, flips isOpen=true, records the
 *      state-change sequence and counts non-transparent pixels over time;
 *   3. plays the OpenIdle animation directly (no state machine) as the
 *      control that separates "content missing" from "state machine
 *      arrives at a state whose animation doesn't key visibility back on";
 *   4. renders Marker+MarkerMachine as the known-good control.
 *
 * This is how the invisible-Card bug was pinned without a device or the
 * Rive editor: CardMachine transitions Closed→OpenIdle correctly, but the
 * state-machine render stays at 0 pixels while OpenIdle played directly
 * draws ~547k — i.e. Closed keys the card's visibility off and OpenIdle
 * never keys it back on (and the contracted Enter/Exit animations don't
 * exist in the file at all). Re-run after any bench-ui.riv re-export; the
 * expected-healthy signature is a non-zero state-machine pixel count.
 *
 * Same transient-localhost + headless-Chrome pattern as
 * compile_mind_target.mjs: localhost-only, read-only, exits with the run.
 *
 * Run:  node tools/inspect_rive_ui.mjs
 */

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

function opaquePixels(canvas) {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let count = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 8) count++;
  return count;
}

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

try {
  const report = {};

  // 1+2. Contents, then the Card driven through its state machine.
  const c1 = makeCanvas(700, 960);
  const stateChanges = [];
  const card = await loadInstance({
    src: '/bench-ui.riv', canvas: c1, artboard: 'Card', stateMachines: 'CardMachine',
    autoplay: true, onStateChange: (e) => stateChanges.push(JSON.stringify(e.data)),
  });
  report.contents = card.contents;
  report.cardBounds = card.bounds;
  await sleep(400);
  const samples = { closed_400ms: opaquePixels(c1) };
  const isOpen = card.stateMachineInputs('CardMachine').find((i) => i.name === 'isOpen');
  if (!isOpen) throw new Error('no isOpen input on CardMachine');
  isOpen.value = true;
  for (const wait of [250, 500, 1000, 2000]) {
    await sleep(wait);
    samples['open_+' + wait + 'ms_cumulative'] = opaquePixels(c1);
  }
  report.cardStateChanges = stateChanges;
  report.cardPixels_stateMachine = samples;

  // 3. OpenIdle played directly — bypasses the state machine, starts from
  // the artboard's design-time defaults.
  const c2 = makeCanvas(700, 960);
  await loadInstance({ src: '/bench-ui.riv', canvas: c2, artboard: 'Card', animations: 'OpenIdle', autoplay: true });
  await sleep(800);
  report.cardPixels_OpenIdle_direct = opaquePixels(c2);

  // 4. Marker control.
  const c3 = makeCanvas(240, 240);
  const marker = await loadInstance({ src: '/bench-ui.riv', canvas: c3, artboard: 'Marker', stateMachines: 'MarkerMachine', autoplay: true });
  await sleep(500);
  report.markerPixels = { idle_500ms: opaquePixels(c3) };
  const isSelected = marker.stateMachineInputs('MarkerMachine').find((i) => i.name === 'isSelected');
  if (isSelected) {
    isSelected.value = true;
    await sleep(600);
    report.markerPixels.selected_600ms = opaquePixels(c3);
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
    if (req.url === '/progress') console.error('[progress]', body);
    if (req.url === '/error') { console.error('[page error]', body); done(1); }
    if (req.url === '/result') { console.log(body); done(0); }
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
  '--user-data-dir=/tmp/inspect-rive-ui-profile', url,
], { stdio: 'ignore' });

const timeout = setTimeout(() => { console.error('[harness] TIMEOUT'); done(2); }, TIMEOUT_MS);
const code = await finished;
clearTimeout(timeout);
chrome.kill('SIGKILL');
server.close();
process.exit(code);
