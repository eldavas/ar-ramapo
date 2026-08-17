/**
 * Precisely locates the pixel row (in artboard design units) where the
 * Card artboard's body text begins, by scanning the rendered raster for
 * the body/subtitle text runs' own authored fill color (#3C3C43,
 * confirmed via tools/dump_riv_objects.py) instead of eyeballing a
 * screenshot — needed to build the fixed-header/scrollable-body DOM
 * split in CardPanel.ts without guessing a magic number.
 *
 * REVISION 1 (2026-08-14, third physical test): the first version of this
 * tool compared two full-artboard PNGs (short vs. long body) by eye and
 * reported "~100–107 design units". That measurement was too close to
 * the true boundary — a real device then showed the first body line
 * frozen/duplicated while scrolling, exactly the symptom of a header
 * crop that clips into the top of the body text. Rewritten to scan every
 * row for pixels matching the body/subtitle text runs' own fill color
 * (both share it, and the bold black title's anti-aliased edges blend
 * through close-enough gray tones to register too — so rows group into
 * bands, and the LAST band is always body, since nothing below it uses
 * that color) instead of eyeballing a screenshot, and recommend the
 * midpoint of the real gap between the end of the header content and the
 * start of body — margin on both sides, not hugging one edge.
 *
 * REVISION 2 (2026-08-14, fourth physical test): revision 1 only tested a
 * single-line title/subtitle. A real device with a subtitle long enough
 * to WRAP to 2 lines clipped into that second line — the boundary isn't
 * independent of content after all, since a longer title/subtitle simply
 * makes the header itself taller. This version renders a deliberately
 * generous worst case instead of a minimal one: a title AND subtitle both
 * long enough to force a 2-line wrap each (see WORST_CASE_TITLE/
 * WORST_CASE_SUBTITLE below — a realistic ceiling for asset-authoring-
 * guide.md's "short date/category tag" subtitle contract, not an
 * arbitrary number). Body length still doesn't matter — only ONE render
 * is needed (no more short/long comparison), since the header's own
 * geometry depends only on title/subtitle.
 *
 * Run:  node tools/inspect_card_header_boundary.mjs
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

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  document.body.appendChild(c);
  return c;
}
function loadInstance(options) {
  return new Promise((resolve, reject) => {
    const instance = new Rive({ ...options, onLoad: () => resolve(instance) });
    instance.on(EventType.LoadError, () => reject(new Error('LoadError')));
  });
}

// REVISION 2: a physical test with a real 2-line subtitle ("Checking the
// header/body boundary") clipped into the second subtitle line even with
// the single-line-subtitle measurement's recommended value — the header/
// body boundary is NOT content-length-independent after all: it depends
// on how many lines the title/subtitle wrap to, which depends on their
// actual text. Measuring the single-line case alone understated the real
// worst case. These two strings are long enough to force a 2-line wrap on
// both (asset-authoring-guide.md documents subtitle as meant to be a
// short "date/category tag" — 2 lines is a realistic, generously-margined
// worst case for that contract, not an arbitrary guess).
const WORST_CASE_TITLE = 'A Fairly Long Two-Line Building Name Example';
const WORST_CASE_SUBTITLE = 'A longer category tag that wraps to two lines';

try {
  const scale = 4; // high res for precise row detection
  const probe = makeCanvas(350, 480);
  const probeInstance = await loadInstance({ src: '/bench-ui.riv', canvas: probe, artboard: 'Card', stateMachines: 'CardMachine', autoplay: true });
  probeInstance.setTextRunValue('title', WORST_CASE_TITLE);
  probeInstance.setTextRunValue('subtitle', WORST_CASE_SUBTITLE);
  probeInstance.setTextRunValue('body', 'Short body only, one line.');
  probeInstance.stateMachineInputs('CardMachine').find((i) => i.name === 'isOpen').value = true;
  await sleep(1200);
  const bounds = probeInstance.bounds;
  const boundsW = bounds.maxX - bounds.minX;
  const boundsH = bounds.maxY - bounds.minY;

  const W = Math.round(boundsW * scale);
  const H = Math.round(boundsH * scale);
  const canvas = makeCanvas(W, H);
  const instance = await loadInstance({ src: '/bench-ui.riv', canvas, artboard: 'Card', stateMachines: 'CardMachine', autoplay: true });
  instance.setTextRunValue('title', WORST_CASE_TITLE);
  instance.setTextRunValue('subtitle', WORST_CASE_SUBTITLE);
  instance.setTextRunValue('body', 'Short body only, one line.');
  instance.stateMachineInputs('CardMachine').find((i) => i.name === 'isOpen').value = true;
  await sleep(1200);
  instance.resizeDrawingSurfaceToCanvas(1);
  await sleep(300);

  const data = canvas.getContext('2d').getImageData(0, 0, W, H).data;
  const target = [0x3C, 0x3C, 0x43];
  function hasBodyColor(rowStart) {
    for (let x = 0; x < W; x++) {
      const i = rowStart + x * 4;
      const a = data[i + 3];
      if (a < 40) continue;
      if (Math.abs(data[i] - target[0]) < 30 && Math.abs(data[i+1] - target[1]) < 30 && Math.abs(data[i+2] - target[2]) < 30) {
        return true;
      }
    }
    return false;
  }
  const rowHasColor = [];
  for (let y = 0; y < H; y++) rowHasColor.push(hasBodyColor(y * W * 4));

  const bands = [];
  let inBand = false;
  for (let y = 0; y < H; y++) {
    if (rowHasColor[y] && !inBand) { bands.push({ start: y, end: y }); inBand = true; }
    else if (rowHasColor[y] && inBand) { bands[bands.length - 1].end = y; }
    else if (!rowHasColor[y] && inBand) { inBand = false; }
  }
  // Merge bands separated by tiny gaps (< 6px at 4x scale, within-glyph
  // anti-aliasing holes), so each merged band is one real text block.
  const merged = [];
  for (const b of bands) {
    if (merged.length > 0 && b.start - merged[merged.length - 1].end < 6) {
      merged[merged.length - 1].end = b.end;
    } else {
      merged.push({ ...b });
    }
  }

  const bodyBand = merged[merged.length - 1];
  const priorBand = merged.length >= 2 ? merged[merged.length - 2] : null;

  await post('/result', JSON.stringify({
    scale, W, H, boundsW, boundsH,
    mergedBands: merged.map((b) => ({
      startPx: b.start, endPx: b.end,
      startDesignUnits: b.start / scale, endDesignUnits: b.end / scale,
    })),
    bodyBandStartDesignUnits: bodyBand ? bodyBand.start / scale : null,
    priorBandEndDesignUnits: priorBand ? priorBand.end / scale : null,
    recommendedHeaderHeightArtboardUnits:
      bodyBand && priorBand ? (priorBand.end / scale + bodyBand.start / scale) / 2 : null,
  }, null, 2));
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
