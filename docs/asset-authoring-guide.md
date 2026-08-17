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

### 2.4 Phase 5 contract — `bench-ui.riv` (Marker + Card)

The spatial experience's UI is one `.riv` file with **two artboards**,
served at the manifest's `riveUrl` (`/assets/bench-ui.riv`). The names
below are the load-bearing contract between the file and the runtime
(`MarkerLayer.ts`, `CardPanel.ts`); all are case-sensitive, and a mismatch
fails loudly at startup (wrong artboard/state-machine name) or on first
use (wrong input/text-run name), never silently.

Design rule behind everything here: **the app owns placement, Rive owns
appearance.** Markers are repositioned every frame by the projector — never
keyframe an artboard sliding to a location. The Card's canvas never moves —
its enter/exit motion lives entirely inside the artboard, which is why it
always animates from the same screen spot.

**Artboard `Marker`** — square, author at 120×120 (rendered at 96 CSS px;
the visual anchor must be the artboard **center**, which the runtime pins
to the projected hotspot point):

| Contract item | Exact name | Notes |
|---|---|---|
| State machine | `MarkerMachine` | bound per hotspot via the `riveStateMachine` custom property (authored by `tools/build_bench_scene.py`) |
| Boolean input | `isSelected` | default false; true while this marker's content is in the Card |
| Boolean input | `isDimmed` | default false; true on every *other* marker while one is selected |
| Hover/press feedback | Rive listeners inside the state machine | visuals only — no tap inputs or events; the app detects taps at the DOM level (single input path) |

Author states to tolerate any flag combination and rapid toggling.

**Artboard `Card`** — author at 350×480 design size (bottom-sheet
portrait; rendered full-width at the bottom of the screen). The
artboard's Auto Layout height is **Hug and that is load-bearing**: the
runtime lets the artboard grow/shrink with the bound content, and
`CardPanel` re-syncs its CSS aspect and canvas backing from the live
bounds every frame (troubleshooting doc §12). Keep width fixed at 350;
changing the height sizing mode away from Hug is a contract change, not
a cosmetic one.
At rest (`isOpen` false) it must show nothing — "closed" is an artboard
state, not a hidden canvas:

| Contract item | Exact name | Notes |
|---|---|---|
| State machine | `CardMachine` | |
| Boolean input | `isOpen` | default false. false→true plays Enter, true→false plays Exit; both transitions must be interruptible |
| Trigger input | `refresh` | quick content pulse fired when content swaps while already open; must be a visual no-op if fired mid-Enter |
| Text run | `title` | at the artboard root, exported name, non-empty placeholder value |
| Text run | `subtitle` | optional secondary line (e.g. a date/category tag) between title and body; may be set to an empty string — author it to collapse gracefully when blank |
| Text run | `body` | same as `title`; sheet content length is unbounded — don't clip/ellipsis it in the artboard, the runtime handles overflow (below) |
| Referenced image asset | `cardImage` | mark the image **Referenced** (not Embedded) with this exact asset name; the runtime substitutes its bitmap from the content source's `imageUrl` |
| Rive Event | `closeRequested` | type General, fired by the authored close button's listener. The button must NOT change `isOpen` itself — the app owns that state and answers the event |
| Fonts | embedded | export with fonts embedded; the runtime is self-hosted and referenced fonts would fail to resolve |

**Scrolling long content (2026-08-14, corrected same day):** the Card
artboard has no authored scroll/clip mechanism (confirmed via
`tools/dump_riv_objects.py` — no `ClippingShape` component exists on it)
and none is required — the runtime handles overflow entirely app-side.
An initial pass scrolled the WHOLE rendered sheet, which dragged the
grabber and close button off-screen with it — wrong, and corrected the
same day: `CardPanel.ts` now splits the DOM into a fixed header (a live
canvas mirror of the artboard's own top crop — grabber, title, subtitle,
close button, measured empirically via
`tools/inspect_card_header_boundary.mjs`, never guessed) that never
scrolls, and a separate scrollable wrapper for the body/image region
only. This is app-owned, not something to author in Rive; don't add
clip/scroll components to the Card artboard to "fix" overflow — the
runtime already handles it (troubleshooting doc §12/§13/§15).

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
3). Everything below is either a real, currently-printed value or is
explicitly marked placeholder — nothing here is rounded or invented; where
a number derives from model data or a script constant, that source is
named so it can be re-derived if the source changes.

**Each of the 4 plaques** (`tools/build_site_plaques.py`):

| Property | Value | Source |
|---|---|---|
| Plaque size | 50 × 50 mm | `SIZE_MM` — real, matches what's printed |
| Artwork resolution | 1024 × 1024 px (≈520 dpi at 50mm) | `SIZE_PX` |
| QR payload | `https://ar-ramapo.onrender.com` (same URL, all 4 — §A: identity is resolved by tracking, never the QR payload) | `AR_EXPERIENCE_URL` |
| `physicalTargetWidthMeters` | 0.05 | matches plaque size exactly (manifest.ts `site-*` entries) |

**QR position within each 50mm plaque** (identical layout on all 4 —
computed from `tools/build_site_plaques.py`'s own `mm()`/QR-placement
math, not measured by hand):

| Measurement | Value |
|---|---:|
| QR size (incl. quiet-zone border) | 30.71 mm (629 px) |
| From left edge | 9.62 mm |
| From right edge | 9.67 mm |
| From top edge | 8.98 mm |
| From bottom edge | 10.30 mm |
| QR center from left edge | 24.98 mm |
| QR center from top edge | 24.34 mm |

(Left/right and top/bottom aren't perfectly symmetric — the QR module
count doesn't divide the plaque evenly at this scale/error-correction
level; both are correct as computed, not a rounding artifact.) Each
side's distinguishing corner mark (triangle/circle/diamond, one shape per
corner) is a 9mm bounding box inset from its corner — see
`draw_corner_shape()`/`corner_origin()` in the same script if you need its
exact placement too.

**The digital-twin model** (`cad-source/handoff/site_terrain.json` /
`site_buildings.json`, real DWG-derived data — not placeholder):

| Element | Width (X) | Depth (Y) | Height (Z) |
|---|---:|---:|---:|
| Terrain footprint | 1606.55 mm | 1343.03 mm | 0–152.4 mm relief |
| Tallest building (top, above the Z=0 terrain plane) | — | — | 105.25 mm |

Terrain relief (0–152.4mm) is true-scale, no vertical exaggeration —
converted directly from the source DWG's real elevation range (450–930 ft)
by the same `ft_to_model_m` factor as the horizontal footprint.

**PLACEHOLDER, not yet measured** (`tools/build_site_buildings.py`'s
`LEDGE_WIDTH_M`, `cad-source/handoff/README.md`'s "Known open item"): the
mounting ledge around the terrain is currently authored at a 3-inch
(76.2mm) *guess*, giving a placeholder total footprint (terrain + ledge on
all 4 sides) of **1758.95 × 1495.43 mm**. This number moves once the real
ledge width lands — swap `LEDGE_WIDTH_M` and re-run
`tools/export_handoff_bundle.py`.

**Plaque position on the model — derived from `site-scene.glb`, not
independently measured; the one placeholder INPUT upstream of these
otherwise-real numbers is the ledge guess above (2026-08-14: implemented
as `manifest.ts`'s `'site'` entry `targets[].originOffsetMeters`, not
just documented — AR_SYSTEM.md §G has the full derivation and the
software verification).** Each plaque's mesh-bounds center in
`site-scene.glb`, relative to `AR_World_Origin`, in glTF X/Z (Blender
authors Y-up→export flips Y to −Z, §F — this is why "north" reads as a
negative Z for `front`, not a sign error):

| Plaque | X from origin | Z from origin |
|---|---:|---:|
| front | 803.275 mm | −38.100 mm |
| back | 803.275 mm | 1381.125 mm |
| left | −38.100 mm | 671.512 mm |
| right | 1644.650 mm | 671.512 mm |

**Plaque mounting rotation (`rotationYawDeg`) — derived, not measured or
invented, 2026-08-14, implemented in the same manifest entry.** Computed
from which edge of the terrain rectangle each plaque sits on (real,
authored geometry: `front`/`back` occupy the strips at Y≈0/Y≈−depth in
`build_site_buildings.py`'s `strips` dict, i.e. the min/max-Z edges after
export; `left`/`right` the min/max-X edges) — the angle between each
plaque's outward edge-normal and `front`'s own (defined as the 0°
reference, matching the already-shipped single-plaque `site-front` entry
so the two stay consistent):

| Plaque | rotationYawDeg |
|---|---:|
| front | 0° (reference) |
| back | 180° |
| left | 90° |
| right | −90° |

**What this rotation derivation does NOT have, and doesn't claim to:** an
on-device-validated mount. The 4 placeholder plaque volumes in
`site-scene.glb` are flat magenta slabs lying on top of the ledge (viewed
from above), not upright wall-mounted plaques — no *authored* facing
direction exists to read a value from, so the numbers above assume a
standard perpendicular-to-edge, artwork-upright vertical mount (the only
sane default for a museum-placard-style plaque). This composes with
`ImageTargetAnchorSource.ts`'s `TARGET_FRAME_TO_WORLD_FIX` — the fixed
target-frame-to-world glue, corrected 2026-08-14 from `Rx(+90°)` to
`identity()` after a physical test showed the scene rendering tilted
(root-caused against external 8th Wall + three.js evidence, docs/research/
8th-wall-troubleshooting.md §14) — but is itself still an independent,
not-yet-on-device-validated assumption: verified in software only (a
dedicated geometry self-consistency test,
`src/client/ImageTargetAnchorSource.test.ts`), not yet against a real
mounted plaque.

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
