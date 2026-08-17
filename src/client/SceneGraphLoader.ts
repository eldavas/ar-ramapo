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

/**
 * The single terrain mesh authored by tools/build_site_buildings.py /
 * build_site_terrain.py (Blender object name `site_terrain`, confirmed to
 * survive glTF export verbatim). This is the ONLY node this loader
 * identifies by a fixed literal name rather than a prefix/userData
 * convention — a structural role (there is exactly one terrain mesh per
 * scene), the same class of fixed name HOTSPOT_NODE_PREFIX already is, not
 * a content lookup the Golden Rule forbids.
 */
const TERRAIN_NODE_NAME = 'site_terrain';

/**
 * Real-hardware finding (2026-08-14, second physical test): with the
 * terrain fixed (below), the mounting ledge and the 4 plaque placeholders
 * were still visible — a wide auxiliary "frame" around the model the
 * production experience must not show (only buildings + markers are real
 * content). Found the correct hook instead of hardcoding 4 more literal
 * mesh names (`site_ledge`, `plaque_front/back/left/right`): confirmed
 * directly against the shipped site-scene.glb that `tools/
 * build_site_buildings.py` already tags exactly this geometry with a
 * `placeholder` glTF extra (`ledge[USERDATA_PLACEHOLDER_KEY] = True`,
 * same for each `pobj` plaque marker) — the asset's own existing semantic
 * distinction for "auxiliary mounting geometry, not real content" (same
 * mechanism `cad-source/handoff/README.md` already describes: "everything
 * placeholder carries a placeholder custom property"), surviving export
 * as `node.userData.placeholder === true`. `site_terrain` itself carries
 * no such flag (it IS real DWG-derived geometry, not a placeholder guess —
 * it's hidden for the separate, already-documented reason above: the
 * physical model already shows its own real terrain).
 */
const USERDATA_PLACEHOLDER_KEY = 'placeholder';

/**
 * Real-hardware finding (2026-08-14, first physical test): the terrain
 * rendered solid black on-device. Root cause, confirmed against the shipped
 * asset and runtime config (not assumed): every mesh in site-scene.glb —
 * terrain, buildings, ledge, plaque placeholders — is authored in Blender
 * with a plain Principled BSDF ("use_nodes = True", a lit/PBR material;
 * tools/build_site_buildings.py's make_material()), which glTF export turns
 * into a lit THREE.MeshStandardMaterial. Neither tracking engine's runtime
 * scene ever adds a THREE.Light: 8th Wall's XrController.configure() sets
 * `enableLighting: false` explicitly (EightWallSession.ts) and MindAR's
 * ARSessionManager never adds one either. Under zero light, a
 * MeshStandardMaterial renders solid black regardless of its authored
 * baseColorFactor — verified directly against the shipped
 * public/assets/site-scene.glb: mat_site_terrain's baseColorFactor is an
 * ordinary opaque tan `[0.55, 0.52, 0.45, 1]`, no alphaMode, no emissive —
 * not a black or transparent material as authored. The only reason the 12
 * hotspot-hosting buildings were ever visible is the debug tint above,
 * which happens to be unlit for exactly this reason. Every OTHER mesh
 * (terrain, the 9 non-hotspot buildings, the ledge, the 4 plaque
 * placeholders) was rendering black for the same underlying reason — masked
 * during desk verification because DevSimSession.ts (the ?fakear=1 desk
 * bypass) adds real THREE.Light objects the real device path never gets.
 *
 * Fix lives here, not in the Blender pipeline: this is a rendering-strategy
 * decision (lit-vs-unlit), not an authoring defect — the authored colors
 * are correct and this loader already owns exactly this class of decision
 * for the hotspot debug tint. Every mesh gets rewrapped in an unlit
 * MeshBasicMaterial that preserves its own authored color, so buildings/
 * ledge/plaques render visibly instead of black; the terrain mesh
 * specifically is made fully transparent instead — the physical 3D-printed
 * model already has a real terrain surface visible through the camera feed,
 * so the digital terrain mesh's only real job is to give
 * HotspotProjector's occlusion raycast a surface to test against (the
 * `occluders` array below), not to be seen. transparent+opacity:0 (not
 * `mesh.visible = false`) keeps the mesh eligible for THREE.Raycaster,
 * which tests geometry only and ignores material opacity — occlusion
 * behavior is unaffected; depthWrite:false additionally keeps the invisible
 * terrain from fighting the depth buffer against any future transparent
 * content placed near Z=0.
 */
function applyUnlitRenderingMaterial(mesh: THREE.Mesh): void {
  if (mesh.name === TERRAIN_NODE_NAME || mesh.userData[USERDATA_PLACEHOLDER_KEY] === true) {
    // Invisible but still present: THREE.Raycaster tests geometry only and
    // ignores material opacity, so the ledge/plaque volumes stay valid
    // occluders (a hotspot behind the ledge is still correctly occluded)
    // without ever being drawn to the camera feed.
    mesh.material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    return;
  }
  const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const baseColor =
    source !== undefined && 'color' in source
      ? (source as THREE.MeshStandardMaterial).color
      : new THREE.Color(0xffffff);
  mesh.material = new THREE.MeshBasicMaterial({ color: baseColor });
}

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
        applyUnlitRenderingMaterial(node as THREE.Mesh);
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
      // Runs after applyUnlitRenderingMaterial above — the debug tint fully
      // replaces the material (same as it always did), so a hotspot host's
      // final material is red regardless of ordering; non-hotspot meshes
      // keep their own unlit, authored-color material from the pass above.
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
