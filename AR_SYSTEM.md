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
  **Forward-looking amendment (recorded 2026-08-10, not yet built — see §E
  and the Phase 3 production-swap design notes in §G):** the production
  Ramapo site model is planned to carry **four plaques, one per side**,
  which supersedes this rule for that experience only — `bench-test` and
  `proxy-target` keep the single-plaque-center origin unchanged. For the
  four-plaque experience, the origin becomes a fixed reference corner of
  the site-model footprint instead of a plaque center, and each plaque's
  position/mount rotation is authored as an offset from that corner.

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
  (§E) — never both. Rive rendering (the Marker artboard contract), the
  Card (plain HTML/CSS as of 2026-08-14 — see §G Phase 3's fifth
  physical-device-test entry), and the whole content pipeline
  (`SceneGraphLoader`, `MarkerLayer`, `CardPanel`, `ContentProvider`,
  `HotspotProjector`) are shared, unmodified, across both engines, behind
  an `AnchorSource` seam (§F).
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

### Multi-target plaques (forward design, Phase 3 production extension — not yet built, recorded 2026-08-10)

For experiences with more than one physical tracking plaque — the planned
production Ramapo layout, one plaque per side of the site model (§A) — the
single `mindTargetUrl`/`imageTargetUrl` fields above are insufficient (they
assume exactly one target per experience, with its center as the origin).
An entry needing multiple plaques declares an optional `targets: PlaqueTarget[]`
instead, XOR with the singular fields, mirroring the existing dual-engine
optional-field pattern rather than introducing a new one:

```
targets?: Array<{
  mindTargetIndex?: number;        // MindAR: index within one multi-image
                                    // .mind bundle (compiler upload order)
  imageTargetUrl?: string;         // 8th Wall: this plaque's compiled
                                    // image-target JSON
  imageTargetName?: string;        // 8th Wall: the target `name` carried
                                    // on Xr8ImageTrackedEvent — matches it
                                    // to this entry at runtime
  physicalTargetWidthMeters: number;
  originOffsetMeters: { x: number; z: number };  // this plaque's position,
                                                  // measured from the §A
                                                  // reference corner
  rotationYawDeg: number;          // corrects this plaque's physical mount
                                    // rotation so content anchors
                                    // identically in world space regardless
                                    // of which plaque triggered tracking
}>
```

Design constraints, decided ahead of the actual numbers (still blocked on
the physical panel-footprint measurement — see the digital-twin sourcing
work):

- **Runtime resolution**: whichever plaque is currently tracked reports an
  index (MindAR `Controller.onUpdate`'s `targetIndex`) or a name (8th
  Wall's `Xr8ImageTrackedEvent.name`) — the runtime looks up the matching
  `targets[]` entry and composes its `rotationYawDeg` + `originOffsetMeters`
  with the tracked pose *before* mounting content, so the same building
  anchors to the same real-world spot no matter which of the four plaques a
  visitor scanned. This closes the "no per-target routing built yet" gap
  already flagged in `docs/asset-authoring-guide.md` §3.3.
- **The four plaque images must be visually distinct from each other, not
  rotated copies of one design.** Feature-based tracking (both MindAR and
  8th Wall) is generally in-plane rotation-invariant — if all four plaques
  used identical artwork, the tracker could not tell which physical plaque
  is in view, and the offset-resolution step above would have no reliable
  input. Each plaque's illustration also independently needs the §3.1
  asset-authoring-guide tracking-quality properties (asymmetric,
  non-repeating detail) — the two requirements compose, they don't
  conflict.
- **All four plaques decode to the identical experience URL.** Which
  plaque is in use is resolved entirely by tracking identity (above), never
  by the QR payload — there is no `?side=` query param or per-plaque URL.

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
- **Every new visual overlay is classified as screen-space or world-space
  before it's designed further — a taxonomy, not a per-feature decision
  (recorded 2026-08-10).**
  - **Screen-space / Rive-owned**: flat, always camera-facing, never
    depth-tested against scene geometry. This is Rive's actual capability
    — a 2D vector/state-machine runtime with no true 3D scene or camera
    system — used today for the hotspot marker and Card panel (§E).
    Correct only for content with no real position on the physical model
    (e.g. clouds, general sky-birds not tied to a ground position) or
    content that is deliberately UI, not world content.
  - **World-space / three.js-owned**: part of the tracked scene graph, so
    it gets correct perspective, occlusion by real scene geometry, and
    parallax for free from the render engine, exactly like the buildings
    and terrain already do. Required for anything tied to a real position
    on the model — a building material highlight, particles constrained to
    a topographic contour line, cars on roads, pedestrians on sidewalks.
  - Rive cannot substitute for the world-space category under any
    circumstances, regardless of how flat or lowfi the target art style
    is — **art style and rendering category are independent decisions.** A
    flat, silhouette-styled car is still world-space content (typically a
    camera-facing billboarded sprite authored *in* the three.js scene, not
    in a `.riv` file) if it needs to sit at a real position and be occluded
    by a building.

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

  **Production-swap design notes (recorded 2026-08-10, forward-looking —
  not yet built, beyond this phase's original exit condition above).**
  Decisions made ahead of the actual production build, during the
  digital-twin sourcing work, so they aren't re-derived later. None of this
  blocks Phase 3 close; it's scoped for whenever the production swap
  happens, and it means the original exit condition's "zero
  application-code change" framing no longer holds in full for the
  four-plaque production experience specifically — `bench-test` and
  `proxy-target` are unaffected.

  **Tracking/origin architecture (not a content addition) — fully designed
  in §A/§E, cross-referenced here only:** four tracking plaques, one per
  side of the site model, replacing the single-plaque origin for this
  experience. The physical layout, manifest schema (`targets[]`),
  origin-corner convention, and per-plaque `rotationYawDeg` correction are
  designed in §A/§E above — still blocked on the physical panel-footprint
  measurement before real offset numbers can be computed.

  **Three candidate content/animation additions**, each classified per
  the screen-space/world-space taxonomy (§F, also recorded 2026-08-10):
    - *Building color/material highlight on tap* — world-space. Needs a
      hotspot-to-building association at the asset level (a new `userData`
      key on the hotspot, per the Golden Rule) so the runtime can identify
      and tint the specific mesh being explored. **Asset-level schema
      designed and first-pass built 2026-08-13**: `tools/build_site_buildings.py`
      now authors a `hotspot_*` empty per building with a real matched
      name (12 of 21 — see the digital-twin sourcing notes for which),
      each carrying `buildingId` (the association key), plus `label`/
      `contentKey` for the future Card. The other 9 buildings (no real
      name yet) intentionally have no hotspot. `riveArtboard`/
      `riveStateMachine` are still unset — no Card/Marker UI has been
      designed for buildings yet, and the runtime tap-handler that reads
      `buildingId` to actually tint a mesh doesn't exist yet either; this
      closes the asset-schema gap only, not the interaction itself.
      Otherwise cheap: a one-time material swap, no sustained per-frame
      cost.
    - *Contour-constrained particle "pulse" animation*, traveling along a
      topographic elevation line on tap/proximity — world-space, and
      explicitly **not** a Rive capability regardless of how the idea is
      sometimes described elsewhere; it needs a genuine three.js particle
      system. Data source already exists: the site DWG decode found 425
      `POLYLINE` contour entities across 49 elevations (digital-twin
      sourcing work) — these would need to survive the terrain-authoring
      pipeline as traversable point sequences, not just baked into static
      mesh geometry the way `tools/build_bench_scene.py`-style scripts
      author meshes today. Real performance risk, not just a note: this
      project has already hit on-device thermal throttling from tracking +
      rendering alone (Phase 6 progress above); a live simulation adds
      sustained cost on the same budget. Bounded/occasional trigger, so
      cheaper than the item below.
    - *Ambient background loop* — cars, pedestrians, birds, clouds,
      continuous from scene load, not interaction-triggered. World-space
      for anything tied to a real ground position (cars on roads, people
      on sidewalks — needs correct occlusion behind buildings);
      screen-space is viable only for content with no fixed position
      relative to the model (clouds, and possibly birds if they drift
      generally overhead rather than track specific ground positions).
      Proposed implementation for the world-space actors: camera-facing
      billboarded sprites — flat/lowfi silhouette art direction, small
      textures, near-zero geometry — positioned in the three.js scene
      graph, never Rive, despite the flat art style (§F: art style and
      rendering category are independent). Of the three additions, this is
      the highest sustained performance cost — always-on, multiple
      concurrent actors — versus the other two, which are one-time or
      bounded/occasional.
    - *Procedural contour-line surface treatment* (recorded 2026-08-12,
      deferred until the terrain mesh is actually integrated into an
      experience) — the physical model's fine engraved/printed topo lines
      turned out to be a material concern, not a geometry one: the first
      working terrain mesh (see the digital-twin sourcing notes) has
      correct shape and full elevation coverage but is flat-shaded gray,
      missing the contour-line look entirely. Proposed fix is a procedural
      height-based contour shader (`fract(height / interval)` thresholded
      near zero — a standard topographic-shading technique) rather than
      baking/UV-texturing the original polylines onto the mesh, since it
      reproduces the lines directly from the geometry with no separate
      texture asset and can't drift out of sync if the mesh changes later.
      **Must be a three.js runtime material, not a Blender-only preview
      material** — a Blender shader wouldn't carry over to the actual app.
      World-space per the §F taxonomy (it's textural detail on real scene
      geometry, not UI).
    - **Open, undecided:** whether cars/pedestrians are authored at true
      1:960 scale (near-invisible, well under 2 mm) or intentionally
      exaggerated for legibility — unlike the terrain itself, which is
      confirmed true-scale, no vertical exaggeration (digital-twin sourcing
      work). Also open: whether the source DWG has road-centerline or
      sidewalk layers for these actors to follow — not yet checked (the
      existing decode only confirmed the `A-BLDG-OUTL` and
      `CG-TOPO-Site Model` layers).

  **Progress (2026-08-13, later same day): `bench-test`/`8thwall-test`
  manifest entries now load the digital-twin `site-scene.glb`/`.usdz`
  instead of the synthetic `bench-scene.*` rig — a test-harness swap, NOT
  the four-plaque production swap above (that stays blocked on the
  physical panel-footprint measurement; nothing about `targets[]` changed).**
  `modelUrl`/`usdzUrl` now point at `site-scene.glb`/`.usdz` (copied from
  `cad-source/handoff/` into `/public/assets`); `mindTargetUrl`/
  `trackingImageUrl`/`physicalTargetWidthMeters` are still `bench-test`'s
  own 5cm QR plaque — this swap changes only which mesh renders, not which
  physical target triggers it. Manifest `bench-test` → 0.5.1,
  `8thwall-test` → 0.2.1.

  Closed the asset-schema gap the same-day building-hotspot revision above
  had deliberately left open: `tools/build_site_buildings.py` now authors
  `riveArtboard`/`riveStateMachine` (`"Marker"`/`"MarkerMachine"`) on the
  12 `hotspot_building_*` nodes — the premise that this needed a
  purpose-built building UI turned out to be wrong. `bench-ui.riv`
  (ground-truth via `tools/inspect_rive_ui.mjs`) has exactly one Marker
  artboard and one Card artboard, both content-agnostic; every hotspot
  this project has ever authored binds the identical `"Marker"`/
  `"MarkerMachine"` literal. Reusing it for buildings is the existing UI,
  not a new one. The content sheet's 12 `site-building-*` rows (`bench-test`
  `contentUrl`) were separately completed (title/body/imageUrl) by hand.

  Verified end to end (headless Chrome, real app + real assets, the
  `?fakegeo=1&fakear=1` desk bypasses) at 320/393/430px: 12 hotspots
  discovered, four distinct buildings each resolve their own `contentKey`
  and open the Card with real content, close button/drag-to-dismiss/
  tap-outside all work (verified with real CDP mouse events — a
  JS-dispatched `PointerEvent` can't satisfy `Element.setPointerCapture`,
  a harness limitation, not an app one). `proxy-target` untouched.

  **Progress (2026-08-13, later still): content pipeline hardened against
  incomplete editorial rows.** `GoogleSheetContentProvider` used to throw
  `ContentResolutionError` for the entire sheet (memoized for the session)
  if any single row's `title`/`body` cell was blank — surfaced immediately
  by the swap above, since 8 of the 12 `site-building-*` rows were still
  unwritten. `CardContent.title`/`body` are now optional, same contract
  `subtitle`/`imageUrl` already had; a blank cell now reads as an absent
  field (`CardPanel` clears that Rive text run, same `?? ''` idiom
  `subtitle` already used — no new empty-state UI). Column-level
  structure (`title`/`body`/`contentKey` must exist as headers) and every
  other failure mode (unknown `contentKey`, network/HTTP failure,
  malformed gviz payload) are unchanged, still fail loud. 9 unit tests
  (`src/client/ContentProvider.test.ts`, run via `npm test` — Node's
  built-in `node:test`, no new dependency) cover both sides of that line.

  **Progress (2026-08-14): real physical targeting wired for all 4 site
  plaques — a test-harness extension of the swap above, still explicitly
  NOT the calibrated four-plaque production design.** The 4 plaque images
  (`tools/plaque/site/plaque-{front,back,left,right}.png`,
  `tools/build_site_plaques.py`) are each compiled into their own
  single-image `.mind` target (`tools/compile_mind_target.mjs`, now
  parameterized — `node tools/compile_mind_target.mjs <png> <mind>` — so it
  compiles any plaque image, not only `bench-plaque.png`) and get their own
  manifest entry: `site-front`/`site-back`/`site-left`/`site-right`, each
  MindAR, each pointing at the real digital-twin `site-scene.glb`/`.usdz`,
  `bench-ui.riv`, and the already-populated content sheet — same
  architecture as `bench-test`, applied 4 times with real artwork instead
  of the synthetic bench plaque. `ACTIVE_TARGET_ID` (the sole
  experience-selection mechanism today, `src/client/main.ts`) is now
  `'site-front'` — the live production default.

  **Explicitly NOT built, and correctly so:** the four-plaque shared-corner
  design (§A/§E's `targets[]`). Confirmed by reading the runtime, not
  assumed: `ImageTargetAnchorSource` takes one `primaryName`;
  `ARSessionManager.start()` takes one fixed `.mind` anchor index;
  docs/asset-authoring-guide.md §3.3 already recorded "no per-target
  routing built yet." Building that now would be new, unverified
  multi-target AR-runtime engineering for `originOffsetMeters`/
  `rotationYawDeg` numbers that are still genuinely unknown — the physical
  panel-footprint measurement (`LEDGE_WIDTH_M`, `cad-source/handoff/
  README.md`'s "Known open item") remains unmeasured. Each of the 4 new
  entries instead anchors the FULL site-scene centered on whichever single
  plaque is scanned (§A's original single-plaque-center rule) — a real
  test of tracking + rendering + hotspots + content with real printed
  artwork, correctly decoupled from the still-blocked shared-origin
  calibration. **Known limitation, physical not software:** scanning any
  plaque other than the one the (not-yet-fabricated) physical model
  happens to be centered on will not line up AR content with real printed
  structures — that alignment is exactly what the blocked design would
  fix.

  **Verified in software** (headless Chrome + CDP, real app + real
  compiled assets): all 4 manifest entries resolve; `GET /api/manifest`
  and HTTP HEAD on all 8 new asset files (4 `.mind`, 4 `.png`) return 200
  with byte-exact `Content-Length`; with `--use-fake-device-for-media-
  stream` (MindAR's `getUserMedia()` has no query-param bypass, unlike the
  8th Wall path's `?fakear=1`), all 4 targets start a MindAR session,
  load `site-scene.glb` under the MindAR glue transform, and discover all
  12 hotspots with zero exceptions — `HotspotProjector` correctly reports
  `tracking=false` throughout, since a fake camera feed has no real
  plaque to match against. `npm run typecheck`/`build`/`test` clean.
  **Requires physical validation, not verifiable in software:** whether
  the printed artwork actually tracks reliably under a real camera (glare,
  print DPI, lighting) — the entire point of testing physical prints — and
  the full tap → content → Card chain against real MindAR tracking (the
  shared downstream pipeline itself was already verified end-to-end with
  the same `site-scene.glb`/hotspots/content sheet via the 8th Wall
  `?fakear=1` path above; only the MindAR-specific bootstrap is new here).

  Printable plaque size (50mm, `tools/build_site_plaques.py`'s `SIZE_MM`)
  and QR-within-plaque placement are real, current values, not
  placeholders — that's what's actually printed on
  `tools/plaque/site/print-sheet.html`. Physical dimensions and exact QR
  placement per plaque: `docs/asset-authoring-guide.md` §3.5. What
  remains a placeholder, unchanged by this pass: `LEDGE_WIDTH_M`, plaque
  *position on the model* (as opposed to plaque print size), and every
  number the four-plaque shared-origin design needs.

  **Progress (2026-08-14, later same day): audit requested on two claims
  from the entry above — both investigated against this file, the runtime,
  and Blender, neither claim survived unchanged.**

  1. **"8th Wall is the definitive production runtime, MindAR was a
     regression" — not supported by this file, checked directly.** §A:
     "Two tracking engines are supported side by side... MindAR (... the
     original and still-active engine...) and 8th Wall." §F: "MindAR and
     8th Wall are the two supported web tracking engines." §G Phase 6's
     own goal statement: 8th Wall was added "as a second, **opt-in**
     tracking engine, **alongside** MindAR **rather than replacing it**...
     this repo's Phase 6 is **deliberately additive**." The phase's own
     title is "8th Wall SLAM Tracking, **Additive Engine**." `git log`
     confirms the same: the commit that first added 8th Wall is titled
     "add 8th Wall as an opt-in tracking engine **alongside** MindAR," and
     `.mind` compiled targets predate this project's Phase 3 (`bench-
     target.mind`) and Phase 0 (`proxy-target.mind`) — MindAR was never
     introduced by, or specific to, the site-plaque work. `ACTIVE_TARGET_ID`
     has been a single hardcoded constant since Phase 1 (`git blame`), not
     a mechanism any recent commit invented. **No MindAR code was removed
     or reverted** — the 4 single-plaque MindAR entries
     (`site-front`/`site-back`/`site-left`/`site-right`) stay, explicitly
     relabeled in `manifest.ts` as a MindAR-specific validation harness
     (same role `bench-test` already has), never the production default.
  2. **"The physical-measurement blocker can't be real if Blender already
     has the geometry" — half right.** `site-scene.glb`'s own
     `plaque_{front,back,left,right}` mesh bounds (traced to
     `tools/build_site_buildings.py`'s `plaque_centers` dict — real script
     math, not invented) DO give exact `originOffsetMeters` for all 4
     plaques, and the terrain rectangle's known edge assignment per plaque
     DOES give a sound, derivable `rotationYawDeg` (edge-outward-normal
     geometry, relative to `site-front` as 0°) — both now implemented
     (below), neither required a physical measurement to derive. What's
     still genuinely a placeholder, confirmed by re-reading the exact same
     source: `LEDGE_WIDTH_M` (`tools/build_site_buildings.py`) is
     authored, in its own comment, as "best guess from the reference
     photo — PLACEHOLDER, not measured" — predates this session entirely
     (commit `172237e`, authored by the project owner, 2026-08-13, before
     any of this digital-targeting work started). The offsets derived from
     it are real numbers with a known, documented, single-constant
     dependency — not an unmeasurable unknown — and are implemented as
     such below.

  **Implemented: real `targets[]` runtime for 8th Wall (§E "Multi-target
  plaques," previously design-only).** New manifest entry `targetId:
  'site'` — `placement: 'image'`, 4-element `targets[]`, one per real
  plaque — is now `ACTIVE_TARGET_ID`, the live production default.
  `packages/experience-manifest/manifest.ts` gains the `PlaqueTarget`
  interface and `targets?` field (exact shape §E already specified).
  `ManifestResolver.ts` validates each target (asset URL, positive width,
  finite offset/rotation) and enforces `targets[]` XOR the singular
  `mindTargetUrl`/`imageTargetUrl` fields. `ImageTargetLoader.ts` gains
  `loadImageTargetDataForTargets()`, fetching every plaque's compiled 8th
  Wall image-target JSON (`npx @8thwall/image-target-cli`, run against all
  4 real plaque PNGs — `public/assets/image-targets/site-{front,back,left,
  right}/`, `imagePath` fixed up to a served root-relative path, same
  documented step `bench-plaque.json` already needed) and merging them
  into one array — 8th Wall natively tracks multiple simultaneously-armed
  image targets and reports which one fired via
  `Xr8ImageTrackedEvent.name`; nothing in the engine binary needed
  extending. `ImageTargetAnchorSource.ts`'s constructor now takes an array
  of resolved targets instead of one name+width; `onImageEvent` routes on
  the fired event's name; `applyPose()` composes the tracked pose with
  that specific plaque's own `originOffsetMeters`/`rotationYawDeg` so the
  mounted site-scene's origin — never the tracked plaque itself once the
  offset is non-zero — ends up at the same world position/orientation
  regardless of which of the 4 plaques triggered tracking. A single-target
  experience (`8thwall-test`) is simply a one-element array with identity
  offset/rotation, which composes down to exactly the pre-existing
  behavior — confirmed by a dedicated test, not just reasoning about it
  (below). `main.ts` unifies both the singular- and `targets[]`-sourced
  paths into one `LoadedMultiImageTargets` shape before either reaches
  `ImageTargetAnchorSource`, so there's one code path, not two.

  **Geometry derivation (full detail, `docs/asset-authoring-guide.md`
  §3.5):** `originOffsetMeters` = each plaque's mesh-bounds center in
  `site-scene.glb`, relative to `AR_World_Origin`, in glTF X/Z (Blender
  Y flips sign on export — Y-up/−Z-forward, §F). `rotationYawDeg` = the
  angle between each plaque's outward-facing edge normal (computed from
  its position relative to the terrain rectangle's centroid — `front`
  sits on the −Z edge, `back` +Z, `left` −X, `right` +X) and `front`'s own
  edge normal, defined as the 0° reference — front=0°, back=180°,
  left=90°, right=−90°. **Not on-device validated** (no physical mount
  exists to validate against — the placeholder plaque volumes in
  `site-scene.glb` are flat top-down markers, not vertical wall plaques,
  so this assumes a perpendicular-to-edge, artwork-upright mount, the
  standard assumption for this kind of plaque): same epistemic status
  `TARGET_FRAME_TO_WORLD_FIX` (the single-target glue this composes with)
  already carried before this pass — not a new, weaker claim.

  **Verified in software:** `npm run typecheck`/`build`/`test` clean.
  `GET /api/manifest`'s `site` entry and HTTP HEAD on all 4 compiled
  image-target JSONs + their luminance PNGs return 200, byte-exact.
  Headless Chrome (`?fakegeo=1&fakear=1`): `site` resolves, loads
  `site-scene.glb`, discovers 12 hotspots, and the full tap → contentKey →
  Card → close/drag/tap-outside chain works — same shared pipeline already
  proven for `site-front` etc, re-confirmed for `site` specifically (a
  real bug surfaced and got fixed here: a stale top-level
  `physicalTargetWidthMeters` check in `runEightWallExperience` didn't
  know about `targets[]` yet and threw at startup — caught by this exact
  probe, not assumed fixed). **The composition math itself** (the new
  part — does each of the 4 targets' offset/rotation actually recover a
  consistent world placement) **is verified by a dedicated unit test**
  (`src/client/ImageTargetAnchorSource.test.ts`, 3 cases: all 4 real
  targets recover an assumed ground-truth world pose from their own
  simulated tracked event; the single-target identity case reduces to the
  pre-existing formula exactly; an unconfigured target name is ignored) —
  pure THREE.js math, runs in plain Node, no camera/engine needed. This is
  the correctness of the *relative* geometry between the 4 plaques, fully
  software-verifiable; it does not and cannot substitute for on-device
  confirmation that `TARGET_FRAME_TO_WORLD_FIX` itself (the shared base
  glue) is correct — that was already an open item before this pass, per
  its own doc comment, unchanged by it.

  **Still open, genuinely requiring physical access, not software:**
  whether the printed plaques track reliably under a real camera; whether
  `TARGET_FRAME_TO_WORLD_FIX`'s base assumption holds on a real mount; and
  the real `LEDGE_WIDTH_M` measurement, which would change the offset
  numbers above (re-derive the same way, documented in
  `docs/asset-authoring-guide.md` §3.5, once it lands) but does not block
  anything currently shipped — the current offsets are real, traceable,
  and self-consistent, just contingent on that one still-placeholder
  input, exactly like every other placeholder-derived number in this
  project already is.

  **Progress (2026-08-14, first real physical-device test): three bugs
  found on real hardware, all fixed at the runtime layer, none required
  touching the tracking architecture, MarkerLayer, or Rive assets.**

  1. **Terrain rendered solid black.** Root cause confirmed against the
     shipped asset, not assumed: every mesh in `site-scene.glb` (terrain,
     buildings, ledge, plaque placeholders) is authored with a lit
     Principled BSDF material (`tools/build_site_buildings.py`'s
     `make_material()`), which glTF export turns into a lit
     `THREE.MeshStandardMaterial`. Neither tracking engine's runtime scene
     ever adds a `THREE.Light` — 8th Wall's `XrController.configure()` sets
     `enableLighting: false` explicitly, MindAR's `ARSessionManager` never
     added one either. Under zero light a `MeshStandardMaterial` renders
     solid black regardless of its authored color — verified directly
     against `public/assets/site-scene.glb`: `mat_site_terrain`'s
     `baseColorFactor` is an ordinary opaque tan `[0.55, 0.52, 0.45, 1]`,
     not black or transparent as authored. The only reason the 12
     hotspot-hosting buildings were ever visible is `SceneGraphLoader`'s
     existing debug tint, which happens to be unlit for exactly this
     reason. Masked during all prior desk verification because
     `DevSimSession.ts` (the `?fakear=1` bypass) adds real
     `THREE.AmbientLight`/`THREE.DirectionalLight` objects the real device
     path never gets — a real gap in the verification methodology, now
     also fixed by testing material state directly rather than only
     smoke-testing DevSim. Fix (`SceneGraphLoader.ts`): every mesh is
     rewrapped in an unlit `MeshBasicMaterial` preserving its own authored
     color (buildings/ledge/plaques now render visibly instead of black);
     the mesh literally named `site_terrain` (a fixed structural name, the
     same class of lookup `HOTSPOT_NODE_PREFIX` already is) is made fully
     transparent (`opacity: 0, depthWrite: false`) instead — the physical
     3D-printed model already has a real terrain surface visible through
     the camera passthrough, so the digital terrain mesh's only job is to
     give `HotspotProjector`'s occlusion raycast a surface to test against
     (`Raycaster` tests geometry only, ignoring material opacity, so
     occlusion is unaffected). Verified at runtime (headless Chrome,
     `window.__debugScene` traversal, temporary/removed before commit):
     `site_terrain` is `MeshBasicMaterial, transparent=true, opacity=0`;
     every other mesh (including the 9 previously-invisible non-hotspot
     buildings) is `MeshBasicMaterial` with its real authored color; zero
     black meshes remain.
  2. **Card content longer than the 90%-viewport height cap had no way to
     be read.** `docs/research/8th-wall-troubleshooting.md` §12 already
     named this precisely: "the next step is an authored internal
     scroll/max-height decision in the asset, not more app-side geometry."
     Confirmed directly (not assumed stale) via `tools/dump_riv_objects.py`
     against the shipped `bench-ui.riv`: the Card artboard has no
     `ClippingShape`/scroll component authored — a single monolithic
     raster with a header (title/subtitle/close button) and body baked
     into the one canvas. Without Rive-editor access to author a
     within-artboard scroll region, and since re-authoring the Card into
     separately-clipped header/body regions would be new UI architecture
     (out of scope for a surgical fix), the fix is code-side and does not
     touch the asset: `CardPanel.ts`'s container switches from
     `overflow:hidden`/`touch-action:none` (content beyond the cap was
     permanently unreachable) to `overflow-y:auto`/`touch-action:pan-y`,
     letting the browser natively scroll the same single canvas — the
     whole sheet (header included) scrolls together, the same pattern
     several production bottom-sheet UIs use. The existing drag-to-dismiss
     gesture is preserved by gating its promotion: a vertical drag is only
     ever taken over as an app-owned dismiss when `container.scrollTop`
     is already `0` and the finger is pulling further down past the
     threshold (mirroring the standard native "pull to dismiss" pattern);
     any other vertical drag is left entirely to native scroll.
     `container.scrollTop` resets to `0` on every `open()` so a short
     article opened after a scrolled long one never starts pre-scrolled.
     Verified at runtime (headless Chrome, synthetic short/medium/long
     content via a temporary/removed `window.__debugCard` hook): short
     content has `scrollHeight === clientHeight` (no scroll, unaffected);
     long content is genuinely scrollable (`scrollHeight` up to 5602px vs.
     a 681px cap), a programmatic `scrollTop = 80` reads back exactly `80`
     (real native scroll, not just CSS), the maximum reachable
     `scrollTop` lands exactly at `scrollHeight − clientHeight` (the true
     end of the content is reachable), `close()` still works after
     scrolling, and re-opening resets `scrollTop` to `0`. **Not verifiable
     in software:** whether the scrollTop-gated dismiss-vs-scroll
     disambiguation feels correct against a real finger's touch gesture on
     iOS Safari — a hardware-only validation gap, same category as the
     tracking glue transforms below.
  3. **AR content drifted, jumped, and briefly appeared at a drastically
     wrong scale after tracking correctly at first — the priority bug.**
     Root cause, confirmed against this file's own pre-existing telemetry
     rather than assumed: `ImageTargetAnchorSource.applyPose()` has always
     applied every single raw tracked pose (`found` AND every `updated`,
     i.e. every frame the target is visible) directly to the world anchor
     with zero plausibility check.
     `docs/research/8th-wall-troubleshooting.md` §10 already captured this
     exact engine-level failure mode in isolation, before it had a
     user-facing consequence: "one of the sessions... converged its
     re-detections onto a bad pose (scale=0.106 m, ratio 2.12...) and
     stayed there for ~a minute" — filed as "watch, no action" at the
     time. The pose-composition math itself (per-plaque offset/rotation)
     is independently verified correct by
     `ImageTargetAnchorSource.test.ts` and was NOT the defect — every
     glitchy engine reading was being composed correctly and then applied
     anyway. Fix reuses the ratio the code already computes for its
     existing scale-mismatch warning (`event.scale` vs.
     `physicalTargetWidthMeters`) as a plausibility gate, not a new
     smoothing/damping layer: once a good anchor exists, a sample whose
     ratio falls outside `SCALE_MISMATCH_TOLERANCE` (±25%) is rejected
     outright — the anchor holds its last known-good transform, exactly
     as it already does across a real `imagelost`, instead of teleporting
     the whole scene to an implausible pose. The very first acquisition
     always applies regardless (no prior good anchor to fall back to;
     refusing to ever place the scene would be worse than an imperfect
     first placement). Verified by two new unit tests in
     `ImageTargetAnchorSource.test.ts` (14 total, up from 12): a
     deliberately implausible-scale `updated` AND re-detection `found`
     sample is rejected while an existing good anchor holds, a subsequent
     good sample still applies normally (rejection is per-sample, not a
     lockout), and the very first acquisition applies even with a bad
     scale (bootstrap can't hang forever). **Not verifiable in software,
     unchanged by this fix:** whether `TARGET_FRAME_TO_WORLD_FIX` and the
     per-plaque mount-rotation assumption hold on a real mount — the same
     hardware-only gap already on record before this pass.

  All three fixes verified together end-to-end (headless Chrome,
  `?fakegeo=1&fakear=1&debug=1`, real compiled assets) at 320×568,
  393×852, and 430×932: 12 hotspots discovered, zero console exceptions,
  full tap → content → Card open → close (tap-outside) chain intact at
  every size. `npm run typecheck`/`build`/`test` clean (14/14 unit tests).
  No change to `TARGET_FRAME_TO_WORLD_FIX`, the multi-target composition
  formula, `MarkerLayer`, `RiveController`, `HotspotProjector`, or any
  `.riv`/`.glb` asset file — every fix lives in the loading/normalization
  or gesture-handling layer that already owned this class of decision.

  **Progress (2026-08-14, second same-day physical-device test): three
  more findings — one a genuine software correction with external
  evidence, two additional bugs in the fixes above, none requiring a
  tracking-architecture or engine change.**

  1. **Markers/scene rendered visibly tilted.** Confirmed by diff
     (`git show` of the previous fix commit) that `applyPose()`'s
     rotation composition was NOT touched by the prior pass — the defect
     predates it, in `TARGET_FRAME_TO_WORLD_FIX` itself, present since
     the constant was introduced and never validated on a real 8th Wall
     image-target detection (the doc comment already named both
     "identity" and "±90°X" as open candidates for exactly this failure).
     Not fixed by "rotating markers until they look right" — markers have
     no rotation logic of their own at all (`MarkerLayer` pins screen-space
     divs by `left`/`top` only); the tilt is entirely a property of the
     3D anchor's own quaternion, computed once in `applyPose()` and
     consumed unmodified by `SceneGraphLoader` (identity for the 8th Wall
     branch, confirmed) and `HotspotProjector` (pure projection, no
     rotation logic). Root-caused instead against two independent,
     external, real-world 8th Wall + three.js integrations: a published
     React Three Fiber walkthrough (dev.to/activeguild, "Bridging 8th
     Wall AR and React Three Fiber") applies
     `object.quaternion.set(pose.rotation.x, ...)` directly from the
     event with no extra glue rotation, and 8th Wall's own forum
     (forum.8thwall.com/t/issues-with-rotation-position-scaling-when-
     image-tracking/1891) explicitly recommends applying `detail.rotation`
     via `quaternion.copy()` "without extra correction rotation" for
     upright 3D content (not a flat overlay) — this project's exact case
     (Y-up glTF content). `TARGET_FRAME_TO_WORLD_FIX` changed from
     `Rx(+90°)` to `identity()`; `rotationYawDeg` (a separate, orthogonal
     per-plaque world-Y correction) is unaffected. Verified: the existing
     composition self-consistency test (`ImageTargetAnchorSource.test.ts`)
     still passes unmodified in structure with its mirrored constant
     updated to match.
  2. **Terrain fixed, but the mounting ledge and 4 plaque placeholders
     were still visible.** `SceneGraphLoader.ts` already had the right
     instinct (hide by semantic role, not by hardcoding names) for
     terrain; the same asset already carries the hook for the rest —
     confirmed directly against the shipped GLB
     (`extras: {"placeholder": true}` on `site_ledge` and all 4
     `plaque_*` nodes, from `tools/build_site_buildings.py`'s own
     `USERDATA_PLACEHOLDER_KEY`, the exact mechanism
     `cad-source/handoff/README.md` already documented: "everything
     placeholder carries a `placeholder` custom property"). Fix: the
     same invisible-but-still-an-occluder treatment terrain already gets
     now also applies to any mesh with `userData.placeholder === true`
     — no new hardcoded mesh names, using the asset's own existing
     semantic marker instead of one matching literally forbidden by the
     Golden Rule's spirit. Verified: headless Chrome scene traversal
     shows `plaque_front/back/left/right` and `site_ledge` all
     `MeshBasicMaterial transparent=true opacity=0`; buildings unaffected.
  3. **The Card scroll fix from the prior pass was wrong — it scrolled
     the WHOLE sheet, dragging the grabber and close button off-screen.**
     A real, user-identified regression in the previous pass's own fix,
     not a pre-existing bug. `CardPanel`'s DOM is restructured into a
     fixed outer shell containing a small, ALWAYS-visible header mirror
     (grabber + title/subtitle + close button) and a separate scrollable
     content wrapper (body/image only) — see the class doc comment for
     the full structure. The header/body boundary is not guessed: 
     `tools/inspect_card_header_boundary.mjs` renders the real
     `bench-ui.riv` Card artboard with short vs. long body content and
     visually diffs the two rasters (a naive pixel-row diff was too
     sensitive to independent-instance anti-aliasing noise near the top
     edge; direct visual inspection of the rendered PNGs was reliable)
     to find the content-invariant region's true extent (~100–107 design
     units, `HEADER_HEIGHT_ARTBOARD_UNITS = 112` with margin). The header
     is a live 2D-canvas `drawImage` mirror of the real interactive
     canvas's own top crop (confirmed `@rive-app/canvas` renders via
     `CanvasRenderingContext2D`, not WebGL, so this is a reliable
     same-frame copy), not a second Rive instance — one artboard, one
     state machine, one place text runs are set. Drag-to-dismiss now
     attaches ONLY to the header (the one region that never scrolls),
     so there is no scroll-vs-dismiss ambiguity to arbitrate at all: the
     content area has no dismiss-gesture listeners whatsoever, which is
     a stronger guarantee than gating on scroll position. **A real bug
     was caught during this pass's own headless verification, not
     shipped**: forwarding a tap from the header mirror initially scaled
     the tap coordinates by the MAIN canvas's full backing size instead
     of the header mirror's own (much smaller) backing size, missing the
     close button's actual hit area entirely — fixed by scaling each
     forwarded pointer by the backing size of whichever canvas the user
     actually touched. Verified end-to-end (headless Chrome + real CDP
     mouse events): short content doesn't scroll; long content does,
     natively (`scrollTop` readback exact, reaches
     `scrollHeight − clientHeight`); header pixels are visibly identical
     before/after scrolling (screenshot comparison); close-button tap
     closes the card; grabber drag-to-dismiss closes the card;
     tap-outside closes the card; re-opening resets `scrollTop` to 0.
  4. **Anchor-stability, audited deeper per explicit request — a real
     gap found beyond the prior pass's scale-ratio gate, not a
     speculative smoothing/Kalman layer.** `isTracking()` (which
     `HotspotProjector` reads to hide markers) has always gated on
     `session.trackingStatus === 'NORMAL'`; `applyPose()`'s
     trustworthiness gate did not — it only checked the engine-reported
     scale ratio. This meant a pose sample arriving while SLAM was
     `RELOCALIZING` (or `TOO_MUCH_MOTION`/`NOT_ENOUGH_TEXTURE`/
     `INITIALIZING`) but happened to report a plausible scale could
     still move the anchor; only the SEPARATE marker-visibility gate hid
     the resulting drift from view, revealing wherever the anchor ended
     up the moment tracking recovered to `NORMAL`. `isSampleTrustworthy()`
     now requires BOTH gates — scale plausibility AND
     `trackingStatus === 'NORMAL'` — before applying any sample past the
     first acquisition (which still always applies; no prior good anchor
     to fall back to). Verified by 2 new unit tests (16 total, up from
     14): a scale-plausible sample arriving mid-`RELOCALIZING` is
     rejected while a prior good anchor holds, recovers once
     `trackingStatus` returns to `NORMAL`; the first-ever acquisition
     still applies even before `trackingStatus` has reported anything.
     **Still open, requiring physical access, not software**: whether
     these two gates catch every real-world instability mode, or whether
     additional signal (e.g. position/rotation continuity between
     consecutive accepted samples) is needed — cannot be determined
     without an on-device session to observe what a genuinely unstable
     tracking run's accepted-sample sequence looks like after this fix.

  Verified together (headless Chrome, real compiled assets, 320/393/430px):
  12 hotspots, zero console exceptions, full tap → Card open → header
  fixed during scroll → close (button/drag/tap-outside) chain at every
  size. `npm run typecheck`/`build`/`test` clean (16/16 unit tests).
  **Not verifiable in software, explicitly separated from the above**:
  whether `TARGET_FRAME_TO_WORLD_FIX = identity()` is exactly right for
  THIS project's real printed plaques and camera (the two external
  sources are strong, independent evidence, not an on-device
  confirmation); whether the 4 plaques' real physical mount matches the
  assumed perpendicular-to-edge vertical mount; and the anchor-stability
  open item above.

  **Progress (2026-08-14, fourth physical-device test): the Card scroll
  fix itself was still incomplete — two more root causes found, both
  fixed. Also: the "small and rotated on a bare desk" observation is
  correctly explained, not a bug.**

  1. **`HEADER_HEIGHT_ARTBOARD_UNITS` (95) still clipped into the header
     content — a longer subtitle wrapping to 2 lines duplicated/froze on
     screen while scrolling.** The prior pass's measurement
     (`tools/inspect_card_header_boundary.mjs`) only tested a single-line
     title/subtitle; real content can wrap. Rewritten to measure a
     deliberately generous worst case — a title AND subtitle both long
     enough to force a 2-line wrap each — and re-measured: real boundary
     160.5 design units, safe midpoint 145.375. Constant raised to 148.
     Known, accepted remaining limit: a title/subtitle wrapping to 3+
     lines would still clip; not addressed with a fully dynamic runtime
     measurement (would need a second hidden Rive instance or a
     visible-flash two-pass render) since no realistic Card content
     needs it — see the constant's own doc comment for the exact
     reasoning and what to do if that assumption ever breaks.
  2. **A second, independent bug in the same symptom family: the first
     line of scrolled BODY content stayed frozen/duplicated even after
     fix 1, confirmed by isolation (not assumed) to be unrelated to the
     header crop boundary at all.** Disabling `refreshHeaderMirror()`
     entirely made the artifact disappear; re-enabling it brought it
     back — proving the continuous `drawImage()` calls reading FROM the
     scrolling main canvas, once per Advance tick, forever, were
     corrupting the browser's own scroll-repaint for that same canvas
     (confirmed geometrically sound: `canvas.getBoundingClientRect()`
     moved by exactly the scroll delta the whole time — this was a paint/
     compositing bug, not a layout bug). Fixed by bounding the mirror
     refresh to a short burst (10 Advance ticks) right after content
     actually changes (`open()`), instead of a persistent per-frame
     subscription — the header's content is static between opens, so it
     never needed continuous re-copying in the first place. Verified by
     isolating the pixel region that previously froze: 100% of header
     columns stay identical across scroll positions (correctly static),
     while the previously-frozen content band now differs by ~72% of
     columns between two different scroll positions (correctly
     reflecting different scrolled-to text), measured via a column
     dark-pixel-count signature comparison, not a visual screenshot
     re-check.
  3. **"Buildings render small and rotated when scanning a single plaque
     lying flat on a desk" — explained, not a defect.** The `'site'`
     entry's `originOffsetMeters` are real, meter-scale offsets (0.7–1.6
     m) computed for the REAL ~1.6×1.3 m physical terrain (§2 above) —
     scanning one plaque on a small desk with no terrain nearby correctly
     places content at its real metric distance from that plaque, which
     necessarily reads as "far away" (hence visually small, at real
     camera perspective) relative to a small test surface. This is the
     intended behavior of the shared-corner design once the physical
     model exists, not a bug introduced by anything in this project.
     `docs/physical-plaque-placement.md` (new) documents this explicitly
     and points to the pre-existing single-plaque MindAR harness entries
     (`site-front` etc.) for isolated desk testing that doesn't need the
     terrain present.

  Verified: `npm run typecheck`/`build`/`test` clean (16/16, unchanged —
  these fixes didn't touch the anchor/composition code the tests cover).
  Headless Chrome, real compiled assets, 320/393/430px: 12 hotspots, zero
  console exceptions, full tap → Card open → close chain. Card-specific:
  header 100% pixel-static across scroll positions; content band
  genuinely changes across scroll positions (column-signature comparison,
  not a visual re-check — screenshot review was blocked by a session
  image-limit constraint during this pass, so the verification method was
  changed to a decisive numeric comparison instead of skipped).
  **Not verifiable in software:** whether the corrected header height
  (148, worst-case 2-line title+subtitle) is generous enough for the
  actual range of building names/tags real editors will write — depends
  on real content, not just the asset.

  **Progress (2026-08-14, fifth physical-device test): the Card scroll
  bug persisted even after the fourth-pass fix — a real device still
  showed several lines of body text frozen at the top of the scroll
  area. Root architectural cause: keeping the Card as a single Rive
  canvas and trying to make part of it stay fixed while scrolling the
  rest was never going to be reliable — the Card is now plain HTML/CSS,
  not a Rive artboard at all.**

  Direct user instruction drove this change, and the instruction was
  correct: five consecutive fix attempts (troubleshooting doc §12
  through §16) had all been narrower patches on top of the same
  fundamentally awkward foundation — one Rive canvas raster, cropped and
  mirrored with increasingly specific measurements and burst-limited
  refresh logic to fake "fixed header, scrollable body," which a real
  DOM element does natively with `flex:none` + `flex:1;
  overflow-y:auto`. Rebuilt `CardPanel.ts` from scratch: title, subtitle,
  body are real text nodes; the image is a real `<img>`; the close
  button is a real `<button>`; the grabber is a plain div. No canvas, no
  Rive, no per-frame polling, no measured-boundary constant — plain CSS
  flexbox owns the header/body split, and native `overflow-y:auto` owns
  scrolling. `bench-ui.riv` no longer has a Card contract at all (still
  serves the `Marker` artboard, unchanged — small, fixed-size content
  never had this problem). `CardImageSlot` (the Rive referenced-asset
  bridge) is deleted; `cardImage` is now a plain `<img src>`, no
  CORS/asset-type caveat needed since nothing reads its pixels.
  `tools/inspect_card_header_boundary.mjs` (the empirical Rive-boundary
  measurement tool from the two prior passes) is deleted — nothing left
  to measure.

  **Verified:** `npm run typecheck`/`build`/`test` clean (16/16,
  unchanged — the Card rewrite touches none of the anchor/composition
  code those tests cover). Headless Chrome, real compiled assets,
  320/393/430px: 12 hotspots, zero console exceptions, full tap → Card
  open → close (button/drag-to-dismiss/tap-outside) chain at every size.
  Card-specific, with a corrected screenshot crop (the previous pass's
  crop region only captured the top of the viewport, missing the
  bottom-anchored card entirely — a test-harness bug in the verification
  itself, caught and fixed before trusting its result): header region
  100% pixel-identical across three different scroll positions (0, 300,
  900px); the content region differs by ~32–39% of columns across every
  40px band checked, between every pair of distinct scroll positions,
  with no anomalous
  band matching an earlier/different position — i.e. no frozen or
  duplicated line anywhere, at any scroll depth. Drag-to-dismiss starting
  ON the close button was confirmed to never engage (the button's own
  `contains()` check, replacing the previous fractional no-drag-zone
  math entirely).
  **Not verifiable in software:** real native `overflow-y:auto` momentum
  scrolling and drag-to-dismiss gesture disambiguation on actual iOS
  Safari touch input — headless Chrome's synthetic mouse events don't
  exercise the same touch/scroll code paths a real finger does, though
  this class of gap is far smaller now than with the canvas-based
  design, since there is no longer any custom paint/compositing logic
  for the browser's own scroll engine to conflict with.

  **Progress (2026-08-17): the 4 plaques' mounting orientation is
  decided — flat on the ledge, artwork facing up, not the vertical
  "museum placard" mount every prior pass had assumed by default (never
  an actual decision — `docs/asset-authoring-guide.md` §3.5 said so at
  the time). `ImageTargetAnchorSource.ts`'s `TARGET_FRAME_TO_WORLD_FIX`
  is corrected accordingly, from `identity()` back to `Rx(+90°)` —
  reasoning from this project's own already-validated MindAR glue for
  the identical physical marker shape (`SceneGraphLoader.ts`'s
  `GLTF_TO_MINDAR_ROTATION_X_RADIANS`, written for the bench-test's
  flat, table-lying plaque), not a blind revert to the pre-08-14 value.
  `rotationYawDeg` and `originOffsetMeters` are unaffected — both are
  purely a function of which terrain edge each plaque sits on, orthogonal
  to mount tilt. Full reasoning: `docs/research/8th-wall-troubleshooting.md`
  §18. **Verified:** `npm run test` — all 16 `ImageTargetAnchorSource.test.ts`
  cases (geometry self-consistency, unaffected by this constant's value)
  still pass with the new value; `npm run typecheck` clean.
  **Still not on-device confirmed:** whether 8th Wall's own image-target
  rotation convention for a flat marker actually matches MindAR's — the
  same-project precedent is strong footing, not a substitute for testing
  against the real hardware/plaque once fabricated.

  **Progress (2026-08-17, later same day): the in-plane mounting
  rotation — which way each plaque's artwork reads — is confirmed
  against a reference diagram: inward, toward the terrain center, not
  outward.** This was a genuinely unspecified gap before now — the
  earlier tilt fix (flat vs. vertical, above) never addressed which way
  the artwork should face once laid flat. Verified by direct vector
  computation (not diagram-reading by eye, which risks sign errors): each
  plaque's required "up" direction points exactly at the terrain
  centroid — front→north, back→south, left→east, right→west, each purely
  along one axis (front/back are centered on the model's X-width,
  left/right on its Z-depth, so the inward vector has no cross-component).
  `docs/physical-plaque-placement.md` §2 now states this as an explicit
  mounting instruction. **No manifest or code change**: `rotationYawDeg`'s
  0°/180°/90°/−90° pattern is relative between the 4 plaques (front
  defines the 0° reference), so it holds regardless of which absolute
  direction "front" itself reads toward — confirmed this is a physical
  mounting-instruction gap only, not a software one.

  **Progress (2026-08-18): real physical measurements landed for the
  ledge width (3.5cm) and full baseboard (167.5 x 141.4cm), and the
  digital-twin's `v` axis convention was corrected at the source.** The
  ledge changed from a placeholder 3in-guess border ring to a single
  full-rectangle mesh at the real measured baseboard size (`tools/
  build_site_buildings.py`) — cross-checked first: real terrain-corner
  elevations and one building's anchor-point position (measured directly
  against the physical model) both matched our existing data closely, so
  this was confirmed a data-quality improvement, not a bug fix. Separately,
  visual inspection in Blender surfaced a real (if cosmetic) issue: the
  2026-08-13 origin fix mirrored `u` only, leaving the authored frame
  left-handed, so Blender's own right-handed top-view convention rendered
  front at the TOP even though left correctly stayed on the left —
  confusing enough (twice, independently) that it's worth fixing at the
  source rather than re-explaining. `v` now has its own `v_sign` (in
  `extract_site_terrain.py`/`extract_site_buildings.py`, mirroring
  `u_sign`'s pattern exactly) and ranges `[0, depth_ft]` (front to back)
  instead of `[-depth_ft, 0]` — two mirrors compose into a proper
  rotation, restoring a right-handed frame, so front now renders at the
  BOTTOM of Blender's default top view, matching physical intuition, with
  left/right and wide/narrow unaffected either way. Confirmed pure
  relabeling, not a position change: identical building matches (12/21)
  and identical terrain relief (450-930ft) before/after in both
  extraction scripts.

  **Explicitly NOT done in this pass, flagged rather than silently
  skipped:** `public/assets/site-scene.glb`/`.usdz` (what the live `site`
  manifest entry actually serves) were NOT resynced from the regenerated
  `cad-source/handoff/` bundle, and manifest.ts's `targets[].
  originOffsetMeters`/`rotationYawDeg` were NOT recomputed against the
  new geometry. Both depend on the new ledge width and `v` convention and
  need a coordinated recompute (same method as `docs/asset-authoring-
  guide.md` §3.5 documents) before this reaches production — copying the
  new glb in without updating those numbers would silently break the live
  four-plaque experience, not fix it. Confirmed `public/assets/` is
  currently untouched (byte-identical to before this session) so
  production is unaffected for now.

  **Progress (2026-08-18, later same day): the flagged production sync
  above is done, and the plaques themselves were redesigned.** Real
  ledge/baseboard measurements landed this session (§ above); separately,
  the user asked for a "make sure everything works on the live `'site'`
  entry" pass, plus a plaque redesign (elongated 90×30mm landscape, QR
  left / instructional text right per a reference design, since the real
  35mm ledge is narrower than the old 50mm square). Both landed together:

  - New artwork: `tools/build_site_plaques.py` rewritten — 90×30mm, badge
    column (not corner marks) for the 4 distinguishing shapes
    (triangle/circle/diamond/square), resolution raised to 24px/mm
    (~610dpi) specifically because `@8thwall/image-target-cli` enforces a
    hard 640px minimum per dimension and the old density fell just short
    at the new 30mm height.
  - New tool: `tools/compile_8thwall_target.mjs`, wrapping
    `@8thwall/image-target-cli`'s internal `applyCrop` (no non-interactive
    CLI mode exists) with an explicit full-image, non-lossy crop —
    the library's own default crop forces a 3:4/4:3 ratio and would have
    silently discarded part of the new landscape artwork (confirmed: the
    *old* square plaques already lost ~25% of the image to this exact
    default, unnoticed until this investigation). Vendored in
    `tools/vendor/image-target-cli/` (isolated `npm install`, not a root
    `package.json` dependency) — the root project has a pre-existing,
    unrelated peer-dependency conflict (rolldown vs. rolldown-plugin-dts)
    that breaks `npm install` for any new package even with
    `--legacy-peer-deps`; vendoring sidesteps it rather than fixing it.
  - All 4 plaques recompiled in both formats: `public/assets/image-targets/
    site-{front,back,left,right}/` (8th Wall) and `public/assets/
    site-{front,back,left,right}-target.mind` (MindAR).
  - `tools/build_site_buildings.py`'s plaque geometry updated to match
    (`PLAQUE_LENGTH_M`/`PLAQUE_DEPTH_M` replace the old single
    `PLAQUE_SIZE_M`, oriented per side — length along whichever edge the
    plaque mounts on).
  - `public/assets/site-scene.glb`/`.usdz` resynced from the regenerated
    `cad-source/handoff/` bundle (closing the gap flagged above).
  - `manifest.ts`'s `'site'` entry `targets[].originOffsetMeters` and
    `physicalTargetWidthMeters` (0.05 → 0.09) recomputed against the new
    geometry — `rotationYawDeg` re-verified from scratch (not assumed
    unchanged, given the same-day `v`-axis flip) and confirmed still
    0°/180°/90°/−90°. Position numbers cross-checked directly against the
    exported GLB's own binary vertex data, not just the generating
    script's formulas. The single-plaque MindAR harness entries
    (`site-front`/etc.) got the same `physicalTargetWidthMeters` update.

  **Verified:** `npm run typecheck`/`build`/`test` clean (16/16, unchanged
  — this pass touches manifest data and asset files, not the
  composition/test code). `public/assets/site-scene.glb` MD5-matches the
  regenerated `cad-source/handoff/` copy. Each compiled 8th-Wall
  image-target JSON's `properties.width/height` matches the full source
  artwork dimensions exactly (2160×720, `isRotated: false`) — confirms
  nothing was cropped away.
  **Not verifiable in software:** whether the new artwork/dimensions
  actually track well on real hardware — this pass makes the production
  entry internally consistent again, it doesn't add new on-device
  evidence beyond what §G's existing open items already track.

  **Progress (2026-08-18, origin-corner fix, same day):** user explicitly
  asked to double-check `AR_World_Origin` against the physical baseboard
  rather than the site model — a real gap: the two prior origin fixes
  (`u_sign`, `v_sign`) only ever repositioned which corner of the
  *terrain* counted as (0,0), never accounting for the baseboard
  extending past the terrain by the ledge width on every side. World
  (0,0,0) sat ~3.4cm/3.5cm inside the true physical board edge, not on
  it, since the ledge/baseboard additions (2026-08-13/2026-08-18) were
  layered on top of an origin convention (`build_site_terrain.py`,
  2026-08-12) written before the baseboard existed as real geometry.

  - `tools/build_site_buildings.py`'s `compute_baseboard_origin_offset()`
    derives `(dx, dy) = ((BASEBOARD_WIDTH_M - terrain_width_m) / 2,
    (BASEBOARD_DEPTH_M - terrain_depth_m) / 2)` and every builder function
    (terrain, buildings, hotspots, ledge/plaques, RAMAPO SITE marker) now
    adds it — a pure translation, not a re-derivation; rotations,
    dimensions, and relative positions are all unaffected. Duplicated into
    `tools/build_site_terrain.py` (the terrain-only staging script) for
    consistency, matching that file's existing convention of duplicating
    `build_terrain_mesh()` rather than sharing a module.
  - **Verified against the regenerated GLB's own binary vertex data**
    (`pygltflib`, not just the generating script's formulas): `site_ledge`
    (the baseboard mesh) now spans exactly X:[0, 1.675], Z:[-1.414, 0] in
    glTF space — its bottom-left corner sits at (0,0,0) to the
    sub-millimeter.
  - `cad-source/out/`, `cad-source/handoff/`, and `public/assets/
    site-scene.glb`/`.usdz` all regenerated and MD5-verified in sync.
  - `manifest.ts`'s `'site'` entry `targets[].originOffsetMeters`
    recomputed the same way as the 2026-08-18 pass above (mesh-bounds
    center of each `plaque_{side}` object, cross-checked against the GLB
    binary data) — every value shifted by the same translation:
    front (0.8375, -0.015), back (0.8375, -1.399), left (0.015, -0.707),
    right (1.66, -0.707). `rotationYawDeg`/`physicalTargetWidthMeters`
    re-verified unchanged (translation doesn't affect either). Version
    bumped 0.1.0 → 0.1.1. `docs/asset-authoring-guide.md` §3.5's plaque
    table updated to match.
  - **Verified:** `npm run typecheck`/`build`/`test` clean, `public/
    assets/site-scene.glb` MD5-matches `cad-source/handoff/`.
  - **Not affected, confirmed by design:** the single-plaque MindAR
    harness entries (`site-front`/etc.) — they re-center the whole scene
    on whichever plaque is scanned, so they have no `originOffsetMeters`
    to begin with and are translation-invariant.

  **Progress (2026-08-2x): QR-plaque artwork identified as a real
  tracking-quality defect, candidate replacement built and on-device
  tested, one open issue found and diagnosed but NOT fixed — handed off
  for the next session (own or collaborator's) to pick up.**

  **Root cause, cross-checked against two independent sources:** on-device
  testing of the printed QR plaques (`tools/build_site_plaques.py`) showed
  slow acquisition, wrong initial pose, and continuous jitter. Both
  `docs/asset-authoring-guide.md` §3.1 (this project's own guidance) and
  8th Wall's own docs (8thwall.org/docs/engine/guides/image-targets: "a
  lot of varied detail" + "high contrast"; avoid "repetitive patterns,"
  "excessive dead space"; "detection cannot distinguish between colors")
  independently say the same thing. A QR code IS a repeating module grid,
  and since all 4 plaques encode the SAME experience URL (§A: identity
  resolved by tracking, never the QR payload), that grid is
  pixel-identical across all 4 "distinct" plaques — violating the
  repetition rule twice over, and undermining the very distinctness the
  per-side badge shapes were meant to provide.

  **Decision: decouple session-bootstrap (QR) from pose-tracking (image
  target) entirely**, rather than iterate on QR-based artwork further:
  - QR code becomes pure "open the web app," moved OFF the 3.5cm ledge
    entirely (signage decision, not a geometry/manifest one) — however
    many copies make sense for reachability, no longer part of the
    tracked scene or coordinate system at all.
  - 4 dedicated image targets stay on the ledge (same mount footprint),
    purpose-built for tracking only: no QR, no shared regions between
    sides, true binary black/white (monochrome laser printer; 8th Wall's
    own docs confirm color doesn't help detection anyway), closer to
    square than the old 90×30mm (3:1) shape — §3.1 also flags "extremely
    thin/long" aspect ratios as less reliable.
  - Organization-logo-as-tracking-target was discussed and explicitly
    deferred (not rejected): a shared logo mark recreates the same
    "identical region across all 4 targets" problem the QR caused, unless
    the logo itself is made non-uniform per side (varying treatment, not
    just a different border around an identical center) — revisit once
    the abstract-pattern approach is validated or found insufficient.

  **Built, phase 1 (abstract patterns, `tools/build_site_tracking_
  targets.py`, new tool):** 4 independent-seed Voronoi cell patterns
  (`scipy.spatial.cKDTree` nearest-seed lookup), each cell pure black or
  white, roughly balanced so no tone dominates. First pass used pure
  uniform-random seed points and visibly produced oversized cells (large
  flat regions — the same "dead space" problem in miniature); fixed by
  switching to blue-noise/Poisson-disc-style rejection sampling
  (`sample_points()`), which evens out cell sizes with no other change.
  30mm square, 24px/mm (matches `build_site_plaques.py`'s density
  convention — 640px minimum enforced by `@8thwall/image-target-cli`). A
  small side label (FRONT/BACK/LEFT/RIGHT) is stamped in one corner —
  both installer verification and a substitute orientation cue now that
  the shape is square (the old landscape aspect ratio used to make a
  90°-rotation mounting mistake obvious on its own).

  **Compiled + wired as a NEW validation harness, not the production
  entry:** `tools/compile_8thwall_target.mjs` (already-existing tool,
  reused as-is) compiled all 4 into `public/assets/image-targets/
  site-tracking-{front,back,left,right}/` — verified 720×720,
  `isRotated: false` (nothing cropped). `manifest.ts` gained 4 new
  single-image-target entries (`site-tracking-front`/etc., same shape as
  `8thwall-test` — no `targets[]` composition), so each candidate can be
  tested independently on real 8th Wall hardware before the production
  `'site'` entry's `targets[]`/geometry get touched at all.

  **On-device test result (site-tracking-front, real printed candidate,
  not a screen):** two findings, one expected-and-fine, one real and
  still open.
  1. **World origin appears at the plaque's own center, not the baseboard
     corner — this is correct, not a regression.** `site-tracking-front`
     is a single-image-target harness entry by design (mirrors
     `site-front`), which re-centers the WHOLE scene on itself (§A's
     original single-plaque-center rule) rather than applying the
     calibrated `originOffsetMeters` the production `targets[]` entry
     computes. That composition only happens once the artwork is
     confirmed good and promoted to the production entry — not done yet,
     intentionally.
  2. **Pose still visibly spins/scales while the camera holds roughly on
     the target and the angle is adjusted — real, diagnosed, NOT fixed.**
     `ImageTargetAnchorSource.applyPose()` applies every sample that
     passes `isSampleTrustworthy()` (scale ratio + `trackingStatus===
     'NORMAL'`) directly to the 3D anchor's rotation/position, every
     frame, with zero temporal filtering — only a binary accept/reject
     gate exists, confirmed by reading the current source (unaffected by
     the collaborator's 3 most-recent commits, all of which explicitly
     state no change to `applyPose()`'s composition math). The improved
     artwork reduces raw pose noise but can't eliminate this class of
     jitter by itself.

     **Proposed fix, NOT implemented — a naive version of this was
     already tried and reverted once in this codebase, so don't just
     add smoothing back blindly:** `OneEuroFilter.ts`'s own doc comment
     says pose-smoothing was tried for MindAR and reverted because it
     "made the whole scene visibly lag behind the physical model" —
     jitter absorption was moved to the 2D screen-space marker stage
     (`MarkerLayer.ts`) instead. `ARSessionManager.ts`'s
     `TRACKING_PROFILE_RIGID_ANCHOR` confirms why: a LOW-beta filter
     causes visible lag/"swim" for a rigidly-anchored scene, so it uses a
     HIGH beta (1000) instead — still damps at-rest tremor
     (`filterMinCF: 0.001`) but gets out of the way almost entirely
     during real motion. That's a different claim than "smoothing is
     unsafe here" — it's "low-beta smoothing is unsafe here," and 8th
     Wall's path currently has zero filtering of any kind, not even a
     high-beta one. Proposed: port `OneEuroFilter1D` into
     `ImageTargetAnchorSource.applyPose()` — one instance per position
     axis (x/y/z), tuned like `TRACKING_PROFILE_RIGID_ANCHOR` (high
     beta/low minCF), not the low-beta profile that caused the original
     regression. Rotation needs one extra step beyond position: filtering
     the quaternion's x/y/z/w components independently requires flipping
     the incoming quaternion's sign when it's on the opposite hemisphere
     from the previous filtered one (quaternions double-cover rotation
     space) before filtering, then renormalizing the result.

  **Status at handoff:** candidates generated and validated as "more
  stable, not yet stable enough," root cause of the remaining jitter is
  diagnosed with a concrete fix proposed (not guessed at), but nothing
  in `ImageTargetAnchorSource.ts` has been changed. `-back`/`-left`/
  `-right` candidates are compiled and wired but not yet on-device
  tested. The production `'site'` entry is untouched by any of this
  session's tracking-target work. Full session narrative, including the
  discarded logo idea and the 8th-Wall-docs research, in
  `docs/research/8th-wall-troubleshooting.md`'s latest section.

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

  **Progress (2026-07-14): the §11 asset fix landed — Card renders, full
  content pipeline verified on a real phone.** The fix was authored on the
  `8th-wall` spike branch (commit `750d68c`, first on-device pass) and
  cherry-picked into this branch asset-for-asset; findings from that
  session, recorded so the next person doesn't re-derive them:

  - **`bench-ui.riv` fixed exactly as §11 prescribed**: `OpenIdle` now
    explicitly re-keys `Card_Body` `opacity=1, y=0` at frame 0 (Rive never
    resets unkeyed properties on a state transition, so `Closed → OpenIdle`
    inherited the hidden pose forever). The one-frame Card flash on fresh
    page load was fixed by setting `Card_Body`'s *base* opacity to 0 —
    only non-layout properties stick as base-value writes on a
    `LayoutComponent` (`y` is recomputed by the flex engine every frame),
    but a fully transparent element is invisible regardless of position.
  - **Marker artboard re-squared to the contracted 120×120** (it had
    drifted to 44×80, leaving the base "drooping" below the projected
    anchor point) and its icon/line/base composite rebuilt as plain
    positioned `Node`s with the touch point at exact artboard center,
    matching the runtime's `Fit.contain`/`Alignment.center` pinning. The
    same binary also carries the branch's earlier restoration of the Card
    title/subtitle text runs (`750d68c`'s parent, `b42f3f5`) — the .riv is
    a whole-file asset; the two fixes are inseparable and both wanted.
  - **Corruption diagnostic worth keeping**: a Rive-editor "Save" once
    exported a ZIP bundle to the `bench-ui.riv` path instead of overwriting
    the binary; the runtime's only symptom is the generic `RiveFile.init()`
    "The file failed to load". A real `.riv` starts with ASCII `RIVE`; if
    `xxd -l4 public/assets/bench-ui.riv` shows `PK\x03\x04`, it's a zip —
    `unzip -l` it and use the `.riv` inside.
  - **`bench-scene.glb` hotspot anchors moved from each domino's
    volumetric center to its top-Y** (X/Z unchanged), so markers sit on
    top of the objects instead of floating at their centers. This was a
    direct patch to the compiled GLB: `tools/build_bench_scene.py` still
    authors hotspots at `(0,0,0)` local to the domino parent (Blender's
    center-of-bounds origin), so **re-running the build script will
    silently revert this** — port the top-Y offset into the script before
    the next re-export.
  - **Content sheet `imageUrl` gotcha**: Dropbox share links fail twice
    over (no `Access-Control-Allow-Origin`, and PDFs aren't decodable
    images); the sheet owner switched the column to real image URLs.
    Confirms the asset-authoring guide's preference for root-relative
    `/assets/...` paths.
  - **Deferred by choice**: the Card's `isOpen` transitions run from the
    state machine's `Any` state with a 220–280 ms linear blend rather than
    the guide's named `Enter`/`Exit` clips. Functionally compliant
    (`Any`-state sources are interruptible by construction) and fine
    on-device; revisit only if the contract wording is enforced literally.

  Verified on iPhone Safari over LAN HTTPS with the `?fakegeo=1&fakear=1`
  desk-sim bypasses: scene load, hotspot projection, Rive markers, Card
  open/close, and content-sheet images all work end to end. The real
  SLAM + image-target path (`ImageTargetAnchorSource`, scanning the
  physical plaque) is still untested on-device — the bypass skips it by
  design. (The same spike commit also back-ported this branch's `0b3c63f`
  dual-path canvas-resize fix into the spike; that part was *not* brought
  back here — it already lives on this branch.)

  **Branch decision (2026-07-14): the `8th-wall` spike is retired in favor
  of this branch, not merged into it.** Confirmed rather than assumed: a
  trial `git merge --allow-unrelated-histories` surfaced 20 conflicting
  files (nearly all of `src/client/`, both config files, both binary Rive
  assets before the above port, the lockfile) — genuinely unrelated,
  independently-built code under the same filenames, not small overlapping
  edits. Before ruling out a real merge, verified this branch is a strict
  superset of the spike, not just "ahead of it": every file present in
  `8th-wall`'s `src/client`/`packages`/`server` also exists here (`git
  ls-tree` diff, zero unique paths), this branch additionally has
  `ARSessionManager.ts`/`InputBridge.ts`/`RenderEngine.ts` (MindAR, still
  load-bearing for `proxy-target`/`bench-test`), `TraceLog.ts`, and the
  Apple App Clip route the spike never had, and the spot-check above (§11
  port) already confirmed the shared contract constants
  (`MarkerLayer`/`CardPanel`'s artboard/state-machine/input names),
  manifest asset paths, tap-handler robustness, and canvas-resize wiring
  all match or exceed the spike's versions. Nothing from the spike's own
  session findings survives only on `8th-wall` — development continues
  here. The `8th-wall` branch itself is left in place for now (not
  deleted), in case anything is missed.

  **Progress (2026-07-14, Card bottom-sheet redesign):** replaced the
  Card's Rive-owned open/close animation with an app-owned one, plus
  drag-to-dismiss — the state-machine-driven fade could not do 1:1
  finger-tracking with a velocity-based release cheaply, which is why
  react-spring-bottom-sheet and react-native-bottom-sheet both drive their
  sheet with a plain transform in code, not a design-tool timeline; this
  follows the same pattern.

  - **Rive simplified to pure content display**: `Closed`'s
    `Card_Body opacity=0, y=380` keyframes and `OpenIdle`'s (§11)
    `opacity=1, y=0` keyframes were both deleted, and `Card_Body`'s base
    opacity restored to `1.0` — the two states are now visually identical.
    `isOpen` is still set by the app (kept only so the state machine
    reaches `OpenIdle`, the source state `RefreshPulse`'s trigger
    transition needs) but no longer drives any visible motion.
    `RefreshPulse` itself (the small in-place bounce on content swap while
    already open) is untouched — the one motion still owned by Rive,
    unrelated to open/close position.
  - **`CardPanel`'s container now owns position** via `transform:
    translateY(...)`, toggled between `0` (open) and `100%` (fully
    off-screen, and the default from construction — synchronous, so there
    is no dependency on Rive/state-machine timing for the old first-load
    flash class of bug at all) with a `300ms cubic-bezier(0.32, 0.72, 0,
    1)` transition for the settle animation, disabled during an active
    drag so the transform tracks the finger with zero lag.
  - **Drag-to-dismiss**: pointerdown/move/up/cancel on the container,
    pointer-captured for the gesture's lifetime. A move under `12px` stays
    a tap candidate (forwarded into the artboard as before, for the close
    button); at or past it, the gesture is a confirmed drag and artboard
    forwarding is suspended for the rest of it. Release past 25% of the
    sheet's own height, or a downward velocity over `0.5px/ms`, commits to
    close (via the same `closeHandler` callback the authored close button
    uses — one app-level close path regardless of gesture); otherwise it
    snaps back open.
  - **Close-button reliability bug, self-inflicted and fixed same-session**:
    the initial `12px` tap/drag threshold intermittently ate the close
    button's clicks. `Card_Close_Button_Container`'s hit area is ~30×30
    artboard units (≈33px on screen) — under Apple's 44pt minimum target
    size — and ordinary finger jitter while aiming at a small target can
    exceed almost any generic threshold. Fixed with a permanent no-drag
    zone (top-right corner, `x ≥ 80%`, `y ≤ 15%` of the container) rather
    than further threshold tuning: a gesture starting there can never be
    promoted to a drag, however far it wanders. The grabber handle
    (top-center, ~45–55% x) is well clear of this zone and unaffected.
  - **Width bug fixed alongside**: `CARD_CSS_WIDTH` was
    `min(92vw, 350px)` — capped at 350px regardless of viewport, leaving
    visible side gaps on any phone wider than ~380px. Changed to `100vw`;
    the now-unneeded `left:50%;transform:translateX(-50%)` centering was
    dropped for a plain `left:0`.
  - **Width-bug follow-up (2026-07-14, second pass): not reproducible in
    the current build — every layer measured full-width.** A new probe
    harness (`tools/run_width_probe.mjs` + `public/__width-probe.html`)
    loads the real app at 320/393/430-px viewports in headless Chrome,
    walks the arrival gate, and measures the whole chain. Results, at
    devicePixelRatio 1 AND 3 (the dpr≥2 path is the on-device
    `backingScale=2` / 700×960-canvas condition):
    container `getBoundingClientRect()` = exactly the viewport width at
    every size (`left:0`, no max/min-width, no ancestor transform, body
    parent); canvas CSS box likewise; and the rendered raster itself is
    solid (alpha>200) from column 0 to the last column on every sampled
    row — so no CSS constraint, no Fit/alignment letterboxing, and no
    artwork inset (a soft shadow reaching x=0 over an inset body was
    explicitly ruled out by the per-row solid scan). With the DOM, the
    backing store, and the pixels all edge-to-edge, there is nothing left
    in the shipped code that can produce side margins.
    That pass's "stale bundle" verdict was **wrong** — its measurements
    all ran with placeholder text. See the third-pass entry below.
  - **Width bug RESOLVED (third pass, same day): Hug-height artboard ×
    Fit.contain letterbox — fixed in `CardPanel`.** The `Card` artboard's
    Auto Layout height is authored as Hug, so its bounds track the
    content (`350×408/604/669` measured across real sheet rows) while
    `CardPanel` assumed a fixed 350×480 canvas; `@rive-app/canvas`'s
    default `Fit.Contain` then letterboxes the taller artboard
    horizontally — visible width fraction = `480/H`, ≈10% camera-feed
    margins per side at H≈604, none at all with short/placeholder
    content (which is why the second pass measured clean).
    `CardPanel.syncAspectToArtboard()` now re-derives the container's
    CSS aspect-ratio and the canvas backing from the live artboard
    bounds on the runtime's Advance event, so canvas aspect ==
    artboard aspect and contain fills the width for every content
    length. Verified end-to-end with a real marker tap + real sheet
    content at 320/393/430px viewports: raster solid to both edges
    where the same content letterboxed 72–627/700 before. Full
    narrative, math, and probe tooling: troubleshooting doc §12.
  - **Height cap follow-up**: the sheet is now capped at 90% of the
    viewport height — container-only clip (canvas keeps its aspect-true
    natural height; shrinking it would recreate the letterbox), pointer
    mapping and the close button's no-drag zone re-anchored to the
    canvas rect accordingly. Protects grabber/title/close button on
    small screens, where tall Hug content used to push the container's
    top edge above the viewport. Troubleshooting doc §12 follow-up.

  **Exit condition:** the `8thwall-test` rig passes the same functional
  bar as `bench-test` — markers persist on tracked content, tapping opens
  the correct card — on a real device, with the root cause of the
  marker-rendering gap above identified and either fixed or, if it's a
  physical tracking-quality issue, documented with a mitigation.

  No iOS work. No WebXR work. No changes to the MindAR runtime path.

  **Progress (2026-08-18): cold-start stabilization — the scene no longer
  reveals itself off an unchecked bootstrap pose.** A user-reported
  production symptom on the `site` experience: after scanning a plaque,
  buildings appeared tiny/mis-oriented and markers were absent for
  ~5–6 seconds, self-correcting with no user action. Root-caused against
  this file's own pre-existing behavior (not assumed): `ImageTargetAnchorSource
  .onImageEvent`'s `'found'` case has always applied the very first tracked
  pose sample unconditionally (`trustworthy = !wasAcquired || ...` —
  the bootstrap sample never goes through `isSampleTrustworthy()` at all —
  see that method's own doc comment, unchanged by this pass: "refusing to
  ever place the scene would be worse than an imperfect first placement")
  and, until this pass, set `group.visible = true` in that same branch —
  the instant the bootstrap sample landed, whatever pose it carried. 8th
  Wall's own absolute-scale estimate (`scale:'absolute'`,
  `EightWallSession.ts`'s own comment: "needs a few seconds of device
  parallax to converge") is routinely not yet converged on that very first
  sample, so the scene rendered at whatever mis-scaled/mis-oriented pose
  the engine reported until a LATER sample independently passed
  `isSampleTrustworthy()` (scale ratio ±25% AND `trackingStatus==='NORMAL'`)
  and silently snapped the anchor to the right place — the exact "wrong,
  then self-corrects" symptom reported, and consistent with this file's own
  §10/§13 telemetry (a bad-pose re-detection "converged... and stayed there
  for ~a minute," filed watch-only at the time because nothing depended on
  anchor VISIBILITY stability yet — it does now). Markers were independently
  absent over the same window for an unrelated but coincident reason:
  `isTracking()` (which gates marker visibility) has always required
  `trackingStatus==='NORMAL'`, the same convergence-dependent signal — the
  two symptoms shared a root mechanism without being coordinated by any
  code that connected them.

  **Fix: applying a pose and revealing it are now two different decisions,
  not one.** `ImageTargetAnchorSource` still applies the bootstrap sample
  unconditionally (unchanged — an anchor must never be left un-placed) but
  no longer reveals `group` for it. `group.visible` now flips true exactly
  once, the first time a sample independently passes
  `isSampleTrustworthy()` — the same event now also resolves a new
  `whenStable(): Promise<void>` on the `AnchorSource` interface
  (`AnchorSource.ts`), distinct from `acquire()` (which still resolves on
  the bootstrap sample, so downstream code can start mounting content
  immediately — see below). `TapPlacedAnchorSource.whenStable()` and the
  `?fakear=1` desk-sim's `SimulatedAnchorSource.whenStable()` both resolve
  immediately — tap placement and the desk sim have no bootstrap-pose
  ambiguity to wait out; only the image-target path has one. No change to
  `applyPose()`'s composition math, `TARGET_FRAME_TO_WORLD_FIX`,
  `rotationYawDeg`, `originOffsetMeters`, or the existing scale/tracking
  plausibility gates — this is a visibility decision layered on top of
  already-correct, already-tested pose logic, not a rewrite of it.

  **`main.ts`'s `runEightWallExperience()` reveal sequence, before/after:**
  before, `overlay.hideAll()` ran immediately after `anchorSource.acquire()`
  (i.e., off the bootstrap sample), then the GLB/Rive/marker/card pipeline
  loaded serially, fully AFTER acquisition, with no architectural reason
  tying that ordering to tracking state. After: GLB fetch+parse, Rive
  fetch+parse, `MarkerLayer.attach()`, and `CardPanel.attach()` (new
  `loadEightWallSceneContent()`, respecting their real dependency graph —
  markers need both the GLB's hotspots and the parsed Rive file;
  `CardPanel` needs neither, since Phase 3's fifth physical-device-test
  entry made it plain HTML/CSS, so it attaches on its own parallel promise)
  are kicked off at the TOP of `runEightWallExperience()` — before the
  arrival gate, before "Start AR," before any AR session exists at all —
  instead of after acquisition. The scene mounts under `anchorSource.group`
  (already hidden) as soon as that load finishes; the overlay shows
  `'Loading…'` (reusing the existing `UxOverlay.showHint()` primitive —
  the same non-blocking, screen-space coaching-strip component already
  used for "Point your camera at the plaque," never a new UI system) from
  the moment the anchor is acquired until BOTH the scene content is
  mounted AND `anchorSource.whenStable()` resolves, at which point
  `overlay.hideAll()` runs once. Because `group.visible` only ever flips
  `false→true` (never back), a later brief tracking loss cannot re-trigger
  the loading state — the existing marker-hysteresis and
  last-known-good-pose behavior (unchanged) handles that exactly as it did
  before this pass.

  **QR first-scan UX**: a second, related gap found in the same pass —
  after tapping "Start AR," `EightWallSession.start()` awaits the engine
  module import, `XrController.configure()`, and `xr8.run()`
  (camera/motion permission prompts) with NO loading feedback of any kind;
  the panel sat unchanged. On a slow/cold cellular connection right after a
  QR scan, this is the strongest code-grounded explanation for users
  re-scanning the QR believing nothing happened (assets/engine already
  cached by the second load, so it then appears instant) — not a browser
  or 8th Wall limitation (confirmed against current 8th Wall docs: no
  official guidance describes this as expected browser behavior). Fixed by
  calling `overlay.showHint('Starting camera…')` synchronously inside the
  "Start AR" click handler, before `session.start()` — confirms the tap
  registered immediately, without touching the still-mandatory iOS
  gesture requirement for `DeviceMotionEvent.requestPermission()`.
  Distinguished explicitly (not assumed): the QR scanner's visual
  recognition of the printed plaque cannot be transferred into the
  browser's own camera session — there is no browser API for that — so the
  physical plaque must always be seen again by whichever camera session is
  doing AR tracking, regardless of any loading-feedback fix. No
  cookie/localStorage persistence was added: nothing about "remembering
  intent to start AR" was found to solve a real problem here — the URL
  itself already carries that intent, and today's flow has exactly one
  required gesture tap, not several.

  **Verified in software** (`npm run typecheck`/`build`/`test`, 19/19 unit
  tests — 3 new, covering exactly this contract: a bootstrap-only pose does
  not reveal the scene or resolve `whenStable()`; the first trustworthy
  sample after bootstrap does, exactly once; an implausible sample arriving
  before any trustworthy one is rejected without revealing or corrupting
  the anchor; the two pre-existing tests that asserted `group.visible ===
  true` off the bootstrap sample were updated to assert the new, correct
  `false`, per this pass's own contract change). The 4-plaque composition
  self-consistency tests, unmodified and still passing, confirm this pass
  did not touch that math. **Not verifiable in software, requires physical
  device testing:** whether the reveal actually lands meaningfully faster
  than 5–6 seconds after a real absolute-scale convergence, and whether the
  "Starting camera…" feedback actually reduces double-QR-scans in the
  field — both need an on-device capture with the temporary diagnostic
  instrumentation (`DiagnosticTimeline.ts`, `?debug=1`) still present in
  this codebase for exactly that purpose; see that file's own doc comment
  for removal instructions once a capture confirms the fix. GLB weight was
  re-confirmed NOT the cause during the original investigation (2.6&nbsp;MB,
  27 meshes, ~38.6K triangles, zero textures) — nothing in this pass
  touched `site-scene.glb` or any Blender asset.

  **Progress (2026-08-19, first physical-device test of the cold-start fix
  above): two more findings — one fully fixed, one partially mitigated
  pending on-device evidence, neither required weakening the anchor's
  existing plausibility gates.**

  1. **`'Loading…'` could hang indefinitely with no explanation if the
     user held the phone still.** Confirmed, not surprising in hindsight:
     `whenStable()` (above) only resolves once absolute scale converges,
     and both `EightWallSession.ts`'s own comment and 8th Wall's official
     world-tracking guidance ("move slowly, especially at startup") agree
     convergence needs real device parallax — a stationary phone may never
     produce a passing sample. By design (this pass deliberately keeps
     that design — see §F, "do not weaken existing plausibility checks"),
     there is no timeout that reveals the scene anyway; what was missing
     was ANY explanation while the user waits. Fixed in `main.ts`: a
     2.5s timer (coaching-copy only, cleared the instant `whenStable()`
     resolves — the reveal criterion itself is unchanged) swaps the hint
     from `'Loading…'` to `'Still locking on — try moving your phone
     slightly closer, then farther from the plaque.'` if convergence
     hasn't happened yet.
  2. **The anchor sometimes doesn't feel "permanent" — markers/model can
     read as lost when the plaque leaves camera view, contradicting the
     hybrid design's whole point (scan once, walk around;
     `disableWorldTracking: false` keeps SLAM world tracking valid across
     `imagelost`).** Confirmed NOT a `group.visible` regression: grepped
     every assignment site — it is set `false` once at construction and
     `true` exactly once, in `onPoseApplied` (Cold-start stabilization
     above); nothing ever reverts it, so the mounted mesh itself does not
     disappear. Two real, separate contributors identified instead:
     - **No feedback during a real, sustained `isTracking()` gap.**
       Markers correctly hide (by design) when SLAM `trackingStatus`
       leaves `NORMAL`, but nothing told the user this was expected and
       temporary — reading as "the model is gone," not "briefly
       re-orienting." Fixed with a new `TrackingLossHint` (`main.ts`,
       wired via the `AnchorSource.isTracking()` seam, so it's identical
       for the image-target and tap-placed paths and inert under
       `?fakear=1`): a hint only after tracking has been down
       continuously for 2s (well past ordinary camera-pan blips, which
       `MarkerLayer`'s own 250ms hysteresis already absorbs separately),
       hidden the instant tracking recovers. Changes no tracking/pose
       logic — purely surfaces an existing signal.
     - **Leading hypothesis, NOT acted on, deliberately: a re-detection
       (`'found'` with `wasAcquired=true`) can be rejected by the SAME
       `trackingStatus==='NORMAL'` gate that protects `'updated'`
       samples, even though the user is at that exact moment looking
       directly at the physical plaque** — arguably the single strongest
       correctness signal the system ever gets, independent of whatever
       transient status SLAM's relocalization reports. If `trackingStatus`
       hasn't caught up to `NORMAL` in the same frame the image is
       re-detected, the correction is silently dropped and the anchor
       keeps holding a possibly-stale/wrong frozen pose until a LATER
       sample happens to pass both gates — plausibly reading as
       "sometimes doesn't recover." **Explicitly not fixed this pass**:
       loosening this gate for re-detection specifically (keep the scale
       check, drop the trackingStatus check, only for `'found'`) is a
       real, defensible option, but it partially reopens the exact class
       of gap the trackingStatus gate was added to close (§ "Second-audit
       finding," 2026-08-14) — not safe to change on a live physical
       exhibit without a captured on-device log confirming this is
       actually what's happening, not a different failure mode entirely.
       Diagnostic instrumentation added instead
       (`ImageTargetAnchorSource.ts`, `re-detection-rejected` mark, naming
       which gate failed) so the next physical-device pass can confirm or
       refute this before any gate changes.

  **Verified in software:** `npm run typecheck`/`build`/`test` clean,
  29/29 (4 new: `TrackingLossHint`'s debounced show/hide contract). No
  change to `applyPose()`, `isSampleTrustworthy()`, `TARGET_FRAME_TO_WORLD_FIX`,
  or any composition math. **Not verifiable in software, explicitly still
  open:** whether the coaching-copy fix actually reads as helpful in the
  field; whether the tracking-loss hint's 2s threshold is well-tuned
  (too eager/too slow) against real SLAM status flicker; and the
  re-detection-rejection hypothesis above, which needs a real capture
  before any gate is touched.

  **Progress (2026-08-19, later same day): the re-detection-rejection
  instrumentation returned its first real capture — the leading
  `trackingStatus`-lag hypothesis above is REFUTED, and the actual cause
  the log shows is very likely a test-rig artifact, not a code defect.**
  On-screen console screenshots from a physical session (`site`, all 4
  plaques cycling through FOUND/LOST) show, across roughly 20 seconds and
  every single one of ~8 captured `re-detection REJECTED` /
  `updated`-rejected lines: `trackingStatus=NORMAL` on every line, no
  exception. The hypothesis specifically predicted rejections coinciding
  with a non-`NORMAL` status — that never happened once in this capture,
  so it's ruled out as the explanation for THIS session (still theoretically
  possible in a different capture; the instrumentation stays in place).

  What the same capture actually shows: the scale-mismatch ratio is
  **stable and tightly clustered, not converging and not wildly
  scattering** — `engine sees 0.198–0.223 m` against `manifest declares
  0.09 m`, i.e. a consistent **~2.2–2.5× ratio**, unchanged from the
  first captured sample to the last across 20+ seconds of repeated
  closer/farther phone motion (the exact coaching motion the "Still
  locking on" hint above asks for). This pattern — tight, stable,
  non-1 ratio that motion does not improve — is the signature of the
  manifest's `physicalTargetWidthMeters` (0.09, correct for the real
  printed 90×30mm plaque per the 2026-08-18 plaque-redesign commit) not
  matching the actual physical size of whatever the camera is looking
  at, not of unconverged absolute scale (§4's own historical log of a
  genuine non-convergence case shows the ratio wandering — `12.40 → 1.68
  → 7.28 → 8.27` — not sitting still). The accompanying photos show the
  test target as a QR/plaque image open in what looks like a photo-editor
  app on a tablet screen, not the printed paper plaque — a ~90mm printed
  target rendered at tablet-screen size (very plausibly ~200mm across)
  would produce almost exactly this ratio. **Confirmed with the project
  owner**: the test target in this capture was the QR image open on a
  tablet screen, not the printed plaque. **No code defect — this session
  needs no code change.** The scale-mismatch rejection is working exactly
  as designed: the manifest correctly declares the real printed plaque's
  width (0.09 m), the engine correctly measured the actual physical
  object in front of it (a much larger on-screen image), and the gate
  correctly refused to trust a reading that implausible. The apparent
  "model never appears no matter how much I move the phone" symptom is
  fully explained without touching `isSampleTrustworthy()`,
  `SCALE_MISMATCH_TOLERANCE`, or any other gate — moving the phone closer/
  farther cannot fix a target whose true physical size will never match
  the declared one. **Action, not a code change:** retest against the
  actual printed 90×30mm plaque (paper), not a screen. The
  re-detection-rejection instrumentation and the `trackingStatus`-lag
  hypothesis both remain open/unrefuted for a FUTURE capture against the
  real print — this capture simply wasn't able to test either one.

  **Progress (2026-08-25): onboarding UX overhaul — 3-step onboarding,
  shared live guidance illustration, Framer Motion, and Zustand adopted
  under a documented state boundary.** Scope: the QR-scan → intuitive
  "start the AR experience" gap flagged by field feedback (users unsure
  they'd entered an AR experience, unsure how to point/move the phone to
  help acquisition). No change to tracking math, `AnchorSource`
  implementations, `TARGET_FRAME_TO_WORLD_FIX`, `originOffsetMeters`,
  `rotationYawDeg`, the manifest schema, or the content pipeline.

  **New dependencies and why:**
  - **`framer-motion@13`**, imported ONLY via its DOM-only subpath
    (`framer-motion/dom`'s `animate()`) — never the React entry point.
    Verified via `npm view`: React is an *optional* peer dependency, not
    pulled in by this import path. Responsibility: onboarding
    step-to-step crossfades (`OnboardingFlow.ts`) and the shared vector
    guidance illustration's looping motion (`ui/PhoneGuidanceIllustration.ts`).
    Rive is completely unaffected — `RiveController`/`MarkerLayer`/the
    Marker and Card `.riv` artboards keep doing exactly what they did
    before this change; Framer Motion never touches a Rive canvas or
    state machine.
  - **`zustand@5`**, imported ONLY via `zustand/vanilla`'s `createStore`
    — never the React `create()` hook, so React never enters the client
    bundle from this dependency either. Two small, separate stores, not
    one general-purpose store:
    - `store/onboardingStore.ts` — UI-only pre-AR flow step
      (`'intro' | 'locate' | 'stabilize'`). Read only by `OnboardingFlow.ts`.
    - `store/arStatusStore.ts` — a derived mirror of AR/tracking status
      (`ArPhase`), written ONLY from `main.ts`'s existing callback call
      sites, read only by `GuidanceOverlay.ts`.
    Deliberately store-free: every engine module
    (`EightWallSession`, `AnchorSource` implementations, `SceneGraphLoader`,
    `HotspotProjector`, `MarkerLayer`, `RiveController`) — framework
    coupling stops at `main.ts`, the existing composition root. `CardPanel`
    also deliberately stays out of Zustand: its drag gesture needs
    synchronous transform writes on every `pointermove`, where a pub-sub
    store adds indirection with no benefit — it remains the same
    self-contained, app-owns-its-transform class it always was, per
    `CardPanel.ts`'s own doc comment.

  **No new signals, no new timers.** `arStatusStore` is written to
  exclusively at points that already existed and were already
  justified in this file: `ImageEventHintGate`'s real
  `EightWallSession.onImageEvent` `'loading'`/`'scanning'` callback, the
  pre-existing `POSE_COACHING_DELAY_MS` coaching timer (already
  documented above as changing only hint TEXT, never the reveal
  criterion), `TrackingLossHint`'s real per-frame `isTracking()` tick,
  and `AnchorSource.whenStable()`'s resolution. None of those three
  classes gained a Zustand/Framer Motion import — `main.ts` is the only
  place that bridges their existing callbacks into a store write.

  **Onboarding flow (`OnboardingFlow.ts`, image-target path only —
  `placement:'image'`, i.e. `site` today; the tap-placement path used by
  other experiences is unchanged, out of scope for this pass):**
  1. *Welcome* — "You're about to start an AR experience..." — no
     illustration yet.
  2. *Find a target* — "Point your camera at one of the 4 image
     references on the model." — shared illustration, `'search'` variant.
  3. *Almost there* — "Move your phone slowly to help it lock on." —
     shared illustration, `'stabilize'` variant, restyled per the
     supplied Figma reference (node 2:5: gradient scrim, pill CTA). This
     step's CTA click handler directly contains the exact body that used
     to live inside the old single `overlay.showPanel(..., 'Start AR',
     ...)` call — `session.start()` is still invoked synchronously from
     a real click handler, so the iOS motion-permission gesture
     requirement is unchanged.

  **Live in-AR guidance (`GuidanceOverlay.ts`):** a small additive
  sibling of `UxOverlay` (never a modification of it — `UxOverlay.ts` has
  zero diff in this pass), subscribed to `arStatusStore`, rendering only
  the same shared vector illustration used in onboarding — reused live
  whenever `ImageEventHintGate`/`TrackingLossHint` signal the user needs
  to search for or re-find a target, or the coaching timer signals a
  "hold on, move slowly" moment. Hint TEXT keeps flowing through the
  existing `overlay.showHint()`/`hideHint()` exactly as before — no
  duplicated text-rendering path.

  **Card (`CardPanel.ts`): a third snap point, `'peek'`, added between
  `'closed'` and `'open'`** (Figma nodes 6:40 "collapsed" / 6:383
  "open" — a real 2-snap-point bottom sheet, not just a reskin). Peek
  height is derived from the header's own rendered height (no hardcoded
  constant) — grabber/title/subtitle visible, body/image below the
  fold, exactly matching 6:40. `open(content)` now lands on `'peek'`;
  a new `expand()` goes `'peek' -> 'open'`; the drag-release math was
  generalized from a single close threshold into a pure, unit-tested
  `resolveSnapPoint()` (`CardPanel.test.ts`, 8 cases) reusing the exact
  existing `DRAG_CLOSE_FRACTION`/`DRAG_CLOSE_VELOCITY_PX_MS` constants.
  The header stays the only drag surface and `contentWrapper` stays the
  only scroll surface, unchanged — grabber/close-button visibility and
  swipe-to-dismiss hold by construction, not by new special-casing.

  **Verified in software:** `npm run typecheck`, `npm run build`, and
  `npm test` all clean (43/43 tests — 12 new: `CardPanel.test.ts`'s
  snap-point resolver, `store/onboardingStore.test.ts`'s step table,
  `store/arStatusStore.test.ts`'s phase-to-illustration mapping). A
  headless-Chrome, real-build smoke test (raw CDP over WebSocket, no
  puppeteer — same dependency-free pattern this repo's `tools/*.mjs`
  probes already use) at 320/393/430px against the actual `dist/server.js`
  confirmed, at every width: all 3 onboarding headings/CTA labels render
  correctly, zero console errors before the Start-AR tap, the onboarding
  overlay is correctly removed after that tap, and the existing "Starting
  camera…" hand-off hint still fires — i.e. the new UI and the existing
  gesture-gated `session.start()` hand-off compose correctly. (`?fakear=1`
  was deliberately NOT used for this test — it bypasses straight into
  `startDevSim()`, which never shows `OnboardingFlow` at all; testing
  past the real Start-AR gesture hits the same pre-existing
  no-GPU/no-camera headless-Chrome ceiling this file's Phase 1 notes
  already documented, not a new limitation.)

  **Requires physical device testing, not verifiable in software:**
  whether the search/stabilize illustrations read as intuitive during
  real phone motion; real on-device image-target loss/reacquisition
  timing against the live `GuidanceOverlay`; the `prefers-reduced-motion`
  fallback on an actual notched iPhone; and the Card's drag-to-peek/
  drag-to-expand feel on a real touchscreen (the pointer-capture-based
  drag math itself is unchanged and was already field-tested pre-peek —
  only the added third snap point is new and untested on-device; per
  this file's own prior note, a JS-dispatched `PointerEvent` can't
  satisfy `Element.setPointerCapture`, so this class of interaction has
  never been headlessly automatable in this repo, before or after this
  pass).

  **Progress (2026-08-25, later same day): first physical-device pass on
  the onboarding above surfaced real UI/animation defects — reworked to
  match the supplied reference design, plus three genuine implementation
  bugs found and fixed via headless screenshot verification, not
  assumption.** No architectural change from the entry above (still the
  same two Zustand stores, same real-signal wiring, same
  `framer-motion/dom`); this is a visual/behavioral revision to
  `OnboardingFlow.ts` and `ui/PhoneGuidanceIllustration.ts` specifically.

  **Onboarding shell redesign** (matches the supplied Apple-object-capture-
  style reference, replacing this entry's earlier dark-scrim/bottom-
  anchored layout): white background; content (illustration, then a 3-dot
  stepper, then heading/body) vertically centered as one group above a
  bottom button block; a "Help" corner button (`onboardingStore.reset()`)
  restarts the flow from step 1; a "Finish" link under the primary CTA on
  every step skips straight to the same Start-AR hand-off as the last
  step's own CTA (both call the identical private `finishNow()`, which is
  what actually invokes `session.start()` — the "Cancel"/"maximize" icons
  from the reference were left out, deliberately: neither has a defined
  destination in this single-entry-point flow, and inventing one wasn't
  asked for). Steps renamed to what they actually teach: `find` ("Find a
  target" / orbit illustration), `lock` ("Lock it in" / voronoi
  illustration), `ready` (Start-AR CTA, no illustration — a clean
  confirm-and-go screen, not a third invented motion variant).

  **Illustration redesigned**: the phone now travels an actual arc (a
  sampled quadratic-bezier x/y/rotate keyframe set, tangent-following
  rotation) instead of oscillating in place ("looked like waving," per
  the physical-device report), and leaves a fading trail behind it. Two
  variants replace the earlier single one — `'orbit'` (phone arcing
  around a wireframe target, for "find a target") and `'voronoi'` (phone
  arcing toward a small abstract cell-pattern glyph evoking the real
  tracking artwork, for "lock on") — reused identically by
  `GuidanceOverlay.ts` live in AR (`arStatusStore`'s `'searching'` /
  `'stabilizing'` phases now map to `'orbit'` / `'voronoi'` respectively,
  same mapping shape as before, just renamed). `GuidanceOverlay` also
  grew from a small, bottom-anchored icon to a large (280px), roughly
  mid-screen one, matching the supplied live-AR reference.

  **Three real bugs found and fixed, each confirmed by direct headless
  screenshot evidence, not inferred from reading the code:**
  1. **White-on-white invisibility.** The illustration's SVG hardcoded
     `stroke="#fff"`, written when the only host was a dark scrim. The
     new white onboarding background made it fully invisible. Fixed by
     switching every stroke/fill to `currentColor` and having each host
     set its own `color` (`OnboardingFlow`: dark; `GuidanceOverlay`:
     white) — one component, two contexts, no hardcoded color anywhere
     in it.
  2. **framer-motion's `pathLength` value never actually drives
     `stroke-dasharray`/`-dashoffset` through the vanilla `animate()`
     entry point.** The trail was originally built on
     `animate(path, { pathLength: [0,1] }, ...)` — framer-motion's
     documented "draw an SVG path" feature. `element.getAnimations()`
     and inline-style inspection after the call showed no native
     Animation and a permanently unchanged inline style: the value
     silently no-ops outside a React `motion.path` component. (Framer
     Motion's transform properties and `opacity`, used elsewhere in this
     same file via the same `animate()` call, work correctly — this is
     scoped to the one property that didn't, not grounds to distrust
     `animate()` generally.) A hand-rolled `requestAnimationFrame` loop
     was tried next and also proved unreliable — `document.hasFocus()`
     is `false` for an automated/backgrounded browser tab, and Chrome
     throttles rAF delivery there, confirmed by comparing an isolated
     121fps rAF measurement on a blank page against a near-stalled one on
     the actual (unfocused, in this harness) app page. Fixed with a
     native CSS `@keyframes` animation on `stroke-dashoffset` (a fixed,
     pre-measured dasharray/length, `SVGPathElement.getTotalLength()`
     measured once and hardcoded — the path never changes) — driven by
     the browser's own animation engine, not app JS ticks, so neither
     failure mode applies. Confirmed via `getAnimations()` returning a
     real, running, correctly-timed native Animation after the fix.
  3. **Duplicate SVG gradient `id` across the two simultaneously-mounted
     instances.** Both `OnboardingFlow`'s and `GuidanceOverlay`'s
     illustrations defined `<linearGradient id="trailFade">`; SVG ids
     must be document-unique, so `url(#trailFade)` in *either* instance
     resolved to whichever gradient landed first in the DOM — meaning
     both trails' `currentColor` gradient stops resolved against that
     one gradient's own ancestor color, not the referencing instance's.
     Isolated by forcing a fully-drawn (non-animated) trail with the real
     gradient — still invisible — against an ad hoc solid-color stroke on
     the identical path, which rendered correctly; that isolated the
     defect to the gradient reference, not the geometry or the animation.
     Fixed by generating a unique gradient id per instance
     (`ar-guidance-trail-fade-${n}`).

  **Verified in software:** `npm run typecheck`/`build`/`test` clean,
  44/44 (one new: `onboardingStore`'s `reset()`). Headless-Chrome, real
  `dist/server.js` build, raw CDP (no puppeteer) at 320/393/430px:
  step headings/CTA labels/illustration size correct at every width;
  Help correctly restarts to step 1 mid-flow; Finish and the last step's
  CTA both reach the same Start-AR hand-off with zero console errors up
  to that point; screenshots (with the dash-animation and gradient-id
  bugs above still both live at the time) were the actual evidence that
  surfaced bugs 1–3 — this pass did not just trust green checkmarks, it
  looked at what rendered. **Requires physical device testing, not
  verifiable in software:** whether the redesigned onboarding and the
  arc/trail motion read as intuitive during real phone handling, and
  the live in-AR `GuidanceOverlay` (large, white-on-camera-feed) —
  headless Chrome has no real camera and no WebGL in this sandboxed
  environment (this file's Phase 1 notes already document that
  ceiling), so the AR-side rendering of this same component was verified
  by code/mechanism review (identical `currentColor` approach, now
  proven correct on the onboarding side) rather than by direct capture.

  **Progress (2026-08-25, later still): first ON-DEVICE physical pass
  (real iPhone, live camera, real AR session) surfaced four more real
  defects — all fixed and re-verified via headless screenshot before this
  entry was written.**

  1. **Illustration too small.** Nominal render size doubled (small
     130→260px, large 280→460px), still capped responsively via CSS
     `max-width` (in vw, so neither ever overflows a narrow phone
     viewport) rather than a fixed pixel ceiling.
  2. **Trail visibly raced ahead of / lagged behind the phone** (on-device
     photos showed the arc line crossing through the phone mid-animation).
     Root cause: two INDEPENDENTLY-timed animations — framer-motion's
     keyframe `animate()` for the phone and a CSS `@keyframes` animation
     for the trail — can each be individually correct and still drift
     relative to each other; nothing coupled them. Also found in the same
     pass: framer-motion's default equal-time spacing across the phone's
     intentionally uneven bezier-t keyframe samples (denser near the
     apex) produced the reported "torpe... como un glitch" stutter — the
     phone was moving at correct POSITIONS but wrong RELATIVE SPEEDS.
     Both fixed by replacing both animation mechanisms with a single
     `requestAnimationFrame` loop that computes one eased progress value
     per frame from a continuous analytic quadratic-bezier formula (point,
     tangent-angle, and a precomputed arc-length-vs-t table for the
     trail's `stroke-dashoffset`) and writes both the phone's transform
     and the trail's dash in the same tick — the trail cannot lead the
     phone by construction, and there are no discrete keyframes left to
     mis-space. (The earlier §G entry's finding that a hand-rolled rAF
     loop looked stalled was a headless/unfocused-tab-only artifact,
     confirmed irrelevant here — this on-device pass is the proof: the
     rAF-driven animation runs correctly on a real, focused phone screen.)
     `framer-motion/dom`'s `animate()` is kept for what it's still
     genuinely used for in this file: the opacity show/hide crossfade.
  3. **Onboarding's corner button was backwards.** The "Help" restart
     button belongs only on the already-in-AR screen, not onboarding
     itself — replaced in `OnboardingFlow.ts` with a top-left "Back"
     button (`onboardingStore.back()`, a new pure `previousOnboardingStep()`
     transition, hidden on the first step) for in-flow navigation. A new
     live-AR "Help" reuses the EXISTING `UxOverlay.showCornerButton()`
     seam (previously only used for tap-placed experiences' "Re-place" —
     same slot, mutually exclusive by `anchorSource.kind`, no conflict),
     wired in `main.ts` right after scene reveal, image-target path only.
     Tapping it resets `onboardingStore` to step 1 and re-opens
     `OnboardingFlow` in a new `replay: true` mode: the last step's CTA
     reads "Got it" instead of "Start AR" and `onComplete` is a plain
     dismiss — the running AR session is never touched, never
     re-triggered.
  4. **Step 3's layout visibly jumped** ("Ready" has no illustration,
     unlike steps 1–2) and the illustration's own fade got caught
     mid-transition. Root cause: the illustration slot's height changed
     whenever the icon disappeared, reflowing everything below it in the
     same frame the crossfade was running. Fixed with a new exported
     `guidanceSlotStyle()` in `PhoneGuidanceIllustration.ts` — the single
     source of truth for the illustration's own box (width + aspect-ratio,
     not a duplicated guess) — so the host reserves the identical
     footprint whether or not a step shows an icon.

  Also reported: white bands top/bottom of the live AR camera view.
  Investigated, not blindly "fixed": `body`'s background is already
  `#000` (not white) and nothing this project's code sets a white
  background behind the camera canvas, so this is not the onboarding
  screen's white bleeding through. `#ar-container`/`#camerafeed` switched
  from static `100vh`/`100vw` to `100dvh`/`100dvw` (dynamic viewport
  units, with the static ones kept as a fallback rule for older browsers)
  as a real, low-risk improvement — the canvas now re-fills automatically
  the instant Safari's chrome auto-collapses on scroll/interaction,
  instead of staying sized to whatever the viewport was on load. This
  does NOT explain everything the report describes, though: the supplied
  photos show iOS's own status bar and Safari's own URL-bar/tab toolbar
  at top and bottom — that chrome is the browser's own UI, entirely
  outside this page's DOM, and no page CSS can paint over or resize it
  while browsing a plain tab (not added to the Home Screen). An
  edge-to-edge camera view with zero browser chrome needs either
  installing this site to the Home Screen (a standalone web app has no
  Safari UI at all) or the native iOS App Clip already on this file's
  roadmap (§G Phase 4, not yet started) — not a web CSS fix.

  **Verified in software:** `npm run typecheck`/`build`/`test` clean,
  47/47 (3 new: `previousOnboardingStep()`'s table). Headless-Chrome, real
  `dist/server.js` build, raw CDP at 320/393/430px: illustration renders
  at the doubled size; Back is hidden on step 1, visible and functional
  on steps 2–3; "Help" is absent from onboarding; step 3's content block
  keeps an identical bounding box whether or not an icon is showing (the
  jump fix); screenshots at two different points in the arc/trail loop
  both show the trail terminating exactly at the phone's position, never
  past it. **Requires physical device testing, not verifiable in
  software:** whether the now-analytic arc motion reads as smooth on a
  real screen (headless screenshots can only confirm sync/position, not
  perceived frame-to-frame smoothness), the live in-AR "Help" replay flow
  (needs a real running AR session to test against), and whether the
  `100dvh`/`100dvw` change measurably changes what's visible around
  Safari's chrome on an actual device.

  **Progress (2026-08-25, later still): production `'site'` entry
  connected to the new Voronoi tracking artwork (explicit user request,
  for physical-device testing) — and the live-AR "Help" button now
  appears from the start of tracking, not gated behind a successful
  lock.**

  **Artwork swap, `packages/experience-manifest/manifest.ts`:** the
  earlier `'site-tracking-front/back/left/right'` entries (the
  single-image-target validation harness this file's prior entry
  describes as "more stable, not yet stable enough," with `-back/-left
  /-right` compiled but never individually on-device tested) were never
  promoted into the production `'site'` entry's `targets[]` — this pass
  does exactly that: `targets[].imageTargetUrl` now points at
  `/assets/image-targets/site-tracking-{front,back,left,right}/...json`
  (verified reachable — `curl -I` 200 on all 4 — before wiring, not
  assumed), `physicalTargetWidthMeters` changed `0.09` → `0.03` (the new
  artwork's real size: 30mm square, not the old 90×30mm landscape).
  `originOffsetMeters`/`rotationYawDeg` are UNCHANGED — those describe
  each plaque's mounted position/rotation, which this artwork-only swap
  does not move (per this file's own prior decision record: "4 dedicated
  image targets stay on the ledge, same mount footprint"). Manifest
  version `0.1.1` → `0.2.0`. **Explicitly not fixed by this swap, and not
  claimed to be:** `ImageTargetAnchorSource.applyPose()`'s zero-temporal-
  filtering pose jitter (still only a proposed, unimplemented fix per
  the prior entry) — pre-existing, not artwork-specific, so this swap
  makes tracking-quality no worse, but doesn't resolve that open item
  either. `site-tracking-back/left/right` are now live on a physical
  device for the first time ever via this change (previously compiled
  and wired but never worn on a real test).

  **Help button timing, `main.ts`:** previously only registered
  (`overlay.showCornerButton('Help', ...)`) after `anchorSource
  .whenStable()` resolved — a user who never achieves a stable lock
  never saw it at all. Moved to fire at the top of the image-target
  branch, immediately after `session.start()` resolves (i.e., the moment
  world tracking actually begins, before the first `imageAnchor
  .acquire()` even starts) — present through searching, acquiring, and
  stable states alike. No FAKE_AR guard needed at the new call site (it's
  already inside the non-FAKE_AR branch); the desk-testing bypass is
  unaffected.

  **Verified in software:** `npm run typecheck`/`build`/`test` clean
  (47/47, unchanged — this pass touched no pure-logic modules).
  `GET /api/manifest` confirmed serving the updated `'site'` entry
  (new URLs, `physicalTargetWidthMeters: 0.03`, `version: '0.2.0'`,
  offsets/rotations byte-identical to before); HTTP HEAD 200 on all 4
  new asset paths. Onboarding headless smoke test (320/393/430px)
  re-run clean after the `main.ts` edit — no regression. **Requires
  physical device testing, not verifiable in software (the whole point
  of this change):** whether the new artwork actually tracks better on
  the real printed plaques at their real mounted positions; whether the
  reused `originOffsetMeters`/`rotationYawDeg` values still line up
  correctly now that the artwork's footprint is smaller and (per the
  design docstring, unconfirmed against an actual print) centered the
  same way the old landscape plaques were; and whether "Help" appearing
  before a lock is achieved reads as useful rather than distracting.

  **Progress (2026-08-26): first physical test of the 2026-08-25 Voronoi
  artwork surfaced "only one of the 4 targets works" — root-caused to a
  real multi-target bug (not artwork quality), fixed; the previously
  proposed pose-smoothing fix (§22 of the troubleshooting doc) also
  implemented in the same pass. Also: the flat-mount requirement
  (§18/§G's 2026-08-17 entry) re-confirmed unchanged and made
  unambiguous in `docs/physical-plaque-placement.md`.**

  **Bug found by code review, not by a new physical capture:**
  `ImageTargetAnchorSource.onImageEvent()`'s 'found' handler gated on a
  single class-wide `acquired` boolean — once ANY plaque acquired the
  anchor, every subsequent 'found' for a DIFFERENT plaque (its own
  first-ever sighting) was held to the same `isSampleTrustworthy()` gate
  designed for noisy re-detection of the SAME already-anchored plaque
  (scale plausibility AND `trackingStatus === 'NORMAL'`). No unit test
  covered "already acquired via target A, first sighting of target B" —
  every existing test either used a single target or explicitly tested
  re-detection of the SAME name. This is a strong, sufficient explanation
  for "only the plaque scanned first ever works": walking to a different
  physical plaque is exactly when `trackingStatus` commonly deviates from
  `NORMAL` (SLAM `RELOCALIZING`/`TOO_MUCH_MOTION` during camera motion),
  so a genuinely new plaque's first sighting had a real chance of landing
  on a rejected sample with no automatic retry a user would perceive as
  "recovering" — the anchor just silently stayed wherever the first
  plaque left it.

  **Fix (`ImageTargetAnchorSource.ts`):** a new `seenTargetNames: Set<string>`
  tracks which plaque names have ever produced a trustworthy sample. A
  'found' event is now treated as trustworthy when `!wasAcquired` (the
  original bootstrap exception) **or** the name is new to this anchor,
  **or** it independently passes `isSampleTrustworthy()` — generalizing
  the existing "the very first sample must not hang forever" reasoning
  from "the whole anchor's first-ever sample" to "this specific plaque's
  first-ever sample." A REPEAT sighting of an already-seen name is
  unaffected — still held to the full gate, exactly as before.

  **Pose smoothing (`docs/research/8th-wall-troubleshooting.md` §22's
  proposal, implemented as proposed):** `applyPose()` now filters the RAW
  tracked position/rotation through a `OneEuroFilter1D` per position axis
  and per quaternion component (hemisphere-continuity-corrected before
  filtering, renormalized after) before composing with
  `TARGET_FRAME_TO_WORLD_FIX`/`rotationYawDeg`/`originOffsetMeters` — not
  the other way around, so the offset is always rotated by a quaternion
  consistent with the filtered position. Tuned like MindAR's own
  `TRACKING_PROFILE_RIGID_ANCHOR` (`ARSessionManager.ts`: minCF 0.001,
  beta 1000) per the proposal's own reasoning — high beta so the filter
  gets out of the way during real motion, unlike the low-beta profile
  already proven to cause visible lag/"swim" when tried for MindAR's
  rigid-anchor case. Filter state (all 7 filters plus the elapsed-time
  clock) resets on every pose discontinuity — a re-detection of the same
  plaque after a loss, or (the fix above) a different plaque's first
  sighting — via the same `resetPoseFilters()` call, so a legitimate jump
  still snaps instead of smoothing across it. The clock is injectable
  (`now: () => number`, defaults to `performance.now`) specifically so
  `ImageTargetAnchorSource.test.ts` can simulate realistic frame-to-frame
  timing instead of the near-zero elapsed time synchronous test calls
  would otherwise measure.

  **Verified in software:** `npm run typecheck`/`build`/`test` clean,
  51/51 (4 new: two covering the multi-target fix directly — a new
  plaque's first sighting applies despite an implausible scale, and
  despite non-`NORMAL` trackingStatus; one confirming a REPEAT sighting
  of an already-seen plaque still gets rejected; one confirming filter
  reset makes a plaque switch snap exactly rather than lag). Pre-existing
  "recovered sample" assertions needed a widened epsilon (still ≤1cm) to
  account for the filter's now-real, expected, small smoothing lag on a
  second-in-a-row sample of the SAME target — a regression in the
  composition math itself would be off by orders of magnitude more than
  that, so this doesn't weaken what those tests catch.

  **Docs:** `docs/physical-plaque-placement.md` rewritten where it still
  described the retired 90×30mm QR-plaque artwork (§1's print sheet,
  size, badge-shape convention) to instead describe the current 30×30mm
  Voronoi targets (§1); the flat-mount requirement (unaffected by the
  artwork swap) called out as an explicit REQUIREMENT rather than left
  as one confirmed fact among many, since a vertical mount would track
  against the wrong axis convention entirely.

  **Requires physical device testing, not verifiable in software:**
  whether the multi-target fix actually resolves "only one target
  works" against the real printed artwork (the code-level explanation is
  strong but this pass had no new physical capture to confirm it
  against); whether the pose-filter tuning feels right on a real device
  (screen-space marker smoothing already uses a different, lower-beta
  profile deliberately — this is the first on-device test of ANY
  smoothing on the 3D anchor itself for 8th Wall); and every item already
  open from the 2026-08-25 entries above (artwork tracking quality,
  reused offset/rotation numbers against the smaller footprint, flat-mount
  vs. 8th Wall's own rotation convention).

  **Progress (2026-08-26, later the same day): on-device debug-console capture reviewed
  (screen test, not a print — see below); `'voronoi'` guidance variant
  redesigned from a second copy of the arc motion into its own
  right/left nudge gesture; step 3 gained a camera-permission reminder.**

  **Debug-console capture reviewed, no action needed:** the supplied
  on-device `?debug=1` log shows repeated `[ImageTarget] FOUND
  "site-tracking-front"` / `scale mismatch: engine sees 0.095-0.184 m,
  manifest declares 0.03 m` / `pose sample rejected` / `LOST`. This is
  the exact, already-documented pattern from this file's own prior §21
  finding (testing against an on-screen image instead of a printed
  target produces a stable-but-wrong scale ratio, correctly rejected by
  `isSampleTrustworthy()`) — confirmed by the user's own report: testing
  was done against an iPad screen, no printer available yet. Not a
  regression, nothing to fix here; the gate is working as designed. Also
  visually confirmed in the same screenshots: the live-AR "Help" button
  IS showing from the start of tracking (the prior entry's fix), before
  any lock was ever achieved.

  **`'voronoi'` motion redesign, `ui/PhoneGuidanceIllustration.ts`:**
  previously reused the exact same left-to-right arc as `'orbit'`, only
  swapping the target glyph — an approximation of "move slightly closer,
  then farther" that didn't actually depict that gesture. Replaced with
  a dedicated nudge motion sharing the same architecture (one
  `requestAnimationFrame` loop, one shared eased `t` per frame driving
  every element, direct `element.style` writes — see the file's own doc
  comment for why): the phone oscillates right then left around a fixed
  center (`x = center ± amplitude * sin(2πt)`), and a short arrow grows
  on whichever side it's currently moving toward (`max(0, ±sin(2πt))`,
  the same `t`) — a shaft scaled via `scaleX` (safe under non-uniform
  scale for a perfectly horizontal line — only its length changes, not
  its stroke thickness) plus a fixed-shape arrowhead translated to the
  shaft's current tip and opacity-faded in near full growth (an angled
  shape WOULD visibly distort under `scaleX`, so it's never scaled, only
  repositioned). `'orbit'`'s arc/trail is untouched. Verified correct
  with real numeric data, not another screenshot guess: a JS-side trace
  polling the phone's live `transform` and both arrows' `scaleX` every
  120ms over 3.2s (recorded in this session, not reproduced here) shows
  a clean, symmetric right→center→left→center cycle with each arrow
  growing to ~0.98–0.99 exactly while the phone is on its side and
  shrinking to 0 the instant it crosses back through center — screenshot
  sampling had initially and coincidentally landed on stroboscopic
  aliasing (a 260ms sample interval is an exact submultiple of the
  2.6s cycle) plus the arrows' genuinely narrow full-extension window,
  reading as "right arrow never appears" when it was a sampling artifact,
  not a logic bug.

  **Onboarding step 2 copy** now matches the live "still locking on"
  hint's wording exactly ("Move your phone slightly closer, then
  farther, to help it lock on.") — same instruction, same words, same
  illustration variant, onboarding and live AR.

  **Onboarding step 3** ("Ready when you are") now explicitly prepares
  the user for the OS camera-permission prompt that `session.start()`
  triggers next: "Tap Start AR to begin. You'll be asked to allow camera
  access — tap Allow to continue."

  **Verified in software:** `npm run typecheck`/`build`/`test` clean
  (47/47, unchanged — no new pure-logic modules this pass). Headless
  smoke test re-run clean at 320/393/430px (no regression). **Requires
  physical device testing, not verifiable in software:** whether the
  new right/left nudge motion reads as intuitive for "move slightly
  closer, then farther" in real hand use; and (still open from the
  prior entry, unrelated to this pass) whether the new tracking artwork
  performs well against the real printed plaques once a print exists.

  **Progress (2026-08-26, later still): physical-device report on the
  `'voronoi'` nudge motion — a real velocity-asymmetry bug, root-caused
  and fixed, plus two layout changes.**

  **Bug: right movement read as slow, the return left read as fast.**
  Root cause, confirmed algebraically, not guessed: the previous code fed
  `easeInOutCubic(raw)` as the ARGUMENT to `sin()`. `easeInOutCubic`
  reaches its own midpoint (0.5) quickly relative to how slowly it
  approaches 0 and 1 (`4r³` for `r<0.5`, so `easeInOutCubic(0.397) ≈
  0.25`) — meaning the sine's rightmost peak (`t=0.25`) landed at
  `raw≈0.397`, only 21% of the "right" half's own raw-time-budget away
  from its end. The result: a slow ~80%-of-the-half departure from
  center out to the peak, then a fast ~20%-of-the-half snap back through
  center into the left excursion — exactly the reported "right is slow,
  left is fast," even though the two halves get EXACTLY equal wall-clock
  time. Fixed by using `raw` directly for `'voronoi'` (no extra easing —
  a plain sine already eases itself naturally at its own extrema, and
  `x(1-raw) = 2·center − x(raw)` holds exactly, an honest mirror
  image). `'orbit'` keeps its internal easing (a one-shot journey, where
  an eased start/end is correct, and no periodic function is involved to
  clash with it). Also, per the same report and 8th Wall's own quoted
  "move slowly" guidance (`EightWallSession.ts`): the cycle slowed
  (2.6s → 3.2s) and both the amplitude and arrow length reduced, for a
  visibly more subtle nudge.

  **Layout: target glyph moved from below the phone (column) to beside
  it (row).** `target-voronoi`'s coordinates shifted so it shares the
  phone/arrows' own y — a single horizontal composition (phone, its
  arrow, the target) instead of a vertically stacked one.

  **Arrow origin: now the phone's current edge, not its center.** The
  arrow groups' position is recomputed every frame as `phoneX(raw) ±
  PHONE_HALF_WIDTH` (10, matching the phone glyph's own local half-width)
  instead of a fixed static point — so the right arrow visibly starts at
  the phone's right edge and the left arrow at its left edge, tracking
  the phone as it moves, per the physical-device report.

  **Verified in software:** `npm run typecheck`/`build`/`test` clean
  (51/51, unchanged this pass). A JS-side numeric trace (phone transform
  + both arrows' `scaleX`, polled every ~120ms over one full cycle)
  confirms the fix directly: right-shaft scaleX rises smoothly
  0.68→0.995 (peak)→0.0006 and left-shaft rises smoothly
  0→0.989 (peak)→0.05, both visibly symmetric rise/fall shapes with
  peaks reaching ~0.99+ — no more front-loaded/back-loaded skew.
  Screenshots confirm the row layout and edge-anchored arrow visually.
  **Requires physical device testing, not verifiable in software:**
  whether the corrected, slower motion now reads as the intended subtle
  gesture in real hand use.

  **Progress (2026-08-31): `ImageTargetAnchorSource`'s tracking strategy
  reversed — anchor once and freeze, instead of continuously re-snapping —
  after weeks of on-device testing under the continuous-re-snap design kept
  surfacing new shapes of the same drift/jitter symptom family (§13, §14,
  §22, §24) even with the plausibility gate and pose-smoothing filter both
  in place.**

  **Decision, not a guess:** `docs/research/8th-wall-troubleshooting.md`
  §25 has the full write-up, including two independent 8th Wall community
  forum threads found this session — one where 8th Wall staff (Ian)
  explicitly recommend anchoring on `xrimagefound` and relying on SLAM
  world tracking for persistence rather than continuously re-applying
  marker pose (the exact symptom this project hit), and one describing the
  same offset-amplifies-drift geometry this project's `originOffsetMeters`
  composition has. The replacement strategy is not new engineering: it is
  the same shape `TapPlacedAnchorSource` has used since Phase 6 began
  (place once on the user's tap, let `disableWorldTracking: false` SLAM
  hold it) — never once the subject of a drift/jitter entry in this file.

  **What changed in `ImageTargetAnchorSource.ts`:** the pre-existing
  bootstrap/convergence/reveal machinery (§19 "Cold-start stabilization")
  is untouched — first `found` still applies unconditionally, the group
  stays hidden until a sample independently passes `isSampleTrustworthy()`
  (scale plausibility AND `trackingStatus === 'NORMAL'`), and that sample
  still reveals the group and resolves `whenStable()`. The instant that
  happens, the transform now FREEZES permanently for the anchor's
  lifetime: every later `found`/`updated` (same plaque re-detected, or a
  different plaque's first-ever sighting) still updates
  `imageVisible`/telemetry but never touches `group.position`/
  `group.quaternion` again. The One Euro Filter smoothing apparatus §22
  added (2026-08-26) is removed outright, not left dormant — with no more
  continuous re-snapping there is nothing left for it to smooth (the group
  is hidden for the entire pre-freeze window anyway, so no user ever saw
  the samples it used to act on); leaving it in place would misdocument
  the shipped design. The `seenTargetNames` multi-target exemption from
  §24 is kept for the (now much shorter) pre-freeze window, but the
  original §24 bug it fixed is now structurally impossible post-freeze:
  nothing is evaluated against any gate once frozen, so nothing can be
  "rejected."

  **Trade-off, stated plainly:** the anchor no longer self-corrects
  accumulated SLAM drift by re-scanning a plaque mid-session. If that
  proves to matter on the physical exhibit (a multi-minute walkaround of
  the ~1.6×1.3m `site` model), the next lever is a bounded,
  user-intentional recenter (`EightWallSession.recenter()` already exists,
  unused) — not a reversion to continuous re-snap. Not built this pass;
  deferred to on-device evidence.

  **Verified in software:** `npm run typecheck`/`build`/`test` clean,
  52/52. `ImageTargetAnchorSource.test.ts` rewritten: every pre-freeze
  gate test kept (tightened to exact-match epsilons now that there's no
  filter lag to account for), the filter-reset-specific test removed
  (nothing left to test), three new tests assert the transform is
  unchanged post-freeze by a same-plaque re-detection, by a run of
  ordinary per-frame `updated` samples, and by a different plaque's
  first-ever sighting. **Requires the physical exhibit, not verifiable in
  software:** whether the §22/§24 jitter/drift reports are actually gone
  on real hardware, and whether losing continuous drift self-correction is
  noticeable over a real walkaround session — the whole reason this is
  shipping to a physical test before any further iteration.

  **Progress (2026-09-01): first physical retest of the freeze above —
  the predicted trade-off hit immediately (scene follows the user and
  loses scale over a walkaround), refined to freeze only the CONTINUOUS
  event stream; plus two unrelated onboarding-copy/illustration gaps
  fixed from the same report.**

  **Anchor stability, refined (`ImageTargetAnchorSource.ts`):**
  `docs/research/8th-wall-troubleshooting.md` §26 has the full write-up.
  Summary: freezing the anchor against EVERY image event (not just the
  continuous `'updated'` stream) removed the only mechanism that ever
  corrected ordinary SLAM/VIO drift during a real multi-minute
  walkaround — re-grounding the content against a plaque's known
  real-world position each time the user looks at one again. The fix
  distinguishes the two event shapes 8th Wall already exposes:
  `'updated'` (fires every frame in view — the proven §22/§24 jitter
  source, stays permanently frozen once stabilized, unchanged) versus
  `'found'` (fires only on a discrete transition — first detection or a
  fresh re-detection after `imagelost`, at most a few times per minute) —
  `'found'` now runs through the same `isSampleTrustworthy()` gate and
  `seenTargetNames` multi-target exemption for the FULL session, exactly
  as it did before `stable` existed. This is not a revert: the
  pre-2026-08-31 code re-applied `'updated'` too, every frame, which is
  what caused the jitter in the first place; this keeps that fix while
  restoring only the bounded, occasional correction.

  **Onboarding copy/illustration, from the same on-device report, found
  by reading code against its own instructional text:**
  1. The "find a target" copy never said the tracking targets are only
     30×30mm (`docs/physical-plaque-placement.md` §1) — plausibly a real
     contributor to "can't get lock," since detection needs the phone
     much closer than "point your camera at the plaque" implies on its
     own. Updated in `main.ts`, `ImageEventHintGate.ts`,
     `TrackingLossHint.ts`, and `OnboardingFlow.ts`'s `find` step.
  2. The "still locking on" hint text ("move your phone slightly closer,
     then farther") and its `'voronoi'` illustration had drifted apart —
     the animation showed a LATERAL nudge, not the depth motion the text
     asks for. Traced through this file's own 2026-08-25/2026-08-26
     onboarding entries: two separate illustration redesigns, neither of
     which ever actually built a depth-motion depiction (the first arced
     toward a target glyph, replaced by a lateral nudge because arcing
     "didn't depict that gesture" either — the nudge was a different
     wrong depiction, not a fix). `PhoneGuidanceIllustration.ts`'s
     `'voronoi'` variant rewritten to a scale "breathing" pulse (the
     phone and a halo ring grow/shrink in place) — the standard 2D
     substitute for depicting motion toward/away from the camera.

  **Verified in software:** `npm run typecheck`/`build`/`test` clean,
  53/53. Three anchor tests rewritten from "once frozen, X does not move
  the anchor" to the opposite assertion (a same-plaque re-detection and a
  different plaque's first sighting both now correctly re-ground it), one
  new test confirms an implausible re-detection is still rejected (gated,
  not unconditional), and the continuous-`'updated'`-never-moves-it
  guarantee is unchanged. **Requires the physical exhibit, not verifiable
  in software — this pass's entire purpose:** whether periodic
  re-grounding on discrete re-detections keeps the scene anchored over a
  real walkaround without reintroducing any jitter, since re-detections
  are still individually un-smoothed, single-sample snaps; and whether the
  30mm-proximity copy and the corrected pulse illustration actually make
  first lock easier in real hand use.

  **Progress (2026-09-01, same day, second retest): the §26 fix did NOT
  resolve the anchor bug — process changed from "guess, ship, retest" to
  "instrument, capture once, diagnose from evidence."**

  Reported verbatim after this fix was live: "loses anchor easily, and the
  scale becomes miniature" — the same symptom family as before §26, not a
  new one, and it survived a fix that should have addressed accumulated
  drift. Full reasoning in `docs/research/8th-wall-troubleshooting.md`
  §27; summary: three fixes in a row (§25, §26) each went straight to a
  physical retest without a device log confirming the diagnosis first —
  the exact anti-pattern this file's own §3 ("measuring instead of
  guessing a fourth time") already named. "Miniature" specifically rules
  out `group.scale` (hardcoded to `1` everywhere in this class, always) as
  the mechanism — an apparent shrink has to be a position/perspective
  effect. Two structurally different hypotheses remain equally consistent
  with everything reported so far: (a) a real gate bug in
  `ImageTargetAnchorSource` letting a bad sample through, or (b) 8th
  Wall's `scale:'absolute'` SLAM estimate itself rescaling mid-session
  (the target's own reported size and the camera's position could move by
  the same factor, which no ratio check on our side would catch) — a
  fundamentally different class of fix that no amount of anchor-gate
  tuning would touch.

  **Rather than guess between them a fourth time:** `EightWallSession.ts`
  now retains the camera handle and exposes a diagnostic-only
  `getCameraPosition()`; every FOUND/updated log line that results in an
  applied pose now also logs the camera's live position, the anchor's
  resulting position, and the distance between them — the cheapest signal
  available to tell "the camera itself jumped/rescaled" from "the anchor's
  own transform is what went wrong" from ONE clean capture. Next step is
  exactly one physical session with `?debug=1`, capturing the full
  console text (not a photo — this file's own §6 already paid that cost
  once), read against the new lines, before any further anchor-logic
  change.

  **Unrelated, from direct on-device feedback on the same session:** the
  §26 entry's scale-pulse `'voronoi'` illustration looked bad in real use.
  Reverted to the pre-pulse lateral right/left nudge (same
  asymmetry-bug-fixed mechanic as before, unchanged), but drawing a narrow
  PROFILE (edge-on) phone silhouette for this variant only, instead of the
  front-facing glyph `'orbit'` uses — nudging toward/away from the
  tracking-pattern glyph beside it now reads as approach/retreat rather
  than sliding sideways past it.

  **Verified in software:** `npm run typecheck`/`build`/`test` clean,
  53/53 (`FakeSession` gained a stubbed `getCameraPosition()` returning
  `null`; no test asserts on the new diagnostic log content itself, which
  carries no tracking-decision weight — it's for a human reading a real
  capture). **Deliberately not attempted this pass:** any further change
  to `ImageTargetAnchorSource`'s gate/composition logic — the entire point
  of this pass is to stop changing that code without evidence.

  **Progress (2026-09-02): first real capture via USB-tethered Web
  Inspector — mostly ruled out hypothesis (a), strengthened (b), didn't
  reproduce the actual symptom; added an untethered log-export tool since
  the cable itself was capping the movement needed to reproduce it.**

  Full reasoning in `docs/research/8th-wall-troubleshooting.md` §27's
  follow-up. Short version: the ~7× scale-mismatch readings during cold
  start were confirmed harmless (gate correctly rejecting pre-convergence
  garbage — the physical target really does measure 3×3cm, matching the
  manifest); a 52-second stretch with zero telemetry lines logged is the
  new leading suspect for ordinary SLAM/VIO position drift that
  `trackingStatus` staying `NORMAL` would never flag. This specific
  capture did not reproduce "anchor lost / scale miniature" — movement was
  minimal, capped by the literal USB cable Web Inspector requires, which
  is exactly the kind of real walkaround needed to trigger it.

  **Fix to the tooling, not the anchor:** `public/index.html`'s existing
  `?debug=1` console now also buffers the full session (uncapped past the
  on-screen panel's 200-line window) and adds a "Show log" button — the
  only `pointer-events:auto` element in that overlay — opening a real
  `<textarea>` with everything pre-selected, copyable by touch with no
  cable or Mac required. Solves the on-screen panel's two real limits at
  once (rolling 200-line window; `pointer-events:none` making its own text
  uncopiable) so a genuine untethered walkaround can finally be captured
  in full.

  **Verified in software:** `npm run typecheck`/`build`/`test` clean,
  53/53 (`public/index.html` is a plain inline script, not part of the
  TypeScript/Vite build graph — no new test surface). **Next physical
  step, unblocked now:** one untethered walkaround reproducing the
  symptom, then "Show log" → send the full text.
