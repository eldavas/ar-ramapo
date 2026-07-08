// Asset system source of truth — AR_SYSTEM.md §E.
//
// Load-bearing since the parent repo's Phase 1: src/client/main.ts
// resolves its active experience through ManifestResolver.ts (in this same
// directory) instead of referencing asset paths as string literals. Adding
// a target means adding an entry here, not editing application code.
//
// Golden Rule (AR_SYSTEM.md §E): this schema carries global physical
// constraints and asset-path routing ONLY. UI interaction attributes —
// Rive artboard bindings, state-machine keys, card copy — are forbidden
// here; they live inside the 3D asset itself as Blender custom properties
// (glTF `extras` → `object.userData`), discovered at runtime by tree
// traversal (see src/client/SceneGraphLoader.ts). A geofence qualifies for
// the manifest under the same reading that physicalTargetWidthMeters did:
// it is a global physical constraint of the experience, not UI data.

export type PlacementMode = 'tap' | 'image';

export interface GeoFenceSpec {
  latitude: number;
  longitude: number;
  /**
   * Gate radius. GPS accuracy on phones is 10–30 m outdoors, so treat this
   * as a coarse arrival gate (≥ 25–30 m), never a positioning source — the
   * precise origin comes from SLAM tap-placement (or an image target on
   * the hybrid path), not from the fence.
   */
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
  /**
   * How this experience establishes its world origin:
   *  - 'tap'   — GPS geofence gates arrival, then SLAM tap-to-place sets
   *              the origin (requires `geo` — it is the only arrival
   *              signal).
   *  - 'image' — an 8th Wall image target on the printed plaque sets the
   *              origin, continuously re-aligned on every sighting, with
   *              SLAM persisting the anchor between sightings (requires
   *              imageTargetUrl + physicalTargetWidthMeters).
   */
  placement: PlacementMode;
  /**
   * GPS arrival gate for any placement mode. Required for 'tap';
   * recommended for site-fixed 'image' experiences (stops users hunting
   * for a plaque that is miles away); omit for portable image-target
   * demos. Record real coordinates on-site with ?recordgeo=1.
   */
  geo?: GeoFenceSpec;
  /**
   * Compiled 8th Wall image-target JSON for 'image' experiences (built
   * from trackingImageUrl artwork with `npx @8thwall/image-target-cli`,
   * committed under /assets/image-targets/, imagePath fixed to a served
   * root-relative path — see README). Replaces the parent repo's
   * mindTargetUrl — MindAR is not part of this runtime.
   */
  imageTargetUrl?: string;
  /**
   * Raw plaque artwork (PNG) for tracking engines that consume the image
   * directly instead of a compiled feature file. Same single-source
   * artwork the compiled target derives from — never a separately
   * authored image (§E, §F).
   */
  trackingImageUrl?: string;
  /**
   * Route to the experience's external display-content source, resolved by
   * the client-side ContentProvider seam (§E Golden Rule amendment,
   * Phase 5). Carries a URL only — never content. The one field permitted
   * to be an absolute https:// URL; root-relative /public paths are also
   * accepted.
   */
  contentUrl?: string;
  /**
   * Printed physical width of the tracking target, in meters. Required on
   * 'image' placements only: it sizes the image target. Under 'tap'
   * placement the engine runs with scale:'absolute' (world units are real
   * meters), so meter-authored content needs no scale bridge at all.
   */
  physicalTargetWidthMeters?: number;
  version: string;
};

export const experienceManifest: ExperienceManifest[] = [
  {
    // 8th Wall spike: the parent repo's bench-test content —
    // bench-scene.glb (four domino building proxies + hotspot_* nodes) and
    // bench-ui.riv (Marker/Card artboards) — anchored to the printed QR
    // plaque on the fixed 3D-printed model (image target = precise origin,
    // continuously re-aligned; SLAM persists between sightings), with a
    // GPS geofence gating arrival. Flip placement to 'tap' to demo without
    // the physical model.
    targetId: 'bench-park',
    riveUrl: '/assets/bench-ui.riv',
    modelUrl: '/assets/bench-scene.glb',
    placement: 'image',
    // Compiled from bench-plaque.png (single-source artwork rule, §E/§F) —
    // regenerate with the image-target CLI if the plaque art changes.
    imageTargetUrl: '/assets/image-targets/bench-plaque/bench-plaque.json',
    trackingImageUrl: '/assets/bench-plaque.png',
    // Printed width of the QR plaque on the 3D-printed model. The parent
    // repo's desk plaque was 0.05 m (tools/build_plaque.py); measure the
    // model's actual print and update — the runtime cross-checks this
    // against the engine's own meter estimate and warns on divergence.
    physicalTargetWidthMeters: 0.05,
    // PLACEHOLDER COORDINATES (Ramapo College campus center). Replace with
    // the real bench's lat/lng before a field test; desk testing bypasses
    // the fence entirely with ?fakegeo=1 (see GeoFenceService). Radius is
    // deliberately generous — the fence is an arrival gate, not a
    // positioning source.
    geo: {
      latitude: 41.0817,
      longitude: -74.174,
      radiusMeters: 30,
    },
    // Same populated Google Sheet as the parent repo's bench-test entry
    // (header row contentKey | title | subtitle | body | imageUrl, one row
    // per hotspot contentKey bench-domino-1..4).
    contentUrl: 'https://docs.google.com/spreadsheets/d/1O4Zq8ggc7TgjKZIuUtufO-G9hJiK2KalJpD2Cux2sN8/gviz/tq?tqx=out:json',
    version: '0.1.0',
  },
];
