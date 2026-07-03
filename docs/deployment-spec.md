# Deployment Spec — Cloud PaaS (Render or equivalent)

Reference configuration for deploying this repository to a container-based
PaaS (Render, Railway, Fly.io, etc). Platform-agnostic on purpose — see
AR_SYSTEM.md §G Phase 2; no provider-specific CI/CD files (`render.yaml`
and similar) are checked into this repo.

## Build & start commands

| Dashboard field | Value | What it does |
|---|---|---|
| Build Command | `pnpm build` (or `npm run build`) | Runs `tsc && vite build` — compiles the server (`server.ts` + `server/**/*.ts` → `/dist`) and the client (`src/client/main.ts` → `/public/dist`) in one step. Errors here fail the deploy before any container starts. |
| Start Command | `pnpm start` (or `npm start`) | Runs `node dist/server.js` only. No compiler, no Vite, no on-the-fly transpilation in the running container — it executes already-built JavaScript. |

`dist/server.js` is the verified production entry point — it's the compiled
form of the root `server.ts` (a two-line entrypoint that calls
`startServer()`; see AR_SYSTEM.md §B rule 1, "no logic in the entrypoint").
There is no separate `dist/server/startServer.js` executable — that file is
an internal module `dist/server.js` imports, not something you run directly.

Locally, the equivalent of what the platform does automatically is two
separate commands, not the old combined `start` script:

```
pnpm build
pnpm start
```

## Environment variables (set these on the host platform's dashboard)

| Variable | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | Forces `[HTTP PROXY MODE]` regardless of any other variable — see `server/startServer.ts`'s orchestration rule. Also disables the dev-only `.env` file load attempt's relevance (platforms inject env vars directly; no `.env` file exists in the container). |
| `PORT` | Leave unset | The platform injects this dynamically at container start. `server/config.ts` reads `process.env.PORT`; do not hardcode a value that could conflict with what the platform assigns. |
| `HOST` | Leave unset | Defaults to `0.0.0.0` (see `server/config.ts`), which is required for the platform's routing layer to reach the container. Do not set this to `127.0.0.1` or `localhost`. |
| `HTTPS_KEY_PATH` | Leave unset/empty | Must resolve to `""` in production. TLS is terminated at the platform's edge (§2.4 / AR_SYSTEM.md §G), not inside the container — setting this would point at a path that doesn't exist on the host filesystem, though `NODE_ENV=production` already forces HTTP regardless. |
| `HTTPS_CERT_PATH` | Leave unset/empty | Same as above. |
| `CORS_ORIGIN` | The production domain(s), e.g. `https://ar.example.com` | The `.env.example` default of `*` is a local-dev convenience; production should scope this to the real origin(s) serving the experience. Comma-separate multiple origins. |

## Verified locally as a stand-in for the container environment

```
$ pnpm build
✓ tsc — zero errors
✓ vite build — public/dist/main.js + public/dist/assets/vendor-*.js

$ env -i PATH="$PATH" NODE_ENV=production PORT=8080 node dist/server.js

AR prototype server ready [HTTP PROXY MODE]
  environment : production
  local       : http://localhost:8080
  network     : http://192.168.1.24:8080  (phone, same WiFi)

$ netstat -an | grep 8080
tcp4  0  0  *.8080  *.*  LISTEN        # bound to all interfaces, not just loopback

$ curl http://localhost:8080/health
{"status":"ok","env":"production"}
```

`env -i` strips the shell's entire environment before setting only
`PATH`/`NODE_ENV`/`PORT` — the closest local approximation of what a fresh
container actually provides (no `.env` file, no `HOST`, no HTTPS variables).
The server booted directly to HTTP proxy mode, bound every interface, and
served both `/health` and the built client bundle with no crash and no
unhandled exception.

## Network topology in production

See AR_SYSTEM.md §G, Phase 2, for the full Edge TLS Termination / Internal
Routing diagram.
