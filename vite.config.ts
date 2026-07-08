import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This project's static web root is /public (see AR_SYSTEM.md §D — the
// Express server only ever serves that directory, nothing else is
// web-reachable). Vite's own automatic "publicDir" passthrough is disabled
// so it never tries to treat /public as its asset-copy directory; the build
// entry is the client's TS module directly, not an HTML file, so index.html
// (hand-maintained in /public) stays untouched by the build and references
// the output with one stable <script> tag — see /public/index.html.
//
// The 8th Wall engine (xr.js) is deliberately NOT bundled: it is a binary
// artifact with its own runtime chunk loader (data-preload-chunks), served
// self-hosted from /xr by the Express server. Only the tiny npm shim
// (@8thwall/engine-binary's index.js, which exposes XR8Promise) goes
// through Rollup.
export default defineConfig({
  publicDir: false,
  // The bundle is served from /dist (an Express-static subpath of /public),
  // not the site root. Without an explicit base, chunk URLs (the vendor
  // chunk, the engine-binary shim reached via dynamic import) can resolve
  // against the document root and 404 as /assets/... instead of
  // /dist/assets/... — observed with the hand-maintained index.html setup.
  base: '/dist/',
  build: {
    outDir: 'public/dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/client/main.ts'),
      output: {
        entryFileNames: 'main.js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        // Third-party render/UI runtimes change far less often than
        // application code; splitting them into their own chunk means an
        // app-code change doesn't bust the (larger) vendor cache entry on
        // repeat visits over mobile networks.
        manualChunks(id: string): string | undefined {
          if (
            id.includes('node_modules') &&
            (id.includes('/three/') || id.includes('@rive-app'))
          ) {
            return 'vendor';
          }
          return undefined;
        },
      },
    },
  },
});
