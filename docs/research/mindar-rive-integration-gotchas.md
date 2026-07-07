# MindAR + Three.js r160 + Rive canvas-lite — integration gotchas

Hard-won findings from the original proof-of-concept build session; none of
these are obvious from the libraries' documentation. The Phase 1 refactor
embodied the fixes in `src/client/{ARSessionManager,RiveController,InputBridge}.ts`,
so the code is the working reference — this document preserves the **why**
behind those decisions, for refactors and for the iOS Rive workstream.

> **Since Phase 5** the runtime package is `@rive-app/canvas` (full build —
> the Card artboard renders Rive Text, which the lite build cannot). The
> package layout is identical (`rive.wasm` at the package root, same
> `rive_advanced.mjs` types), so every gotcha below applies unchanged;
> read "canvas-lite" as "canvas".

Treat as a pre-flight checklist whenever setting up or modifying this stack.

## Module loading

- MindAR (`mindar-image-three.prod.js`) is **ESM-only** — cannot load as a
  plain `<script>`. Use `<script type="module">`.
- MindAR imports `three` and `three/addons/` as bare specifiers. Pre-Phase-1
  this required an importmap; since Phase 1 both are version-pinned npm
  packages bundled by Vite, which resolves the specifiers at build time.

## Rive setup

- `@rive-app/canvas-lite` (and the full `@rive-app/canvas` used since
  Phase 5) has **no ESM build** suitable for CDN use. Install locally and
  bundle (Phase 1 does this via npm + Vite).
- The Rive canvas **must be in the DOM** (even off-screen via
  `position:fixed; top:-9999px`) or Rive's visibility check pauses its render
  loop entirely.
- **Never call `resizeDrawingSurfaceToCanvas()`** on an offscreen canvas — it
  reads `clientWidth`/`clientHeight`, which are 0 for detached elements, and
  silently zeroes out the canvas dimensions.
- Set `riveTexture.generateMipmaps = false` and
  `riveTexture.minFilter = THREE.LinearFilter` on the `CanvasTexture` —
  mobile WebGL cannot generate mipmaps for canvas-sourced textures.

## MindAR + Three.js r160 compatibility

- **`targetFound`/`targetLost` events do not fire** on `anchor.group` with
  Three.js r160 (event dispatch bug). Poll `anchor.group.visible` in the
  animation loop instead. (This is why `HotspotProjector` polls visibility
  rather than listening for events.)
- **Touch events on `renderer.domElement` are swallowed** by MindAR's video
  layer. Listen on `document` instead (see `InputBridge`). Screen-space DOM
  overlays above the video layer (e.g. `HotspotOverlay` cards) receive
  pointer events normally and do not need the workaround.

## Rive pointer events (the hard part)

- `riveInstance.pointerDown()` **does not exist** on the high-level `Rive`
  class — calling it silently fails.
- The native `StateMachineInstance` is accessed via:
  `r.animator.stateMachines.find(sm => sm.name === SM_NAME).instance`
- `StateMachineInstance.pointerDown(x, y, pointerId)` takes
  **artboard-space coordinates** (not canvas pixels) and requires
  **3 arguments** (pointerId = `0` for single touch).
- Convert canvas pixels → artboard space using the runtime's own functions:

  ```js
  const fwd = rt.computeAlignment(rt.Fit.contain, rt.Alignment.center, frame, artboard.bounds, 1.0);
  const inv = new rt.Mat2D(); fwd.invert(inv);
  const mapped = rt.mapXY(inv, new rt.Vec2D(canvasX, canvasY));
  stateMachine.pointerDown(mapped.x(), mapped.y(), 0);
  // always delete WASM heap objects: mapped, vec, inv, fwd
  ```

- Canvas → Rive canvas coordinate conversion (with default `flipY=true`
  CanvasTexture): `canvasX = uv.x * size`, `canvasY = (1 - uv.y) * size`.

## Tracking stability

- `filterMinCF: 0.001, filterBeta: 0.01` on `MindARThree` eliminates jitter
  at rest but causes lag on fast movement.
- `filterBeta: 0.5` balances smoothness and responsiveness for normal use.
- Add `missTolerance: 10` to hold tracking through brief interruptions.
- Distance tracking loss is a **target image quality** problem — aim for
  compiler score 70+, high contrast, asymmetric features.
