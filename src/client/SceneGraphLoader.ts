import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * §F axis-convention lockdown, 8th Wall edition — the glue between
 * authored space and the tracking engine's world space. This block is the
 * ONLY place the conversion exists on the web runtime; it must never be
 * re-derived ad hoc at call sites.
 *
 * Rotation: IDENTITY. Blender's glTF export is Y-up / −Z-forward, and
 * 8th Wall's three.js world is also Y-up (a normal three.js scene). The
 * parent repo's +90°X rotation existed only because MindAR frames a flat
 * image target as Z-up; with no image target there is nothing to
 * re-frame. Validate visually on first device run — if the scene lies
 * flat-wrong this is the one named constant to change.
 *
 * Scale: 1. The engine is configured with scale:'absolute'
 * (EightWallSession), so world units are real meters — the same unit the
 * scene is authored in. MindAR's 1/physicalTargetWidthMeters marker-width
 * conversion is gone entirely; physicalTargetWidthMeters only returns if
 * an image-target AnchorSource is added (hybrid path).
 */
const GLTF_TO_WORLD_ROTATION_X_RADIANS = 0;
const GLTF_TO_WORLD_SCALE = 1;

/**
 * Interaction nodes are discovered by name prefix via tree traversal —
 * never enumerated in a configuration payload (Golden Rule, AR_SYSTEM.md
 * §E). Their behavior data arrives as Blender custom properties → glTF
 * `extras` → Object3D.userData.
 */
export const HOTSPOT_NODE_PREFIX = 'hotspot_';

/**
 * Visual-debug aid carried over from the parent's Phase 3: proxy meshes
 * that host a hotspot are tinted solid red so they read instantly against
 * the dark Rive card pills during on-device testing. Applied semantically
 * (nearest mesh ancestor of each hotspot_* node) — never by content node
 * name, per the Golden Rule (AR_SYSTEM.md §E). Unlit material on purpose:
 * the scene has no lights, and the tint must read identically from every
 * angle.
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
  /** Attach to the AnchorSource's group — glue transform already applied. */
  root: THREE.Group;
  hotspots: Hotspot[];
  /** Every mesh in the scene — the occlusion-raycast target set. */
  occluders: THREE.Object3D[];
}

/**
 * Loads the baked scene mesh declared in the experience manifest, applies
 * the §F glue transform, and discovers `hotspot_*` interaction nodes.
 * Rendering and projection are deliberately not this module's job — see
 * FrameBus.ts and HotspotProjector.ts.
 */
export class SceneGraphLoader {
  private readonly loader = new GLTFLoader();

  constructor(private readonly modelUrl: string) {}

  async load(): Promise<LoadedSceneGraph> {
    const gltf = await this.loader.loadAsync(this.modelUrl);

    const root = new THREE.Group();
    root.name = 'scene-graph-root';
    root.rotation.x = GLTF_TO_WORLD_ROTATION_X_RADIANS;
    root.scale.setScalar(GLTF_TO_WORLD_SCALE);
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
