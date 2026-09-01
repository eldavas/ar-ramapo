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

---

## 7. Instrumentation pass (2026-07-09) — telemetry for §6 step 1, no fix applied

Desk research (official docs + code trace, this session) sharpened §5's
hypothesis into something falsifiable: `ImageTargetAnchorSource
.isTracking()` gates markers on `trackingStatus === 'NORMAL'`, and the
official docs establish that under `scale:'absolute'` the engine sits in
`LIMITED` until absolute scale converges (`configure()` reference: absolute
positions honored "once scale has been estimated"; the official Coaching
Overlay exists precisely to walk users out of that state; §4's own logs
show the scale estimate never converging). The base mesh renders ungated
(pose snaps straight from image events), which is why dominos stay correct
while markers vanish — the two paths diverge exactly at `isTracking()`.

**Deliberately NOT fixed yet.** Two readings remain possible and the
decision needs on-device telemetry, not inference: (a) the gate is too
strict — the plaque being actively tracked (`imageVisible=true`) is a
valid pose regardless of SLAM status, so markers should show; or (b)
`LIMITED` really does mean the world frame is unreliable enough that
showing markers would misplace them. What discriminates: whether marker
positions during `imageVisible && LIMITED` windows are correct (a) or
visibly wrong (b), and which `reason` the engine reports.

Telemetry added (all transition-triggered, never per-frame; all carry a
session-relative `[+N.Ns]` stamp from `src/client/TraceLog.ts` in the
message text, so a capture survives losing the debug console's own
wall-clock prefix):

- `[TrackingStatus]` — `EightWallSession` no longer discards `reason`;
  logs every `(status, reason)` change (the same pair the binary's
  dispatcher dedupes on). The binary's reason enum is richer than the
  documented two: `INITIALIZING` / `RELOCALIZING` / `TOO_MUCH_MOTION` /
  `NOT_ENOUGH_TEXTURE` — the discriminator between "scale never
  converged", "bad environment texture", and "relocalization churn".
- `[ImageTarget]` — `FOUND`/`LOST` with scale, full pose, and the
  `acquired` transition; `updated` throttled to 1/s; the scale-mismatch
  warning now throttled to 1/s too (it fired per frame while the target
  was in view — console flood).
- `[ImageTargetAnchorSource] isTracking()` — logs when ANY gate input
  changes (`acquired`, `imageVisible`, `trackingStatus`, `reason`,
  result), not just the boolean result: the (a)/(b) decision hinges on
  seeing `imageVisible=true` coincide with `LIMITED`.
- `[HotspotProjector]` — per-hotspot VISIBLE ↔ HIDDEN transitions with
  the failing guard named (`tracking=false` / `frustum=false`;
  occlusion is part of the state string since it dims rather than
  hides). `ProjectedHotspot` gained a `hiddenReason` field so
  MarkerLayer can name the cause without re-deriving it.
- `[MarkerLayer]` — `display:block`/`display:none` transitions, the
  hide log naming the hysteresis expiry and the projector's reason.
- `[Tap]` — `pointerdown`/`pointerup` on a marker (MarkerLayer), then
  `onMarkerTap` → `getContent()` resolved/failed → `card.open()` (the
  8th Wall wiring in main.ts), one line per hop.

**Expected timeline if the hypothesis holds** (capture with `?debug=1`,
copy text per §6 step 1 — don't transcribe a photo):

```
[TrackingStatus] NORMAL … → [ImageTarget] FOUND (acquired: false -> true)
→ isTracking() => true → [HotspotProjector] VISIBLE → [MarkerLayer] display:block
→ [TrackingStatus] LIMITED reason=… → isTracking() => false (imageVisible may still be true)
→ [HotspotProjector] HIDDEN (tracking=false) → [MarkerLayer] display:none
→ [ImageTarget] updated keeps arriving while dominos keep rendering
```

If instead the projector reports `HIDDEN (frustum=false)`, or markers
never log `display:block` at all while `isTracking() => true`, the bug is
downstream and §6 step 2's second branch applies. While capturing, also
note on screen whether dominos are correctly placed during
`imageVisible=true && LIMITED` windows — that's the (a)/(b) discriminator
above.

---

## 8. First on-device capture (2026-07-09): hypothesis refuted in its
specific form — `trackingStatus` was never parsing at all

The §7 telemetry produced its answer on the first capture, and it was
neither §7's (a) nor (b): every `isTracking()` snapshot, across the whole
session, read

```
acquired=true imageVisible=true trackingStatus=undefined reason=UNSPECIFIED
=> false (markers hidden while false)
```

`trackingStatus=undefined` — not `LIMITED`, not `NORMAL`, not even the
`'UNSPECIFIED'` the field initializes to. That last detail is the proof:
the only way the getter returns `undefined` instead of its initial
`'UNSPECIFIED'` is the `reality.trackingstatus` listener having fired and
assigned `event.status` where `event.status` didn't exist. The listener
read the payload off the top-level event object; the binary wraps every
listener payload as `{name, detail}` — verified by construction in the
installed `dist/xr.js`, whose internal dispatcher literally pushes
`{name: `${module}.${event}`, detail: payload}` into the listener queue.
Image events always parsed fine for one reason only: `emitImage()` had a
defensive `.detail ?? raw` unwrap from day one (its own comment left the
shape as an open question — now settled: **nested**). The trackingstatus
listener lacked the unwrap, so:

- `this.status` became `undefined` on the first dispatch and the
  `(status, reason)` dedupe then swallowed every subsequent event.
- `isTracking()`'s `status === 'NORMAL'` could never be true, in any
  session, under any tracking quality. Markers were gated off
  unconditionally — a pure code bug, not a tracking-quality problem.
- The §5 "leading hypothesis" (absolute-scale non-convergence keeping
  status in LIMITED) is refuted *as the cause of this symptom*: the gate
  never got as far as reading a real status.

Two supporting observations from the same capture:

- **Absolute scale now converges.** Engine estimates ran 0.046–0.063 m
  against the declared 0.05 m (ratio 0.9–1.26) — no scale-mismatch
  warnings fired at all, in stark contrast to §4's 12.4× readings.
  Re-detection poses were consistent to the centimeter across
  FOUND/LOST cycles. Tracking quality looks healthy.
- **FOUND/LOST churn continues** (~every 2–5 s with the plaque in view),
  each firing `onOriginChanged`. Harmless for the anchor (poses agree),
  but worth watching: every churn resets MarkerLayer's One Euro filters
  once markers actually render.

**Loose end, explicitly unresolved:** the originally reported "markers
flash briefly on first detection" is *incompatible* with a
permanently-false gate — `MarkerLayer` creates markers at `display:none`
and only `projection.visible === true` can ever show one. Whatever
flashed in the pre-instrumentation sessions (UxOverlay hint, the Card
during an earlier build, something else), it wasn't the marker pipeline
under this gate. Don't spend time on it unless it reappears in an
instrumented capture, where the logs will now name it.

**Fix applied (parse only — the §7 (a)/(b) gate decision stays open):**
the trackingstatus listener now applies the same `.detail ?? raw` unwrap
as `emitImage()`, types the result as `Partial<...>`, and fail-loudly
warns (with the raw JSON) if `status` is still undefined after the
unwrap, instead of poisoning the cached status. `isTracking()` and the
`NORMAL` gate are untouched. **Next capture decides the gate:** with
status parsing fixed, either status reads `NORMAL` with the plaque in
view and markers simply work (gate was fine all along, §7 moot), or it
reads `LIMITED reason=…` and §7's (a)/(b) discriminator — marker/domino
placement correctness during `imageVisible && LIMITED` windows — finally
gets its evidence.

---

## 9. Second instrumented capture (2026-07-09): markers fixed and
verified; the open issue moves to the tap → Card link

The §8 parse fix resolved the original symptom outright, with the
telemetry to prove each link:

- `trackingStatus=NORMAL reason=UNSPECIFIED` in every snapshot — the §7
  (a)/(b) gate question is **moot**; the `NORMAL` gate stays as designed.
- `isTracking() => true` held through repeated `LOST` events
  (`imageVisible=false`, `acquired=true`, still `=> true`) — the
  scan-once-walk-around hybrid persistence works exactly as designed.
- Full visibility chain observed live: `[HotspotProjector] VISIBLE` →
  `[MarkerLayer] display:block`, with `HIDDEN (frustum=false)` flapping
  only at the literal screen edges (x≈-3 and x≈394-396 on a 393-wide
  viewport) — normal framing behavior, absorbed by the hysteresis.
- Absolute scale converged (engine estimates 0.056–0.070 m vs. 0.05
  declared; one transient 0.345 m reading immediately after a
  re-detection, corrected within a second).
- **A tap on a marker fired its Rive selection visual** (color change) —
  pointer forwarding and the DOM tap path work.

**New open issue, one link further down the chain:** the tapped marker's
Card never appeared, and — the discriminating detail — after that first
tap, taps on that marker AND every other marker produced nothing at all.
The capture contained no `[Tap]`/content lines for the window in
question (garbled/truncated), so two scenarios remain live:

- **S1 (leading):** `getContent()` resolved and `card.open()` ran clean —
  `open_=true`, `pointerEvents=auto`, `isOpen=true` into the state
  machine — but the Card artboard drew nothing visible. The card's
  container is a ~350×480 bottom sheet (y≈215–695 on this viewport)
  whose listeners `stopPropagation()` every pointer event while open:
  an invisibly-open card converts most of the lower screen into a dead
  zone that neither the markers nor the tap-outside-close handler can
  ever see. That mechanism reproduces "first tap works, every
  subsequent tap dead" exactly. Note the Card has never been verified
  rendering on ANY engine — the Phase 5 MindAR verification was
  interrupted mid-way by the 8th Wall pivot (see `ACTIVE_TARGET_ID`'s
  own comment), so an authoring/artboard issue is fully plausible.
- **S2:** the Google Sheet fetch hung forever (the one silent path in
  `GoogleSheetContentProvider` — every failure throws loudly, but a
  never-settling fetch has no timeout). Weaker fit: the card never
  opens, `pointerEvents` stays `none`, so markers would have remained
  tappable.

Telemetry added to discriminate (same transition-only discipline as §7):
`[Card] open("title")` at entry (before the fail-loud setText/setBool
calls, so an authoring throw is bracketed), `[Card] close()`,
`[Card] closeRequested Rive event`, `[Card] pointerdown/up … swallowed
by the open card container` (only observable while `pointerEvents:auto`
— a capture full of these with nothing visible on screen is S1's
smoking gun), and `[Tap] pointerup outside markers/card — closing card`
in main.ts.

**Fastest next test — no field session needed:** `?fakear=1&debug=1` on
a desktop browser (or the phone at a desk) runs the identical
tap→getContent→card.open chain against `DevSimSession`'s
always-tracking anchor, with full devtools. If the Card fails to render
there too, this is a Card-artboard/CardPanel issue debuggable entirely
at a desk; if it renders, the difference is environmental (network to
the sheet, on-device Rive text rendering) and the new `[Card]`/`[Tap]`
lines in a field capture will place the break exactly.

**CORRECTION (learned the hard way):** `?fakear=1` alone is NOT enough
for a desk test — the geofence arrival gate runs before the engine
branch whenever the experience declares `geo`, and `8thwall-test`
carries placeholder coordinates (Ramapo campus). On a desk anywhere
else, real geolocation resolves to "Walk to the site to start" and the
session never proceeds. The full desk-test parameter set is
**`?fakear=1&fakegeo=1&debug=1`**.

---

## 10. Third instrumented capture (2026-07-09): S1 confirmed — the Card
opens invisibly and swallows every tap; plus a new, distinct viewport
shrink (NOT §3 again)

### S1 confirmed by telemetry

The capture contains the tail of the `[Card] open(…)` line (`…tercepts
every tap in its box)`) followed by ~22 seconds of

```
[Card] pointerdown at (306,587) — swallowed by the open card container, …
[Card] pointerup   at (306,587) — …
[Card] pointerdown at (126,277) — …
```

So: `getContent()` resolved, `card.open()` ran to completion (the
fail-loud setText/setBool accessors did not throw — a throw after
`pointerEvents=auto` would have hit main.ts's catch and closed the
card, and the swallow window would not have lasted 22 s), `isOpen=true`
reached the state machine — **and the artboard drew nothing visible
while its container intercepted every tap in the bottom-sheet box.**
§9's S2 (hung sheet fetch) is eliminated. The bug is now precisely:
*the Card artboard renders invisibly under `isOpen=true` on this
device*. Whether that's artboard authoring (Enter animation not wired
to `isOpen` the way CardPanel assumes) or a runtime rendering issue is
exactly what the `?fakear=1&fakegeo=1&debug=1` desk test discriminates
— the Card has still never been observed rendering on any engine (§9).
`open()` now also logs the artboard bounds and container CSS box, so a
0×0 artboard or collapsed container would name itself.

### The viewport shrink — different mechanism than §3, same visual smell

Reported: canvas leaves dead space right and bottom, "moderate" version
of the §3 symptom. The diagnostics say it is NOT §3 (engine/CSS sizing
all worked):

```
window.innerWidth/innerHeight = 351 x 621     (was 393 x 695)
renderer.getSize() = 351.0 x 621.0            (matches innerWidth exactly)
canvas drawing buffer = 1053 x 1863           (= 351x621 × dpr 3)
camera.aspect = 0.565                         (correct for 351x621)
```

Every layer agrees with `innerWidth/innerHeight`; what shrank is the
window itself: 393→351 and 695→621 are the SAME uniform factor
(÷1.12) on both axes — the signature of page zoom. On iOS,
`innerWidth` tracks the *visual* viewport and `user-scalable=no` has
been ignored since iOS 10, so an accidental pinch zooms the page and
the resize handler then faithfully sizes the canvas to the shrunken
viewport. The hole that allowed it: `touch-action: none` was set on
`html, body` — but `touch-action` does not inherit, and `#camerafeed`
(most of the screen) never declared it, so pinches starting on the
camera canvas reached the browser. Fixes/diagnostics shipped:

- `#camerafeed` now carries `touch-action: none` in BOTH the stylesheet
  rule and the inline style (the §3 keep-in-sync rule).
- `logCanvasDiagnostics()` now logs `window.visualViewport`
  width/height/scale — `scale != 1` proves page zoom directly if this
  ever recurs (a reload also resets pinch zoom, worth knowing
  mid-session).

### Tracking note (watch, no action)

One of the sessions in this capture converged its re-detections onto a
bad pose (`scale=0.106` m, ratio 2.12, rotation far from the usual
values) and stayed there for ~a minute. Same §5 churn family — if
misplaced content is ever observed on screen, correlate with these
lines before suspecting the render pipeline.

**No longer watch-only (2026-08-14):** this exact phenomenon became a
real, user-facing bug once a production experience depended on anchor
stability — see §13.

---

## 11. Root cause found (2026-07-10): the Card artboard's `Closed` state
hides the card and `OpenIdle` never keys it back on — an asset
authoring bug, isolated without a device or the Rive editor

The corrected desk test (`?fakear=1&fakegeo=1&debug=1`) reproduced the
invisible card on desktop, which made it fully harness-testable. A new
tool, **`tools/inspect_rive_ui.mjs`** (same transient-localhost +
headless-Chrome pattern as `compile_mind_target.mjs`), loads
`bench-ui.riv` with the app's own `@rive-app/canvas` runtime, drives the
Card exactly as `CardPanel` does, and counts non-transparent pixels.
The numbers are unambiguous:

```
CardMachine state changes on isOpen=true:  Closed → OpenIdle   (transition wiring CORRECT)
Card pixels via state machine:             0 at +250/500/1000/2000 ms  (invisible)
Card 'OpenIdle' animation played directly: 546,856 pixels      (content EXISTS and renders)
Marker control via MarkerMachine:          ~10,100 pixels      (healthy)
```

Mechanism (a classic Rive authoring trap): properties not keyed by the
current state persist from the previous state. The `Closed` animation
keys the card's visibility off (per the guide's own contract: "at rest
it must show nothing — 'closed' is an artboard state"); `OpenIdle` keys
only its idle motion and **never keys the visibility back on**. Played
directly, `OpenIdle` starts from design-time defaults (visible) — hence
546k pixels; reached through the state machine from `Closed`, it
inherits hidden and draws nothing, forever. Every runtime observation
across §9–§10 (open() completes, no throws, state machine advances,
container swallows taps, zero visuals) is this one asset defect.

Contract drift found by the same probe, to fix in the same authoring
pass:

- The contracted **`Enter` / `Exit` animations do not exist** in the
  file at all — the Card's animations are `Closed`, `RefreshPulse`,
  `OpenIdle` (asset-authoring-guide §2.4 requires Enter/Exit on the
  false↔true transitions, both interruptible).
- The Card artboard is **350×391**, not the contracted 350×480
  (`CardPanel.ts`'s `CARD_ARTBOARD_WIDTH/HEIGHT` and the container's
  CSS aspect-ratio assume 480 — today this only letterboxes via
  Fit.contain, but the drift should be resolved on whichever side is
  intended).
- There is also a third artboard, `Viewport` (state machine
  `"State Machine 1"`, input `isOpened`), not part of any documented
  contract — presumably a leftover or a nested component; renders ~1.2k
  px in isolation. Decide its fate while in the editor.

**The fix is an asset edit, not code** (Golden Rule: Rive owns
appearance): in the Rive editor, on the `Card` artboard — author
`Enter`/`Exit` per the §2.4 contract (or minimally: key the hidden
properties back to visible at the start of the open-side state), wire
`Closed →(isOpen)→ Enter → OpenIdle` and back through `Exit`, re-export
to `public/assets/bench-ui.riv`, and bump the manifest version on every
entry that serves it (`bench-test`, `8thwall-test`) per §E. Then re-run
`node tools/inspect_rive_ui.mjs` — the healthy signature is a non-zero
state-machine pixel count — before spending any on-device session.

## 12. The Card width bug (2026-07-14): Hug-height artboard × Fit.contain

### Symptom

On-device, the open Card renders visibly narrower than the screen —
camera feed showing through symmetric side margins (~10% of the viewport
per side on the captured example) — while the card's container div
provably spans the full `100vw`.

### Wrong turn first, recorded on purpose

A first investigation pass measured the DOM (container rect == viewport
at 320/393/430px), the computed styles (no max-width, no ancestor
transform), and the rendered raster (solid pixels edge-to-edge at
devicePixelRatio 1 AND 3) and concluded the shipped code could not
produce margins — verdict "stale bundle on the device". That verdict was
wrong, and the miss is instructive: **every one of those measurements ran
with the placeholder text runs** (`Title` / `Subtitle` / `Paragraph`).
The bug only exists with real content. Any future Card rendering probe
must load sheet-length text before measuring.

### The telemetry that broke the case

The `[Card] open(...)` log line prints the artboard bounds. Across three
different hotspots' real content it read **350×408, 350×604, 350×669** —
the artboard's HEIGHT tracks the content. Two facts combine from there:

1. **The `Card` artboard's Auto Layout height is authored as Hug.** Its
   bounds re-resolve to the content height on the frame after any text
   run changes (grows past 480 for real paragraphs, and also *shrinks* —
   the placeholder content resolves to ~408). The artboard's design
   width/height properties stay 350×480; only `bounds` moves.
2. **`@rive-app/canvas` renders with `Fit.Contain` + `Alignment.Center`
   by default** (`Layout` constructor defaults; `RiveController` passes
   no layout). Contain against the app's fixed-aspect canvas
   (350×480 × backingScale) letterboxes any artboard whose aspect no
   longer matches.

For bounds `350×H` with `H > 480`, contain becomes height-limited and
the drawn artboard occupies a fixed **fraction `480/H` of the canvas
width**, centered: H=604 → 79.5% wide → ~10.3% margins per side (the
captured screenshot); H=669 → ~14% per side; H=408 → full width but a
vertical dead band instead (the fixed 350/480 CSS aspect is wrong in
both directions once the artboard hugs).

Reproduced headlessly (Card + `CardMachine`, 700×960 canvas, setting
only the `body` text run):

| body content | artboard bounds | solid raster columns (of 700) |
|---|---|---|
| `Paragraph` (placeholder) | 350×407.6 | 0–699 (full width) |
| sheet-length paragraph | 350×603.6 | **72–627** (≈10.3%/side letterbox) |
| placeholder again | 350×407.6 | 0–699 (reversible) |

Cross-validation: manually overriding the container in devtools to
`width:125vw; left:-49px` made the card fill the screen exactly —
because 125% ≈ 604/480, the geometric inverse of the letterbox, and
−49px re-centers the 25vw overflow. (Constant-based, so it broke the
other content lengths; kept here as confirmation, not as a fix.)

Asset-structure notes from a direct object-level inspection of the
binary (`tools/dump_riv_objects.py`), for whoever edits this file next:
the white background is painted by the **unnamed root LayoutComponent's
own background fill** (white, corner radius 24), not by a Shape, and
spans the full 0–350 in artboard space (its serialized 347×520 / y=999
design values are overridden by the layout at runtime). No
ClippingShape objects exist in the artboard. `Card_Body` and
`Card_Close_Button_Container` no longer exist as names — the redesign
left the body container unnamed and the tap listener is
`Card_Close_Button`.

### The fix (code-side, keeping Hug)

Hug is desirable — the sheet sizes itself to its content — so the stale
half of the contract was `CardPanel`'s fixed 350/480 assumption, not the
asset. `CardPanel.syncAspectToArtboard()` now re-derives the container's
CSS `aspect-ratio` and the canvas backing store from the live artboard
bounds, on the runtime's `Advance` event (layout results are never fresh
synchronously after `setTextRunValue`). Canvas aspect == artboard aspect
means `Fit.contain` fills the width by construction, for every content
length. Backing resize goes through Rive's own
`resizeDrawingSurfaceToCanvas(pixelRatio)` so renderer alignment state
stays coherent; input mapping (`mapCanvasPointToArtboard`) needs no
change — it mirrors the same contain math with live canvas dimensions.

Verified end-to-end (`tools/run_width_probe.mjs`, which now also taps a
real marker so the card opens with real sheet content): with the same
long content that letterboxed to columns 72–627 before, container aspect
re-syncs to `350/603.611`, backing to 786×1355 (aspect-matched), and the
solid raster spans 0–785 of 786 — full width at all three test viewports.
Reproduce the underlying asset behavior in isolation with
`tools/inspect_card_growth.mjs`.

### Follow-up, same day: 90%-viewport height cap (clip, not shrink)

With Hug + long content the card is simply *taller* (677px on a 393×852
viewport for H=604) — mostly the design working as intended, but on a
small screen the bottom-anchored container can out-grow the viewport
and push its TOP edge off screen, taking the grabber, title, and close
button with it (measured: H=669 on a 320×568 viewport → 611px natural
height, top at −43px).

`CardPanel` now caps the container at
`CARD_MAX_VIEWPORT_HEIGHT_FRACTION` (0.9) of `window.innerHeight`,
resolved in the same `syncAspectToArtboard()` pass. The critical detail
is WHAT gets capped: **the container only**. The canvas keeps its
natural aspect-true height inside it and the container's
`overflow:hidden` clips the sheet's bottom — shrinking the canvas box
to the capped height instead would recreate this very section's
letterbox (canvas aspect ≠ artboard aspect is the whole bug). Because
the sync pass also tracks viewport dimensions, rotation and iOS
URL-bar collapse re-resolve the cap automatically.

Input-mapping consequence, fixed in the same pass: pointer→artboard
forwarding and the close button's no-drag zone previously measured the
*container* rect, which was safe only while canvas == container. Under
the cap the canvas is taller, so both now measure the **canvas** rect —
the box the renderer actually maps artboard space onto. Drag
close-threshold (25%) stays container-based on purpose: it is a gesture
against the visible sheet, not against the (partly clipped) artwork.

Verified with the same end-to-end probe: on a 320×568 viewport with
real sheet content, container height pins to 511.2px (= 0.9 × 568),
the canvas keeps 551.9px, backing stays aspect-matched (640×1103), and
the raster remains solid edge-to-edge; the two larger viewports stay in
the uncapped regime, byte-identical to the width fix's behavior.
Content clipped by the cap is simply not reachable today — if that ever
matters in the field, the next step is an authored internal
scroll/max-height decision in the asset, not more app-side geometry.

**Update (2026-08-14): it did matter in the field — first physical test,
real building copy exceeded the cap with no way to read the rest.**
Re-checked "an authored internal scroll/max-height decision in the asset"
directly against the shipped `bench-ui.riv` (`tools/dump_riv_objects.py`):
no `ClippingShape`/scroll component exists on the Card artboard — still a
single monolithic raster, header and body baked into one canvas. Rather
than author that structure (no Rive-editor access in this pass, and
splitting header/body into separately-clipped regions is new UI
architecture), the fix landed code-side without touching the asset:
`CardPanel.ts`'s container now natively scrolls the whole sheet
(`overflow-y:auto`, was `hidden`), with the existing drag-to-dismiss
gesture only taking over when already scrolled to the top and pulling
further down. Full detail, the runtime verification numbers, and why this
doesn't conflict with "no more app-side geometry": AR_SYSTEM.md §G Phase
3, "Progress (2026-08-14, first real physical-device test)", bug 2.

---

## 13. Terrain rendered black + world anchor drift/scale jumps (2026-08-14,
first real physical-device test) — two more bugs, both root-caused and
fixed; full detail lives in AR_SYSTEM.md, cross-referenced here so anyone
starting from this file's chronology doesn't miss them.

**Terrain black:** not a material authoring defect (`mat_site_terrain`'s
`baseColorFactor` is an ordinary opaque tan, verified directly against the
shipped GLB) — every mesh in `site-scene.glb` uses a lit PBR material and
neither tracking engine's runtime scene ever adds a `THREE.Light`
(`enableLighting: false` for 8th Wall, no light in MindAR's
`ARSessionManager` either). Only the 12 hotspot-hosting buildings were
ever visible, via `SceneGraphLoader`'s existing unlit debug tint — masked
in all prior desk verification because `DevSimSession.ts`'s `?fakear=1`
bypass adds real lights the device path never gets. Fixed in
`SceneGraphLoader.ts`: every mesh becomes an unlit `MeshBasicMaterial`
preserving its authored color; `site_terrain` specifically goes fully
transparent instead (the physical model already has a real terrain
surface visible through the camera) while staying in `occluders` for
`HotspotProjector`'s raycast, which ignores material opacity entirely.

**World anchor drift/scale jumps (priority bug):** `ImageTargetAnchorSource
.applyPose()` has always applied every raw tracked pose — `found` and
every per-frame `updated` — directly to the world anchor with zero
plausibility check. §10 above already logged the exact underlying engine
phenomenon in isolation ("converged its re-detections onto a bad pose...
and stayed there for ~a minute") — filed as watch-only because nothing
depended on anchor stability yet. It does now. The pose-composition math
itself (verified by `ImageTargetAnchorSource.test.ts`) was never the
defect. Fixed by promoting the already-computed scale-mismatch ratio
(§4 above) from a log-only warning to an actual accept/reject gate: once
a good anchor exists, a sample whose scale ratio falls outside
`SCALE_MISMATCH_TOLERANCE` is rejected outright, holding the last
known-good transform instead of jumping to an implausible one. The very
first acquisition still always applies (no fallback to fall back to).

Both fixes, verification numbers, and the still-open hardware-only gaps
(`TARGET_FRAME_TO_WORLD_FIX` and the per-plaque mount rotation remain
"best inference, validate on device" — unchanged by this pass): AR_SYSTEM.md
§G Phase 3, "Progress (2026-08-14, first real physical-device test)".

---

## 14. TARGET_FRAME_TO_WORLD_FIX was actually wrong (2026-08-14, second
same-day physical test) — the scene rendered visibly tilted, root-caused
against external evidence rather than guessed

The §13 update above corrected two rendering bugs but didn't touch the
tracking rotation math. A second same-day physical pass showed the whole
digital scene rendering tilted relative to the tracked plaque — markers
included, since `MarkerLayer` has no rotation logic of its own at all
(pure 2D `left`/`top` positioning from `HotspotProjector`'s projection);
the tilt is entirely downstream of `ImageTargetAnchorSource.group`'s own
quaternion.

**Ruled out first, not assumed:** `git show` of the previous fix commit
confirmed `applyPose()`'s rotation composition was untouched by it — the
defect predates that pass, in `TARGET_FRAME_TO_WORLD_FIX`'s VALUE, not
the composition formula (independently verified self-consistent by
`ImageTargetAnchorSource.test.ts`, unchanged). The constant had been
`Rx(+90°)` since introduction and had never actually been exercised
against a real 8th Wall image-target detection — its own doc comment
already named "identity" and "±90°X" as open candidates for this exact
failure mode.

**Evidence, not a guess between the two named candidates:** two
independent, external, real-world 8th Wall + three.js integrations were
checked (WebSearch/WebFetch, not internal reasoning):

- A published React Three Fiber walkthrough (dev.to/activeguild,
  "Bridging 8th Wall AR and React Three Fiber: How Pose Data Flows into
  Three.js") applies the event's rotation directly:
  `groupRef.current.quaternion.set(pose.rotation.x, pose.rotation.y,
  pose.rotation.z, pose.rotation.w)` — no extra glue rotation.
- 8th Wall's own community forum
  (forum.8thwall.com/t/issues-with-rotation-position-scaling-when-image-
  tracking/1891), an official response to exactly this class of report,
  recommends `object3D.quaternion.copy()` from the event's `detail.rotation`
  "without extra correction rotation" for 3D content that should stand
  upright aligned with the tracked image (as opposed to a flat
  texture-replacement overlay laid directly onto the image plane) — this
  project's exact case, Y-up glTF content.

Both sources independently converge on "apply the event's rotation
directly, no fixed glue quaternion" for this content shape. Fix:
`TARGET_FRAME_TO_WORLD_FIX` changed from `Rx(+90°)` to `identity()`.
`rotationYawDeg` (the separate, orthogonal per-plaque world-Y-axis
correction — §E "Multi-target plaques") is unaffected either way.

**Not resolved by this pass, explicitly separated:** whether identity()
is exactly correct for THIS project's real printed plaques and camera —
the two sources are strong, independent, external evidence, not an
on-device confirmation of this specific asset; and whether the 4 real
plaques' physical mount (once fabricated) matches the assumed
perpendicular-to-edge, artwork-upright vertical mount
docs/asset-authoring-guide.md §3.5 already flags as unverified.

## 15. Ledge/plaque placeholders still visible after the terrain fix, and
the Card scroll fix from §13 was itself a regression — both fixed the
same day

**Ledge/plaques:** the terrain-specific fix in §13 didn't generalize to
the mounting ledge or the 4 plaque placeholder volumes, which stayed
visible (a wide diagonal "frame" in the physical photo evidence).
`tools/build_site_buildings.py` already tags this exact geometry with
`extras: {"placeholder": true}` (confirmed against the shipped GLB, not
assumed from the script alone) — the same mechanism
`cad-source/handoff/README.md` already documented. `SceneGraphLoader.ts`
now applies the same invisible-but-still-an-occluder treatment to any
mesh carrying that flag, generalizing the terrain fix instead of adding
4 more hardcoded mesh names.

**Card scroll regression:** §13's fix made the ENTIRE Card container
scroll, which drags the grabber and close button off-screen along with
the body — not the intended behavior, and a real regression in that
pass's own fix (user-caught, not a pre-existing bug). Corrected to a
fixed-header/scrollable-content DOM split; a real pointer-forwarding bug
was caught by this pass's own headless verification before shipping
(header taps were scaled by the wrong canvas's backing size and missed
the close button). Full detail, the header-boundary measurement
methodology, and verification numbers: AR_SYSTEM.md §G Phase 3,
"Progress (2026-08-14, second same-day physical-device test)" — same
entry covers all of §14 and §15's fixes plus the anchor-stability
trackingStatus gate.

## 16. The §15 Card fix was STILL incomplete — two more root causes in the
same "frozen text while scrolling" symptom family (2026-08-14, fourth
physical test)

Two genuinely independent bugs, both producing a similar-looking symptom
(text appearing to stick/duplicate near the top of the scrolled area),
found by isolation rather than assumed to be the same bug twice.

**Bug A — the header crop still clipped, just for a different content
shape.** §15's `HEADER_HEIGHT_ARTBOARD_UNITS` measurement only tested a
single-line title/subtitle. A subtitle long enough to wrap to 2 lines
duplicated/froze its second line — the boundary genuinely depends on how
many lines the title/subtitle wrap to, which depends on their actual
text, not just a fixed artboard geometry fact.
`tools/inspect_card_header_boundary.mjs` now measures a deliberately
generous worst case (title AND subtitle both wrapping to 2 lines) instead
of a single-line minimum; the constant moved from 95 to 148 (real
measured boundary at that worst case: 160.5, midpoint 145.375).

**Bug B — independent of A, and easy to mistake for the same thing:**
even with A fixed, the FIRST LINE OF BODY CONTENT (not header content)
stayed frozen/duplicated while the rest scrolled correctly underneath it.
Isolated by disabling the header-mirror refresh entirely: the artifact
disappeared. Root cause: `refreshHeaderMirror()` was calling
`ctx.drawImage()` with the SCROLLING main canvas as its source, once per
Rive Advance tick, forever (many times per second, indefinitely) — this
corrupts the browser's own scroll-repaint for that same canvas, leaving a
stale raster in the region that had just scrolled into view. Confirmed
NOT a layout bug first: `canvas.getBoundingClientRect()` moved by exactly
the scroll delta throughout, so the DOM position was always correct —
only the painted pixels lagged. Fixed by bounding the header-mirror
refresh to a short burst (10 ticks) right after content actually changes
(`open()`), instead of a persistent per-Advance-tick subscription — the
header's own content is static between opens and never needed continuous
re-copying.

**Verification note:** screenshot review was blocked mid-session by a
image-count/size constraint on the review tooling itself (unrelated to
the app) — the fix was verified instead via a decisive numeric method: a
per-column dark-pixel-count signature of the suspect screen region,
compared across scroll positions. Header region: 100% of columns
identical across all tested scroll positions (correctly static). Content
region that previously froze: ~72% of columns differ between two
different scroll positions (correctly reflecting genuinely different
scrolled-to text, not a coincidental partial match).

Also clarified in this pass, not a bug: scanning a single plaque lying
flat on a bare desk (no physical terrain nearby) makes buildings render
small and, before the §14 rotation fix, visibly rotated — both are
consequences of the `'site'` entry's real, meter-scale offsets (designed
for the actual ~1.6×1.3m terrain) applied with nothing physical to
overlay onto, not a defect. See `docs/physical-plaque-placement.md`
(new) for the physical placement checklist and the pointer to the
single-plaque MindAR harness entries for isolated desk testing.

Full detail and verification numbers: AR_SYSTEM.md §G Phase 3, "Progress
(2026-08-14, fourth physical-device test)".

## 17. The Card is no longer a Rive artboard (2026-08-14, fifth physical
test) — five straight fix attempts on the same foundation was the signal
to change the foundation, not patch it again

§§12–16 above are five consecutive attempts to make ONE Rive canvas keep
part of itself (the header) visually fixed while the rest (the body)
scrolls: a width/letterbox fix, a height-cap fix, a whole-sheet-scroll
fix that regressed the header, a header-crop-measurement fix that was
wrong twice (single-line assumption, then a paint-compositing bug from
continuously mirroring the canvas), and even after fixing that, a real
device STILL showed several lines of body text frozen at the top of the
scroll area on the next physical test.

The user's direct read of the situation was correct and is the reason
this section exists: a single canvas has no native concept of "part of
me is fixed, part of me scrolls" — every attempt above was really
building a bespoke, increasingly fragile simulation of what
`flex:none` + `flex:1; overflow-y:auto` does for free. The fix was to
stop patching the canvas-based design and rebuild the Card as plain
HTML/CSS: `CardPanel.ts` now owns real DOM elements (a heading, two
paragraphs, an `<img>`, a `<button>`) instead of a Rive artboard, text
runs, and a referenced asset. `bench-ui.riv`'s `Card` artboard, the
`CardImageSlot` Rive-asset bridge, and
`tools/inspect_card_header_boundary.mjs` (the measurement tool the
previous two passes needed) are all deleted — there is nothing left to
measure once the browser's own layout engine owns the split.

**Verification note, same class of lesson as §15's own regression:** the
first re-run of the scroll-freeze verification against the new HTML
Card came back "100% identical everywhere," which looked like ANOTHER
freeze bug — but was actually the verification script's own crop region
missing the card entirely (a leftover hardcoded top-of-viewport crop
from the canvas-based design's geometry, never updated for the new
bottom-anchored flexbox layout, so it was screenshotting empty background
above the card). Caught by checking the layout numbers before trusting
the pixel comparison, not by assuming a fix must be wrong just because a
check failed. Corrected to crop around the container's actual measured
`getBoundingClientRect()`, after which the real result was unambiguous:
header 100% identical across all tested scroll depths, content
consistently ~32–39% different between any two distinct scroll depths,
no anomalous "frozen" band anywhere.

Full detail: AR_SYSTEM.md §G Phase 3, "Progress (2026-08-14, fifth
physical-device test)".

## 18. TARGET_FRAME_TO_WORLD_FIX corrected again (2026-08-17) — mounting
orientation decided flat, not vertical

§14 corrected this constant to `identity()` based on strong external
evidence (a published integration example + an official 8th Wall forum
response), both about content that "should stand upright, aligned with a
WALL-mounted vertical tracked image." That evidence was sound for the
case it addressed — but the underlying physical assumption it was
answering (the 4 plaques mount vertically, "museum placard" style) is
what turned out wrong, not the reasoning about identity() vs `Rx(+90°)`
for THAT case. Root cause of the mismatch: nothing in this codebase had
ever actually decided the mount orientation before §14 — `docs/asset-
authoring-guide.md` §3.5 said as much at the time ("the only sane default
for a museum-placard-style plaque"), a default, not a decision. A
coworker physical review on 2026-08-17 made the real decision: the
plaques lie flat on the ledge, artwork facing up — the same orientation
the placeholder plaque geometry in `site-scene.glb` (flat magenta slabs)
had already been authored in all along, coincidentally or not.

**Fix:** rather than re-deriving a flat-marker rotation from scratch or
re-guessing between identity/±90°X, reused this project's own existing,
already-validated glue for the identical physical shape —
`SceneGraphLoader.ts`'s `GLTF_TO_MINDAR_ROTATION_X_RADIANS = Math.PI / 2`,
written for MindAR's bench-test plaque, which has always been a flat,
table-lying marker (`build_bench_scene.py`'s `ar_launch_plaque`). Same
physical marker shape, same glTF-authored content axes (X-east/Y-up/
Z-south) → same rotation. `TARGET_FRAME_TO_WORLD_FIX` is now `Rx(+90°)`
— numerically the pre-§14 value, but arrived at for a different, now-
confirmed reason (the flat-marker precedent), not a blind revert.

**Not re-litigated, still holds:** `applyPose()`'s composition math and
`rotationYawDeg`'s derivation (both orthogonal to this constant, per
their own doc comments) — unchanged, `ImageTargetAnchorSource.test.ts`'s
16 tests still pass with the new constant value substituted in.

**Still open, requiring physical access, not software:** whether 8th
Wall's own image-target rotation convention for a flat/horizontal marker
actually matches MindAR's convention. Both are standard AR-SDK patterns
for this marker shape, and reusing an already-validated same-project
value is stronger footing than a fresh guess, but it is not the same as
an on-device 8th Wall confirmation — that still doesn't exist for this
specific hardware/plaque combination.

## 19. Cold-start stabilization (2026-08-18): the bootstrap pose was
being revealed to the user, not just applied

**Symptom (production, `site`):** after scanning a plaque, buildings
appeared tiny/mis-oriented and markers were absent for ~5–6 seconds,
self-correcting with no user action — a production-visible consequence
of a mechanism this log already understood in isolation, just never
connected to a visibility decision before now.

**Root cause, confirmed against the code, not assumed:** two facts that
were each already documented separately in this file finally compose
into one user-facing bug:

- §13's fix (`isSampleTrustworthy()`) made the anchor's TRANSFORM immune
  to a bad sample once a good one exists — but the very first, bootstrap
  sample has never gone through that gate at all (`trustworthy =
  !wasAcquired || isSampleTrustworthy(ratio)` in `onImageEvent`'s
  `'found'` case — the bootstrap sample short-circuits the check
  entirely, by design, per `isSampleTrustworthy`'s own doc comment: "the
  very first acquisition always applies regardless — refusing to ever
  place the scene would be worse than an imperfect first placement").
- Until this pass, `group.visible = true` ran in that exact same
  bootstrap branch — the instant the FIRST sample landed, correct or
  not. §4's own absolute-scale convergence note ("needs a few seconds of
  device parallax to converge") means that first sample is routinely not
  yet converged, so the scene rendered at whatever pose the engine's
  early estimate produced, then silently snapped once a LATER sample
  independently passed `isSampleTrustworthy()`.

Markers were absent over the identical window for a coincident,
independent reason: `isTracking()` (gating marker visibility, unchanged
by this pass) has always required `trackingStatus==='NORMAL'` — the same
convergence-dependent signal driving the scale gate. Two different gates,
same underlying engine latency, never coordinated by any code that
connected them — which is exactly why the building and the markers
appeared to "fix themselves" in lockstep.

**Fix:** applying a pose to the anchor's transform and revealing that
transform to the user are now two separate decisions.
`ImageTargetAnchorSource.group.visible` flips `true` exactly once — the
first time a sample independently passes `isSampleTrustworthy()` — via a
new private `onPoseApplied()` hook, which also resolves a new
`whenStable(): Promise<void>` added to the `AnchorSource` interface.
`main.ts` gates the `'Loading…'` → revealed transition (reusing
`UxOverlay.showHint()`, not a new UI system) on `whenStable()`, never on
`acquire()` alone. `TapPlacedAnchorSource`/the `?fakear=1` desk-sim's
`SimulatedAnchorSource` both implement `whenStable()` as an immediate
resolve — neither has a bootstrap-pose ambiguity to wait out. No change
to `applyPose()`, `TARGET_FRAME_TO_WORLD_FIX`, `rotationYawDeg`,
`originOffsetMeters`, or either existing plausibility gate.

**Secondary finding, same pass: GLB/Rive/marker/card loading was
serialized strictly after image-target acquisition, with no
architectural reason.** `runEightWallExperience()` now kicks off GLB
fetch+parse, Rive fetch+parse, `MarkerLayer.attach()`, and
`CardPanel.attach()` (respecting their real dependency graph — see the
new `loadEightWallSceneContent()` in `main.ts`) at the top of the
function, before the arrival gate or "Start AR" even run, instead of
after acquisition. This does not by itself fix the bootstrap-pose bug
above (parallelizing asset loading doesn't touch pose plausibility at
all) but removes real, unnecessary serial latency stacked on top of it.

**QR first-scan UX, investigated in the same pass:** current 8th Wall
docs (checked this session) don't describe "first QR scan opens the
site but doesn't start AR" as expected browser/engine behavior — no
official page covers it. The strongest code-grounded explanation found:
after "Start AR" is tapped, `EightWallSession.start()` awaits the engine
module import, `configure()`, and `xr8.run()` (camera/motion permission
chain) with zero loading feedback — on a cold cellular connection right
after a QR scan, long enough to read as "nothing happened." Fixed with a
synchronous `overlay.showHint('Starting camera…')` in the click handler,
before `session.start()` — confirms the tap without touching the still-
mandatory iOS gesture requirement for `DeviceMotionEvent.requestPermission()`.
Explicitly NOT attempted: transferring the QR scanner's visual
recognition of the plaque into the browser's camera session — no browser
API exists for that, so the physical plaque must always be re-seen by
whichever camera session does AR tracking. No cookie/localStorage
persistence added — nothing here needed it.

**Verified in software:** `npm run typecheck`/`build`/`test` clean, 19/19
unit tests (3 new: bootstrap-only pose does not reveal or resolve
`whenStable()`; first trustworthy sample after bootstrap does, exactly
once; an implausible pre-trustworthy sample is rejected without
revealing or corrupting the anchor). The two pre-existing tests that
asserted `group.visible === true` off the bootstrap sample were updated
to assert `false`, matching this pass's contract change; every other
existing test, including the 4-plaque composition self-consistency
suite, passes unmodified. **Not verifiable in software, requires a real
device:** whether the reveal lands meaningfully faster than the reported
5–6 seconds, and whether the "Starting camera…" feedback measurably
reduces double-QR-scans in the field. The temporary diagnostic
instrumentation (`DiagnosticTimeline.ts`, `?debug=1`) is deliberately
still in the codebase to capture exactly that on the next physical pass
— see its own doc comment for what to remove once a capture confirms
the fix.

## 20. First physical test of §19's fix (2026-08-19): 'Loading…' could
hang forever, and the anchor's "permanence" needs one more decision

Two findings from the first real-device pass after §19 landed, full
detail in AR_SYSTEM.md §G Phase 6 "Progress (2026-08-19)" — summarized
here for the chronological record.

**'Loading…' hangs with no explanation if the phone stays still.**
Expected, in hindsight: `whenStable()` only resolves once absolute scale
converges, and convergence needs real device parallax (both this
codebase's own comment and 8th Wall's official world-tracking guidance
say so). Fixed with a 2.5s coaching-copy timer in `main.ts` — text only,
cleared the instant `whenStable()` resolves; the reveal criterion itself
is untouched, no timeout reveals anything.

**The anchor "getting lost" when the plaque leaves view is NOT a
`group.visible` regression** (every assignment site checked directly —
set `false` once, `true` exactly once, never reverted) but two separate,
real contributors:

1. Zero feedback during a genuine, sustained `isTracking()` gap (SLAM
   `trackingStatus` leaving `NORMAL`) — markers correctly hide by design,
   but nothing told the user it was temporary. Fixed with a debounced
   `TrackingLossHint` (2s sustained-loss threshold, well past ordinary
   camera-pan blips), wired through the `AnchorSource.isTracking()` seam
   — identical for image-target and tap-placed origins.
2. **Leading hypothesis, deliberately NOT acted on yet:** a re-detection
   (`'found'` after `imagelost`) is gated by the same
   `trackingStatus==='NORMAL'` check as a continuous `'updated'` sample —
   but a re-detection is the user looking DIRECTLY at the plaque, a
   stronger signal than whatever transient relocalization status SLAM
   reports in that same frame. If status hasn't caught up to `NORMAL`
   yet, the correction is silently dropped and the anchor keeps its
   stale frozen pose. Loosening this (scale check only, for `'found'`
   re-detections specifically) is plausible and bounded, but partially
   reopens the exact gap the trackingStatus gate (§ above, "Second-audit
   finding") was added to close — not safe to change on a live physical
   exhibit without a captured log confirming this diagnosis first.
   Instrumented instead: `ImageTargetAnchorSource.ts` now marks
   `re-detection-rejected` naming which gate failed, whenever a
   re-detection is dropped. **Next step, not this pass:** capture one of
   these on a real device — if `scalePlausible=true` and
   `trackingStatus` reads something other than `NORMAL` at rejection
   time, that confirms the hypothesis and the gate change becomes a
   well-evidenced next fix; if the rejections are actually bad-scale
   readings, the hypothesis is refuted and the real cause is still open.

**Verified in software:** `npm run typecheck`/`build`/`test` clean,
29/29 (4 new `TrackingLossHint` tests). No change to `applyPose()`,
`isSampleTrustworthy()`, or any composition/glue math.

## 21. First capture from §20's instrumentation (2026-08-19, same day):
`trackingStatus`-lag hypothesis refuted; "model never appears" traced to
testing against a screen image instead of the printed plaque — no code
defect

The `re-detection-rejected` instrumentation (§20) returned its first
real capture: ~8 rejected samples over ~20s, cycling through all 4
`site` plaques. **Every single line reads `trackingStatus=NORMAL`** —
the §20 hypothesis (a re-detection rejected because SLAM status hasn't
caught up to `NORMAL` yet) predicted the opposite and is refuted for
this session. Kept as a live, unrefuted possibility for a future capture
— it just didn't happen here.

What actually rejected every sample: `engine sees 0.198–0.223 m,
manifest declares 0.09 m`, ratio **2.2–2.5×**, stable across the whole
20s window regardless of the user repeatedly moving the phone closer and
farther (the exact motion the coaching hint from §20 asks for). Compare
§4's own historical example of genuine non-convergence — `12.40 → 1.68 →
7.28 → 8.27`, wandering, not settled — this capture's numbers do the
opposite: they sit still. A stable, motion-immune, non-1 ratio is the
signature of a target whose true physical size doesn't match
`physicalTargetWidthMeters`, not of unconverged scale.

**Confirmed with the project owner:** the capture was taken pointing the
camera at the QR/plaque artwork open in a photo-viewer/editor app on a
tablet screen, not the printed 90×30mm paper plaque the manifest's
`0.09` is measured against. **No code changed — none was needed.** The
gate did exactly its job: it correctly measured the real object in front
of the camera (a tablet-screen rendering, plausibly ~200mm across) and
correctly refused to trust a reading that implausible against the
declared print size. Moving the phone cannot fix a target whose real
size will never match what's declared, which is why the coaching motion
had zero effect across 20 seconds. **Next step is a retest against the
actual printed plaque**, not a code change — and that retest is also
what's still needed to get real evidence for (or against) the
`trackingStatus`-lag hypothesis this capture couldn't test.

---

## 22. QR-plaque artwork replaced with candidate abstract tracking
targets (2026-08-2x planning + build session) — root cause of jitter
found in the ARTWORK, a second real jitter cause found in the CODE,
diagnosed but not fixed, handed off.

**Why this session started:** on-device testing of the printed QR
plaques (the production `'site'` entry's actual artwork,
`tools/build_site_plaques.py`) showed slow acquisition, wrong initial
pose, and continuous jitter — independent of the §21 scale-mismatch
finding above (that was a screen-vs-paper measurement issue; this is
about the artwork's own trackability).

**Root cause, from two independent sources agreeing:** this project's
own `docs/asset-authoring-guide.md` §3.1 and 8th Wall's own docs
(8thwall.org/docs/engine/guides/image-targets) both say the same thing —
"a lot of varied detail" + "high contrast"; avoid "repetitive patterns,"
"excessive dead space," "low resolution"; and (8th Wall specifically)
"detection cannot distinguish between colors, so don't rely on it as a
key differentiator." A QR code is a repeating module grid, and since all
4 plaques encode the SAME experience URL (§A: identity resolved by
tracking, never the QR payload), that grid is **pixel-identical across
all 4 "distinct" plaques** — the per-side badge shapes were supposed to
make the 4 plaques trackably distinct from each other, but roughly half
of each plaque's area was silently identical to its siblings the whole
time. The old 90×30mm (3:1) aspect ratio also directly violates §3.1's
"avoid extremely thin/long" guidance.

**Decision: decouple QR (session bootstrap) from image target (pose
tracking) entirely**, rather than iterate on QR-based artwork further —
full reasoning in AR_SYSTEM.md §G Phase 6's matching progress entry.
Logo-as-tracking-target was discussed and deferred (not rejected): a
shared org logo recreates the identical-region problem in a new shape
unless it's made non-uniform per side, not just framed differently.

**Built:** `tools/build_site_tracking_targets.py` (new) generates 4
abstract Voronoi-cell B&W patterns, one independent RNG seed per side, no
shared regions at all (unlike the QR block). First attempt used
uniform-random seed points and visibly produced oversized cells — a
miniature version of the same "dead space" problem; fixed by switching
to blue-noise/Poisson-disc rejection sampling, no other change. 30mm
square (not 90×30mm — freed from needing to share the plaque with a
QR+text layout), 24px/mm matching `build_site_plaques.py`'s existing
density convention.

**Compiled + wired as a NEW harness, not the production entry:** reused
`tools/compile_8thwall_target.mjs` as-is → `public/assets/image-targets/
site-tracking-{front,back,left,right}/`, verified 720×720 /
`isRotated: false` (nothing cropped). 4 new single-image-target
`manifest.ts` entries (`site-tracking-front`/etc., same minimal shape as
`8thwall-test` — no `targets[]` composition), so each candidate is
testable on real hardware independent of the production `'site'` entry's
calibrated geometry.

**On-device test, `site-tracking-front`, real printed candidate:**
tracking felt more stable than the old QR plaque, but two things stood
out:

1. **World origin renders at the plaque's own center, not the baseboard
   corner.** Expected, not a bug: this harness entry is a single-image-
   target design (mirrors `site-front`, §A's single-plaque-center rule),
   which intentionally re-centers the whole scene on itself rather than
   applying the production entry's calibrated `originOffsetMeters`. That
   composition step is later, once artwork is finalized.
2. **The whole scene still visibly spins/scales while the camera holds
   roughly on the target and the viewing angle is adjusted.** Real, and
   traced to actual code, not assumed: `ImageTargetAnchorSource.
   applyPose()` applies every sample that passes `isSampleTrustworthy()`
   (scale ratio + `trackingStatus==='NORMAL'`) directly to the 3D
   anchor's rotation/position, every single frame, with **zero temporal
   filtering** — only a binary accept/reject gate exists. Confirmed this
   is unaffected by any of §19–21's fixes above (all three explicitly
   state no change to `applyPose()`'s composition math) — this is a
   separate, still-open gap, not a regression from recent work.

   **A fix is proposed, deliberately NOT implemented yet, because a
   naive version of it was already tried and reverted once in this exact
   codebase** — worth being careful, not just porting a filter in blind:
   `OneEuroFilter.ts`'s own doc comment records that pose-smoothing was
   tried for MindAR and reverted because it "made the whole scene
   visibly lag behind the physical model" — jitter absorption moved to
   the 2D screen-space marker stage (`MarkerLayer.ts`) instead.
   `ARSessionManager.ts`'s `TRACKING_PROFILE_RIGID_ANCHOR` shows why: a
   LOW-beta filter causes visible lag/"swim" for a rigidly-anchored
   scene, so MindAR's own profile uses a HIGH beta (1000) — still damps
   at-rest tremor (`filterMinCF: 0.001`) but gets out of the way almost
   entirely during real motion. That's evidence against LOW-beta
   smoothing specifically, not against smoothing in general — and 8th
   Wall's path currently has no filtering of any kind, high-beta or
   otherwise. **Proposed:** port `OneEuroFilter1D` into
   `ImageTargetAnchorSource.applyPose()`, one instance per position axis
   (x/y/z), tuned like `TRACKING_PROFILE_RIGID_ANCHOR` (high beta/low
   minCF) rather than the low-beta profile that caused the original
   regression. Quaternion rotation needs one extra step beyond position:
   filtering x/y/z/w independently requires flipping the incoming
   quaternion's sign when it's on the opposite hemisphere from the
   previous filtered one (quaternions double-cover rotation space)
   before filtering, then renormalizing the result afterward.

**Status at handoff:** `site-tracking-front` tested and diagnosed;
`-back`/`-left`/`-right` compiled and wired but not yet on-device tested.
No change made to `ImageTargetAnchorSource.ts` — the smoothing fix above
is a proposal with a concrete implementation sketch, not code. Production
`'site'` entry untouched by any of this. `ACTIVE_TARGET_ID` (`main.ts`)
reverted to `'site'` before this session's changes were committed — flip
it to any `site-tracking-*` id to resume testing a specific candidate.

## 23. Onboarding UX overhaul (2026-08-25): the §19/§20 coaching signals now also drive a live visual guidance illustration — no new signal added

Cross-reference only — the full write-up lives in AR_SYSTEM.md §G Phase 6's
"Progress (2026-08-25)" entry. Noted here because it directly reuses two
signals this file already documented: `ImageEventHintGate` (§19's
'searching'/'loading' hint gate) and the `POSE_COACHING_DELAY_MS` coaching
timer (§20, "Fixed with a 2.5s coaching-copy timer... text only, cleared the
instant `whenStable()` resolves"). Both now also drive a small `arStatusStore`
(Zustand, `zustand/vanilla`) phase alongside the hint text they already set,
read by a new `GuidanceOverlay.ts` that shows a shared vector "move your
phone" illustration (Framer Motion, `framer-motion/dom`) — the same
illustration a new 3-step onboarding (`OnboardingFlow.ts`) shows before the
AR session even starts. No new timer, no new engine event: the coaching
timer's criterion (`whenStable()`) and its text are exactly what §20 shipped;
this pass only mirrors that same signal into one more place to look at.

## 24. "Only one of the 4 targets works" (2026-08-26) — a real multi-target bug, not artwork; §22's smoothing proposal also implemented

Cross-reference only — the full write-up lives in AR_SYSTEM.md §G Phase 6's
"Progress (2026-08-26)" entry, right after the §22-referencing 2026-08-25
artwork-swap entry above it. Summary for anyone jumping straight to this
file: a physical test of the new Voronoi tracking targets (§22) reported
only one plaque tracking; found by reading `ImageTargetAnchorSource.ts`,
not from a new capture — the anchor's `acquired` gate was class-wide, so a
DIFFERENT plaque's first-ever sighting was held to the strict
re-detection-trust gate meant for the SAME already-anchored plaque, and
silently rejected whenever `trackingStatus` wasn't `NORMAL` at that exact
moment (common while walking to a different physical plaque). Fixed with a
`seenTargetNames` set — a name's first sighting is now exempt, a repeat
sighting is not. §22's pose-smoothing proposal (OneEuroFilter1D per
position axis and quaternion component, tuned like
`TRACKING_PROFILE_RIGID_ANCHOR`) was implemented in the same pass, exactly
as sketched there, with filter resets wired to the same discontinuity
points (re-detection, or the new fix's "different plaque" case). 51/51
tests pass (4 new). Neither fix has a fresh on-device confirmation yet —
see AR_SYSTEM.md's entry for exactly what's still open.

---

## 25. Strategy change (2026-08-31): stop continuously re-snapping the anchor — place it once, freeze it, let SLAM persist it

**Why now, after §22/§24 already shipped a plausibility gate plus pose smoothing:** weeks of on-device testing under the continuous-re-snap design kept producing new variants of the same symptom family — drift/scale jumps (§13), a wrong-looking scene because a bad glue rotation got re-applied every frame (§14), continuous jitter/spin while the camera held still on a target even after the plausibility gate and One Euro Filter landed (§22/§24), and (per outside research this same session) a documented, non-project-specific failure mode: an anchor offset from its tracked plaque amplifies ordinary per-frame angular noise into visible positional swim, proportional to the offset distance — exactly this project's multi-target `originOffsetMeters` composition (§E). Each fix narrowed the symptom without removing its structural cause: `applyPose()` writing `group.position`/`group.quaternion` from a fresh tracked sample, indefinitely, for the entire session.

**External evidence, gathered before deciding, not after:** two independent 8th Wall community sources describe this exact failure and its resolution.

- 8th Wall's own forum, "Jitter from image markers and stabilizing AR content" (forum.8thwall.com/t/1108): a developer reported the identical symptom — tall content jittering because "small angular errors from the new calculations on each successive frame" accumulate under continuous re-tracking. **Ian, 8th Wall staff, recommended enabling world tracking (SLAM) on `xrimagefound` and relying on it for persistence, instead of continuously re-applying image-marker pose.**
- 8th Wall's forum, "Issues with anchoring a model offset from the target image" (forum.8thwall.com/t/7239): a separate report of content anchored away from the tracked image (this project's exact `originOffsetMeters` shape) drifting specifically when the camera turns — the geometric consequence of amplifying per-sample angular noise by a lever arm, independent of any particular engine version or this project's own code.

Neither source, nor the official Image Targets guide, describes continuous re-snapping as the recommended pattern for anchoring stable content — it is a pattern this project chose (documented in `ImageTargetAnchorSource`'s original class doc comment as "correcting accumulated SLAM drift whenever the user glances back at whichever plaque is currently in view"), not one 8th Wall prescribes.

**The alternative already existed in this codebase, unmodified, for the other `AnchorSource` implementation:** `TapPlacedAnchorSource.acquire()` writes `group.position`/`group.quaternion` exactly once (the user's tap) and never touches them again — `disableWorldTracking: false` SLAM holds that transform for the rest of the session. It has never once been the subject of a drift/jitter entry in this log.

**Decision: adopt the same shape for `ImageTargetAnchorSource`.** The pre-existing bootstrap/convergence/reveal machinery (§19 "Cold-start stabilization") is unchanged: the first `found` of any configured plaque still applies unconditionally so the anchor is never left un-placed, the group stays hidden until a sample independently passes `isSampleTrustworthy()` (scale plausibility AND `trackingStatus === 'NORMAL'`), and that first passing sample still reveals the group and resolves `whenStable()`. What changed is what happens the instant that reveal fires: `stable` now also means **frozen, permanently, for the lifetime of the anchor instance** — every later `found` (a re-detection of the same plaque, or the first-ever sighting of a different one) and every `updated` sample still updates `imageVisible`/telemetry (so marker gating and the console log stream are unaffected) but is a pose no-op. `imagelost` already stopped feeding snaps; this extends the same "SLAM alone holds the world frame" behavior to cover the plaque coming back into view too, not just it leaving.

**Removed, not just left unused:** the One Euro Filter smoothing apparatus §22 added (per-position-axis and per-quaternion-component filters, hemisphere-continuity correction, `resetPoseFilters()`, the injectable clock). With no more continuous re-snapping there is nothing left for it to smooth — the group is hidden for the entire pre-freeze convergence window in the first place, so no user ever saw the handful of samples it used to act on. Keeping it would misdocument the shipped design to the next reader.

**Multi-target switching (§24) — narrowed to a non-issue, not re-broken:** the `seenTargetNames` first-sighting exemption is kept for the (now much shorter) pre-freeze window, but the ORIGINAL §24 bug — a different plaque's first-ever sighting, scanned well after the anchor had already been established, silently rejected depending on `trackingStatus` timing — is now structurally impossible: after freeze, every `found`/`updated` short-circuits before the trust gate (or the `seenTargetNames` check) is even reached. No plaque's sighting is ever "rejected" post-freeze, because none are evaluated at all.

**Trade-off, stated plainly:** the anchor no longer self-corrects accumulated SLAM drift by re-scanning a plaque mid-session. If that turns out to matter in practice on the physical `site` exhibit (a multi-minute session walking around a ~1.6×1.3m model), the next lever is a bounded, user-intentional recenter — `EightWallSession.recenter()` already exists, unused — not a reversion to continuous re-snap. Deliberately not built in this pass; a decision for if and when on-device evidence asks for it.

**Verified in software:** `npm run typecheck`/`build`/`test` clean, 52/52 (`ImageTargetAnchorSource.test.ts` rewritten: every pre-freeze gate test kept with tightened epsilons now that there's no filter lag to account for, the dedicated filter-reset test removed since there's no filter left to test, three new tests added asserting the anchor's transform is unchanged by a same-plaque re-detection, by a run of ordinary per-frame `updated` samples, and by a different plaque's first-ever sighting — all three post-freeze). **Not verifiable in software, requires the physical exhibit:** whether the jitter/drift reports from §22/§24 are actually gone on real hardware, and whether the loss of continuous drift self-correction is noticeable over a real walkaround session.

---

## 26. First physical retest of §25's freeze (2026-09-01): the predicted trade-off hit immediately — refined to "freeze the continuous stream, keep correcting on discrete re-detections"

**Symptom, reported directly by the user during a real walkaround of the `site` model:** after moving the phone enough to finally get a stable lock, the scene was NOT staying put — "the model starts moving with me, and at some point loses scale again." This is the exact symptom the §25 write-up's own "Trade-off, stated plainly" paragraph predicted as the risk of removing continuous re-snapping, now confirmed on the very first physical retest, not a new independent bug.

**Root cause, not a regression in §25's own fix:** §25 correctly eliminated the §22/§24 jitter (continuously re-applying a noisy per-frame `updated` sample), but froze the transform against EVERY subsequent image event, including `'found'` (a discrete re-detection). A real multi-minute walkaround of a physical model has no other mechanism to correct ordinary SLAM/VIO drift — the camera's own tracked pose accumulates small position/orientation error over time (a property of monocular visual-inertial tracking in general, not of this app's code) — and the ONLY thing that ever corrected that drift, in every version of this anchor before §25, was re-grounding the content against a plaque's known-fixed real-world position each time the user looked at one again. Freezing forever removed that correction entirely, so accumulated drift became visible exactly as reported: content appears to "follow" the user as the camera's own position estimate silently diverges from reality.

**The refinement:** the two 8th Wall event kinds this class already distinguishes are NOT interchangeable, and treating both as "the thing `stable` freezes" was the mistake:

- `'updated'` — fires every frame the target is in view. A continuous stream. This is what caused the §22/§24 jitter when perpetually re-applied, and freezing it out permanently (unchanged from §25) is what actually fixed that bug.
- `'found'` — fires only on a discrete transition: first detection, or a fresh re-detection after `imagelost`. At most a handful of times per minute during normal use. Re-grounding the anchor on this signal is a bounded, occasional correction — exactly the periodic "check a landmark, correct dead-reckoning drift" pattern real SLAM-assisted AR needs for anything beyond a short session — not a source of per-frame perturbation.

`ImageTargetAnchorSource.ts` now keeps `'updated'` frozen out permanently once `stable` (no change — this is the part that must never regress back to jitter), but `'found'` runs through the exact same `isSampleTrustworthy()` gate and `seenTargetNames` multi-target exemption for the FULL session, `stable` or not — identical to how it behaved before `stable` existed at all. Walking up to a different, never-before-seen plaque well into an established session (the original §24 scenario, which §25's pure freeze had made structurally impossible again) now works exactly as §24 intended.

**Why this isn't "just revert to §25's predecessor":** the pre-§25 code re-applied `'updated'` too, every single frame, which is precisely the jitter source. This keeps §25's core insight (continuous per-frame sampling must never drive the anchor) while restoring only the discrete, occasional correction — a narrower, more specific claim than either "always re-snap" or "never re-snap."

**Verified in software:** `npm run typecheck`/`build`/`test` clean, 53/53. Three `ImageTargetAnchorSource.test.ts` tests rewritten from "once frozen, X does not move the anchor" (for a same-plaque re-detection, and for a different plaque's first sighting) to the opposite assertion — both now correctly re-ground the anchor — plus one new test confirming a re-detection with an implausible scale is still rejected (the periodic correction is gated, not unconditional), and the continuous-`'updated'`-never-moves-it test is kept unchanged (that guarantee did not regress). **Not verifiable in software, requires the physical exhibit — this pass's entire purpose:** whether periodic re-grounding on discrete re-detections is enough to keep the scene visually anchored over a real walkaround without reintroducing any of the §22/§24 jitter, since re-detections are still individually un-smoothed, single-sample snaps.

**Separately in this same pass, unrelated to anchor stability:** the on-device report that motivated this fix also surfaced two independent onboarding-UX gaps found by reading the guidance code against its own instructional text, not by further testing — full detail in AR_SYSTEM.md's matching 2026-09-01 entry:

1. The "find a target" copy never mentioned that the tracking targets are only 30×30mm (`docs/physical-plaque-placement.md` §1) — a real contributor to "can't get lock" reports, since successful detection needs the phone much closer than "point your camera at the plaque" implies. Copy updated in `main.ts`, `ImageEventHintGate.ts`, `TrackingLossHint.ts`, and `OnboardingFlow.ts`'s `find` step to say so.
2. The "still locking on" hint's text ("move your phone slightly closer, then farther") and its `'voronoi'` illustration had drifted apart: the animation depicted a LATERAL (left/right) nudge, not the depth (closer/farther) motion the text asks for — traced back through this project's own history (AR_SYSTEM.md's 2026-08-25/2026-08-26 entries) to two separate illustration redesigns, neither of which ever actually built a depth-motion depiction. `PhoneGuidanceIllustration.ts`'s `'voronoi'` variant rewritten to a scale "breathing" pulse (phone and a halo ring grow/shrink in place) instead of a lateral nudge — the standard 2D substitute for depicting motion toward/away from the camera.

---

## 27. Second physical retest (2026-09-01, same day): §26's fix did NOT resolve the anchor bug — same symptom, exact wording "loses anchor easily, scale becomes miniature." Stopped guessing; switched to an instrumentation-first strategy instead of a fourth blind fix.

**Why this entry exists:** three fixes in a row (§25 freeze, §26 discrete-re-detection refinement) were each shipped straight to a physical retest without a device log confirming the diagnosis first, and each retest came back with the anchor still broken. That is the exact anti-pattern this file's own §3 ("Measuring instead of guessing a fourth time") already named and warned against, re-happening. This entry is a deliberate change of process, not another code guess.

**What we know, stated precisely:** "the anchor is lost easily, and the scale becomes miniature" — reported verbatim after a session that DID reach a stable lock first (so bootstrap/convergence/reveal are not the issue), and after §26 was live (so discrete-re-detection re-grounding, as coded, did not fix it either). "Miniature," specifically, rules out one thing outright: `anchorScaleForEvent()` returns a hardcoded `1` unconditionally — `group.scale` is never anything but `1` anywhere in this class, past or present. **Nothing in `ImageTargetAnchorSource` can literally shrink the mesh.** An apparent shrink has to come from somewhere else: the anchor's `position` ending up much farther from the camera than reality (making the model look tiny by ordinary perspective), or — a structurally different possibility this project has not yet instrumented for — the CAMERA's own live pose/absolute-scale estimate moving or rescaling independently of anything this class does.

**Two live hypotheses, deliberately not collapsed into one guess:**

- **(a) A gate bug**: some accepted `'found'`/`'updated'` sample is passing `isSampleTrustworthy()` with a genuinely bad pose (e.g., the ratio check has a blind spot, or `trackingStatus` reads `'NORMAL'` during an actually-bad reading). This would be a fixable bug in THIS class's own logic.
- **(b) Camera-side drift/rescale, outside this class's authority entirely**: 8th Wall's `scale:'absolute'` mode is a live, ongoing SLAM/VIO estimate (this file's own §4/§8 already documented that it "needs a few seconds of device parallax to converge" — nothing states it can never re-adjust after that). If the engine's own notion of "one real meter" shifts mid-session (a known general limitation class of monocular visual-inertial scale estimation, not specific to this codebase), the CAMERA'S reported position moves according to the NEW scale while our frozen `group` transform stays expressed in the OLD scale's meters — every gate this class has (`isScalePlausible`, `trackingStatus === 'NORMAL'`) is blind to this, because a uniform rescale can move the target's OWN apparent size (`event.scale`) and its position by the same factor, so the ratio this class checks can stay near 1.0 even while the whole coordinate frame has drifted. If this is what's happening, no amount of tuning `ImageTargetAnchorSource`'s gates fixes it — the fix would have to be structurally different (e.g., a bounded periodic `session.recenter()`, detecting the rescale directly if the engine exposes any signal for it, or moving off `scale:'absolute'` for this content).

**These two hypotheses require different fixes, and every symptom reported so far is consistent with either one.** That is precisely why another guess is not the efficient next step — a wrong guess between them costs a full field-test round trip to find out it didn't help, exactly what's already happened twice.

**Instrumentation added instead of a fourth fix (`EightWallSession.ts`, `ImageTargetAnchorSource.ts`):** `EightWallSession` now retains the camera handle from `onStart` and exposes `getCameraPosition()` — a plain, diagnostic-only snapshot of the camera's live world position, never read by any tracking/pose decision. Every existing FOUND/updated log line that results in an accepted `applyPose()` call (bootstrap, a trustworthy re-detection, or a trustworthy pre-stabilization `'updated'` sample) now also logs the camera's current position, the anchor's resulting position, and the distance between them. This is the cheapest available way to discriminate (a) from (b) from ONE clean capture: if the camera's logged position jumps/teleports or the camera-to-anchor distance changes by an amount inconsistent with how far the user actually walked, that is direct, hard evidence for (b); if the camera moves smoothly and continuously while the ANCHOR's own logged position/ratio is what looks wrong at the moment of the visual glitch, that points at (a) and exactly which accepted sample caused it.

**The strategy going forward — the direct answer to "how do we stop doing a thousand iterations":** stop shipping a fix, then testing, then guessing again. Next step is exactly one physical session: reproduce the bug once with `?debug=1` on, and capture the FULL on-screen console text (long-press-select and copy, or mirror to a desktop browser via remote debugging — a photo has already cost real time to this investigation once before, §6 step 1, for the same reason: illegible/garbled transcription). That single capture, read against the new camera-diagnostic lines, should be enough to name which of (a)/(b) is real — at which point the next code change is aimed at a confirmed cause instead of a plausible one.

**Animation, unrelated to the anchor bug, reverted per direct feedback:** the §26 entry's scale-pulse `'voronoi'` illustration was reported as looking bad on-device. Reverted to the pre-pulse lateral right/left nudge mechanic (unchanged from its own last verified-correct state — same asymmetry-bug fix, same analytic per-frame formula), but the phone glyph used for this variant only is now a narrow PROFILE (edge-on) silhouette instead of the front-facing glyph `'orbit'` uses, per the request — a side-view phone nudging toward/away from the tracking-pattern glyph beside it reads as approaching/retreating rather than sliding sideways past it.

**Verified in software:** `npm run typecheck`/`build`/`test` clean, 53/53 (`FakeSession` in `ImageTargetAnchorSource.test.ts` gained a stubbed `getCameraPosition()` returning `null`, matching the real class's "not started" case — no test asserts on the new camera-diagnostic lines themselves, since they carry no tracking-decision weight to verify, only log content for a human to read from a real capture). **Not verifiable in software, and explicitly not attempted this pass:** which of hypothesis (a) or (b) is correct — that is what the next physical capture is for, not another code change.
