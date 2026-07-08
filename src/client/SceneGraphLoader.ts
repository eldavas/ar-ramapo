import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * §F axis-convention lockdown — the glue between authored space and each
 * tracking engine's anchor space. MindAR needs it here because its anchor
 * frame and marker-width scale are baked into the loaded mesh itself. 8th
 * Wall does NOT: its AnchorSource implementations (ImageTargetAnchorSource's
 * own TARGET_FRAME_TO_WORLD_FIX, TapPlacedAnchorSource's yaw-only placement)
 * already deliver a correctly-oriented, real-meters anchor group, and
 * `scale:'absolute'` means the meter-authored GLB mounts at identity scale —
 * applying this MindAR glue on top would double-transform the scene (see the
 * Phase 2B decision record). These two constants remain the ONLY place the
 * MindAR conversion exists on the web runtime; never re-derived ad hoc.
 *
 * Rotation: Blender authors Z-up; the glTF exporter converts to Y-up, so
 * exported content is X-east / Y-up / Z-south. MindAR's anchor frames the
 * flat plaque as X-east / Y-north / Z-up. Rotating +90° about X maps
 * (x, y, z) → (x, −z, y) = (east, north, up). Same rotation the pre-Phase-1
 * prototype applied to its single plane.
 */
const GLTF_TO_MINDAR_ROTATION_X_RADIANS = Math.PI / 2;

/**
 * Scale: MindAR anchor space is measured in marker-widths (the plaque spans
 * exactly 1 unit), while scene content is authored in meters. The
 * conversion factor is 1 / physicalTargetWidthMeters — supplied per
 * experience by the manifest (AR_SYSTEM.md §E), never hardcoded. MindAR
 * only — see the tracking-engine glue comment above.
 */
function metersToMarkerWidths(physicalTargetWidthMeters: number): number {
  return 1 / physicalTargetWidthMeters;
}

/**
 * Which tracking engine's anchor frame this load targets. Defaults to
 * 'mindar' so every pre-existing call site (unchanged since Phase 3) keeps
 * compiling and behaving identically without passing a third argument.
 */
export type SceneTrackingEngine = 'mindar' | '8thwall';

/**
 * Interaction nodes are discovered by name prefix via tree traversal —
 * never enumerated in a configuration payload (Golden Rule, AR_SYSTEM.md
 * §E). Their behavior data arrives as Blender custom properties → glTF
 * `extras` → Object3D.userData.
 */
export const HOTSPOT_NODE_PREFIX = 'hotspot_';

/**
 * Phase 3 visual-debug aid: proxy meshes that host a hotspot are tinted
 * solid red so they read instantly against the dark Rive card pills during
 * on-device bench-testing. Applied semantically (nearest mesh ancestor of
 * each hotspot_* node) — never by content node name, per the Golden Rule
 * (AR_SYSTEM.md §E). Unlit material on purpose: the MindAR scene has no
 * lights, and the tint must read identically from every angle.
 */
const HOTSPOT_HOST_DEBUG_COLOR = 0xff0000;

export interface Hotspot {
  name: string;
  node: THREE.Object3D;
  userData: Record<string, unknown>;
  /**
   * The hotspot's own ancestor chain (its building proxy, offset group,
   * …). HotspotProjector excludes these from the occlusion test — an empty
   * authored inside a building mesh would otherwise be permanently
   * "occluded" by its own building.
   */
  ancestors: ReadonlySet<THREE.Object3D>;
}

export interface LoadedSceneGraph {
  /** Attach to anchor.group — glue transform already applied. */
  root: THREE.Group;
  hotspots: Hotspot[];
  /** Every mesh in the scene — the occlusion-raycast target set. */
  occluders: THREE.Object3D[];
}

/**
 * Loads the baked scene mesh declared in the experience manifest, applies
 * the tracking-engine glue transform for `engine`, and discovers
 * `hotspot_*` interaction nodes. Rendering and projection are deliberately
 * not this module's job — see RenderEngine.ts and HotspotProjector.ts.
 */
export class SceneGraphLoader {
  private readonly loader = new GLTFLoader();

  constructor(
    private readonly modelUrl: string,
    private readonly physicalTargetWidthMeters: number,
    private readonly engine: SceneTrackingEngine = 'mindar'
  ) {}

  async load(): Promise<LoadedSceneGraph> {
    const gltf = await this.loader.loadAsync(this.modelUrl);

    const root = new THREE.Group();
    root.name = 'scene-graph-root';
    if (this.engine === 'mindar') {
      root.rotation.x = GLTF_TO_MINDAR_ROTATION_X_RADIANS;
      root.scale.setScalar(metersToMarkerWidths(this.physicalTargetWidthMeters));
    }
    // '8thwall': identity rotation, scale 1 — AnchorSource (Image/TapPlaced)
    // already supplies the correct frame and real-meters absolute scale;
    // applying the MindAR glue here too would double-transform the scene
    // (see the constants' doc comment above).
    root.add(gltf.scene);

    const hotspots: Hotspot[] = [];
    const occluders: THREE.Object3D[] = [];

    gltf.scene.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        occluders.push(node);
      }
      if (node.name.startsWith(HOTSPOT_NODE_PREFIX)) {
        hotspots.push({
          name: node.name,
          node,
          userData: node.userData,
          ancestors: collectAncestors(node, root),
        });
      }
    });

    for (const hotspot of hotspots) {
      tintNearestMeshAncestor(hotspot.node, root);
    }

    return { root, hotspots, occluders };
  }
}

function tintNearestMeshAncestor(node: THREE.Object3D, stopAt: THREE.Object3D): void {
  for (let current = node.parent; current !== null && current !== stopAt; current = current.parent) {
    if ((current as THREE.Mesh).isMesh) {
      (current as THREE.Mesh).material = new THREE.MeshBasicMaterial({ color: HOTSPOT_HOST_DEBUG_COLOR });
      return;
    }
  }
}

function collectAncestors(node: THREE.Object3D, stopAt: THREE.Object3D): ReadonlySet<THREE.Object3D> {
  const ancestors = new Set<THREE.Object3D>();
  for (let current = node.parent; current !== null && current !== stopAt; current = current.parent) {
    ancestors.add(current);
  }
  return ancestors;
}
