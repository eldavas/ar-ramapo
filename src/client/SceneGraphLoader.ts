import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * §F axis-convention lockdown — the glue between authored space and
 * MindAR's anchor space. These two constants are the ONLY place this
 * conversion exists on the web runtime; they are validated by the Phase 3
 * bench-test and must never be re-derived ad hoc at call sites.
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
 * experience by the manifest (AR_SYSTEM.md §E), never hardcoded.
 */
function metersToMarkerWidths(physicalTargetWidthMeters: number): number {
  return 1 / physicalTargetWidthMeters;
}

/**
 * Interaction nodes are discovered by name prefix via tree traversal —
 * never enumerated in a configuration payload (Golden Rule, AR_SYSTEM.md
 * §E). Their behavior data arrives as Blender custom properties → glTF
 * `extras` → Object3D.userData.
 */
export const HOTSPOT_NODE_PREFIX = 'hotspot_';

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
 * the §F glue transform, and discovers `hotspot_*` interaction nodes.
 * Rendering and projection are deliberately not this module's job — see
 * RenderEngine.ts and HotspotProjector.ts.
 */
export class SceneGraphLoader {
  private readonly loader = new GLTFLoader();

  constructor(
    private readonly modelUrl: string,
    private readonly physicalTargetWidthMeters: number
  ) {}

  async load(): Promise<LoadedSceneGraph> {
    const gltf = await this.loader.loadAsync(this.modelUrl);

    const root = new THREE.Group();
    root.name = 'scene-graph-root';
    root.rotation.x = GLTF_TO_MINDAR_ROTATION_X_RADIANS;
    root.scale.setScalar(metersToMarkerWidths(this.physicalTargetWidthMeters));
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

    return { root, hotspots, occluders };
  }
}

function collectAncestors(node: THREE.Object3D, stopAt: THREE.Object3D): ReadonlySet<THREE.Object3D> {
  const ancestors = new Set<THREE.Object3D>();
  for (let current = node.parent; current !== null && current !== stopAt; current = current.parent) {
    ancestors.add(current);
  }
  return ancestors;
}
