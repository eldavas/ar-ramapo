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
  mindTargetUrl?: string;
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
    // contentKey | title | body | imageUrl, shared "anyone with the link
    // can view". REPLACE the sheet id below with the real one — until then
    // this resolves but fails loudly at fetch time, same policy as the
    // asset files themselves (see the comment above).
    contentUrl: 'https://docs.google.com/spreadsheets/d/REPLACE_WITH_SHEET_ID/gviz/tq?tqx=out:json',
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
    version: '0.4.0',
  },
];
