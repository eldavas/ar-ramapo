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
   */
  physicalTargetWidthMeters?: number;
  version: string;
};

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
    modelUrl: '/assets/bench-scene.glb',
    usdzUrl: '/assets/bench-scene.usdz',
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
    version: '0.4.2',
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
    modelUrl: '/assets/bench-scene.glb',
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
    version: '0.1.1',
  },
];
