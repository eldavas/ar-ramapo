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
    riveUrl: '/assets/ui-test.riv',
    modelUrl: '/assets/bench-scene.glb',
    mindTargetUrl: '/assets/bench-target.mind',
    physicalTargetWidthMeters: 0.05,
    // 0.2.0: all four hotspot_* nodes in bench-scene.glb now declare
    // riveStateMachine (was two of four).
    version: '0.2.0',
  },
];
