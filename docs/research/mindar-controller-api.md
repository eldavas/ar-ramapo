# MindAR standalone Controller API (v1.2.5, source-verified)

Findings from reading mind-ar v1.2.5 source (github.com/hiukim/mind-ar-js
tag v1.2.5, `src/image-target/controller.js` and `input-loader.js`) plus the
shipped dist bytes. Researched for the deferred Android WebXR enhancement
track (see [webxr-platform-landscape-2026.md](webxr-platform-landscape-2026.md)):
MindAR's `MindARThree` wrapper owns its own getUserMedia pipeline, but the
underlying `Controller` can be driven with arbitrary frames (WebXR raw camera
access, video files, test photos). None of this is documented upstream.

These are internal APIs — **pin version 1.2.5** when relying on them.

- `new Controller({inputWidth, inputHeight, onUpdate, maxTrack,
  warmupTolerance, missTolerance, filterMinCF, filterBeta})` — **no
  video/DOM dependency**. ⚠️ Default `filterBeta = 1000` (wildly different
  from the MindARThree-tuned 0.01) — always pass filter values explicitly.
- **Intrinsics injection:** `controller.projectionTransform` is a 3×3 K
  matrix (default: fovy 45°, principal point at center). It is consumed only
  inside `addImageTargetsFromBuffer` (Tracker ctor + worker setup
  postMessage). Mutating it after `new Controller()` and **before**
  `await controller.addImageTargets(url)` cleanly injects real intrinsics.
  fx≠fy is fine (the pose estimator reads `[0][0]` and `[1][1]`
  independently).
- `addImageTargets()` returns `{dimensions}`;
  `dimensions[0] = [markerWidthPx, markerHeightPx]`.
- `controller.processVideo(input)` runs a self-driving loop that re-reads
  `input` via `context.drawImage(input, 0, 0, input.width, input.height)`
  **every iteration** — a persistent `<canvas>` you keep redrawing is the
  cleanest input (it reads `.width`/`.height`, not `videoWidth`). Call
  `controller.dummyRun(input)` once first (GPU kernel warm-up).
- `controller.stopProcessVideo()` breaks the loop; `processVideo` can be
  re-called afterward (rebuilds trackingStates). `dispose()` kills the
  worker — only at teardown.
- `onUpdate({type:'updateMatrix', targetIndex, worldMatrix})`: `worldMatrix`
  is a 16-float column-major GL matrix, marker→camera, **already**
  handedness-corrected (`_glModelViewMatrix`), One-Euro-filtered, and
  warmup/miss gated; `null` = lost. Units = target-image **pixels**, origin
  marker bottom-left, X right, Y up, Z toward camera — same OpenGL
  convention as WebXR view space (no fix-ups needed). Physical scale must be
  supplied externally (marker width in meters — this is what
  `physicalTargetWidthMeters` in the experience manifest carries).
- **The dist build is bundler-free:** `mindar-image.prod.js` is a small ESM
  re-export; its ~2.2 MB chunk bundles tfjs, does **not** import `three`,
  and creates its worker from an inline Blob/data-URI (verified in dist
  bytes). Coexists with the three-flavour build (shared chunk). This is also
  why `tools/compile_mind_target.mjs` can drive the `Compiler` export from a
  bare localhost page with no bundling step.
- Deriving intrinsics from a WebXR view: `fx = camW/2·p[0]`,
  `fy = camH/2·p[5]`, `u0 = (1−p[8])·camW/2`, `v0 = (1−p[9])·camH/2`, then
  `cy = camH − v0` (GL bottom-left → image top-left), where
  `p = view.projectionMatrix` and cam size comes from `view.camera`.
- `getRotatedZ90Matrix` exists in the codebase if a portrait 90°-rotation
  case ever appears.
