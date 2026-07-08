import * as THREE from 'three';
import type { EightWallSession } from './EightWallSession.js';
import type { FrameBus } from './FrameBus.js';

export interface PlacementPose {
  position: THREE.Vector3;
  /** Yaw-only orientation: authored +Z faces the user at placement time. */
  quaternion: THREE.Quaternion;
}

/**
 * Tap-to-place UX: while active, a flat ring reticle tracks the SLAM
 * hit-test result at screen center each frame; the first tap while the
 * reticle has a valid pose freezes that pose as the content origin.
 *
 * Hit-test fallback: until the engine has a surface estimate along the
 * center ray, the camera-center ray is intersected with the horizontal
 * plane y = 0 — with scale:'absolute' and the camera origin pinned at eye
 * height (EightWallSession), y ≈ 0 is the expected ground. The fallback
 * keeps placement usable on low-texture ground where SLAM surfaces
 * converge slowly; it is visually distinguished (dimmed reticle) so the
 * user keeps scanning for a real lock.
 */
export class PlacementController {
  private readonly raycaster = new THREE.Raycaster();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly reticle: THREE.Mesh;
  private readonly reticleMaterial: THREE.MeshBasicMaterial;
  private hasPose = false;
  private fromFallback = false;
  private active = false;
  private frameCallbackInstalled = false;

  constructor(
    private readonly session: EightWallSession,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly frameBus: FrameBus,
    private readonly canvas: HTMLCanvasElement
  ) {
    this.reticleMaterial = new THREE.MeshBasicMaterial({
      color: 0x4ade80,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      // Always draw over scene geometry — a reticle half-swallowed by the
      // ground estimate reads as broken.
      depthTest: false,
    });
    this.reticle = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.16, 48), this.reticleMaterial);
    this.reticle.rotation.x = -Math.PI / 2;
    this.reticle.renderOrder = 999;
    this.reticle.visible = false;
  }

  /**
   * Runs the placement interaction to completion. Resolves with the frozen
   * pose on the confirming tap. The reticle and listeners are fully torn
   * down before resolution, so run() can be invoked again later (re-place).
   */
  run(): Promise<PlacementPose> {
    this.active = true;
    this.hasPose = false;
    this.scene.add(this.reticle);
    // FrameBus has no unsubscribe (parent-repo convention: subscriptions
    // live for the session), so the callback is installed once and gates
    // itself on `active` — run() can then be re-invoked for re-placement.
    if (!this.frameCallbackInstalled) {
      this.frameBus.onFrame(() => this.updateReticle());
      this.frameCallbackInstalled = true;
    }

    return new Promise<PlacementPose>((resolve) => {
      const onTap = (event: PointerEvent): void => {
        if (!this.active || !this.hasPose) return;
        event.stopPropagation();
        this.active = false;
        this.canvas.removeEventListener('pointerup', onTap);

        const position = this.reticle.position.clone();
        const quaternion = yawTowardCamera(position, this.camera);
        this.scene.remove(this.reticle);
        this.reticle.visible = false;
        resolve({ position, quaternion });
      };
      this.canvas.addEventListener('pointerup', onTap);
    });
  }

  private updateReticle(): void {
    if (!this.active) return;

    const hit = this.session.hitTest(0.5, 0.5);
    if (hit) {
      this.reticle.position.set(hit.position.x, hit.position.y, hit.position.z);
      this.hasPose = true;
      this.fromFallback = false;
    } else {
      const fallback = this.groundPlaneFallback();
      if (fallback) {
        this.reticle.position.copy(fallback);
        this.hasPose = true;
        this.fromFallback = true;
      } else {
        this.hasPose = false;
      }
    }

    this.reticle.visible = this.hasPose;
    this.reticleMaterial.opacity = this.fromFallback ? 0.35 : 0.9;
  }

  private groundPlaneFallback(): THREE.Vector3 | null {
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const intersection = new THREE.Vector3();
    const hit = this.raycaster.ray.intersectPlane(this.groundPlane, intersection);
    if (!hit) return null;
    // Reject degenerate hits: nearly-horizontal rays intersect the plane
    // absurdly far away; clamping keeps the reticle within a usable range.
    const distance = this.camera.position.distanceTo(intersection);
    if (distance < 0.3 || distance > 8) return null;
    return intersection;
  }
}

/**
 * Yaw-only quaternion so the placed content's authored front (+Z after the
 * identity glue transform) faces the user's ground-projected position at
 * placement time.
 */
function yawTowardCamera(origin: THREE.Vector3, camera: THREE.PerspectiveCamera): THREE.Quaternion {
  const dx = camera.position.x - origin.x;
  const dz = camera.position.z - origin.z;
  const yaw = Math.atan2(dx, dz);
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
}
