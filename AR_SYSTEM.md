# AR_SYSTEM.md

**This file is the single source of truth for this project.** Any code, PR, or
decision that contradicts it is either a bug or a reason to update this file
first — never the other way around silently.

Status: Phase 3 (Spatial Bench-Test & Coordinate System Lockdown) open —
blocks only on the on-device pass-criteria measurement. Phase 4 (Native iOS
App Clip) open. Phase 5 (Rive Interaction Layer & Content Binding) open.
Phase 6 (8th Wall SLAM Tracking, Additive Engine) open — see §G. See §G for
full phase history. The Phase 0–5 document (MindAR as the only web tracking
engine) is preserved verbatim at `AR_SYSTEM_LEGACY_MINDAR.md` for history;
this file supersedes it as of Phase 6.

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
- Web / Android — Three.js + Rive, delivered as a standard HTTPS web
  experience, no install required. Two tracking engines are supported side
  by side as of Phase 6 (§F): **MindAR** (printed-plaque image tracking,
  the original and still-active engine — `proxy-target`, `bench-test`) and
  **8th Wall** (SLAM world tracking + GPS geofence + optional image-target
  hybrid — `8thwall-test`). An experience declares exactly one, via the
  manifest's `mindTargetUrl` (MindAR) or `placement` (8th Wall) fields
  (§E) — never both. Rive rendering, the Marker/Card artboard contract,
  and the whole content pipeline (`SceneGraphLoader`, `MarkerLayer`,
  `CardPanel`, `ContentProvider`, `HotspotProjector`) are shared,
  unmodified, across both engines, behind an `AnchorSource` seam (§F).
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
- `trackingImageUrl?: string` — the raw plaque artwork (PNG), for tracking
  engines that consume the image directly instead of a compiled feature
  file: ARKit builds its `ARReferenceImage` from this bitmap plus
  `physicalTargetWidthMeters`. Same single-source artwork that
  `tools/build_plaque.py` generates and `bench-target.mind` was compiled
  from — never a separately authored image. Required on any entry the iOS
  App Clip consumes (`.mind` is MindAR-only and unreadable by ARKit).
- `contentUrl?: string` — route to the experience's external display-content
  source, resolved by the client-side `ContentProvider` seam (Golden Rule
  amendment below, Phase 5). Phase 5 points it at a published Google Sheet
  endpoint; a future CMS is the same field with a different URL and a
  different provider implementation — never a schema change. It carries a
  URL only, never content. This is the one manifest field permitted to be an
  absolute `https://` URL (an external source by definition); every other
  asset URL remains a root-relative `/public` path.
- `physicalTargetWidthMeters?: number` — the printed physical width of the
  tracking target. Optional in the type, but **required on any entry that
  declares `modelUrl`**: it is the sole scale bridge between meter-authored
  content and the tracking engines (MindAR anchor space is measured in
  marker-widths and needs the ×(1/width) conversion; ARKit sizes its
  `ARReferenceImage` from the same number). For 8th Wall `placement:'image'`
  entries this same field sizes the image target; it does **not** scale
  the mounted mesh (8th Wall's `scale:'absolute'` mode mounts at scale 1 —
  see §F) — it is a cross-check against the engine's own meter estimate
  only, warned on >25% divergence, never a render multiplier.
- `placement?: 'tap' | 'image'` — 8th Wall path selector (Phase 6, §F).
  Undefined means the legacy MindAR path, routed off `mindTargetUrl`
  below; present means 8th Wall SLAM owns this experience. `'tap'` gates
  arrival on `geo` then freezes the origin on a SLAM tap-to-place gesture;
  `'image'` uses an 8th Wall image target (`imageTargetUrl`) as a
  continuously-realigned origin, with SLAM persisting the anchor between
  sightings. An entry declares this field XOR `mindTargetUrl`, never both.
- `geo?: { latitude: number; longitude: number; radiusMeters: number }` —
  GPS arrival gate for the 8th Wall path (`GeoFenceSpec`). Required for
  `placement:'tap'` (the only arrival signal); optional but recommended
  for `placement:'image'` (stops users hunting for a plaque miles away).
  Never a positioning source — GPS accuracy is 10–30 m outdoors, so this
  only gates arrival; the precise origin always comes from SLAM.
- `imageTargetUrl?: string` — compiled 8th Wall image-target JSON
  (`npx @8thwall/image-target-cli`) for `placement:'image'` entries — the
  8th Wall analogue of `mindTargetUrl`, never declared alongside it.
- `mindTargetUrl?: string` — the compiled MindAR tracking target (legacy
  engine path, §F). An entry declares this XOR `placement`, never both.
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
- **Display content is addressed by the asset, never stored in the schema
  (Phase 5 amendment).** A hotspot's `userData` carries its content
  *binding key* (`contentKey`) and its Rive bindings (`riveArtboard`,
  `riveStateMachine`); the display content behind that key (card title,
  body copy, image reference) MAY live in an external content source,
  resolved at runtime through the client-side `ContentProvider` seam and
  routed via the manifest's `contentUrl`. The manifest schema, the
  `/api/manifest` response, and this document remain forbidden from
  carrying the content itself or any per-node behavior matrix.
- The render engine **discovers** interaction nodes dynamically by tree
  traversal (the `hotspot_` name prefix), never by reading node lists,
  bindings, or copy from a configuration payload.
- Consequence: changing what a card *says* is a **content-source edit** (a
  sheet row today, a CMS record later — no redeploy); changing what a
  hotspot *binds to* is an **asset edit and a manifest version bump**.
  Neither must ever require touching this file, the schema, the API, or
  application code.

---

## F. AR constraints

- **MindAR and 8th Wall are the two supported web tracking engines (Phase 6
  supersedes the original "MindAR is the only tracking library" rule).** No
  *third* tracking library is introduced without a decision recorded in
  this file. An experience declares exactly one engine per manifest entry
  (§E: `mindTargetUrl` XOR `placement`), never both, and the two engines
  share every downstream module unmodified — `SceneGraphLoader`,
  `HotspotProjector`, `MarkerLayer`, `CardPanel`, `ContentProvider` — via
  the `AnchorSource` seam (`src/client/AnchorSource.ts`): `kind`,
  `group` (the mount point scene content parents under), `acquire()`,
  `isTracking()`, `onOriginChanged()`. MindAR's own anchor is not an
  `AnchorSource` implementation (it predates the interface) — its
  `main.ts` branch stays entirely separate and untouched; 8th Wall's
  `TapPlacedAnchorSource` (SLAM tap-to-place) and `ImageTargetAnchorSource`
  (SLAM + image target hybrid) are the two current implementations.
  `SceneGraphLoader`'s constructor takes an `engine: 'mindar' | '8thwall'`
  parameter (default `'mindar'`, so every pre-Phase-6 call site is
  unaffected): MindAR needs its own glue rotation/scale baked into the
  loaded mesh (below); 8th Wall's `AnchorSource` implementations already
  deliver a correctly oriented, real-meters anchor under `scale:'absolute'`,
  so the loader mounts at identity rotation and scale 1 for that engine —
  applying MindAR's glue on top would double-transform the scene.
- **The 8th Wall engine binary is not MIT-licensed.** It ships under a
  Niantic Spatial limited-use license
  (`node_modules/@8thwall/engine-binary/LICENSE`): free for XR Engine
  purposes, revocable, non-transferable; §1.2 restricts use in a paid
  product whose value derives substantially from the Software's
  functionality (revisit before any commercial deployment); §1.3.1
  requires attribution "in any material in which Licensee utilizes the
  functionality of the Software" — rendered as the engine's own
  `resources/powered-by.svg` badge, always visible, linking to
  8thwall.org (`public/index.html`, `#powered-by-8thwall`). Do not remove
  it without re-reading §1.3. Self-hosted from `/xr`
  (`server/createServer.ts`, same pattern as `/rive`) — no CDN at
  runtime, same rule as every other runtime dependency in this repo.
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
  (authored north/+Y becomes runtime −Z). As of Phase 4 the USD export is
  converted to the same Y-up / −Z-forward convention at export time, so
  both runtime assets (`.glb`, `.usdz`) share one delivered orientation and
  the USDZ complies with the Y-up stage convention ARKit/AR Quick Look
  assume. Each tracking engine frames the
  flat plaque differently: MindAR anchor space is X-east / Y-north / Z-up in
  **marker-width units**; ARKit `ARImageAnchor` is X-east / Y-up / Z-south
  in meters; 8th Wall's `scale:'absolute'` mode uses real meters directly
  (identity rotation/scale from `SceneGraphLoader`, per the engine-coexistence
  rule above), with `ImageTargetAnchorSource`'s own
  `TARGET_FRAME_TO_WORLD_FIX` supplying the image-target frame fix
  (best-inference pending further on-device validation — see
  `docs/research/8th-wall-troubleshooting.md`). The rotation/scale glue
  transform between authored space and each engine's anchor space is a
  named constant in the runtime that consumes it, validated by the Phase 3
  bench-test (MindAR) or by on-device Phase 6 testing (8th Wall), and never
  derived ad hoc at call sites.

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

  **Progress (2026-07-02):** governance and runtime scope are implemented
  and verified. Manifest schema extended (`physicalTargetWidthMeters`,
  `usdzUrl`) with resolver enforcement (declaring `modelUrl` without a
  positive `physicalTargetWidthMeters` throws at resolution);
  `GET /api/manifest` serves the exact manifest array, verified against
  the compiled production build; the three client modules landed —
  `SceneGraphLoader.ts` (owns the §F glue constants), `HotspotProjector.ts`
  (frustum, occlusion-with-ancestor-exclusion, and polled tracking-loss
  guards), `HotspotOverlay.ts` (cards driven exclusively by asset
  `userData`, per the Golden Rule) — wired in `main.ts` behind the
  `modelUrl` declaration. Strict typecheck and production build clean; the
  `bench-test` manifest entry is registered.

  **Progress (2026-07-03): bench-test is live; phase blocks on on-device
  validation.** All Phase 3 assets are authored, deployed, and active:

  - `tools/build_bench_scene.py` (headless Blender) authors the mock scene
    from the ruler-measured rig coordinates — plaque printed-face center at
    world (0,0,0) per §A, measurements preserved verbatim inside
    `Physical_Model_Offset_Group`, `hotspot_*` **empties** (not meshes — a
    co-located hotspot mesh would occlude itself in `HotspotProjector`)
    carrying `label`/`riveStateMachine` custom properties per the Golden
    Rule. Exports `bench-scene.glb` + `bench-scene.usdz` from one scene.
  - `tools/build_plaque.py` generates the single-source plaque artwork (QR
    to the live experience, asymmetry tell, +Y north arrow) and a print
    sheet with a 100 mm calibration bar; `tools/compile_mind_target.mjs`
    compiles `bench-target.mind` from that same PNG with mind-ar 1.2.5's
    own `Compiler` (headless Chrome harness). Printed plaque, tracking
    data, and digital twin are pixel-identical by construction.
  - The physical rig is printed and assembled; `ACTIVE_TARGET_ID` is
    flipped to `bench-test` (manifest entry at version 0.2.0 — all four
    hotspots now declare `riveStateMachine`); deployed and smoke-tested
    (manifest, model, target, and Rive assets all serving).

  **The single remaining step before phase close:** on-device validation
  against the pass criteria above, then recording the validated §F glue
  constants and measured accuracy numbers here. Two authoring assumptions
  to check explicitly on device: domino 1/4 dims were taken as local
  (pre-rotation) extents with the 90° applied as object rotation, and all
  measured Z values were read as heights above the box-cover top surface.

  **Progress (2026-07-03): on-device iPhone testing surfaced four
  stabilization/correctness bugs in the runtime scope, all fixed; phase
  still blocks on the pass-criteria measurement pass above.**

  - **Frame-rate-dependent smoothing.** `HotspotOverlay`'s screen-position
    Lerp and tracking-loss hysteresis were fixed per-frame constants (a
    fraction-per-tick factor, a frame count) — correct only at a constant
    60fps. iPhone tracking is exactly the scenario where frame time is
    least stable (thermal throttling under camera + tracking + WASM load),
    so smoothing and hide behavior ran faster or slower than tuned
    depending on device load. Fixed by threading real elapsed time through
    the render loop: `RenderEngine.onFrame` now reports `deltaMs` (it
    previously passed the raw, unused `requestAnimationFrame` timestamp);
    `HotspotOverlay` converts the tuned 60fps-reference Lerp factor into a
    time-compensated one and expresses the hysteresis grace period in
    milliseconds rather than a frame count. Verified numerically: the
    compensated factor returns the original tuned value exactly at 60fps,
    scales up correctly at lower rates, and approaches a direct
    snap-to-target after a long stall (e.g. a backgrounded tab) instead of
    an oddly slow partial lerp.
  - **Silent lookup failure.** `HotspotOverlay.update()` silently skipped
    any projection whose `Hotspot` object wasn't found in its internal
    maps — a real invariant (object-identity keys, stable only because
    `SceneGraphLoader` builds the hotspot list once) with no enforcement
    or signal if ever violated, contradicting §C's no-silent-failure rule.
    Now warns once per hotspot, naming exactly which one and why, instead
    of failing invisibly.
  - **Duplicate UI mount.** `main.ts` unconditionally created the
    pre-Phase-3 single Rive-textured plane (anchored directly above the
    tracking target) for every experience, *in addition to* the Phase 3
    spatial pipeline whenever `modelUrl` was declared. For `bench-test`
    this rendered an extra, unintended card directly over the QR
    origin — the origin is a reference point, not a hotspot (§A) — and
    that leftover plane was the only thing actually receiving touch
    input, because its input path (`InputBridge`, a document-level 3D
    raycast) doesn't depend on DOM hit-testing the way the hotspot cards
    do. The two paths are now mutually exclusive on
    `experience.modelUrl`: spatial experiences get only the hotspot
    pipeline, non-spatial ones keep the legacy plane.
  - **Touch target too small.** With the duplicate mount removed, the
    hotspot cards' own unresponsiveness became visible: their
    `pointerdown`/`pointerup` listeners were attached only to the inner
    96×96px Rive canvas, not the full visible card (label text + padded
    pill background), so most of what looked tappable wasn't. Listeners
    now attach to the whole card; a tap landing outside the inner canvas
    clamps to the nearest valid canvas coordinate before mapping into
    artboard space.

  Verified by strict typecheck and a clean production build after each
  fix; on-device confirmation of touch response and single-card rendering
  is the next step, ahead of the pass-criteria measurement pass still
  blocking phase close.

  **Progress (2026-07-03, second on-device pass): Rive input and proxy
  contrast confirmed working on iPhone; that pass surfaced one regression
  and one calibration bug, both fixed.**

  - **Black-screen regression (camera feed invisible).** Root cause was a
    CSS painting-order subtlety introduced by the previous fix round, not
    a stream or tracking failure (tracking kept working — cards and
    dominos appeared over a black void). MindAR injects its camera
    `<video>` with `z-index: -2`. While only `body` carried
    `background: #000`, that background propagated to the root canvas
    (painted behind everything, negative z-index included) and the video
    was visible. The gesture-blocking change had set the background on
    `html, body` together; with `html` owning a background, `body`'s no
    longer propagates and instead paints at its normal position in the
    painting order — *above* negative-z-index descendants. The body's
    black rectangle covered the video while the transparent WebGL canvas
    (z-index auto) and card overlay (z-index 10) still painted on top:
    exactly "scene visible, camera black." Fixed two ways at once: the
    page background lives on `body` only (restoring propagation), and
    `#ar-container` now sets `isolation: isolate`, trapping the video's
    negative z-index inside the container's own stacking context so no
    future page-level background can ever paint over the camera again.
  - **Card jitter after the rigid tracking profile.** Expected trade-off
    surfaced by the profile split: with pose smoothing removed
    (`TRACKING_PROFILE_RIGID_ANCHOR`), the estimator's high-frequency
    noise reaches the 2D projection raw, and the fixed-factor Lerp in the
    overlay can't both kill tremor at rest and stay lag-free during pans.
    Replaced the Lerp with a proper One Euro filter in **screen space
    only** (`src/client/OneEuroFilter.ts`, per-axis per-card): the 3D
    scene keeps the rigid pose (no swim), while the overlay's cutoff
    frequency adapts to card speed — canonical pointing defaults
    (minCutoff 1.0 Hz, beta 0.007, dCutoff 1.0 Hz). Verified numerically:
    ±3 px input tremor at rest collapses to ~0.3 px output; a 600 px/s
    pan carries only ~10 px steady-state lag; the first frame after a
    hysteresis reset snaps exactly to the input (no ghost slide). Filter
    history resets when the hide-grace window expires, so re-detections
    anchor at the new position instead of sliding from the old one.
    On-device calibration knobs are documented at the constants in
    `HotspotOverlay.ts` (lower minCutoff if rest tremor persists; raise
    beta if fast pans feel draggy).

  No iOS work. No WebXR work.

- **Phase 4 — Native iOS App Clip. (OPEN)**
  Goal: the iOS delivery path promised in §A — a native App Clip
  (Swift / SwiftUI / ARKit / RealityKit / Rive iOS runtime) that consumes
  the exact same creative assets and manifest as the web client, sharing
  zero rendering code with it (§F). The native workspace lives in
  `../ar-appclip`, a sibling of this repository — ARKit/RealityKit code
  never enters this repo.

  **Governance scope (this document, done first):**
  - Manifest schema gains `trackingImageUrl` (§E): ARKit consumes the raw
    plaque bitmap + `physicalTargetWidthMeters` to build its
    `ARReferenceImage`; the compiled `.mind` file is MindAR-only. The
    plaque PNG is now hosted under `/public/assets` (same single-source
    artwork from `tools/build_plaque.py`, now copied into the served tree
    by that tool).
  - The `bench-test` entry declares `usdzUrl` and `trackingImageUrl`
    (version 0.3.0) — the USDZ existed and was served but was never
    declared, so no manifest-resolving client could reach it.
  - `GET /.well-known/apple-app-site-association` is served as an explicit
    route (§D) with `Content-Type: application/json` — Apple's domain
    verification for App Clip invocation requires it. Platform deployment
    identity (Team ID + Clip bundle ID), not an AR asset: it lives in
    `server/appleAppSiteAssociation.ts`, never in the manifest (§E).
  - The USDZ export in `tools/build_bench_scene.py` is re-specified as a
    **Y-up, `.usda`-packaged USDZ** (same Blender scene, same single
    export path — §E's zero-duplication rule intact). Two reasons,
    both verified empirically against the previous artifact: (a) the old
    export was a Z-up `.usdc` stage, violating the Y-up convention ARKit
    and AR Quick Look assume (§F); (b) RealityKit's loader exposes no API
    for USD `userProperties`, so the Golden Rule's metadata channel
    (`label`, `riveStateMachine` on `hotspot_*` prims) was unreadable on
    iOS from the binary crate — the ASCII `.usda` layer inside the
    package is parsed by the App Clip's own small USD-text reader, while
    RealityKit loads the identical package for rendering.

  **Native scope (in `../ar-appclip`):** manifest intake mirroring
  `ManifestResolver` semantics (typed errors, URL validation, the
  modelUrl↔physicalTargetWidthMeters pairing rule applied to `usdzUrl`);
  ARKit world tracking with a continuously-tracked detection image sized
  from `physicalTargetWidthMeters` (initially pure image tracking for
  web-behavior parity; the first on-device TestFlight pass showed ARKit's
  per-frame `isTracked` flickering on any motion blur, hiding the UI
  constantly — world tracking keeps the anchor registered at its last
  pose while the plaque is briefly unreadable, which is correct for a
  static rig; the web keeps hide-on-target-lost, and the native overlay
  constants — hysteresis 750 ms, One Euro minCutoff 0.6 — are tuned
  per-platform by design);
  version-keyed asset caching; scene-graph mount with the §F glue
  constants for ARKit (identity rotation and unit scale by construction,
  given the Y-up meters export — recorded as named constants regardless,
  per §F, and validated by re-running the Phase 3 bench-test rig on
  device); hotspot discovery by `hotspot_` prefix traversal of the
  RealityKit entity tree joined with the parsed `userProperties`; a
  screen-space One Euro filter (same constants as `HotspotOverlay.ts`)
  and the same 250 ms tracking-loss hysteresis; single-path touch
  forwarding into the Rive artboard, mirroring the web's
  clamp-to-canvas-edge behavior.

  **Exit condition:** the bench-test rig passes the Phase 3 §G pass
  criteria on the native stack (same plaque, same rig, same asymmetry
  tell), and the validated ARKit glue constants are recorded here.

  No changes to web-client runtime code. No WebXR work.

- **Phase 5 — Rive Interaction Layer & Content Binding. (OPEN)**
  Goal: replace the bench-test per-hotspot label cards with the production
  interaction model — a per-hotspot **Marker** Rive instance as the visual
  cue, plus **one** screen-fixed **Card** bottom sheet as the universal
  content panel — and prove the external-content seam end to end (§E
  Golden Rule amendment): card copy edited in an external source (a Google
  Sheet this phase) appears in the AR card with zero code, asset, or
  schema change.

  **Interaction model:** the app owns *placement*, Rive owns *appearance*.
  Markers are repositioned every frame by the existing
  projector/One-Euro/hysteresis pipeline; their artboard animates only
  local state (idle / pressed / selected / dimmed). The Card's canvas
  never moves; its enter/exit/refresh motion lives entirely inside the
  artboard — which is why it always animates from the same screen spot
  regardless of which marker was tapped. Tap detection stays at the DOM
  level as the single input path (`shouldDisableRiveListeners: true`
  stands, per the Phase 3 on-device double-fire lesson); the app answers
  the Card's authored close button through a Rive Event rather than
  letting the artboard mutate its own `isOpen` state.

  **Governance scope (this document, done first):** the `contentUrl`
  manifest field (§E), the Golden Rule amendment separating content
  *binding* (in the asset) from content *storage* (external, behind the
  `ContentProvider` seam) (§E), and this entry.

  **Runtime scope:** `@rive-app/canvas-lite` → `@rive-app/canvas` (the
  Card renders Rive Text; the lite runtime has no text support);
  `RiveController` gains named-artboard support, a shared parsed
  `RiveFile` across instances, and public fail-loud accessors for boolean
  inputs, triggers, text runs, and Rive events; `HotspotOverlay` →
  `MarkerLayer` (same projection/filter/hysteresis skeleton, Rive-only
  visuals, tap → selection callback); new `CardPanel` (bottom sheet,
  content set via text runs + `cardImage` referenced-asset substitution);
  new `ContentProvider` seam with a `GoogleSheetContentProvider` (gviz
  JSON endpoint — a future CMS is a new provider class, nothing else
  changes).

  **Authoring scope:** `bench-ui.riv` — two artboards (`Marker`, `Card`);
  the exact artboard / state-machine / input / text-run / event naming
  contract lives in docs/asset-authoring-guide.md, not here (Golden Rule:
  this file never lists input names). Bench-scene rebuild: `hotspot_*`
  nodes gain `contentKey` and `riveArtboard` custom properties, and
  `riveStateMachine` values rename `'State Machine 1'` → `'MarkerMachine'`
  (the Rive-editor default name said nothing; both the .riv and the scene
  are new this phase, so the rename is free). Manifest `bench-test` →
  0.4.0.

  **Pass criteria:** tap a marker → the Card opens with that hotspot's
  content; the other markers dim; tapping another marker while open swaps
  content with the authored refresh pulse (no close/reopen); the Card
  closes via its authored close button, tap-outside, and re-tapping the
  selected marker; tracking loss hides markers but never the Card;
  editing a sheet cell changes the card copy on next load with no
  redeploy; `proxy-target` runs regression-free.

  **Exit condition:** the CMS-era migration is a provider swap — a new
  `ContentProvider` implementation pointed at the CMS endpoint — with
  zero changes to the manifest schema, the assets, or the UI modules.

  No iOS work in this repo. No WebXR work. No new tracking targets.
  Independent of Phase 3's on-device measurement pass and Phase 4's
  native workstream.

- **Phase 6 — 8th Wall SLAM Tracking, Additive Engine. (OPEN)**
  Goal: add Niantic 8th Wall SLAM world tracking (+ GPS geofence, +
  optional image-target hybrid) as a **second, opt-in** tracking engine,
  alongside MindAR rather than replacing it — the original spike this
  work is based on (`8th-wall` branch, single-commit, no common git
  ancestor with `master`) framed it as a full pivot; this repo's Phase 6
  is deliberately additive instead, since `proxy-target` and `bench-test`
  still depend on MindAR. Full chronological detail, including three
  wrong turns on the viewport bug before on-device measurement settled
  it, lives in `docs/research/8th-wall-troubleshooting.md` — read it
  before re-deriving any of this.

  **Why 8th Wall:** SLAM world tracking plus drift correction, over
  MindAR's image-only tracking — better stability for the ARClip/web
  parity workstream. The hosted 8th Wall platform retired February 2026;
  the project uses the free, self-hostable `@8thwall/engine-binary`
  (SLAM World Effects, Image Targets, Absolute Scale — no VPS/Lightship
  Maps, those are enterprise-only via Niantic Spatial), so the arrival
  signal is a coarse GPS geofence plus either SLAM tap-to-place or an
  8th Wall image target for the precise origin.

  **Governance scope (this document, done first):** the engine-coexistence
  rule and licensing/attribution note (§F), the additive manifest schema
  extension — `placement`, `geo`, `imageTargetUrl` (§E) — and this entry.
  Unlike the original spike's own governance record, `mindTargetUrl`
  was **not** removed and `placement` was made optional, not required —
  the spike's schema would have broken `proxy-target`/`bench-test` at
  compile time.

  **Extraction approach:** surgical (`git checkout 8th-wall --
  <paths>`), not a merge — `git merge-base` confirms the two branches
  share no common history, and a straight
  `git merge --allow-unrelated-histories -X theirs` would have silently
  replaced this document's entire Phase 0–5 record, the Apple App Clip
  association route, and `package.json`'s dependency set with the
  spike's own versions. Eleven new client modules were pulled in as-is
  (`EightWallSession`, `AnchorSource`, `PlacementController`,
  `TapPlacedAnchorSource`, `ImageTargetAnchorSource`, `ImageTargetLoader`,
  `GeoFenceService`, `DevSimSession`, `FrameBus`, `UxOverlay`,
  `RecordGeoMode`), plus two type-declaration files and the compiled
  `bench-plaque` image-target assets that were missed in the first
  extraction pass. `@8thwall/engine-binary` was added to `package.json`
  by hand; `mind-ar` was kept.

  **Runtime scope:** `main.ts` forks on `experience.placement !==
  undefined` into `runEightWallExperience()`, sharing
  `SceneGraphLoader`/`MarkerLayer`/`CardPanel`/`ContentProvider`/
  `HotspotProjector` unmodified with the MindAR branch (§F's
  `AnchorSource` seam); the MindAR branch is untouched. Desk-testing
  bypasses are query params, not build flags: `?fakegeo=1` (fake GPS
  fix), `?fakear=1` (swap the engine for `DevSimSession`'s orbiting-camera
  sim — SLAM only runs on real phones), `?recordgeo=1` (GPS-recording
  site-setup mode). `?debug=1` activates an on-screen console (a plain
  inline `<script>` at the top of `index.html`'s `<body>`, installed
  before `/dist/main.js` and its import graph even begin to evaluate —
  necessary because this repo has previously hit module-load failures
  a constructor-time console patch would have missed entirely).

  **Infrastructure:** `/xr` static route (`server/createServer.ts`,
  mirrors `/rive`); `public/index.html`'s `#camerafeed` canvas coexists
  with MindAR's `#ar-container` (only one is driven per page load); the
  `#powered-by-8thwall` license attribution link (§F). Test entry
  `8thwall-test` reuses `bench-test`'s own `bench-scene.glb`,
  `bench-ui.riv`, and content sheet, so the tracking engine is the only
  variable under test. `main.ts`'s `ACTIVE_TARGET_ID` currently points at
  `8thwall-test` for this walkthrough — flip it back to `bench-test` to
  resume the MindAR path; no other change needed.

  **Progress (2026-07-09):** viewport rendering confirmed fixed on-device
  with measured numbers (`canvas.getBoundingClientRect()` now matches
  `window.innerWidth/innerHeight` exactly; `renderer.getPixelRatio()` and
  `camera.aspect` both correct) — see the troubleshooting doc §3 for the
  three earlier wrong turns and why each was wrong. A scale-mismatch
  warning (`ImageTargetAnchorSource`'s cross-check against
  `physicalTargetWidthMeters`) was investigated and confirmed **not** to
  drive any render transform in either consumer (`anchorScaleForEvent()`
  always returns `1`; `SceneGraphLoader`'s 8th-Wall branch never reads
  the value) — see the troubleshooting doc §4.

  **Still open, blocking phase close:** Rive markers/cards do not
  reliably render on top of the tracked content — they flash briefly on
  first image-target detection, then disappear, so a tap never gets the
  chance to open a card. Leading hypothesis: unstable image-target
  tracking (repeated found/lost cycles, a non-converging scale estimate
  across the same session) rather than a code defect in the marker
  pipeline itself, which is shared, unmodified, with the already-working
  MindAR path. See the troubleshooting doc §5–6 for the full evidence
  chain and the branching next-steps plan (get a clean
  `isTracking()` transition log first; branch from there).

  **Progress (2026-07-09, second pass):** desk research against the
  official 8th Wall engine docs narrowed the leading hypothesis to the
  `trackingStatus === 'NORMAL'` gate in `ImageTargetAnchorSource
  .isTracking()` interacting with `scale:'absolute'`'s documented
  behavior (status sits `LIMITED` until absolute scale converges — and
  §4 of the troubleshooting doc shows it never converged). Full
  transition-only, on-device telemetry landed across the chain
  (`EightWallSession` reason capture, image events, `isTracking()`
  snapshot, `HotspotProjector` visibility reasons, `MarkerLayer`
  display transitions, tap chain) — troubleshooting doc §7 has the log
  grammar, the expected timeline, and the open (a)/(b) decision. **No
  behavior change shipped; the fix decision explicitly waits on a clean
  on-device capture.**

  **Progress (2026-07-09, first instrumented capture):** hypothesis
  refuted in its specific form — `trackingStatus` read `undefined` in
  every snapshot: the `reality.trackingstatus` listener parsed the
  payload off the top-level event object, but the binary wraps every
  listener payload as `{name, detail}` (verified by construction in the
  installed `dist/xr.js`; image events only ever worked because
  `emitImage()` had the `.detail` unwrap from day one). The gate could
  therefore never pass, in any session, under any tracking quality — a
  parse bug, not a tracking-quality problem. Parse fixed (unwrap +
  fail-loud warn on a still-unparseable payload); the `NORMAL` gate
  itself deliberately untouched — troubleshooting doc §8 has the full
  capture analysis, including that absolute scale now converges
  (0.046–0.063 m vs. 0.05 declared) and that the next capture decides
  whether the gate needs changing at all.

  **Progress (2026-07-09, second instrumented capture): the original
  marker symptom is FIXED and verified on device** — markers render,
  persist through image-lost windows (`trackingStatus=NORMAL`
  throughout; the §8 gate question resolved as "gate was fine"), and a
  marker tap fires its Rive selection visual. **The still-open blocker
  moved one link down: tapping a marker never opens its Card, and after
  the first tap all markers stop responding** — leading theory: the
  Card opens invisibly and its `pointer-events:auto` bottom-sheet box
  swallows every subsequent tap (the Card has never been verified
  rendering on any engine; Phase 5's MindAR verification was
  interrupted by this phase's pivot). Card-chain telemetry landed;
  troubleshooting doc §9 has both candidate scenarios, what each log
  line discriminates, and the `?fakear=1` desk test that exercises the
  tap→card chain without a field session.

  **Progress (2026-07-09, third instrumented capture):** the invisible
  card confirmed by telemetry — `card.open()` ran to completion and its
  container logged 22 s of swallowed taps while nothing was visible:
  the open issue is now precisely "the Card artboard renders invisibly
  under `isOpen=true`", discriminated next by the corrected desk test
  (`?fakear=1&fakegeo=1&debug=1` — `fakegeo` is required; the geofence
  gate runs before the engine branch and blocks any desk). A separate
  viewport shrink (dead space right/bottom) was diagnosed as page/pinch
  zoom, NOT a §3 recurrence — `touch-action: none` did not inherit onto
  `#camerafeed`; guarded now, and the canvas diagnostics log
  `visualViewport` scale. Troubleshooting doc §10.

  **Progress (2026-07-10): invisible-Card root cause found — an asset
  authoring bug in `bench-ui.riv`, not code.** Isolated headlessly with
  the new `tools/inspect_rive_ui.mjs` (same harness pattern as
  `compile_mind_target.mjs`): `CardMachine` transitions
  `Closed → OpenIdle` correctly on `isOpen=true`, but renders 0 pixels
  through the state machine while the same `OpenIdle` animation played
  directly renders ~547k — `Closed` keys the card's visibility off and
  `OpenIdle` never keys it back on; the contracted `Enter`/`Exit`
  animations don't exist in the file. The fix is a Rive-editor asset
  edit + re-export + manifest version bump (Golden Rule: appearance
  belongs to the asset). Full probe data and the authoring fix list in
  troubleshooting doc §11.

  **Exit condition:** the `8thwall-test` rig passes the same functional
  bar as `bench-test` — markers persist on tracked content, tapping opens
  the correct card — on a real device, with the root cause of the
  marker-rendering gap above identified and either fixed or, if it's a
  physical tracking-quality issue, documented with a mitigation.

  No iOS work. No WebXR work. No changes to the MindAR runtime path.
