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
