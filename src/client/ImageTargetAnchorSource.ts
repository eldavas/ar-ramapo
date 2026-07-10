import * as THREE from 'three';
import type { AnchorSource, OriginKind } from './AnchorSource.js';
import type { EightWallSession, ImageEventKind } from './EightWallSession.js';
import type { Xr8ImageTrackedEvent } from './types/xr8.js';
import { traceT } from './TraceLog.js';

/**
 * §F axis-convention lockdown, image-target edition — the ONLY place the
 * target-frame → world-frame conversion exists (same contract as
 * SceneGraphLoader's GLTF_TO_WORLD constants; the two compose, they never
 * duplicate).
 *
 * Best inference pending device validation: 8th Wall FLAT targets frame
 * the printed image in the target's local XY plane with +Z out of the
 * surface toward the viewer (the engine's own examples attach a default
 * three.js PlaneGeometry — which lies in XY facing +Z — directly at the
 * event pose). The GLB is authored Y-up, so Rx(+90°) maps authored +Y
 * onto target +Z: content "stands up out of the plaque" — the same +90°X
 * the parent repo needed for MindAR, for the same reason.
 *
 * VALIDATE ON DEVICE (Phase D checkpoint): if the scene lies flat-wrong,
 * this quaternion is the one named thing to change (candidates: identity,
 * ±90°X). If the plaque ends up mounted vertically/tilted on the printed
 * model and content must stay world-upright regardless, replace the rigid
 * fix with position-from-event + yaw-only rotation — a change confined to
 * applyPose().
 */
const TARGET_FRAME_TO_WORLD_FIX = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  Math.PI / 2
);

/**
 * §F scale glue. Under scale:'absolute' world units are real meters and
 * the GLB is meters-authored, so the anchor mounts at scale 1 —
 * event.scale is NOT a multiplier. It is the engine's meter estimate of
 * the target's larger printed dimension, which makes it a cross-check:
 * warn loudly when it diverges from the manifest's
 * physicalTargetWidthMeters, because that means absolute scale hasn't
 * converged yet (coach more parallax) or the declared printed width is
 * wrong. If a future entry ever runs scale:'responsive', the return value
 * becomes event.scale / physicalTargetWidthMeters — keep that here.
 */
const SCALE_MISMATCH_TOLERANCE = 0.25; // ±25%

// applyPose() runs on every imageupdated (per frame while the target is in
// view), so an unthrottled mismatch warning floods the 200-line on-screen
// console during exactly the sessions it exists to diagnose. Once per
// second preserves the signal (§4 of the troubleshooting doc reads the
// ratio's trend across a session, not per-frame values).
const SCALE_MISMATCH_WARN_INTERVAL_MS = 1000;
let lastScaleMismatchWarnMs = 0;

function anchorScaleForEvent(
  event: Xr8ImageTrackedEvent,
  physicalTargetWidthMeters: number
): number {
  const ratio = event.scale / physicalTargetWidthMeters;
  if (Math.abs(ratio - 1) > SCALE_MISMATCH_TOLERANCE) {
    const now = performance.now();
    if (now - lastScaleMismatchWarnMs > SCALE_MISMATCH_WARN_INTERVAL_MS) {
      lastScaleMismatchWarnMs = now;
      console.warn(
        `[${traceT()}] [ImageTarget] scale mismatch: engine sees ${event.scale.toFixed(3)} m, ` +
          `manifest declares ${physicalTargetWidthMeters} m (ratio ${ratio.toFixed(2)}). ` +
          'Absolute scale may not have converged yet, or physicalTargetWidthMeters is wrong.'
      );
    }
  }
  return 1;
}

/** Compact pose formatter for the telemetry lines below. */
function formatPose(event: Xr8ImageTrackedEvent): string {
  const p = event.position;
  const r = event.rotation;
  return (
    `pos=(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) ` +
    `rot=(${r.x.toFixed(2)}, ${r.y.toFixed(2)}, ${r.z.toFixed(2)}, ${r.w.toFixed(2)})`
  );
}

/**
 * AnchorSource whose origin is the printed QR plaque on the fixed
 * 3D-printed model, tracked as an 8th Wall image target.
 *
 * acquire() resolves on the FIRST imagefound; every subsequent
 * imagefound/imageupdated re-snaps the mount group to the tracked pose,
 * correcting accumulated SLAM drift whenever the user glances back at the
 * plaque. After imagelost the group simply stops receiving snaps — SLAM
 * world tracking (disableWorldTracking: false in EightWallSession) keeps
 * the frozen world pose valid, so content persists while the user walks
 * around the model. Scan once, walk around.
 *
 * onOriginChanged fires only on RE-detection (imagefound after a lost,
 * once already acquired) — a discontinuity where the pose may visibly
 * jump, so downstream screen-space filter state deserves a reset cue.
 * imageupdated re-snaps are continuous sub-centimeter corrections that
 * flow through per-frame projection naturally; firing per update would
 * reset MarkerLayer's One Euro filters every frame and defeat smoothing.
 */
export class ImageTargetAnchorSource implements AnchorSource {
  readonly kind: OriginKind = 'image-target';
  readonly group = new THREE.Group();

  private acquired = false;
  private imageVisible = false;
  private acquireResolve: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly originChangedHandlers: Array<() => void> = [];
  private readonly scratchQuat = new THREE.Quaternion();
  // On-device telemetry (?debug=1, see the inline console in index.html),
  // instrumented for the troubleshooting doc §5–6 investigation: every
  // input that feeds the marker-visibility gate is logged on CHANGE, never
  // per frame — isTracking() is polled every frame by HotspotProjector, so
  // the snapshot below is the only spam guard. 'updated' fires every frame
  // the target is in view and stays throttled to 1/s.
  private lastTrackingSnapshot: string | null = null;
  private lastUpdatedLogMs = 0;
  private static readonly UPDATED_LOG_INTERVAL_MS = 1000;

  constructor(
    private readonly session: EightWallSession,
    private readonly scene: THREE.Scene,
    /**
     * `name` from the compiled target JSON (ImageTargetLoader.primaryName)
     * — events are filtered on it, so a renamed compile output can't
     * silently mismatch.
     */
    private readonly targetName: string,
    private readonly physicalTargetWidthMeters: number
  ) {
    this.group.name = 'image-target-anchor';
    this.group.visible = false;
    this.scene.add(this.group);
    this.unsubscribe = this.session.onImageEvent((kind, event) => this.onImageEvent(kind, event));
  }

  acquire(): Promise<void> {
    console.log(
      `[${traceT()}] [ImageTargetAnchorSource] acquire() — waiting for first imagefound of "${this.targetName}"...`
    );
    // Re-acquire is a no-op by design: re-alignment is automatic on every
    // sighting of the plaque, so there is nothing to re-run.
    if (this.acquired) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.acquireResolve = resolve;
    });
  }

  /**
   * NORMAL SLAM after first detection — visible-or-SLAM-extended. The
   * plaque leaving the camera view must NOT read as tracking loss; that
   * persistence is the whole point of the hybrid design.
   */
  isTracking(): boolean {
    const status = this.session.trackingStatus;
    const reason = this.session.trackingReason;
    const result = this.acquired && status === 'NORMAL';
    // Log when ANY component of the gate changes — not just the boolean
    // result. The §6 decision (gate too strict vs. LIMITED legitimately
    // meaning "hide") hinges on seeing imageVisible=true coincide with
    // status=LIMITED, which a result-only log can never show.
    const snapshot = `${this.acquired}|${this.imageVisible}|${status}|${reason}|${result}`;
    if (snapshot !== this.lastTrackingSnapshot) {
      this.lastTrackingSnapshot = snapshot;
      console.log(
        `[${traceT()}] [ImageTargetAnchorSource] isTracking()\n` +
          `  acquired=${this.acquired} imageVisible=${this.imageVisible}\n` +
          `  trackingStatus=${status} reason=${reason}\n` +
          `  => ${result}${result ? '' : ' (markers hidden while false)'}`
      );
    }
    return result;
  }

  /** UX-only signal (e.g. a "glance at the plaque to re-align" hint). */
  isImageVisible(): boolean {
    return this.imageVisible;
  }

  onOriginChanged(handler: () => void): void {
    this.originChangedHandlers.push(handler);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.scene.remove(this.group);
    this.originChangedHandlers.length = 0;
    this.acquired = false;
  }

  private onImageEvent(kind: ImageEventKind, event: Xr8ImageTrackedEvent | null): void {
    if (event !== null && event.name !== this.targetName) return;
    switch (kind) {
      case 'found': {
        if (event === null) return;
        const wasAcquired = this.acquired;
        console.log(
          `[${traceT()}] [ImageTarget] FOUND "${event.name}"\n` +
            `  scale=${event.scale.toFixed(3)}m ${formatPose(event)}\n` +
            `  acquired: ${wasAcquired} -> true` +
            (wasAcquired
              ? ' (re-detection — firing onOriginChanged, pose discontinuity)'
              : ' (first acquire — group visible, resolving acquire())')
        );
        this.applyPose(event);
        this.imageVisible = true;
        if (!this.acquired) {
          this.acquired = true;
          this.group.visible = true;
          this.acquireResolve?.();
          this.acquireResolve = null;
        } else {
          // Re-detection after a lost = pose discontinuity.
          for (const handler of this.originChangedHandlers) {
            handler();
          }
        }
        break;
      }
      case 'updated':
        if (event !== null) {
          const now = performance.now();
          if (now - this.lastUpdatedLogMs > ImageTargetAnchorSource.UPDATED_LOG_INTERVAL_MS) {
            this.lastUpdatedLogMs = now;
            console.log(
              `[${traceT()}] [ImageTarget] updated (throttled 1/s) "${event.name}" ` +
                `scale=${event.scale.toFixed(3)}m ${formatPose(event)}`
            );
          }
          this.applyPose(event);
          this.imageVisible = true;
        }
        break;
      case 'lost':
        console.log(
          `[${traceT()}] [ImageTarget] LOST "${event?.name ?? this.targetName}"\n` +
            `  imageVisible: ${this.imageVisible} -> false; acquired stays ${this.acquired}\n` +
            '  pose frozen at last snap — SLAM world tracking persists it'
        );
        // Pose freezes at the last snap; SLAM world tracking persists it.
        this.imageVisible = false;
        break;
      case 'loading':
        console.log(`[${traceT()}] [ImageTarget] loading image target data...`);
        break;
      case 'scanning':
        console.log(`[${traceT()}] [ImageTarget] scanning for target...`);
        break;
    }
  }

  private applyPose(event: Xr8ImageTrackedEvent): void {
    this.group.position.set(event.position.x, event.position.y, event.position.z);
    this.scratchQuat.set(event.rotation.x, event.rotation.y, event.rotation.z, event.rotation.w);
    this.group.quaternion.copy(this.scratchQuat).multiply(TARGET_FRAME_TO_WORLD_FIX);
    this.group.scale.setScalar(anchorScaleForEvent(event, this.physicalTargetWidthMeters));
  }
}
