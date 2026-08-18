# Asset Authoring Guide — Rive UI & MindAR Targets

Audience: anyone adding or changing the *content* of an experience (the Rive
UI, the tracked image, or a whole new target) without necessarily touching
the TypeScript modules. Read AR_SYSTEM.md first for the architecture rules
this guide operates inside of — this doc is the "how do I actually do the
thing" companion to that "what are the rules" document.

## 1. The mental model

Every AR experience in this project is three pieces glued together by one
manifest entry:

```
┌─────────────────────┐     ┌──────────────────────┐     ┌───────────────────┐
│  MindAR target       │     │  experience-manifest  │     │  Rive UI           │
│  *.mind file          │────▶│  entry (one targetId) │◀────│  *.riv file         │
│  (what the camera     │     │  packages/experience- │     │  (what renders on   │
│   recognizes)         │     │  manifest/manifest.ts │     │   top of it)        │
└─────────────────────┘     └──────────────────────┘     └───────────────────┘
```

Nothing in `src/client/*.ts` should ever reference an asset path directly —
`main.ts` calls `resolveExperience(targetId)`
(`packages/experience-manifest/ManifestResolver.ts`) and gets back the
`riveUrl`/`mindTargetUrl` for that experience. If you're adding content and
find yourself typing a `/assets/...` path into a `.ts` file, stop — it
belongs in the manifest instead (AR_SYSTEM.md §D/§E).

---

## 2. Editing the Rive UI

> **Phase 5 note:** everything in §2.1–2.3 describes the *legacy
> single-card* experience (`proxy-target`, `ui-test.riv`) — still accurate
> for that path. Spatial experiences (anything declaring `modelUrl`) use
> the **two-artboard contract in §2.4** instead: Rive bindings arrive per
> hotspot from the scene asset, not from `STATE_MACHINE_NAME`.

### 2.1 What this project expects from a `.riv` file

Read from `src/client/RiveController.ts` and `src/client/main.ts` — these
are hard constraints today, not suggestions:

| Constraint | Where it's enforced | What happens if you don't match it |
|---|---|---|
| Must have a **state machine** (not just a timeline animation) | `RiveController` constructs Rive with `stateMachines: <name>` and calls `pointerDown`/`pointerUp` on the state machine instance | Touch input silently does nothing — `RiveController.pointerDown/pointerUp` no-op via `this.stateMachine?.` if the state machine name doesn't match |
| The state machine's exact name must match `STATE_MACHINE_NAME` in `src/client/main.ts:11` | Passed into `new RiveController(riveUrl, STATE_MACHINE_NAME)` | Same as above — Rive fails to find a matching state machine and `RiveController.isReady` never becomes `true` |
| Artboard is rendered into a **512×512** offscreen canvas (`RIVE_CANVAS_SIZE` in `RiveController.ts`) using `Fit.contain` / `Alignment.center` | `RiveController.mapCanvasPointToArtboard()` | A non-square artboard gets letterboxed inside that 512×512 frame, same as any `Fit.contain` layout — design your artboard knowing the touch-mapping math assumes this exact fit/alignment pair. If you change canvas size or fit mode, update both in `RiveController.ts` together, they must stay consistent |
| Pointer input arrives in **artboard-space coordinates**, not canvas pixels | `mapCanvasPointToArtboard()` does the `computeAlignment → invert → mapXY` conversion for you | You don't need to do anything here as an artboard author — just know that any listener/hit area you build in the Rive editor should be positioned in normal artboard coordinates; the coordinate translation is handled entirely on the code side |

### 2.2 Replacing or updating the `.riv` file

1. Open/edit the file in the [Rive editor](https://rive.app/) (desktop or web).
2. Keep (or rename consistently) **one state machine** that receives the
   interaction — if you rename it, update `STATE_MACHINE_NAME` in
   `src/client/main.ts:11` in the same change.
3. Export/download the `.riv` file.
4. Drop it into `public/assets/` (e.g. `public/assets/ui-test.riv` — replace
   in place, or add a new filename if you're building a second experience,
   see §4).
5. If you replaced the file at its existing path, nothing else needs to
   change — the manifest already points `riveUrl` at that path. If you used
   a new filename, update `riveUrl` in
   `packages/experience-manifest/manifest.ts` to match.
6. Rebuild and test locally (§5).

### 2.3 Adding new interactive inputs

If you add new inputs to the state machine beyond simple
pointer down/up (e.g. a number or boolean input driven by AR tracking
state, not touch), you'll need a small addition to `RiveController.ts` — it
currently only exposes `pointerDown`/`pointerUp`. Look at
`RiveController`'s private `stateMachine` field
(`StateMachineInstance` from `@rive-app/canvas-lite/rive_advanced.mjs`) for
the available methods (`inputs()`, numeric/boolean input setters) before
adding a new public method to the class — keep the "no direct access to
Rive internals outside this file" boundary intact (see the `internals()`
cast and its comment at the top of `RiveController.ts` for why that
boundary exists).

### 2.4 Phase 5 UI — `bench-ui.riv` (Marker) + plain HTML/CSS (Card)

The spatial experience's UI is split across two different renderers, for
two different reasons — this is a **deliberate split, not an
inconsistency**, and the reasoning below is worth reading before assuming
one should just match the other.

**Marker** — still a Rive artboard, served from the manifest's `riveUrl`
(`/assets/bench-ui.riv`). Design rule: **the app owns placement, Rive
owns appearance.** Markers are repositioned every frame by the
projector — never keyframe an artboard sliding to a location. A marker is
small, fixed-size (120×120 design, 96 CSS px rendered), and never needs
to reflow around variable-length content, so a single Rive canvas is a
good fit and has never caused a rendering bug.

Author at 120×120 (the visual anchor must be the artboard **center**,
which the runtime pins to the projected hotspot point):

| Contract item | Exact name | Notes |
|---|---|---|
| State machine | `MarkerMachine` | bound per hotspot via the `riveStateMachine` custom property (authored by `tools/build_bench_scene.py`) |
| Boolean input | `isSelected` | default false; true while this marker's content is in the Card |
| Boolean input | `isDimmed` | default false; true on every *other* marker while one is selected |
| Hover/press feedback | Rive listeners inside the state machine | visuals only — no tap inputs or events; the app detects taps at the DOM level (single input path) |

Author states to tolerate any flag combination and rapid toggling.

**Card — plain HTML/CSS, not a Rive artboard (2026-08-14, corrected after
repeated failures).** The Card used to be a Rive artboard (`Card` in
`bench-ui.riv`) with `title`/`subtitle`/`body` text runs and a
`cardImage` referenced asset. That design went through five consecutive
physical-device fix attempts trying to make ONE Rive canvas keep its
header fixed while scrolling its body — including a canvas-cropping/
mirroring scheme that introduced its own browser paint-compositing bug —
because a single Rive canvas has no native way to do that at all. The
underlying problem was never Rive-specific: it's "keep a header fixed,
scroll the body," which HTML/CSS (`flex:none` header + `flex:1;
overflow-y:auto` content) does natively and has never needed a single
fix since switching to it. The Card is now built entirely in
`CardPanel.ts` — title, subtitle, body, and the close button/grabber are
real DOM elements, not Rive text runs or listeners. **There is no
authoring contract for the Card in `bench-ui.riv` any more** — don't
re-add a `Card` artboard there; if the Card's visual design needs to
change, change `CardPanel.ts`'s inline styles directly.

The `cardImage` field from the content sheet is now just an `<img src>`
— no Referenced/Embedded asset distinction, no CORS caveat (nothing
reads its pixels), any URL the sheet points at works the same way it
would in a plain web page.

**Hotspot custom properties (scene asset side):** each `hotspot_*` node
carries `label`, `contentKey`, `riveArtboard` (`Marker`), and
`riveStateMachine` (`MarkerMachine`) — authored in
`tools/build_bench_scene.py` (dominoes) and `tools/build_site_buildings.py`
(named buildings), all four required by `MarkerLayer` since Phase 5. These
are always the same two literal values (`Marker`/`MarkerMachine`) — there
is exactly one Marker artboard in `bench-ui.riv`, content-agnostic, reused
by every hotspot in the project; don't read "authored per hotspot" as an
invitation to design a per-content-type Marker unless the artboard itself
actually changes.

**Content source (Google Sheet):** the manifest's `contentUrl` points at
the sheet's gviz endpoint
(`https://docs.google.com/spreadsheets/d/<SHEET_ID>/gviz/tq?tqx=out:json`),
sharing set to "anyone with the link can view". First row is the header —
`contentKey | title | subtitle | body | imageUrl` (column order free, labels
exact) — one row per hotspot. All four content columns (`title`/
`subtitle`/`body`/`imageUrl`) must exist as headers, but any individual
cell may be left blank — `GoogleSheetContentProvider` treats a blank cell
as an absent field (the Card clears that text run/skips the image) rather
than a resolution error; only an unknown `contentKey`, a missing column,
or the sheet being unreachable/malformed still throw
`ContentResolutionError` (`src/client/ContentProvider.ts`). Root-relative
paths under `/public` (e.g. `/assets/content/images/domino-1.jpg`) are
recommended for images — absolute https URLs work only if the host serves
CORS headers. Editing a cell shows up on the next page load; no redeploy.

---

## 3. Creating or replacing a MindAR tracking target

### 3.1 What makes a good tracking image

MindAR (like most feature-based AR tracking) needs an image with strong,
irregular visual detail — not a design constraint of this codebase, but of
the underlying computer-vision technique:

- **High contrast and fine detail** — logos, photos, and illustrations with
  texture track far better than flat colors or simple shapes.
- **Asymmetric, non-repeating patterns** — avoid grids, checkerboards, or
  anything with repeated tiles; the tracker matches distinctive local
  features, and repetition creates ambiguous matches.
- **Avoid large flat/plain areas** — a mostly-white or mostly-solid-color
  image gives the tracker very little to lock onto.
- **Reasonable aspect ratio** — extremely thin/long images track less
  reliably than something closer to square.

If tracking feels jittery or fails to lock on with a new image, the image
itself — not the code — is almost always the first thing to check.

### 3.2 Compiling the image into a `.mind` file

MindAR doesn't track the raw image directly — it needs the image compiled
into its own descriptor format first. The standard, zero-setup way to do
this:

1. Go to the official MindAR image target compiler:
   `https://hiukim.github.io/mind-ar-js-doc/tools/compile/`
2. Upload your source image (PNG/JPG).
3. Click compile, wait for it to finish, download the resulting `.mind`
   file.

This is an **authoring-time tool you run once per image**, not a runtime
dependency — it doesn't conflict with this project's "no CDN dependency at
runtime" rule (AR_SYSTEM.md §C/§F), since nothing in the deployed app calls
out to it.

> **Programmatic alternative (optional, for scripted/CI compilation):**
> `mind-ar` (already a project dependency) exports a `Compiler` class from
> `mind-ar/dist/mindar-image.prod.js` with `compileImageTargets(images,
> onProgress)` and `exportData()` methods, usable from a plain Node script.
> It needs `canvas` (already in `node_modules` as a transitive dependency of
> `mind-ar`, but its native bindings aren't built by default in this repo —
> run `pnpm approve-builds` and select `canvas` if you want to go this
> route, which additionally requires Cairo/Pango system libraries via
> Homebrew on macOS). Not set up as a script in this repo today — only
> worth the setup cost if you're compiling many targets repeatedly or want
> this step in CI rather than done by hand in a browser.

### 3.3 Multiple targets in one `.mind` file

MindAR's compiler accepts multiple images and bakes them into a single
`.mind` file, indexed in upload order (0, 1, 2, …). This project currently
uses **one target at index 0** —
`ARSessionManager.start(0)` in `src/client/main.ts:33`
(`session.start(0)` → `mindAR.addAnchor(0)`). If you compile a `.mind` file
with more than one image, you must track which index corresponds to which
physical marker and pass the right index to `addAnchor()`/`start()` — there
is no per-target routing built yet (see AR_SYSTEM.md's routing-structure
note in the architecture review; each anchor still needs to be wired up in
`main.ts` by hand today).

### 3.4 Replacing the target file

1. Drop the new `.mind` file into `public/assets/`.
2. Update `mindTargetUrl` in
   `packages/experience-manifest/manifest.ts` to point at it (or replace
   the file in place at the existing path — then no manifest change is
   needed).
3. Rebuild and test locally (§5), ideally by printing the target image and
   pointing a phone camera at the physical printout — testing against a
   photo of the image on a screen behaves differently than a printed
   marker under real lighting.

### 3.5 Physical dimensions — the 4 site plaques and the digital-twin model

**For the step-by-step physical printing/mounting checklist (where each
plaque goes, in what orientation, and what's still placeholder), see
`docs/physical-plaque-placement.md`** — this section is the underlying
derivation data that doc pulls from; that one is the operational
walkthrough.

Recorded 2026-08-14 alongside wiring the 4 real site-plaque targets
(`site-front`/`site-back`/`site-left`/`site-right`, AR_SYSTEM.md §G Phase
3); **redesigned 2026-08-18** once the real ledge width (3.5cm) made the
original 50mm square plaque impossible to mount without overhanging.
Everything below is either a real, currently-printed value or is
explicitly marked placeholder — nothing here is rounded or invented; where
a number derives from model data or a script constant, that source is
named so it can be re-derived if the source changes.

**Each of the 4 plaques** (`tools/build_site_plaques.py`):

| Property | Value | Source |
|---|---|---|
| Plaque size | 90 × 30 mm (landscape) | `PLAQUE_WIDTH_MM`/`PLAQUE_HEIGHT_MM` — real, matches what's printed. 30mm leaves a deliberate 5mm margin within the real 3.5cm ledge, not just "smaller than it" |
| Artwork resolution | 2160 × 720 px (24px/mm, ≈610dpi) | `PX_PER_MM` — raised from the previous design's 20.48px/mm specifically because `@8thwall/image-target-cli` enforces a hard 640px minimum per dimension; 30mm at the old density (614px) failed outright |
| QR payload | `https://ar-ramapo.onrender.com` (same URL, all 4 — §A: identity is resolved by tracking, never the QR payload) | `AR_EXPERIENCE_URL` |
| `physicalTargetWidthMeters` | 0.09 | matches the plaque's WIDTH (long axis) exactly (manifest.ts `site-*` and `'site'` entries) |

**Layout within each 90×30mm plaque** (identical on all 4 except the
badge — computed from `tools/build_site_plaques.py`'s own `mm()`
placement math, not measured by hand; matches a reference design the
user supplied, QR left / instructional text right):

| Element | Position |
|---|---:|
| QR size (incl. quiet-zone border) | 23.33 mm, left-aligned 2.5mm from the left edge, vertically centered |
| "Scan me" / "Hold the camera to the image" text | starts ~4mm right of the QR block |
| Distinguishing badge (shape) | fixed column, centered 6mm from the right edge |
| Side label (e.g. "FRONT") | directly below the badge, same column |

The distinguishing badge is now a fixed-position column (not an actual
corner of the artwork, unlike the previous design) — since the plaque's
own 3:1 landscape aspect ratio already makes a 90°-rotated mounting
mistake obvious to a human installer (a wide sign turned sideways looks
wrong at a glance), the badge's job is purely tracking-distinctness
between the 4 designs and installer verification, not rotation-proofing.
Shape per side: front=triangle, back=circle, left=diamond, right=square
— see `SIDES`/`draw_badge_shape()` in `tools/build_site_plaques.py` if
you need the exact geometry.

**The digital-twin model** (`cad-source/handoff/site_terrain.json` /
`site_buildings.json`, real DWG-derived data — not placeholder):

| Element | Width (X) | Depth (Y) | Height (Z) |
|---|---:|---:|---:|
| Terrain footprint | 1606.55 mm | 1343.03 mm | 0–152.4 mm relief |
| Tallest building (top, above the Z=0 terrain plane) | — | — | 105.25 mm |

Terrain relief (0–152.4mm) is true-scale, no vertical exaggeration —
converted directly from the source DWG's real elevation range (450–930 ft)
by the same `ft_to_model_m` factor as the horizontal footprint.

**Ledge width — REAL, measured 2026-08-18** (was a 3in/76.2mm guess
before): `tools/build_site_buildings.py`'s `LEDGE_WIDTH_M` is now 3.5cm,
confirmed uniform on all 4 sides. The full baseboard is ALSO a real
measurement now, not derived from the ledge width —
`BASEBOARD_WIDTH_M`/`BASEBOARD_DEPTH_M` = **1675 × 1414 mm** — the two
were cross-checked against each other and agree to within ~1.5mm, well
inside manual-measurement tolerance. `site_ledge` in the Blender scene is
now a single full-rectangle mesh at this real size (previously a 4-strip
border ring at the guessed width).

**Plaque position on the model — derived from `site-scene.glb`, not
independently measured. Recomputed 2026-08-18** against the real ledge
width above and the new 90×30mm plaque geometry (previously derived
against the 76.2mm guess and the old 50mm square — both stale numbers
this recompute replaces). Implemented in `manifest.ts`'s `'site'` entry
`targets[].originOffsetMeters` — AR_SYSTEM.md §G has the full derivation
history. Each plaque's mesh-bounds center in `site-scene.glb`, relative
to `AR_World_Origin`, in glTF X/Z (Blender authors Y-up→export flips Y to
−Z, §F), cross-checked directly against the GLB's own binary vertex data,
not just the generating script's formulas:

| Plaque | X from origin | Z from origin |
|---|---:|---:|
| front | 803.275 mm | 20.488 mm |
| back | 803.275 mm | −1363.513 mm |
| left | −19.225 mm | −671.513 mm |
| right | 1625.775 mm | −671.513 mm |

**Plaque mounting rotation (`rotationYawDeg`) — derived, not measured or
invented, 2026-08-14, implemented in the same manifest entry.** Computed
from which edge of the terrain rectangle each plaque sits on (real,
authored geometry — `front`/`back` occupy the strips at the min/max-Z
edges after export; `left`/`right` the min/max-X edges) — the angle
between each plaque's outward edge-normal and `front`'s own (defined as
the 0° reference, matching the already-shipped single-plaque `site-front`
entry so the two stay consistent). **Re-verified 2026-08-18** against the
new geometry rather than assumed to still hold (the terrain's `v`-axis
sign flipped the same day, which changes individual edge-normal
components even though the values below turn out unchanged — recomputed
from scratch, not carried over on faith):

| Plaque | rotationYawDeg |
|---|---:|
| front | 0° (reference) |
| back | 180° |
| left | 90° |
| right | −90° |

**Note on "outward edge-normal" above — a math reference axis, not a
physical-facing claim:** that phrase describes how the angle was
*computed* (each edge's outward normal is an easy, unambiguous direction
to derive from the terrain rectangle's geometry), not which way the
printed artwork faces once mounted. Those are independent questions — the
mounting *rotation* (which way each plaque's artwork reads) is confirmed
2026-08-17 to be **inward**, toward the terrain center, in
`docs/physical-plaque-placement.md` §2. `rotationYawDeg`'s values above
are unaffected either way: they're *relative* corrections between the 4
plaques (front defines the 0° reference), so they hold regardless of
which absolute direction "front" itself reads toward.

**What this rotation derivation does NOT have, and doesn't claim to:** an
on-device-validated mount. `rotationYawDeg` itself is unaffected by mount
tilt (it's purely a function of which edge of the terrain rectangle the
plaque sits on), but it composes with `ImageTargetAnchorSource.ts`'s
`TARGET_FRAME_TO_WORLD_FIX` — the fixed target-frame-to-world glue, which
DOES depend on mount tilt. **Mounting orientation confirmed 2026-08-17
(coworker physical review): flat on the ledge, artwork facing up** — the
4 placeholder plaque volumes in `site-scene.glb` (flat magenta slabs
lying on top of the ledge, viewed from above) turn out to already match
the real intended mount, not just be a simple placeholder shape.
`TARGET_FRAME_TO_WORLD_FIX` was corrected accordingly: `identity()`
(2026-08-14, evidence-backed for the vertical-mount assumption that
turned out wrong) → `Rx(+90°)` (2026-08-17, reasoning from this project's
own already-validated MindAR glue for the identical flat-plaque shape,
`SceneGraphLoader.ts`'s `GLTF_TO_MINDAR_ROTATION_X_RADIANS`) — see
`docs/research/8th-wall-troubleshooting.md` §14 and its follow-up entry.
Still verified in software only (`src/client/ImageTargetAnchorSource.test.ts`'s
geometry self-consistency check), not yet against a real mounted plaque.

---

## 4. Registering a new experience in the manifest

`packages/experience-manifest/manifest.ts` is the only place asset paths
are declared. The schema (`ExperienceManifest`, same file):

```ts
type ExperienceManifest = {
  targetId: string;      // unique key you choose, e.g. "product-poster"
  riveUrl: string;       // root-relative path under /public, e.g. "/assets/poster-ui.riv"
  modelUrl?: string;     // reserved for future 3D-model support, optional
  mindTargetUrl?: string;// root-relative path to the compiled .mind file
  version: string;       // bump this whenever the asset bundle changes
};
```

To add a new experience:

1. Add both asset files under `public/assets/` (§2.2, §3.4).
2. Add a new entry to the `experienceManifest` array in `manifest.ts`:
   ```ts
   {
     targetId: 'product-poster',
     riveUrl: '/assets/poster-ui.riv',
     mindTargetUrl: '/assets/poster-target.mind',
     version: '0.1.0',
   }
   ```
3. **Asset URL rules, enforced at runtime** by
   `ManifestResolver.ts`'s validation
   (`ASSET_URL_PATTERN = /^\/\S+$/`): every URL must start with `/` and
   contain no whitespace — i.e. a root-relative path actually served from
   `/public`, never an absolute external URL, a bare filename, or an empty
   string. Get this wrong and `resolveExperience()` throws a
   `ManifestResolutionError` immediately at startup — loudly, not a silent
   404 later — telling you exactly which field and entry is malformed.

### Switching which experience is active

There's no target-selection UI yet — the active experience is a single
constant: `ACTIVE_TARGET_ID` in `src/client/main.ts:17`. To make your new
entry the one that loads, change that constant to your new `targetId` (and
update `STATE_MACHINE_NAME` on line 11 if your new `.riv` file uses a
different state machine name — see §2.1).

---

## 5. Testing locally after any asset change

```
pnpm build     # tsc (server) + vite build (client) — rebuilds public/dist
pnpm start     # boots the server; needs local certs for camera access,
               # see the main README/AR_SYSTEM.md for the mkcert setup
```

Then open `https://<your-lan-ip>:3000` on a phone on the same WiFi network,
grant camera access, and point it at the physical printed target. Things to
actually check, not just assume:

- Does the tracked plane/UI appear when the camera sees the marker, and
  disappear/re-anchor correctly when you move the camera away and back?
- Does touching the on-screen UI trigger the expected state-machine
  transition (not just render — actually respond to touch)?
- Open the browser console (remote-debug the phone from desktop Chrome/
  Safari if possible) and confirm there's no `ManifestResolutionError` or
  Rive/MindAR load error logged by `main()`'s `.catch()` handler.

---

## 6. Common pitfalls

- **State machine name mismatch** between the `.riv` file and
  `STATE_MACHINE_NAME` (`main.ts:11`) — the most common "nothing responds
  to touch" bug. Always change both together.
- **Manifest asset path typo** — caught loudly at startup by
  `ManifestResolver`, so check the console immediately rather than
  assuming a blank screen is a tracking problem.
- **Forgetting the anchor index** when compiling a multi-image `.mind`
  file (§3.3) — the visual target you're pointing the camera at might not
  be index `0`.
- **Non-square Rive artboards** rendering letterboxed — expected behavior
  given the `Fit.contain` layout (§2.1), not a bug, but worth designing
  around rather than being surprised by.
