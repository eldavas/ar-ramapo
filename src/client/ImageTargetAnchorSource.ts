import * as THREE from 'three';
import type { AnchorSource, OriginKind } from './AnchorSource.js';
import type { EightWallSession, ImageEventKind } from './EightWallSession.js';
import type { ResolvedPlaqueTarget } from './ImageTargetLoader.js';
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

function scaleRatio(event: Xr8ImageTrackedEvent, physicalTargetWidthMeters: number): number {
  return event.scale / physicalTargetWidthMeters;
}

/**
 * First real physical-device test (2026-08-14) surfaced a world anchor that
 * drifts/jumps and briefly appears at a drastically wrong scale/distance
 * after tracking correctly at first. Root cause, confirmed against this
 * file's pre-existing behavior and telemetry (docs/research/
 * 8th-wall-troubleshooting.md §4/§10) rather than assumed: applyPose() —
 * below — has always applied every single raw tracked pose (both `found`
 * and every `updated`, i.e. every frame the target is visible) directly to
 * the world anchor with zero plausibility check. §10 of that log already
 * captured this engine-level failure mode in isolation, before it had a
 * user-facing consequence: "one of the sessions... converged its
 * re-detections onto a bad pose (scale=0.106 m, ratio 2.12...) and stayed
 * there for ~a minute" — filed as "watch, no action" at the time because
 * nothing downstream depended on anchor stability yet. It does now. The
 * composition math itself (offset/rotation per plaque) is independently
 * verified correct by ImageTargetAnchorSource.test.ts and is NOT the
 * defect — every glitchy reading was being composed correctly and then
 * applied anyway.
 *
 * This is not "add damping until it looks better": it reuses the ratio the
 * code already computes for the scale-mismatch warning above as a
 * plausibility gate on whether to trust a given tracked sample at all, not
 * a smoothing/lerp of good and bad samples together. A ratio far from 1
 * means the engine's own absolute-scale estimate for this reading hasn't
 * converged (or is actively bad) — exactly the condition the warning
 * already names, previously logged and ignored, now acted on: once a good
 * anchor exists, an implausible reading is rejected outright (the anchor
 * holds its last known-good transform, exactly as it already does across a
 * real `imagelost`) rather than teleporting the whole scene to a bad pose.
 * The very first acquisition always applies regardless — there is no prior
 * good anchor to fall back to, and refusing to ever place the scene would
 * be worse than an imperfect first placement.
 */
function isPoseTrustworthy(ratio: number): boolean {
  return Math.abs(ratio - 1) <= SCALE_MISMATCH_TOLERANCE;
}

function warnIfScaleMismatch(event: Xr8ImageTrackedEvent, physicalTargetWidthMeters: number, ratio: number): void {
  if (Math.abs(ratio - 1) > SCALE_MISMATCH_TOLERANCE) {
    const now = performance.now();
    if (now - lastScaleMismatchWarnMs > SCALE_MISMATCH_WARN_INTERVAL_MS) {
      lastScaleMismatchWarnMs = now;
      console.warn(
        `[${traceT()}] [ImageTarget] scale mismatch: engine sees ${event.scale.toFixed(3)} m, ` +
          `manifest declares ${physicalTargetWidthMeters} m (ratio ${ratio.toFixed(2)}). ` +
          'Absolute scale may not have converged yet, or physicalTargetWidthMeters is wrong. ' +
          'Pose sample rejected — anchor holds its last known-good transform.'
      );
    }
  }
}

function anchorScaleForEvent(): number {
  // Under scale:'absolute' the GLB mounts at scale 1 always — event.scale
  // is never a render multiplier (see the class doc comment above). The
  // mismatch warning/rejection now happens earlier, in onImageEvent, before
  // applyPose is even called for an untrustworthy sample.
  return 1;
}

/**
 * Per-plaque yaw correction, applied AFTER the fixed TARGET_FRAME_TO_WORLD_FIX
 * above — that fix handles "flat marker in general"; this handles "this
 * specific plaque's own mount rotation relative to the model's reference
 * orientation" (§E "Multi-target plaques"; ResolvedPlaqueTarget.rotationYawDeg
 * doc comment has the full derivation). Identity (0°) for a single-target
 * experience, which is exactly today's pre-multi-target behavior — see the
 * single-element-array note on the constructor.
 */
function yawCorrectionQuaternion(rotationYawDeg: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    THREE.MathUtils.degToRad(rotationYawDeg)
  );
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
 * AnchorSource whose origin is a printed QR plaque on the fixed 3D-printed
 * model, tracked as an 8th Wall image target — one or more plaques, per
 * `targets` (§E "Multi-target plaques"). A single-target experience (e.g.
 * 8thwall-test) is simply a one-element `targets` array with
 * originOffsetMeters {x:0,z:0} and rotationYawDeg 0, which reduces
 * applyPose()'s composition to exactly the pre-multi-target math (see its
 * doc comment) — no behavior change for existing single-target callers.
 *
 * acquire() resolves on the FIRST imagefound of ANY configured plaque;
 * every subsequent imagefound/imageupdated (of any plaque still in the
 * `targets` map) re-snaps the mount group to that plaque's own
 * offset/rotation-corrected pose, correcting accumulated SLAM drift
 * whenever the user glances back at whichever plaque is currently in
 * view — PROVIDED the sample passes isPoseTrustworthy() (below): a reading
 * whose engine-reported scale is implausible is rejected outright instead
 * of applied, so a single bad frame can no longer move the anchor (see that
 * function's doc comment for the on-device evidence this responds to).
 * After imagelost the group simply stops receiving snaps — SLAM world
 * tracking (disableWorldTracking: false in EightWallSession) keeps the
 * frozen world pose valid, so content persists while the user walks around
 * the model. Scan any one plaque once, walk around.
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
  private readonly scratchOffset = new THREE.Vector3();
  private readonly targetsByName: ReadonlyMap<string, ResolvedPlaqueTarget>;
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
    /** One entry per plaque this experience should recognize (§E). */
    targets: readonly ResolvedPlaqueTarget[]
  ) {
    this.targetsByName = new Map(targets.map((target) => [target.name, target]));
    this.group.name = 'image-target-anchor';
    this.group.visible = false;
    this.scene.add(this.group);
    this.unsubscribe = this.session.onImageEvent((kind, event) => this.onImageEvent(kind, event));
  }

  acquire(): Promise<void> {
    const names = [...this.targetsByName.keys()].join('", "');
    console.log(
      `[${traceT()}] [ImageTargetAnchorSource] acquire() — waiting for first imagefound of any of "${names}"...`
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
    // Ignore events for a target name outside this experience's `targets`
    // — same filtering intent as the pre-multi-target single-name compare,
    // now a map lookup instead of one equality check.
    const target = event === null ? undefined : this.targetsByName.get(event.name);
    if (event !== null && target === undefined) return;
    switch (kind) {
      case 'found': {
        if (event === null || target === undefined) return;
        const wasAcquired = this.acquired;
        const ratio = scaleRatio(event, target.physicalTargetWidthMeters);
        // First-ever acquisition always applies — there is no prior
        // known-good anchor to fall back to (see isPoseTrustworthy's doc
        // comment).
        const trustworthy = !wasAcquired || isPoseTrustworthy(ratio);
        console.log(
          `[${traceT()}] [ImageTarget] FOUND "${event.name}"\n` +
            `  scale=${event.scale.toFixed(3)}m ${formatPose(event)}\n` +
            `  acquired: ${wasAcquired} -> true` +
            (wasAcquired
              ? trustworthy
                ? ' (re-detection — firing onOriginChanged, pose discontinuity)'
                : ' (re-detection REJECTED — scale ratio outside tolerance, keeping previous anchor)'
              : ' (first acquire — group visible, resolving acquire())')
        );
        this.imageVisible = true;
        if (trustworthy) {
          this.applyPose(event, target);
        } else {
          warnIfScaleMismatch(event, target.physicalTargetWidthMeters, ratio);
        }
        if (!this.acquired) {
          this.acquired = true;
          this.group.visible = true;
          this.acquireResolve?.();
          this.acquireResolve = null;
        } else if (trustworthy) {
          // Re-detection after a lost = pose discontinuity (only when the
          // anchor actually moved — a rejected sample changed nothing).
          for (const handler of this.originChangedHandlers) {
            handler();
          }
        }
        break;
      }
      case 'updated':
        if (event !== null && target !== undefined) {
          const now = performance.now();
          if (now - this.lastUpdatedLogMs > ImageTargetAnchorSource.UPDATED_LOG_INTERVAL_MS) {
            this.lastUpdatedLogMs = now;
            console.log(
              `[${traceT()}] [ImageTarget] updated (throttled 1/s) "${event.name}" ` +
                `scale=${event.scale.toFixed(3)}m ${formatPose(event)}`
            );
          }
          const ratio = scaleRatio(event, target.physicalTargetWidthMeters);
          if (isPoseTrustworthy(ratio)) {
            this.applyPose(event, target);
          } else {
            warnIfScaleMismatch(event, target.physicalTargetWidthMeters, ratio);
          }
          this.imageVisible = true;
        }
        break;
      case 'lost':
        console.log(
          `[${traceT()}] [ImageTarget] LOST "${event?.name ?? '(unknown)'}"\n` +
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

  /**
   * Composes the tracked plaque's pose with ITS OWN offset/rotation
   * correction so the mounted site-scene's origin (never the tracked
   * plaque itself, once originOffsetMeters is non-zero) ends up at the
   * same world position/orientation regardless of which of the `targets`
   * plaques fired (§E "Multi-target plaques" — "Runtime resolution").
   *
   * correctedQuat is "how the model's own local frame is oriented in
   * world space, given this specific plaque's mount": the tracked
   * rotation, the fixed flat-marker glue (TARGET_FRAME_TO_WORLD_FIX), then
   * this plaque's own yaw correction relative to the other plaques. The
   * model's world origin then sits `originOffsetMeters` away from the
   * tracked plaque, in the model's own (now-known) orientation — so it's
   * the tracked position MINUS that offset rotated into world space, not
   * the tracked position itself (which is where the pre-multi-target code
   * put it — correct only when offsetMeters is exactly {0,0}).
   */
  private applyPose(event: Xr8ImageTrackedEvent, target: ResolvedPlaqueTarget): void {
    this.scratchQuat.set(event.rotation.x, event.rotation.y, event.rotation.z, event.rotation.w);
    this.group.quaternion
      .copy(this.scratchQuat)
      .multiply(TARGET_FRAME_TO_WORLD_FIX)
      .multiply(yawCorrectionQuaternion(target.rotationYawDeg));

    this.scratchOffset
      .set(target.originOffsetMeters.x, 0, target.originOffsetMeters.z)
      .applyQuaternion(this.group.quaternion);
    this.group.position
      .set(event.position.x, event.position.y, event.position.z)
      .sub(this.scratchOffset);

    this.group.scale.setScalar(anchorScaleForEvent());
  }
}
