# AR_SYSTEM.md

**This file is the single source of truth for this project.** Any code, PR, or
decision that contradicts it is either a bug or a reason to update this file
first — never the other way around silently.

Status: Phase 3 (Spatial Bench-Test & Coordinate System Lockdown) open.
See §G for phase history.

---

## A. Project vision

**What this is:** a production-grade, cross-platform AR experience that
accompanies a **physical, 3D-printed architectural site model**. Scanning a
printed QR plaque opens a digital storytelling layer — interactive 3D
graphics, site timelines, and Rive-driven information cards — overlaid
directly on the physical structures, with no app-store install. The web
layer (MindAR + Three.js + Rive) is the primary delivery mechanism today and
the permanent delivery mechanism for Android. iOS gets a native
ARKit/RealityKit App Clip once that workstream starts — not a WebXR
experience, because WebXR AR sessions do not exist in Safari.

Two spatial invariants anchor the entire content pipeline:

- **The digital twin ships as a lightweight 3D mesh baked out of the source
  architectural CAD drawings.** Heavy, unoptimized CAD files never ship to
  the runtime — the deliverable asset is always a WebGL-optimized bake
  (glTF/GLB for web, USDZ for iOS), derived from CAD, not CAD itself.
- **The exact center of the QR plaque is the absolute origin (0, 0, 0) of
  the scene graph.** All model geometry, offsets, and interaction nodes are
  authored relative to that origin so the tracking engine's computed world
  coordinate system and the authored scene coincide by construction.

**What this is NOT:**
- Not a WebXR-first product. WebXR is an optional enhancement path that may
  apply to future Android capability, never a dependency of the core
  experience.
- Not a single-experience demo forever. The architecture must support more
  than one tracked target and more than one content bundle without a rewrite
  (see §E).
- Not a general-purpose static site. This is a camera-permission, secure
  context, asset-heavy application with different constraints than a normal
  web app (see §C, §D).

**Target platforms:**
- Web / Android — MindAR + Three.js + Rive, delivered as a standard HTTPS web
  experience, no install required.
- iOS — future native App Clip (ARKit + RealityKit + Rive iOS runtime). Not
  yet built. Not mixed into the web codebase (§F).

**Constraints that shape every decision below:**
- Safari has no `navigator.xr` AR session support. Any "WebXR" plan that
  assumes parity across browsers is wrong on its face.
- ARKit and MindAR are different tracking stacks with different compiled
  target formats (`.mind` vs. plain reference images) and different asset
  formats for 3D content (glTF/GLB vs. USDZ). They are not portable by
  translation, only by maintaining a shared source asset and a conversion
  pipeline.
- AR requires a secure context (HTTPS) for camera access on real devices.
  There is no dev/production split where this constraint disappears — only
  where TLS termination happens (locally via a dev cert, in production at the
  hosting/edge layer).

---

## B. Architecture rules

1. **Separation of concerns is mandatory.** AR session bootstrap, rendering,
   input handling, asset resolution, and the HTTP server are five distinct
   concerns and must live in five distinct modules. A change to one must not
   require touching the others.
2. **No monolithic files.** God-files that mix unrelated responsibilities
   (the original `app.js`, which mixed AR session bootstrap, Rive lifecycle,
   the input-to-artboard coordinate bridge, and the render loop in one
   156-line file) are explicitly forbidden going forward. New code in that
   area must be split along the boundaries above.
3. **No direct asset exposure from the server root.** The HTTP server must
   never serve its own source, configuration, lockfiles, or credentials. Only
   an explicitly designated public directory is web-reachable (§D).
4. **All web-servable files live under `/public`.** Nothing outside that
   directory is addressable over HTTP, ever, under any environment.

---

## C. Technology constraints

- **TypeScript everywhere for core logic.** Vanilla JS is not permitted for
  server code, client code, or shared logic. As of Phase 1 this applies to
  the client too — `public/app.js` no longer exists; its logic lives in
  `src/client/*.ts`, compiled by Vite (see §G).
- **Strict mode is non-negotiable.** Every `tsconfig.json` in this repository
  must set:
  - `"strict": true`
  - `"noImplicitAny": true`
  - `"noUnusedLocals": true`
- **No silent runtime failures.** TypeScript's type system exists here to
  catch mistakes at compile time — `any`, unchecked casts, and
  `// @ts-ignore` are not acceptable ways to satisfy the compiler. If a type
  is awkward, fix the type, not the compiler.

---

## D. Security constraints

- **No serving of the repository root.** Verified vulnerability from the
  pre-Phase-0 codebase: `express.static()` pointed at the project root
  exposed the dev TLS private key, full server source, `package.json`, and
  the lockfile over plain HTTP with zero authentication. This class of bug is
  now structurally prevented — the static middleware only ever points at
  `/public`.
- **No exposure of server internals.** `server/` is never inside the served
  directory tree. If it needs to be reachable, it needs to be an explicit
  route, not a side effect of static serving. `GET /api/manifest` (§E) is
  the canonical example: the manifest is exposed through a declared route
  with a specified response shape — never by making `packages/` reachable.
- **All assets must be explicitly declared in a manifest.** No AR experience
  may reference an asset path that isn't declared in the experience manifest
  (§E). This is a scaffold in Phase 0 (types only, no enforcement) and
  becomes load-bearing in the phase that wires it into the runtime.
- **No hardcoded file paths in runtime logic.** Once the manifest is wired in
  (post–Phase 0), asset URLs are resolved through it, not written as string
  literals in application code.

---

## E. Asset system rules

- All AR assets (Rive files, tracking targets, 3D models) are referenced
  through an `experience-manifest` package, keyed by `targetId`.
- The manifest is versioned per entry — an asset bundle update is a version
  bump, not a silent file replacement.
- Runtime logic never touches the filesystem directly to resolve an asset; it
  resolves a `targetId` through the manifest to get a URL.
- As of Phase 1, this is enforced at runtime, not just declared in types:
  `packages/experience-manifest/ManifestResolver.ts` resolves a `targetId` to
  its manifest entry and validates every asset URL on it, throwing a typed
  `ManifestResolutionError` — never returning `undefined` — if the target is
  unknown or a URL is malformed. `src/client/main.ts` calls this at startup;
  no asset path is written as a string literal in application code.

### Manifest schema (Phase 3 extension)

The manifest entry carries **global physical constraints and asset-path
routing, nothing else**:

- `targetId: string` — the experience key.
- `riveUrl: string` — the Rive UI asset.
- `modelUrl?: string` — the baked 3D mesh (glTF/GLB) for the web runtime.
- `usdzUrl?: string` — the USDZ variant of the same baked mesh, consumed by
  the future iOS App Clip. Same source scene, different export — never a
  separately authored asset.
- `mindTargetUrl?: string` — the compiled MindAR tracking target.
- `physicalTargetWidthMeters?: number` — the printed physical width of the
  tracking target. Optional in the type, but **required on any entry that
  declares `modelUrl`**: it is the sole scale bridge between meter-authored
  content and the tracking engines (MindAR anchor space is measured in
  marker-widths and needs the ×(1/width) conversion; ARKit sizes its
  `ARReferenceImage` from the same number).
- `version: string` — bumped on any asset change, never silently replaced.

### Manifest exposure: `GET /api/manifest`

Native clients (the future iOS App Clip) must resolve assets through the
same manifest as the web client (§F: platforms share creative assets and
the manifest *schema*, never code). The server exposes the **full versioned
manifest array — the exact `manifest.ts` shape, no more, no less** — at the
explicit route `GET /api/manifest`. Clients resolve their `targetId`
locally, mirroring `ManifestResolver`; the server never resolves on the
client's behalf, and the response never carries fields that are not in the
schema above.

### Golden Rule: zero UI/hotspot coupling in governance schemas

- The manifest schema, the `/api/manifest` response, and every table in this
  document are **forbidden** from carrying UI interaction attributes — Rive
  artboard bindings, state-machine keys, input names, card copy strings, or
  any per-node behavior matrix.
- All node-level interaction behavior is **encapsulated inside the asset
  file itself**: authored as Blender custom properties on the scene-graph
  nodes, exported as glTF `extras` (and the USD equivalent), surfacing at
  runtime as `object.userData`.
- The render engine **discovers** interaction nodes dynamically by tree
  traversal (the `hotspot_` name prefix), never by reading node lists,
  bindings, or copy from a configuration payload.
- Consequence: changing what a hotspot does, says, or triggers is an **asset
  edit and a manifest version bump** — it must never require touching this
  file, the schema, the API, or application code.

---

## F. AR constraints

- **MindAR is the only tracking library for the web layer.** No competing
  tracking library is introduced without a decision recorded in this file.
- **WebXR is an optional enhancement, never a dependency.** Nothing in the
  core experience may require `navigator.xr` to function, because it doesn't
  exist on iOS Safari and can't be relied on as a baseline anywhere.
- **iOS is a future native App Clip, not a web code path.** ARKit/RealityKit
  code does not belong in this repository's web application — when that
  workstream starts, it is a separate native project that shares creative
  assets and the manifest schema, not rendering code (see the architecture
  review preceding this document for the full Option A/B analysis).
- **Axis conventions are locked per engine, as named constants in code.**
  Authoring is Blender Z-up in meters; the glTF exporter converts to Y-up
  (authored north/+Y becomes runtime −Z). Each tracking engine frames the
  flat plaque differently: MindAR anchor space is X-east / Y-north / Z-up in
  **marker-width units**; ARKit `ARImageAnchor` is X-east / Y-up / Z-south
  in meters. The rotation/scale glue transform between authored space and
  each engine's anchor space is a named constant in the runtime that
  consumes it, validated by the Phase 3 bench-test, and never derived ad hoc
  at call sites.

---

## G. Phase history

- **Phase 0 — Foundation.** TypeScript migration of the server layer,
  root-exposure vulnerability fixed, `/public` boundary established,
  experience-manifest scaffold introduced. No functional or AR behavior
  change. No iOS work. No WebXR work. No new features.

- **Phase 1 — Core Web Refactor & Runtime Type Safety.** Eliminated the
  vanilla-JS client (`public/app.js` deleted); its logic now lives in four
  isolated `src/client/*.ts` modules (`ARSessionManager`, `RenderEngine`,
  `RiveController`, `InputBridge`) plus `main.ts`, wired together with zero
  global mutable state, under the same strict compiler settings as the
  server. `three` and `mind-ar` moved from CDN `<script>`/import-map
  dependencies to real, version-pinned npm packages, bundled by Vite
  (`vite.config.ts`) into `/public/dist`. `packages/experience-manifest`
  went from a typed scaffold to an active runtime validator
  (`ManifestResolver.ts`) — no asset URL in the client is a hardcoded string
  literal anymore. AR behavior (MindAR tracking, the Rive-to-artboard
  coordinate bridge, touch input) is functionally unchanged from
  pre-Phase-1; verified by strict type-checking, a clean Vite production
  build, live HTTP checks against the compiled server, and a headless-Chrome
  smoke test confirming the manifest resolves, MindAR bootstraps, and errors
  fail loudly (a missing-GPU `WebGLRenderer` error in that sandboxed
  environment was caught and logged by `main()`'s error handler exactly as
  designed, rather than failing silently — real camera/device testing is
  still the user's to do).

  **Production impact of this phase:**
  - *Performance & loading:* the client ships minified and code-split — a
    small (~5&nbsp;KB) app-logic entry (`main.js`) separate from a hashed
    vendor chunk containing `three`/`mind-ar`/Rive. Because the vendor chunk
    changes far less often than application code, repeat visits over mobile
    networks re-fetch only the small entry file; the large vendor payload
    stays cached. Every build produces new content hashes on changed files,
    so cache invalidation is deterministic instead of relying on the CDN's
    own cache headers.
  - *Runtime stability:* strict TypeScript (`strict`, `noImplicitAny`,
    `noUnusedLocals`, `noUnusedParameters`) across both client and server
    catches a whole class of mistakes — wrong argument types, unreachable
    `undefined`s, dead code — at compile time instead of on a user's device
    mid-session. Where the client *must* cross into unvalidated territory
    (an unknown `targetId`, a malformed manifest URL), `ManifestResolver`
    throws a specific, typed error immediately rather than letting a
    `fetch()` 404 or an `undefined` silently propagate into the render loop.
  - *Scalability:* adding a second tracked target/experience is now a
    manifest entry (`packages/experience-manifest/manifest.ts`), not a code
    change — `src/client/main.ts` already resolves its asset URLs
    dynamically through `resolveExperience()`.
  - *Source security:* the client ships as a built, minified bundle under
    `/public/dist`, not readable source modules — combined with the Phase 0
    fix, nothing under `src/`, `server/`, or `packages/` (TypeScript source,
    comments, internal structure) is ever reachable over HTTP; only the
    compiled output is.

  No iOS work. No WebXR work. No new UI features or tracking targets.

- **Phase 1.5 — TLS Termination Isolation & Environment-Agnostic Config.**
  `server/config.ts`'s `HTTPS_KEY_PATH`/`HTTPS_CERT_PATH` (renamed from
  `SSL_KEY`/`SSL_CERT`) now default to `""` — no hardcoded local file-path
  fallback survives onto a machine that never had that path. `PORT` parsing
  hardened against non-numeric input. `server/startServer.ts`'s orchestration
  collapsed to one rule: development with both cert paths present on disk →
  `https.createServer`; production, or missing certs for any reason → plain
  `http.createServer`, with startup logs stating `[SECURE HTTPS PORT]` or
  `[HTTP PROXY MODE]` explicitly. `fs.existsSync()` always gates
  `fs.readFileSync()` — a missing `.pem` can no longer throw an unhandled
  `ENOENT`. Verified booting cleanly with no `.env` at all, with dev certs
  present, and with `NODE_ENV=production` overriding certs that do exist.

- **Phase 2 — Cloud Deployment Readiness & Edge TLS Verification.** Split
  the build/run lifecycle to match how a PaaS actually deploys a container:
  `pnpm build` (`tsc && vite build`) compiles both the server (`/dist`) and
  the client (`/public/dist`) once, ahead of time; `pnpm start` now runs only
  `node dist/server.js` — no compiler, no Vite, no on-the-fly transpilation
  inside the running container (previously `start` re-ran `tsc` and `vite
  build` on every boot, which is fine for a laptop but wrong for a platform
  that should boot the same immutable artifact on every restart). Host
  binding and port injection were verified, not just asserted: booting with
  `env -i PATH="$PATH" NODE_ENV=production PORT=8080 node dist/server.js` —
  stripping the shell environment down to exactly what a fresh container
  provides — bound `0.0.0.0:8080` (confirmed via `netstat`, not just assumed
  from reading the code) and served `/health` and the built client bundle
  with zero exceptions. Reference environment-variable values for a host
  platform's dashboard are documented in `docs/deployment-spec.md`. No
  provider-specific CI/CD config (e.g. `render.yaml`) was added — the repo
  stays platform-agnostic.

  **Cloud network topology:**
  ```
  Phone / browser                Cloud platform edge              Node.js container
  ─────────────────              ────────────────────              ──────────────────
  https://ar.example.com  ──▶   Managed TLS termination    ──▶    http://0.0.0.0:$PORT
  (public HTTPS, camera-        (provider's certificate,           (server/startServer.ts,
   grade secure context)         handles the TLS handshake          [HTTP PROXY MODE] —
                                 transparently)                     plain HTTP internally)
  ```
  The browser's secure context requirement (mandatory for MindAR/WebXR
  camera access — see §A) is satisfied entirely at the edge. The Node
  process never holds a certificate in production and never needs to; it
  only ever speaks HTTP inside the platform's private network, which is
  exactly what Phase 1.5's orchestration rule already forces whenever
  `NODE_ENV=production`. This is the intended, permanent production
  topology — not a stand-in for local `.pem` certs, which remain
  development-only (§C, §F).

  No iOS work. No WebXR work. No changes to AR tracking, the Rive
  interaction bridge, or the manifest payload schema.

- **Phase 3 — Spatial Bench-Test & Coordinate System Lockdown. (OPEN)**
  Goal: prove the authored-space → tracked-space pipeline end to end with a
  low-fidelity mock scene before any architectural mesh exists, and lock
  the per-engine axis conventions (§F) permanently.

  **Governance scope (this document, done first):** manifest schema
  extension (`physicalTargetWidthMeters`, `usdzUrl` — §E), the
  `GET /api/manifest` route specification (§D, §E), and the Golden Rule on
  UI/hotspot decoupling (§E).

  **Physical rig:** a 5×5 cm printed QR plaque, taped dead flat, as the
  physical (0,0,0); a board-game box as the baseboard stand-in, its offset
  from the plaque center ruler-measured on all three axes (including the
  box height — proxies sit on top of it); **four dominos** as proxy
  buildings; a deliberate asymmetry tell in the arrangement so any axis
  flip is visible at a glance.

  **Authoring scope:** a Blender mock scene in meters mirroring the rig —
  `AR_World_Origin` empty at origin, `QR_Plaque_Proxy` plane at (0,0,0), a
  `Physical_Model_Offset_Group` translated by the measured offsets holding
  the baseboard and domino proxies, and `hotspot_*` empties inside the
  proxies carrying their interaction data as Blender custom properties
  (per the Golden Rule, §E). Exported as `.glb` for this phase and `.usdz`
  from the same scene for the future iOS workstream.

  **Runtime scope:** a `bench-test` manifest entry (first consumer of
  `modelUrl` + `physicalTargetWidthMeters`); three new `src/client`
  modules honoring §B separation — `SceneGraphLoader.ts` (loads the mesh,
  applies the §F glue transform, discovers `hotspot_*` nodes by
  traversal), `HotspotProjector.ts` (per-frame world→screen projection
  with frustum check, occlusion raycast, and hide-on-target-lost), and
  `HotspotOverlay.ts` (screen-space Rive cards pinned at projected
  coordinates); `main.ts` switches the active target. No changes to
  `ARSessionManager`, `InputBridge`, or the server beyond the declared
  route.

  **Pass criteria:** virtual baseboard within ~5 mm of the physical box
  edges at 0.5 m viewing distance from multiple angles; hotspot pins
  visually locked to their dominos (within a few pixels) while orbiting;
  behavior reproducible across re-detections; occlusion and frustum
  handling verified. **Deliverables:** the locked §F glue-transform
  constants and measured accuracy numbers (including the small-marker
  lever-arm error) recorded here on phase close.

  Exit condition: production content becomes a pure asset swap — the
  CAD-baked mesh replaces the proxies in the same hierarchy under the same
  origin convention, with zero application-code change.

  No iOS work. No WebXR work.
