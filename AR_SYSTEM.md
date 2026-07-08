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

## Open items / not yet built

- **Real geofence coordinates**: `packages/experience-manifest/manifest.ts`
  ships placeholder coordinates (Ramapo College campus center) — record
  the real site with `?recordgeo=1` before any field test.
- **Plaque print width**: `physicalTargetWidthMeters: 0.05` is the parent
  desk plaque; measure the model's actual print and update.
- **On-device image-target checkpoint**: payload nesting, axis constant,
  scale cross-check — steps in README.md.
- **On-device verification**: this spike has been verified in-browser via
  the `?fakegeo=1&fakear=1` desk-simulation bypasses (see README.md). SLAM
  world tracking itself only runs on real phones — the engine rejects
  desktop sessions with "No valid session manager to handle this session."
  On-device HTTPS testing (iPhone Safari, Android Chrome) is required
  before calling tracking quality/drift/scale accuracy validated.
