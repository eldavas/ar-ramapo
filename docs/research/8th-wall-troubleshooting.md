# 8th Wall integration — troubleshooting log

Audience: same as `mindar-rive-integration-gotchas.md` — anyone touching the
8th Wall tracking path (`src/client/EightWallSession.ts`,
`ImageTargetAnchorSource.ts`, `TapPlacedAnchorSource.ts`,
`PlacementController.ts`) or debugging why markers/cards don't appear on
the `8thwall-test` manifest entry. This is a chronological record of what
was tried, what the evidence actually showed, and what's still open —
read it before re-deriving any of this from scratch.

Companion reading: `AR_SYSTEM.md`'s 8th-wall decision record (on the
`8th-wall` branch, and mirrored into `master` once the governance doc is
updated) covers *why* 8th Wall was adopted (SLAM + drift correction over
MindAR's image-only tracking) and the licensing constraint (the
distributed engine binary is not MIT — Niantic license, attribution
required, see the `#powered-by-8thwall` element in `index.html`).

---

## 1. How the code got here: surgical extraction, not a merge

`8th-wall` started as a collaborator's standalone spike — a single-commit
branch (`8b93bf8`) with **no common git ancestor** with `master`
(`git merge-base` returns nothing). It duplicates the entire app
(`main.ts`, `manifest.ts`, `server/`, `package.json`, `AR_SYSTEM.md` —
27 overlapping file paths) with a from-scratch reimplementation, not a
fork of the same lineage.

A straight `git merge --allow-unrelated-histories -X theirs` was
considered and **rejected**: `-X theirs` resolves every conflicting path
by taking the spike's version, which would have silently dropped the
Apple App Clip association route (`server/createServer.ts`), truncated
`AR_SYSTEM.md`'s entire Phase 0–5 governance history down to the spike's
5.8 KB rewrite, and swapped `package.json`'s dependencies wholesale.

Instead: **surgical extraction**. On `master`, exactly the new
tracking-subsystem files were pulled in with
`git checkout 8th-wall -- <paths>`:

```
src/client/EightWallSession.ts
src/client/GeoFenceService.ts
src/client/ImageTargetAnchorSource.ts
src/client/PlacementController.ts
src/client/TapPlacedAnchorSource.ts
src/client/DevSimSession.ts
src/client/AnchorSource.ts
src/client/FrameBus.ts
src/client/ImageTargetLoader.ts
src/client/RecordGeoMode.ts
src/client/UxOverlay.ts
src/client/types/xr8.ts
src/client/types/engine-binary.d.ts
public/assets/image-targets/bench-plaque/*  (compiled image-target JSON + PNG derivatives)
```

The last three (the two type-declaration files and the compiled
image-target assets) were **missed in the first extraction pass** and
only surfaced as `tsc`/fetch failures once wiring started — worth
checking for again if any other file from the spike turns out to import
something not yet extracted.

`@8thwall/engine-binary` was added to `package.json` by hand (not copied
wholesale from the spike's `package.json`, which also renames the project
and drops `mind-ar` — `master` keeps `mind-ar` since `bench-test` and
`proxy-target` still use it). Running `pnpm install` for this also
incidentally fixed an unrelated, pre-existing bug: `@rive-app/canvas` had
been declared in `package.json` since the Phase 5 Rive work but never
actually installed, breaking `pnpm build` — a second `pnpm install` on an
unrelated dependency add fixed it as a side effect.

Safety net: a `master-before-8thwall` branch was cut before any of this
landed, in case the whole approach needed to be rolled back.

Commit: `b3c568c` — schema + `main.ts` bifurcation + infra wiring, all in
one pass once the extraction was reviewed.

---

## 2. Schema and runtime wiring

### Manifest (`packages/experience-manifest/manifest.ts`)

Additive only — the spike's schema *replaces* `mindTargetUrl` with
`placement`/`geo`/`imageTargetUrl` and makes `placement` **required**.
Doing that on `master` would break `proxy-target`/`bench-test` (neither
declares `placement`). Instead:

- `mindTargetUrl?: string` stays, untouched.
- `placement?: PlacementMode` (`'tap' | 'image'`) is **optional** —
  undefined means the legacy MindAR path (routed off `mindTargetUrl`,
  exactly as before); present means the 8th Wall path.
- `geo?: GeoFenceSpec`, `imageTargetUrl?: string` added alongside.

An entry declares either `mindTargetUrl` (MindAR) or `placement` (8th
Wall) — never both.

### `main.ts` bifurcation

`main()` forks near the top, right after `resolveExperience()`:

```ts
if (experience.placement !== undefined) {
  await runEightWallExperience(experience);
  return;
}
// ---- MindAR path (unchanged since Phase 1) ----
```

`runEightWallExperience()` is a new function, transplanted from the
spike's own `main.ts` almost verbatim. It shares `SceneGraphLoader`,
`MarkerLayer`, `CardPanel`, `ContentProvider`, and `HotspotProjector`
**unmodified** with the MindAR path — only the tracking/origin layer
differs, behind the `AnchorSource` seam (`TapPlacedAnchorSource` for SLAM
tap-placement, `ImageTargetAnchorSource` for the printed-plaque path).
Query-param bypasses for desk testing: `?fakegeo=1` (fake GPS fix),
`?fakear=1` (swap the whole engine for `DevSimSession`'s orbiting-camera
sim), `?recordgeo=1` (GPS-recording site-setup mode, short-circuits
before any experience resolves).

### `SceneGraphLoader.ts` — the scale/rotation bug that was almost shipped

The MindAR glue transform (+90° X rotation, `1 / physicalTargetWidthMeters`
scale) was baked into `SceneGraphLoader` unconditionally. Wiring the 8th
Wall path through it as-is would have **double-transformed** the scene:
8th Wall's `AnchorSource` implementations already deliver a correctly
oriented, real-meters anchor (`scale:'absolute'` means the meter-authored
GLB mounts at scale 1), so applying the MindAR glue on top would have
scaled the mesh by `1/0.05 = 20x` and rotated it twice.

Fixed by adding a third constructor parameter,
`engine: 'mindar' | '8thwall' = 'mindar'` (default preserves every
existing call site verbatim): the glue transform now only applies when
`engine === 'mindar'`; the 8th Wall path mounts at identity
rotation/scale 1.

A `throw` guard was shipped first (loud failure instead of silently
mounting mis-scaled geometry) while the real fix was being designed —
worth knowing if you ever see that guard's error message in old logs.

### Server + HTML infrastructure

- `server/createServer.ts`: `/xr` static route → 
  `node_modules/@8thwall/engine-binary/dist`, same pattern as the
  existing `/rive` route.
- `public/index.html`: `<canvas id="camerafeed">` coexists with the
  MindAR `#ar-container` div — only one is ever driven per page load,
  depending on which experience's `placement` field resolves. Added the
  engine's script tag (`<script src="/xr/xr.js" async
  data-preload-chunks="slam">`) and the `#powered-by-8thwall` attribution
  link the license requires.
- `packages/experience-manifest/manifest.ts`: a test entry,
  `8thwall-test`, reuses `bench-test`'s own `bench-scene.glb`,
  `bench-ui.riv`, and populated Google Sheet — the only variable under
  test is the tracking engine itself.
- `src/client/main.ts`: `ACTIVE_TARGET_ID` temporarily points at
  `'8thwall-test'` for this walkthrough. **Flip it back to `'bench-test'`
  to resume the MindAR/Rive path** — one constant, documented in place.

Commit: `b3c568c`.

---

## 3. The viewport bug — three wrong turns before the data settled it

### Symptom

Camera feed and UI rendered into roughly a third of the screen. Reported
as fixed by rotating the phone, but rotating then introduced a visible
zoom/stretch distortion.

### Attempt 1 (rejected before shipping) — blind CSS rewrite

A plan (relayed from a second AI's suggestion) proposed rewriting
`#ar-container`/`#camerafeed` CSS on the theory that the two elements
were "sibling blocks competing for space in normal document flow." This
was checked against the actual stylesheet before touching anything:
`#camerafeed` was already `position: fixed; inset: 0` — already fully out
of document flow, so that specific mechanism could not be what was
happening. The CSS rewrite was paused in favor of instrumenting and
measuring first.

### Attempt 2 (`243445d`) — manual resize, wrong theory

Added `EightWallSession.installFullWindowResize()`: on
`resize`/`orientationchange`, call `renderer.setSize(innerWidth,
innerHeight, false)` and update `camera.aspect`. Reasoning at the time:
grepping the installed `node_modules/@8thwall/engine-binary/dist/xr.js`
for `XRExtras`/`FullWindowCanvas` found exactly one match —
`PQ(r, "FullWindowCanvas", "XRExtras.FullWindowCanvas", ..., "R13.1")` —
a deprecation-shim pointer, not an implementation; `window.XRExtras` is
never assigned anywhere in the binary. Conclusion: the engine has no
built-in full-window canvas handling (that utility lives in a separate,
hosted-platform-only script this self-hosted setup doesn't load), so the
app needs to do it.

### Attempt 3 (`a768d9a`) — removed the "fix," based on a second grep

On-device testing after Attempt 2 showed sizing "correct enough" at first
load but distorted after rotating — read as two resize handlers fighting.
A broader grep of the same binary (this time for plain `resize` /
`orientationchange` / `devicePixelRatio` / `innerWidth` / `innerHeight`,
not just `XRExtras`) found `addEventListener("resize", ...)` and
`addEventListener("orientationchange", ...)` registered by the engine
itself, plus internal use of `devicePixelRatio`/`innerWidth`/`innerHeight`.
Concluded the engine *does* own resize end-to-end, just not through the
absent `XRExtras` utility, and that `installFullWindowResize()` was a
second handler competing with the engine's own one on the same two
events. **Removed it entirely.**

This conclusion was wrong. The grep only proved those listener
registrations exist *somewhere* in a ~1 MB bundle covering several
unrelated features (face effects, world effects, sky effects) — not that
they're wired to the `Threejs` pipeline module this app actually uses.

### Measuring instead of guessing a fourth time

Rather than propose another CSS or JS change, `logCanvasDiagnostics()`
was added to `EightWallSession.ts`: three reads per session (synchronous
inside `onStart`, on the next `requestAnimationFrame`, and again at
`+1000ms`), logging `canvas.getBoundingClientRect()`, `canvas.width/height`
(drawing buffer), `window.innerWidth/innerHeight`, `devicePixelRatio`,
`renderer.getSize()/getPixelRatio()`, and `camera.aspect`.

**First capture** (after `a768d9a`, no manual resize active):

```
canvas.getBoundingClientRect() = 300.0 x 150.0   (left=0.0, top=0.0)
canvas.width/height (drawing buffer) = 300 x 150
window.innerWidth/innerHeight = 393 x 695
window.devicePixelRatio = 3
renderer.getSize() = 300.0 x 150.0
renderer.getPixelRatio() = 1
camera.aspect = 2.000
```

Unchanged between the `onStart` read and the `+1000ms` read. 300×150 is
the literal, unstyled default size of an HTML `<canvas>` element;
`camera.aspect` is exactly `300/150`. **Proof, not inference: nothing
resizes this pipeline on its own.** Attempt 3's removal was wrong.

An identity check was added next
(`renderer.domElement === this.canvas`) to rule out the engine rendering
into a *different* canvas than `#camerafeed` (which would mean our CSS
could never reach the real one). Came back `true` — same element,
confirmed by object reference, not just by ID string.

That raised a second question: if it's confirmed the same element, why
did the **layout box** (`getBoundingClientRect()`, which has nothing to
do with the drawing-buffer attributes) also read 300×150, when the
external stylesheet rule (`#camerafeed { width: 100vw; height: 100vh;
... }`) targets exactly that element? `getComputedStyle()` +
`canvas.style.cssText` were added to the diagnostic to see what the
browser actually resolved, instead of continuing to infer it — but before
that capture came back, a targeted experiment was proposed: add the
equivalent styling as an **inline** `style` attribute directly on the
canvas in `index.html`, since an inline attribute wins any
stylesheet-cascade ambiguity outright.

### The fix that actually shipped (`0b3c63f`)

Rather than ship the inline-style experiment alone (which would settle
*whether* it worked but not *why* the stylesheet rule wasn't applying),
two independent, redundant fixes were shipped together, with the
diagnostic log running both immediately before and immediately after the
JS-side fix in the same `onStart` callback:

1. **`public/index.html`**: `#camerafeed` also carries
   `style="position: fixed; inset: 0; width: 100vw; height: 100vh;
   display: block;"` inline, alongside the (unchanged) stylesheet rule.
2. **`EightWallSession.ts`**: `installFullWindowResize()` restored, now
   calling `renderer.setSize(width, height, true)` — `updateStyle: true`,
   not Attempt 2's `false` — so it rewrites `canvas.style` directly via
   JS on every call. This is authoritative regardless of which of the two
   theories (CSS cascade issue vs. engine not resizing) was the real
   cause, and regardless of whether the engine's own resize listeners
   (confirmed to exist in the binary, never confirmed to apply to this
   pipeline) ever fire.

**Confirmed fixed, on-device, with numbers:**

```
canvas.getBoundingClientRect() = 393.0 x 695.0   (matches window.innerWidth/innerHeight)
canvas.width/height (drawing buffer) = 1179 x 2085   (= 393x695 * devicePixelRatio 3)
renderer.getPixelRatio() = 3
camera.aspect = 0.565   (correct portrait ratio, was 2.000)
```

**Open question, low priority:** which of the two layers (inline HTML
style vs. JS `setSize(..., true)`) actually did the work, or whether it
needed both, was never isolated — both are cheap and harmless to keep
active together, so there was no reason to spend a test cycle finding
out. If a future change ever needs to remove one of them, re-run
`logCanvasDiagnostics()` with only one active before doing so.

---

## 4. The scale-mismatch warning — a real log, a wrong conclusion drawn from it

`ImageTargetAnchorSource.ts` warns when the engine's own meter-estimate of
the tracked image's size diverges from the manifest's
`physicalTargetWidthMeters` by more than 25%:

```
[ar-ramapo] image-target scale mismatch: engine sees 0.620 m, manifest
declares 0.05 m (ratio 12.40). Absolute scale may not have converged yet,
or physicalTargetWidthMeters is wrong.
```

It was proposed to "fix" this by changing `physicalTargetWidthMeters` in
the manifest from `0.05` to `0.62` (or whatever the engine happened to
report that session) to make the ratio converge to ~1.0, on the theory
that the mismatch was "projecting markers 12x larger than reality."

**This was not implemented, and would not have fixed anything.** The
function that consumes this value is scale-neutral by construction:

```ts
function anchorScaleForEvent(event, physicalTargetWidthMeters): number {
  const ratio = event.scale / physicalTargetWidthMeters;
  if (Math.abs(ratio - 1) > SCALE_MISMATCH_TOLERANCE) {
    console.warn(/* ... */);
  }
  return 1;   // unconditional — the warning never changes this
}
```

`this.group.scale.setScalar(anchorScaleForEvent(...))` always sets scale
to `1`, no matter the ratio. Separately, `SceneGraphLoader`'s 8th-Wall
branch (§2 above) never even reads `physicalTargetWidthMeters` for
scaling. Changing the manifest value would not have touched any actual
render transform, and would have asserted a false physical measurement:
the plaque really is 5 cm — the same physical object `bench-test`'s
MindAR entry already declares at `0.05`, built by the same
`tools/build_plaque.py`.

What the warning actually measures (both across a single session and
across repeated sessions) has been **wildly inconsistent** for the same
static, physical plaque: `12.40` → `1.68` → `7.28` → `8.27` in one
session; `13.67` → `1.64` → `2.79` in another — interleaved with repeated
`FOUND → LOST → re-detection` cycles. A single non-converged reading
right after a fresh detection would be expected (the code's own comment:
absolute scale needs a few seconds of device parallax to converge); a
ratio that gets *worse* over the same session, correlated with frequent
re-detections, points at unstable image-target tracking rather than
scale non-convergence or a wrong manifest value. See §5.

---

## 5. Open issue: markers/cards don't render on top of the content

**Symptom (current, unresolved):** the base 3D content (the domino
meshes from `bench-scene.glb`) mounts and renders correctly, and the
viewport now fills the screen correctly (§3). The Rive marker UI that
should pin on top of each domino flashes briefly on first load, then
disappears, and doesn't reliably reappear — so tapping a domino never
gets the chance to open its card.

**What's already ruled out:**
- Not a `SceneGraphLoader` scale/rotation bug (§2) — the base mesh
  renders in the right place, at the right size.
- Not the viewport bug (§3) — confirmed fixed with matching numbers.
- Not a dead code path — `MarkerLayer`/`CardPanel`/`ContentProvider` are
  the exact same, already-verified-working modules the MindAR path uses;
  nothing 8th-Wall-specific touches them.
- Not (probably) a marker-gating design flaw — `HotspotProjector`'s
  `visible` flag is deliberately tolerant of *brief* image-target loss:
  `ImageTargetAnchorSource.isTracking()` is gated on
  `session.trackingStatus === 'NORMAL'` (SLAM world-tracking quality),
  **not** on the image being currently in view — the whole point of the
  hybrid design (§ its own class doc comment) is that losing sight of the
  plaque must not read as tracking loss.

**Current leading hypothesis:** image-target detection itself is
unstable on the test device/environment — repeated
`FOUND → LOST → re-detection` cycles (§4's log excerpts), each landing on
a different, inconsistent scale estimate. If the underlying SLAM
`trackingStatus` is flickering in step with that (not just the
image-specific found/lost signal), `isTracking()` would flip false
frequently enough that markers rarely stay visible long enough to be
useful, and `MarkerLayer`'s 250 ms hysteresis window wouldn't be long
enough to bridge multi-second tracking gaps (nor should it be — a
multi-second real loss legitimately should hide markers).

**Not yet confirmed:** whether `trackingStatus` (not image found/lost)
is actually what's flapping. `ImageTargetAnchorSource.ts` already logs
every `isTracking()` transition
(`[ImageTargetAnchorSource] isTracking() -> ...`), added specifically to
answer this — but the last on-device capture was transcribed from a
screenshot/photo with enough garbling that those specific lines may have
been lost in the transcription, not necessarily absent from the session.

---

## 6. Next steps

In order — each step is cheap and answers a specific yes/no before moving
to the next one, rather than guessing at a fix.

1. **Get a clean, complete log capture.** Copy the on-screen console's
   text directly (long-press-select on mobile, or mirror the device to a
   desktop browser via remote debugging if available) instead of
   transcribing a photo. Specifically look for `[ImageTargetAnchorSource]
   isTracking() -> ...` lines and note their timestamps relative to the
   `FOUND`/`LOST` lines already visible.

2. **Branch on what that shows:**
   - If `isTracking()` flips `false` every time an image `LOST` fires
     (i.e. it's tracking the image-found signal, not surviving through
     it as designed) → re-read `EightWallSession`'s
     `'reality.trackingstatus'` listener and `ImageTargetAnchorSource
     .isTracking()` together; there may be a mismatch between what the
     engine reports as `trackingStatus` and what the class assumes
     (e.g. the engine might report `LIMITED` rather than `NORMAL` during
     exactly the same window the image is lost, if `disableWorldTracking`
     isn't behaving as documented for this binary version — the same
     class of "the code comment's assumption about engine internals
     doesn't match the shipped binary" mistake as §3 Attempts 2 and 3, so
     verify with a log, not by re-reading the comment).
   - If `isTracking()` stays `true` throughout, but markers still don't
     render → the bug isn't tracking-status at all; it's downstream in
     `HotspotProjector`'s frustum check or `MarkerLayer`'s DOM
     positioning. Add the same kind of throttled per-frame diagnostic
     already used elsewhere in this doc (§3, §4) to
     `HotspotProjector.project()`: log `inFrustum`/`occluded`/
     `screenX,screenY` for one known hotspot, throttled to ~1/second, and
     compare those screen coordinates against the actual viewport size
     confirmed correct in §3.

3. **If tracking instability is confirmed and is the actual bottleneck**,
   this stops being a code problem and starts being a *content/tracking
   quality* problem — options, cheapest first:
   - Recompile the image target from a higher-contrast, more
     feature-rich version of `bench-plaque.png` (§ the existing tracking
     guidance in `docs/asset-authoring-guide.md` §3.1 for MindAR targets
     applies just as much to 8th Wall's feature-point tracking — flat
     color, low contrast, and repeating patterns all track worse
     regardless of engine).
   - Test with better, more even lighting and the phone held at a
     shorter, more perpendicular distance/angle to the plaque — SLAM
     absolute-scale convergence and image-target lock both degrade with
     poor viewing geometry.
   - Only after the above: consider whether `EightWallSession`'s
     `XrController.configure()` flags (`scale`, `disableWorldTracking`)
     need different values for this physical setup — but change one flag
     at a time and re-capture the diagnostic logs after each, the same
     discipline that got the viewport bug fixed correctly on the fourth
     attempt instead of the first.

4. **Do not re-attempt the `physicalTargetWidthMeters` edit** (§4) as a
   troubleshooting step for this issue either — it's been shown
   scale-neutral for the 8th Wall path twice over (the render transform,
   and now confirmed to have no bearing on tracking stability, which is a
   property of the engine's own image recognition, not of any
   manifest-declared number).
