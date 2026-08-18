// Asset system source of truth — AR_SYSTEM.md §E.
//
// As of Phase 1, this is load-bearing: src/client/main.ts resolves its
// active experience through ManifestResolver.ts (in this same directory)
// instead of referencing asset paths as string literals. Adding a target
// means adding an entry here, not editing application code.
//
// Golden Rule (AR_SYSTEM.md §E): this schema carries global physical
// constraints and asset-path routing ONLY. UI interaction attributes —
// Rive artboard bindings, state-machine keys, card copy — are forbidden
// here; they live inside the 3D asset itself as Blender custom properties
// (glTF `extras` → `object.userData`), discovered at runtime by tree
// traversal (see src/client/SceneGraphLoader.ts).

export type PlacementMode = 'tap' | 'image';

/**
 * GPS arrival gate for an 8th Wall experience (§E — a global physical
 * constraint of the experience, not UI data, same reading as
 * physicalTargetWidthMeters). Never a positioning source: GPS accuracy on
 * phones is 10–30 m outdoors, so this only gates arrival — the precise
 * origin comes from SLAM tap-placement or an image target.
 */
export interface GeoFenceSpec {
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

export type ExperienceManifest = {
  targetId: string;
  riveUrl: string;
  /** Baked 3D mesh (glTF/GLB) for the web runtime — never raw CAD (§A). */
  modelUrl?: string;
  /**
   * USDZ export of the same baked scene, consumed by the future iOS App
   * Clip. Same Blender source, different export — never a separately
   * authored asset (§E).
   */
  usdzUrl?: string;
  /** MindAR's compiled tracking target. Legacy engine path — an entry
   * declares either this (MindAR) or `placement` (8th Wall), never both. */
  mindTargetUrl?: string;
  /**
   * Tracking-engine selector for the 8th Wall path. Undefined means the
   * legacy MindAR path (routed off `mindTargetUrl`, unchanged since
   * Phase 1); present means 8th Wall SLAM owns this experience:
   *  - 'tap'   — GPS geofence gates arrival, then SLAM tap-to-place sets
   *              the origin (requires `geo`).
   *  - 'image' — an 8th Wall image target on the printed plaque sets the
   *              origin (requires `imageTargetUrl` + `physicalTargetWidthMeters`).
   */
  placement?: PlacementMode;
  /** GPS arrival gate, 8th Wall path only. See `placement`. */
  geo?: GeoFenceSpec;
  /**
   * Compiled 8th Wall image-target JSON for `placement: 'image'` (built
   * with `npx @8thwall/image-target-cli`, committed under
   * /assets/image-targets/). The 8th Wall analogue of `mindTargetUrl` —
   * never both declared on the same entry.
   */
  imageTargetUrl?: string;
  /**
   * Raw plaque artwork (PNG) for tracking engines that consume the image
   * directly instead of a compiled feature file: ARKit builds its
   * ARReferenceImage from this bitmap plus physicalTargetWidthMeters.
   * Same single-source artwork bench-target.mind was compiled from —
   * never a separately authored image (§E, §F). Required on any entry the
   * iOS App Clip consumes.
   */
  trackingImageUrl?: string;
  /**
   * Route to the experience's external display-content source, resolved by
   * the client-side ContentProvider seam (§E Golden Rule amendment,
   * Phase 5). Carries a URL only — never content. The one field permitted
   * to be an absolute https:// URL (an external source by definition;
   * Phase 5 points it at a Google Sheet gviz endpoint, a future CMS is the
   * same field with a different URL); root-relative /public paths are also
   * accepted.
   */
  contentUrl?: string;
  /**
   * Printed physical width of the tracking target, in meters. Required on
   * any entry that declares modelUrl (enforced by ManifestResolver): it is
   * the sole scale bridge between meter-authored content and the tracking
   * engines — MindAR anchor space is measured in marker-widths and needs
   * the ×(1/width) conversion; ARKit sizes its ARReferenceImage from the
   * same number (§E, §F).
   *
   * Required on every entry in `targets[]` below too (each plaque has its
   * own printed width — in practice the same value on all of them, since
   * they're printed at the same size, but declared per-target because
   * nothing enforces them being identical).
   */
  physicalTargetWidthMeters?: number;
  /**
   * Multi-target plaques (§A/§E "Multi-target plaques" forward design,
   * implemented 2026-08-14): for an experience with more than one physical
   * tracking plaque converging on the same site-scene — the production
   * Ramapo layout, one plaque per side — the singular `imageTargetUrl`/
   * `mindTargetUrl` above are insufficient (they assume exactly one target,
   * with its own center as the origin). Declares this instead, XOR with
   * those singular fields (mirrors the existing dual-engine optional-field
   * pattern rather than introducing a new one). 8th Wall only today —
   * `mindTargetIndex` is reserved per the original design but unconsumed;
   * MindAR multi-target routing is still "not yet built" (§G, unchanged).
   */
  targets?: PlaqueTarget[];
  version: string;
};

/**
 * One physical plaque within a multi-target experience. `imageTargetUrl`'s
 * data is merged with every other target's before being handed to 8th
 * Wall's `XrController.configure({ imageTargetData })` — the engine
 * natively tracks multiple simultaneously-armed image targets and reports
 * which one fired via `Xr8ImageTrackedEvent.name`; `ImageTargetAnchorSource`
 * routes on that name to the matching entry below.
 */
export interface PlaqueTarget {
  /** MindAR: index within one multi-image .mind bundle. Reserved, unused today. */
  mindTargetIndex?: number;
  /** 8th Wall: this plaque's compiled image-target JSON (§E). */
  imageTargetUrl?: string;
  /**
   * 8th Wall: the target `name` carried on `Xr8ImageTrackedEvent`, matching
   * it to this entry at runtime. Optional — defaults to the compiled
   * target's own `name` field (image-target-cli names it after the output
   * folder; see ImageTargetLoader) when the two already agree, which is the
   * common case; only needed if they must differ.
   */
  imageTargetName?: string;
  physicalTargetWidthMeters: number;
  /**
   * This plaque's position, measured from the §A reference corner (the
   * scene's own authored origin — `AR_World_Origin` in site-scene.glb), in
   * the model's own local X/Z (glTF Y-up: X = east/west, Z = north/south).
   * Derived directly from `site-scene.glb`'s own `plaque_{front,back,left,
   * right}` mesh bounds (which trace back to `tools/build_site_buildings.py`'s
   * `plaque_centers` dict — not independently measured or invented) — see
   * that script and AR_SYSTEM.md §G for the derivation and its one
   * placeholder input (`LEDGE_WIDTH_M`, still a fabricator-unconfirmed
   * guess; these offsets move if that constant changes and the scene is
   * re-exported).
   */
  originOffsetMeters: { x: number; z: number };
  /**
   * Corrects this plaque's physical mount rotation, in degrees, so content
   * anchors identically in world space regardless of which plaque
   * triggered tracking. Derived geometrically from which edge of the
   * terrain rectangle each plaque sits on (real, authored geometry — see
   * AR_SYSTEM.md §G), relative to `site-front`'s own mount as the 0°
   * reference (matching the already-shipped single-plaque `site-front`
   * entry, so the two stay consistent). NOT validated on a physical mount:
   * the placeholder plaque volumes in site-scene.glb are flat top-down
   * markers with no authored facing direction, so this assumes a
   * perpendicular-to-edge, artwork-upright vertical mount — the standard
   * assumption for this kind of plaque, but unverified against a real
   * fabricated mount (same "best inference, validate on device" status
   * ImageTargetAnchorSource.ts's own TARGET_FRAME_TO_WORLD_FIX already
   * carries for the single-target path this composes with).
   */
  rotationYawDeg: number;
}

export const experienceManifest: ExperienceManifest[] = [
  {
    targetId: 'proxy-target',
    riveUrl: '/assets/ui-test.riv',
    mindTargetUrl: '/assets/proxy-target.mind',
    version: '0.1.0',
  },
  {
    // Phase 3 bench-test rig (AR_SYSTEM.md §G): 5×5 cm QR plaque at the
    // physical origin, game-box baseboard stand-in, four domino building
    // proxies. bench-scene.glb (Blender export) and bench-target.mind
    // (compiled QR plaque) are authored during Phase 3 — until they exist
    // under /public/assets, resolving this entry fails at fetch time, not
    // silently.
    targetId: 'bench-test',
    riveUrl: '/assets/bench-ui.riv',
    modelUrl: '/assets/site-scene.glb',
    usdzUrl: '/assets/site-scene.usdz',
    mindTargetUrl: '/assets/bench-target.mind',
    trackingImageUrl: '/assets/bench-plaque.png',
    // Phase 5 external-content source (§E): a Google Sheet with header row
    // contentKey | title | subtitle | body | imageUrl, shared "anyone with
    // the link can view". One row per hotspot contentKey declared in
    // tools/build_bench_scene.py (bench-domino-1..4); subtitle/imageUrl are
    // optional columns, currently blank.
    contentUrl: 'https://docs.google.com/spreadsheets/d/1O4Zq8ggc7TgjKZIuUtufO-G9hJiK2KalJpD2Cux2sN8/gviz/tq?tqx=out:json',
    physicalTargetWidthMeters: 0.05,
    // 0.2.0: all four hotspot_* nodes in bench-scene.glb now declare
    // riveStateMachine (was two of four).
    // 0.3.0 (Phase 4): usdzUrl declared (the file was served but never
    // reachable through the manifest); trackingImageUrl added for ARKit;
    // bench-scene.usdz re-exported as a Y-up .usda package (§F/§G Phase 4).
    // 0.4.0 (Phase 5): riveUrl → bench-ui.riv (two artboards: Marker,
    // Card); hotspots gain contentKey + riveArtboard custom properties and
    // riveStateMachine renames 'State Machine 1' → 'MarkerMachine';
    // contentUrl introduced (external content seam).
    // 0.4.1: contentUrl points at the real, populated Google Sheet
    // (previously the unfilled REPLACE_WITH_SHEET_ID placeholder, which
    // resolved but always failed at fetch time — the Card never opened).
    // 0.4.2: bench-ui.riv fixed per the 2026-07-10 invisible-Card root
    // cause (OpenIdle now re-keys Card_Body opacity/y; base opacity 0
    // kills the first-load flash; Marker artboard back to the contracted
    // 120×120 square) plus Card title/subtitle text runs restored;
    // bench-scene.glb hotspot anchors moved from each domino's volumetric
    // center to its top-Y (§G Phase 6, 2026-07-14 on-device findings).
    // 0.5.0: modelUrl/usdzUrl swapped from bench-scene.* to the digital-twin
    // handoff bundle's site-scene.* (cad-source/handoff/, copied into
    // /public/assets). mindTargetUrl/trackingImageUrl/physicalTargetWidthMeters
    // are still bench-plaque's (5cm QR) — the real 4-plaque tracking swap is
    // a separate, not-yet-built step (§E).
    // 0.5.1: site-scene.glb re-exported — hotspot_building_* nodes now carry
    // riveArtboard/riveStateMachine ("Marker"/"MarkerMachine", the same
    // shared values every hotspot in this project binds; see
    // tools/build_site_buildings.py's 2026-08-13 third-pass revision note).
    // Fixes the 0.5.0 MarkerLayer.requireString crash. STILL OPEN: 8 of the
    // 12 site-building-* rows in the content sheet above are missing a body
    // value, which makes GoogleSheetContentProvider fail its (session-wide,
    // eager) parse for every contentKey, not just the incomplete rows — a
    // content-authoring gap in the sheet, not a code or asset defect.
    version: '0.5.1',
  },
  {
    // Phase 2C: 8th Wall test entry (AR_SYSTEM.md's 8th-wall decision
    // record) — reuses bench-test's own content (same bench-scene.glb,
    // bench-ui.riv, and populated Google Sheet) so this exercises exactly
    // the same MarkerLayer/CardPanel/ContentProvider pipeline as bench-test,
    // isolating the variable under test to the tracking engine itself.
    // A separate targetId (never bench-test's own) so flipping
    // ACTIVE_TARGET_ID in main.ts back to 'bench-test' instantly restores
    // the MindAR path with zero manifest changes.
    targetId: '8thwall-test',
    riveUrl: '/assets/bench-ui.riv',
    modelUrl: '/assets/site-scene.glb',
    placement: 'image',
    // Compiled from bench-plaque.png with `npx @8thwall/image-target-cli`
    // (single-source artwork rule, §E/§F) — regenerate if the plaque art
    // changes. Extracted from the 8th-wall branch (git checkout 8th-wall --
    // public/assets/image-targets/), same as bench-plaque.png itself.
    imageTargetUrl: '/assets/image-targets/bench-plaque/bench-plaque.json',
    trackingImageUrl: '/assets/bench-plaque.png',
    physicalTargetWidthMeters: 0.05,
    // PLACEHOLDER COORDINATES (Ramapo College campus center) — desk/local
    // testing bypasses the fence entirely with ?fakegeo=1 (see
    // GeoFenceService). Replace with the real site's lat/lng before any
    // field test; radius is deliberately generous — the fence is an
    // arrival gate, not a positioning source.
    geo: {
      latitude: 41.0817,
      longitude: -74.174,
      radiusMeters: 30,
    },
    contentUrl: 'https://docs.google.com/spreadsheets/d/1O4Zq8ggc7TgjKZIuUtufO-G9hJiK2KalJpD2Cux2sN8/gviz/tq?tqx=out:json',
    // 0.1.1: same shared-asset fix as bench-test 0.4.2 (bench-ui.riv Card
    // visibility + Marker anchoring, bench-scene.glb top-Y hotspots).
    // 0.2.0: modelUrl swapped bench-scene.glb -> site-scene.glb.
    // 0.2.1: same site-scene.glb re-export as bench-test 0.5.1 above
    // (riveArtboard/riveStateMachine added to the building hotspots; same
    // still-open sheet-content gap noted there).
    version: '0.2.1',
  },
  // ---------------------------------------------------------------------
  // SINGLE-ENGINE VALIDATION HARNESS, not the production entry (see 'site'
  // below for that): 4 standalone MindAR entries, one per real plaque
  // (AR_SYSTEM.md §G Phase 3 production-swap notes, 2026-08-14). Each of
  // tools/plaque/site/plaque-{front,back,left,right}.png is compiled into
  // its own single-image .mind target (tools/compile_mind_target.mjs
  // <png> <mind> — the same compiler bench-target.mind uses, now
  // parameterized for any image) and gets its own manifest entry — the
  // existing single-plaque MindAR architecture (§A's original rule: the QR
  // plaque center is the scene's absolute origin) applied 4 times. Kept
  // for exactly what bench-test/8thwall-test are already kept for: a
  // MindAR-specific (as opposed to 8th Wall) tracking-quality/regression
  // harness against the real printed artwork and the real site-scene —
  // each anchors the FULL site-scene centered on whichever single plaque
  // was scanned, which is NOT how the real four-plaque experience behaves
  // (that needs the shared-corner offsets in 'site' below). Never the
  // active production default (see ACTIVE_TARGET_ID, src/client/main.ts).
  {
    targetId: 'site-front',
    riveUrl: '/assets/bench-ui.riv',
    modelUrl: '/assets/site-scene.glb',
    usdzUrl: '/assets/site-scene.usdz',
    mindTargetUrl: '/assets/site-front-target.mind',
    trackingImageUrl: '/assets/site-front-plaque.png',
    contentUrl: 'https://docs.google.com/spreadsheets/d/1O4Zq8ggc7TgjKZIuUtufO-G9hJiK2KalJpD2Cux2sN8/gviz/tq?tqx=out:json',
    // Matches the printed plaque's real, fabricated WIDTH (the long axis)
    // — tools/build_site_plaques.py's PLAQUE_WIDTH_MM constant. Not a
    // guess: it's simply what the plaques are printed at (tools/plaque/
    // site/print-sheet.html). 2026-08-18: redesigned from a 50mm square
    // to a 90x30mm landscape layout (real ledge is 3.5cm, a square this
    // large no longer fit) — this is the 90mm width, not the 30mm height;
    // MindAR's own convention scales by the source image's width.
    physicalTargetWidthMeters: 0.09,
    version: '0.1.0',
  },
  {
    targetId: 'site-back',
    riveUrl: '/assets/bench-ui.riv',
    modelUrl: '/assets/site-scene.glb',
    usdzUrl: '/assets/site-scene.usdz',
    mindTargetUrl: '/assets/site-back-target.mind',
    trackingImageUrl: '/assets/site-back-plaque.png',
    contentUrl: 'https://docs.google.com/spreadsheets/d/1O4Zq8ggc7TgjKZIuUtufO-G9hJiK2KalJpD2Cux2sN8/gviz/tq?tqx=out:json',
    physicalTargetWidthMeters: 0.09,
    version: '0.1.0',
  },
  {
    targetId: 'site-left',
    riveUrl: '/assets/bench-ui.riv',
    modelUrl: '/assets/site-scene.glb',
    usdzUrl: '/assets/site-scene.usdz',
    mindTargetUrl: '/assets/site-left-target.mind',
    trackingImageUrl: '/assets/site-left-plaque.png',
    contentUrl: 'https://docs.google.com/spreadsheets/d/1O4Zq8ggc7TgjKZIuUtufO-G9hJiK2KalJpD2Cux2sN8/gviz/tq?tqx=out:json',
    physicalTargetWidthMeters: 0.09,
    version: '0.1.0',
  },
  {
    targetId: 'site-right',
    riveUrl: '/assets/bench-ui.riv',
    modelUrl: '/assets/site-scene.glb',
    usdzUrl: '/assets/site-scene.usdz',
    mindTargetUrl: '/assets/site-right-target.mind',
    trackingImageUrl: '/assets/site-right-plaque.png',
    contentUrl: 'https://docs.google.com/spreadsheets/d/1O4Zq8ggc7TgjKZIuUtufO-G9hJiK2KalJpD2Cux2sN8/gviz/tq?tqx=out:json',
    physicalTargetWidthMeters: 0.09,
    version: '0.1.0',
  },
  // ---------------------------------------------------------------------
  // PRODUCTION ENTRY (2026-08-14): the real four-plaque experience — 8th
  // Wall, `targets[]`, any of the 4 real plaques converges on the same
  // site-scene/hotspots/Marker/Card/content pipeline, correctly positioned
  // relative to the shared §A reference corner (`AR_World_Origin` in
  // site-scene.glb) rather than re-centered on whichever plaque fired.
  // This is what `ACTIVE_TARGET_ID` (src/client/main.ts) points at.
  //
  // originOffsetMeters/rotationYawDeg below are DERIVED, not measured or
  // invented — see AR_SYSTEM.md §G for the full derivation and the exact
  // Blender/script objects each number traces back to. Short version:
  // offsets come straight from site-scene.glb's own plaque_{side} mesh
  // bounds (which trace to tools/build_site_buildings.py's plaque_specs
  // dict); rotations come from which edge of the terrain rectangle each
  // plaque sits on (also real, authored geometry), relative to
  // 'site-front' above as the 0° reference.
  //
  // RECOMPUTED 2026-08-18 (both LEDGE_WIDTH_M and BASEBOARD_WIDTH_M/DEPTH_M
  // are now real measurements, not guesses — see the digital-twin sourcing
  // project notes — and the plaques themselves were redesigned from a 50mm
  // square to a 90x30mm landscape layout, hence physicalTargetWidthMeters
  // 0.05 -> 0.09 too). rotationYawDeg is unchanged (0/180/90/-90): it only
  // depends on which edge each plaque sits on, not on ledge width or
  // plaque size, and was re-verified against the new geometry, not assumed
  // to still hold. originOffsetMeters values below are re-derived the same
  // way as before — mesh-bounds center of each plaque_{side} object in the
  // regenerated site-scene.glb, cross-checked directly against the GLB's
  // own binary vertex data (not just the generating script's formulas) —
  // and will move again if LEDGE_WIDTH_M or the plaque size changes and
  // the scene is re-exported, same as before.
  {
    targetId: 'site',
    riveUrl: '/assets/bench-ui.riv',
    modelUrl: '/assets/site-scene.glb',
    usdzUrl: '/assets/site-scene.usdz',
    placement: 'image',
    contentUrl: 'https://docs.google.com/spreadsheets/d/1O4Zq8ggc7TgjKZIuUtufO-G9hJiK2KalJpD2Cux2sN8/gviz/tq?tqx=out:json',
    targets: [
      {
        imageTargetUrl: '/assets/image-targets/site-front/site-front.json',
        physicalTargetWidthMeters: 0.09,
        originOffsetMeters: { x: 0.803275, z: 0.020488 },
        rotationYawDeg: 0,
      },
      {
        imageTargetUrl: '/assets/image-targets/site-back/site-back.json',
        physicalTargetWidthMeters: 0.09,
        originOffsetMeters: { x: 0.803275, z: -1.363513 },
        rotationYawDeg: 180,
      },
      {
        imageTargetUrl: '/assets/image-targets/site-left/site-left.json',
        physicalTargetWidthMeters: 0.09,
        originOffsetMeters: { x: -0.019225, z: -0.671513 },
        rotationYawDeg: 90,
      },
      {
        imageTargetUrl: '/assets/image-targets/site-right/site-right.json',
        physicalTargetWidthMeters: 0.09,
        originOffsetMeters: { x: 1.625775, z: -0.671513 },
        rotationYawDeg: -90,
      },
    ],
    version: '0.1.0',
  },
];
