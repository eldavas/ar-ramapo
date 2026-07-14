# AR System — 8th Wall + Rive Spike

This repo is a greenfield spike, branched from the parent repo
(`../ar-prototype` / `ar-ramapo`, `master`) whose `AR_SYSTEM.md` §F commits
to MindAR as "the only tracking library for the web layer... no competing
tracking library is introduced without a decision recorded in this file."
This file is that decision record for this branch.

## Decision: MindAR → 8th Wall (SLAM + GPS geofence), Rive UI retained

**Date:** 2026-07-08 (see also `/Users/davidrivera/.claude/plans/let-s-explore-a-different-reactive-corbato.md`)

**What changed:** the tracking layer moved from MindAR image-target
tracking (printed QR plaque as world origin) to Niantic's 8th Wall SLAM
world tracking, gated by a GPS geofence and started by user tap-to-place.
The Rive UI layer (`RiveController`, `MarkerLayer`, `CardPanel`,
`ContentProvider`, `bench-ui.riv`, the Marker/Card artboard contract) was
carried over unmodified — the entire "app owns placement, Rive owns
appearance" contract from the parent repo's `docs/asset-authoring-guide.md`
§2.4 still applies verbatim.

**Why:** the user wanted to explore a location-driven experience instead
of a printed-plaque one. As of Feb 28, 2026 the hosted 8th Wall platform
retired; 8th Wall now ships as a free, self-hostable engine binary
(`@8thwall/engine-binary`, no account/API key) with SLAM World Effects,
Image Targets, and Absolute Scale. Niantic's cm-precision VPS location
anchoring is *not* included — it's enterprise-only via Niantic Spatial —
so this spike uses the free path: a coarse GPS arrival gate plus SLAM
tap-to-place for the precise origin.

**Architecture consequence:** the world-origin source is now behind an
`AnchorSource` interface (`src/client/AnchorSource.ts`) rather than being
MindAR's anchor group directly. `TapPlacedAnchorSource` is the only
implementation today; an `ImageTargetAnchorSource` (8th Wall image target
on the same printed plaque, for a GPS+plaque hybrid) is a documented but
unbuilt extension point — see the plan file §5 Phase 5.

**Glue-transform consequence:** `SceneGraphLoader`'s meters↔marker-widths
scale bridge and the +90°X MindAR-frame rotation are gone. With the engine
configured `scale: 'absolute'`, world units are real meters, matching the
Blender-authored GLB directly — rotation identity, scale 1.

## License and attribution

The 8th Wall engine binary is **not MIT** — it ships under a Niantic
Spatial limited-use license (`node_modules/@8thwall/engine-binary/LICENSE`).
Key terms:
- Free for XR Engine purposes, revocable, non-transferable.
- §1.2 restricts use in a paid product/service whose value derives
  substantially from the Software's functionality — revisit before any
  commercial deployment of this spike.
- §1.3.1 requires attribution "in any material in which Licensee utilizes
  the functionality of the Software": this app renders the engine's own
  `resources/powered-by.svg` badge as a persistent, always-visible mark
  (`public/index.html`, `#powered-by-8thwall`) linking to 8thwall.org.
  Do not remove it without re-reading §1.3.

The framework/tooling (`@8thwall/xrextras`, the open `8thwall/8thwall`
monorepo) is MIT; only the compiled engine binary carries the limited-use
terms. Both facts are cited in `node_modules/@8thwall/engine-binary/README.md`.

## "No CDN at runtime" rule — still holds

Same rule as the parent repo (§C/§F there): the engine binary is
self-hosted from `/xr` (`server/createServer.ts`, an Express static route
over `node_modules/@8thwall/engine-binary/dist`), not loaded from
`cdn.jsdelivr.net`. Rive's wasm runtime is likewise self-hosted from
`/rive`, unchanged from the parent repo.

## Decision addendum (2026-07-08, round 2): QR image target = primary origin

The final 3D-printed model is fixed at a known site with a printed QR
plaque. `bench-park` flipped to `placement: 'image'`:
`ImageTargetAnchorSource` (`src/client/ImageTargetAnchorSource.ts`)
acquires on the first `reality.imagefound`, **continuously re-aligns** on
every subsequent sighting (drift correction), and relies on SLAM world
tracking to persist the anchor after `reality.imagelost` — scan once, walk
around. GPS remains an arrival gate only (now for any placement mode that
declares `geo`), never a positioning source. Tap-to-place remains a
supported placement mode per manifest entry.

Two §F glue constants live in `ImageTargetAnchorSource.ts` and nowhere
else: `TARGET_FRAME_TO_WORLD_FIX` (+90°X best-inference, validate on
device — see README's checkpoint) and the scale rule (anchor mounts at
scale 1 under absolute scale; `event.scale` is only a cross-check against
`physicalTargetWidthMeters`, warning on >25% divergence).

The compiled target (`public/assets/image-targets/bench-plaque/`) derives
from the same single-source `bench-plaque.png` artwork as the parent
repo's `.mind` target — §E's single-source rule holds across engines.

## Findings (2026-07-14): first on-device pass, canvas/Rive/content bugs fixed

First real-phone testing session (LAN HTTPS + `?fakegeo=1&fakear=1` desk-sim
bypass to exercise the full content pipeline without the physical plaque).
Found and fixed several bugs, all now resolved; recorded here so the next
person doesn't re-derive them.

**Canvas stuck at ~1/3 screen (300×150 default).** `EightWallSession.ts`
carried a "Phase 2E" doc comment asserting the engine owns resize end to
end and the app must never touch it — that conclusion was already disproven
on `master` (commit `0b3c63f`, "dual-path canvas sizing fix") via on-device
measurement: the engine never calls `renderer.setSize()` for this pipeline.
This branch forked before that fix landed and still had the stale
assumption. Ported the fix: `installFullWindowResize()` in
`EightWallSession.ts` (JS-driven `renderer.setSize(..., true)` on start and
every resize/orientationchange) plus a matching inline style on
`#camerafeed` in `public/index.html` as a redundant second path.

**`bench-ui.riv` silently became a ZIP bundle.** A Rive editor "Save"
action exported a zip (`hpr_card.riv` + a loose `cardImage-*.jpeg`) instead
of overwriting the `.riv` binary in place, and that zip landed at the
`bench-ui.riv` path. The JS runtime's error for this is the generic
`RiveFile.init()` failure "The file failed to load" — no marker/card ever
renders, no other symptom. **Diagnostic**: a real `.riv` starts with ASCII
`RIVE`; if `xxd -l4 public/assets/bench-ui.riv` shows `PK\x03\x04` instead,
it's a zip — `unzip -l` it and use the `.riv` inside. Root-caused, not yet
prevented; worth a pre-flight check in `server/createServer.ts` or a
build-time asset validator if this recurs.

**Marker artboard non-square broke center-anchoring.** The
`docs/asset-authoring-guide.md` §2.4 contract requires the `Marker`
artboard be authored square at 120×120 because the runtime always pins the
artboard's *geometric center* to the projected hotspot point
(`RiveController.mapCanvasPointToArtboard`, `Fit.contain` +
`Alignment.center`). It had drifted to 44×80 (tall, non-square), so
centering the whole icon+line+base composite left the "base" (the intended
ground-contact point) sitting well below the true anchor — visually
"drooping" toward the ground. Fixed in two passes: resized the artboard
back to 120×120, then rebuilt the marker's internal structure as plain
positioned `Node` children (`Icon`/`Dotted line`/`Base`) instead of nested
flex `LayoutComponent`s — the flex engine's `justifyContent`/`alignItems`
enum semantics did not match observed layout behavior after repeated
attempts, and plain x/y transforms are directly verifiable via
`query_property_values`. **Lesson for future marker edits**: the anchor
element (whatever should touch the 3D point) must sit at *exactly* the
artboard's center coordinates — centering the whole visual composite's
bounding box is not the same thing if the composite isn't itself symmetric
around its own touch point.

**Hotspot 3D anchor was at the domino's volumetric center, not its top.**
Confirmed via direct GLB node-transform math that all 4 `hotspot_*` empties
sat exactly at their parent domino mesh's bounding-box center (Blender's
default "origin to center of bounds" behavior) — correct 3D authoring, but
not what a "pin standing on top of the object" marker design wants.
Patched each hotspot's local Y translation directly in
`public/assets/bench-scene.glb` so its world position lands at the
domino's top-Y instead (X/Z unchanged). **This is a compiled-asset patch,
not a Blender-source fix** — there is no `.blend` file or
`tools/build_bench_scene.py` in this repo (per the README, `bench-scene.glb`
was copied from the parent repo's `bench-test` experience unchanged). If
this scene is ever re-exported from the real Blender source, this Y-offset
will be silently lost and needs re-applying (or, better, porting into the
source file itself).

**Card never appeared after tapping a marker — classic Rive state-persistence
trap.** `CardMachine`'s `Closed` state explicitly keyframes `Card_Body`
(the content container) to `opacity=0, y=380`. `OpenIdle` keyframed
neither property. Rive does not reset unkeyed properties to their design
default on a state transition — it leaves them at whatever the previously
active state last set. So `Closed → OpenIdle` inherited the hidden pose
forever, even though every other signal (state machine advancing, `isOpen`
set, no thrown errors, correctly-sized/positioned DOM container) looked
completely healthy. Fixed by explicitly keyframing `Card_Body`
`opacity=1, y=0` at frame 0 of `OpenIdle`. **General lesson**: if a Rive
state "does nothing" despite the state machine provably transitioning,
suspect a property that one state keys and a sibling state doesn't —
diff the keyframe sets across every state that touches the same object,
not just the state that "should" be responsible.

**Card briefly flashed on every fresh page load.** Before the state
machine's first `advance()` tick, Rive draws the artboard's static
(non-animated) base pose — and `Card_Body`'s authored base opacity was
`1.0` (visible), so there was a one-frame flash before `Entry → Closed`
took effect. Attempted to fix by writing the base `y` to `380` to match
`Closed` too, but discovered `Card_Body` is a `LayoutComponent` whose `y`
is continuously recomputed by the flex layout engine — a direct
property-set to `y` does not persist (verified: wrote a distinctive test
value, it reverted to `0` on the next read). Only `opacity`, a
non-layout-computed property, actually sticks as a base-value write.
Fixed by setting only the base `opacity` to `0` — sufficient, since a
fully transparent element is invisible regardless of its position.
**Lesson**: on a `LayoutComponent`, only non-layout properties (opacity,
color, etc.) can be corrected via a static base-value write; positional
properties (`y`, `x`, `positiontop`, ...) need either a keyframe in every
reachable state or a plain (non-layout) `Node` instead.

**Content sheet `imageUrl` column had Dropbox PDF share links, not
images.** `CardImageSlot.setImage()` fetches the URL and runs
`decodeImage()` on the bytes — a `www.dropbox.com/.../*.pdf?...&dl=0` link
fails on two independent counts: the share-link host doesn't send
`Access-Control-Allow-Origin` (blocked before the bytes are even read),
and it's a PDF, not a raster image, so decoding would fail regardless.
Not a code or Rive issue — the sheet owner corrected the column to real
image URLs and it now works. Confirms the guide's existing recommendation
(§2.4): prefer root-relative `/assets/...` paths (no CORS involved) over
third-party share links for `imageUrl`.

**Still open, deferred by choice**: the `Card` artboard's `isOpen`
transitions are wired directly from the state machine's `Any` state with a
220–280ms linear blend, not via dedicated named `Enter`/`Exit` animation
clips as `docs/asset-authoring-guide.md` §2.4 literally specifies. This
does satisfy the contract's *functional* requirement ("both transitions
must be interruptible" — an `Any`-state source is interruptible by
construction) and tested fine on-device after the fixes above, so it was
left as-is rather than restructured. Revisit if the guide's contract
wording is ever enforced literally, or if the current blend doesn't hold
up under faster real-world tap patterns than were tested here.

## Open items / not yet built

- **Real geofence coordinates**: `packages/experience-manifest/manifest.ts`
  ships placeholder coordinates (Ramapo College campus center) — record
  the real site with `?recordgeo=1` before any field test.
- **Plaque print width**: `physicalTargetWidthMeters: 0.05` is the parent
  desk plaque; measure the model's actual print and update.
- **On-device image-target checkpoint**: payload nesting, axis constant,
  scale cross-check — steps in README.md.
- **On-device verification**: the full content pipeline (scene load,
  hotspot projection, Rive markers, Card open/close/refresh, content-sheet
  images) has now been verified on a real phone browser (iPhone Safari,
  LAN HTTPS) via the `?fakegeo=1&fakear=1` desk-simulation bypasses — see
  "Findings (2026-07-14)" above. The real SLAM + image-target path itself
  (`ImageTargetAnchorSource`, scanning the physical plaque) is still
  untested on-device — the desk-sim bypass skips it entirely by design.
  Complete the "On-device checkpoint for the image-target path" below
  before trusting tracking quality/drift/scale accuracy.
