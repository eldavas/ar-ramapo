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
export default defineConfig({
  publicDir: false,
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
        // Third-party AR/render/UI runtimes change far less often than
        // application code; splitting them into their own chunk means an
        // app-code change doesn't bust the (larger) vendor cache entry on
        // repeat visits over mobile networks.
        manualChunks(id: string): string | undefined {
          if (
            id.includes('node_modules') &&
            (id.includes('/three/') || id.includes('/mind-ar/') || id.includes('@rive-app'))
          ) {
            return 'vendor';
          }
          return undefined;
        },
      },
    },
  },
});
