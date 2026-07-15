/**
 * Card width probe runner (AR_SYSTEM.md §G Phase 6, 2026-07-14 width-bug
 * investigation). Drives public/__width-probe.html in headless Chrome:
 * that page loads the REAL app (same origin, so the iframe DOM is
 * reachable) at several device-like viewport widths, clicks through the
 * arrival gate, and measures every layer that could constrain the Card's
 * width — DOM rects, computed styles, ancestor transforms, and the Rive
 * canvas raster itself (soft + solid pixel extents per row, which no DOM
 * measurement can see).
 *
 * Healthy signature, per size: container rect width == innerWidth, and
 * raster solid extents 0..(backingWidth-1). Anything else localizes the
 * constraint: DOM numbers → CSS/layout; raster side gaps → Rive
 * fit/artwork.
 *
 * Same transient-collector + headless-Chrome pattern as
 * inspect_rive_ui.mjs: localhost-only, read-only, exits with the run.
 *
 * Run:  node dist/server.js   (the real app server, in another shell)
 *       node tools/run_width_probe.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP_URL = 'https://localhost:3000/__width-probe.html';
const TIMEOUT_MS = 120 * 1000;

const result = await new Promise((resolve, reject) => {
  const collector = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method !== 'POST') { res.end(); return; }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.end('ok');
      collector.close();
      resolve(body);
    });
  });
  collector.listen(4600, '127.0.0.1', () => {
    const chrome = spawn(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        // Reproduces phone backing-store conditions: devicePixelRatio 3
        // drives CardPanel's backingScale to its MAX_BACKING_SCALE=2 path
        // (700x960 canvas), same as on-device. Re-run with this flag
        // removed to cover the dpr=1 / backingScale=1 path too.
        '--force-device-scale-factor=3',
        '--enable-unsafe-swiftshader',
        '--ignore-certificate-errors',
        '--window-size=1400,1100',
        '--user-data-dir=/tmp/width-probe-profile',
        '--no-first-run',
        APP_URL,
      ],
      { stdio: 'ignore' }
    );
    const timer = setTimeout(() => {
      chrome.kill();
      collector.close();
      reject(new Error('width probe timed out — is the app server running on :3000?'));
    }, TIMEOUT_MS);
    collector.on('close', () => { clearTimeout(timer); chrome.kill(); });
  });
});

console.log(result);
