import * as THREE from 'three';
import type { Hotspot } from './SceneGraphLoader.js';
import { traceT } from './TraceLog.js';

/** Which guard zeroed `visible` — null while visible. */
export type HotspotHiddenReason = 'tracking' | 'frustum';

export interface ProjectedHotspot {
  hotspot: Hotspot;
  /** CSS pixels relative to the viewport (renderer canvas bounds). */
  screenX: number;
  screenY: number;
  /** In front of the camera, inside the frustum, and target is tracked. */
  visible: boolean;
  /** Line of sight from the camera is blocked by scene geometry. */
  occluded: boolean;
  /**
   * Why `visible` is false ('tracking' = isTrackingActive() returned
   * false; 'frustum' = behind the camera or outside NDC bounds), so
   * downstream consumers (MarkerLayer's hide log) can name the exact
   * cause instead of re-deriving it.
   */
  hiddenReason: HotspotHiddenReason | null;
}

/**
 * Projects hotspot world positions into screen space every frame so
 * MarkerLayer can pin UI at them. Owns the three visibility guards:
 * frustum check (behind-camera and off-screen), occlusion raycast against
 * scene meshes, and tracking-loss (all hidden when the anchor group is
 * invisible — polled, because MindAR's targetFound/targetLost events do
 * not fire with three r160).
 *
 * Occlusion note: a hotspot's own ancestor chain is excluded from the
 * raycast (see Hotspot.ancestors), so an empty authored inside its
 * building mesh isn't permanently occluded by that building. Authoring
 * convention: parent each hotspot empty to the building mesh it belongs
 * to.
 */
export class HotspotProjector {
  private readonly raycaster = new THREE.Raycaster();
  private readonly worldPosition = new THREE.Vector3();
  private readonly cameraSpacePosition = new THREE.Vector3();
  private readonly ndcPosition = new THREE.Vector3();
  private readonly cameraOrigin = new THREE.Vector3();
  private readonly rayDirection = new THREE.Vector3();
  // On-device telemetry (troubleshooting doc §6): per-hotspot visibility
  // state, logged ONLY on transition — project() runs every frame, so a
  // per-frame log would flood the ?debug=1 console instantly.
  private readonly lastLoggedState = new Map<Hotspot, string>();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly rendererDomElement: HTMLCanvasElement,
    private readonly hotspots: readonly Hotspot[],
    private readonly occluders: readonly THREE.Object3D[],
    private readonly isTrackingActive: () => boolean
  ) {}

  project(): ProjectedHotspot[] {
    const trackingActive = this.isTrackingActive();
    const rect = this.rendererDomElement.getBoundingClientRect();
    this.camera.getWorldPosition(this.cameraOrigin);

    return this.hotspots.map((hotspot) => {
      hotspot.node.getWorldPosition(this.worldPosition);

      // Behind-camera check in camera space (three cameras look down −Z);
      // Vector3.project() alone mirrors points behind the camera into
      // plausible-looking NDC coordinates instead of rejecting them.
      this.cameraSpacePosition.copy(this.worldPosition).applyMatrix4(this.camera.matrixWorldInverse);
      const inFront = this.cameraSpacePosition.z < 0;

      this.ndcPosition.copy(this.worldPosition).project(this.camera);
      const inFrustum =
        inFront &&
        this.ndcPosition.x >= -1 &&
        this.ndcPosition.x <= 1 &&
        this.ndcPosition.y >= -1 &&
        this.ndcPosition.y <= 1;

      const screenX = rect.left + ((this.ndcPosition.x + 1) / 2) * rect.width;
      const screenY = rect.top + ((1 - this.ndcPosition.y) / 2) * rect.height;

      const visible = trackingActive && inFrustum;
      const occluded = visible && this.isOccluded(hotspot);
      const hiddenReason: HotspotHiddenReason | null = visible
        ? null
        : !trackingActive
          ? 'tracking'
          : 'frustum';

      // Transition-only visibility telemetry. Occlusion is part of the
      // state string on purpose: an occluded marker stays mounted (dimmed,
      // not hidden), and that distinction matters when reconstructing why
      // a marker "disappeared".
      const state = visible
        ? occluded
          ? 'VISIBLE (occluded=true — marker dimmed, not hidden)'
          : 'VISIBLE'
        : `HIDDEN (${hiddenReason === 'tracking' ? 'tracking=false' : 'frustum=false'})`;
      if (this.lastLoggedState.get(hotspot) !== state) {
        this.lastLoggedState.set(hotspot, state);
        console.log(
          `[${traceT()}] [HotspotProjector] "${hotspot.name}" -> ${state} ` +
            `(screen=${screenX.toFixed(0)},${screenY.toFixed(0)})`
        );
      }

      return { hotspot, screenX, screenY, visible, occluded, hiddenReason };
    });
  }

  private isOccluded(hotspot: Hotspot): boolean {
    const distanceToHotspot = this.cameraOrigin.distanceTo(this.worldPosition);
    if (distanceToHotspot === 0) return false;

    this.rayDirection.copy(this.worldPosition).sub(this.cameraOrigin).normalize();
    this.raycaster.set(this.cameraOrigin, this.rayDirection);
    this.raycaster.far = distanceToHotspot;

    const hits = this.raycaster.intersectObjects(this.occluders as THREE.Object3D[], false);
    // A mesh surface grazing the hotspot itself (its building's front face)
    // shouldn't count as blocking it — only geometry meaningfully closer to
    // the camera does. Threshold is relative so it holds at any scale.
    const closerThan = distanceToHotspot * 0.99;
    return hits.some((hit) => hit.distance < closerThan && !hotspot.ancestors.has(hit.object));
  }
}
