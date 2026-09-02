import * as THREE from 'three';
import type { AnchorSource, OriginKind } from './AnchorSource.js';
import type { EightWallSession, ImageEventKind } from './EightWallSession.js';
import type { ResolvedPlaqueTarget } from './ImageTargetLoader.js';
import type { Xr8ImageTrackedEvent } from './types/xr8.js';
import { traceT } from './TraceLog.js';
// TEMPORARY diagnostic instrumentation — see DiagnosticTimeline.ts's own
// doc comment. Remove this import and every diagMark() call site once the
// 5-6s startup investigation is closed.
import { diagMark } from './DiagnosticTimeline.js';

/**
 * §F axis-convention lockdown, image-target edition — the ONLY place the
 * target-frame → world-frame conversion exists (same contract as
 * SceneGraphLoader's GLTF_TO_WORLD constants; the two compose, they never
 * duplicate).
 *
 * CORRECTED AGAIN (2026-08-17, coworker physical review): the 4 plaques'
 * real mounting orientation is decided — flat on the ledge surface,
 * artwork facing up, NOT standing vertically like a museum placard. The
 * 2026-08-14 fix below (`identity()`) was evidence-backed for THAT
 * assumption specifically ("content should stand upright aligned with a
 * WALL-mounted vertical image"); now that the physical mount is flat, this
 * project already has a validated glue transform for exactly this
 * physical configuration — `SceneGraphLoader.ts`'s
 * `GLTF_TO_MINDAR_ROTATION_X_RADIANS = Math.PI / 2` — because MindAR's
 * bench-test plaque (`build_bench_scene.py`'s `ar_launch_plaque`) has
 * ALWAYS been a flat, table-lying plaque: "MindAR's anchor frames the flat
 * plaque as X-east / Y-north / Z-up. Rotating +90° about X maps (x, y, z)
 * → (x, −z, y) = (east, north, up)." Reused here rather than re-derived —
 * same physical marker shape (flat, artwork-up), same glTF-authored
 * content (X-east/Y-up/Z-south), so the same rotation applies. `Rx(+90°)`
 * was in fact this constant's original value before the 2026-08-14 pass
 * changed it to `identity()` under the (now-corrected) vertical-mount
 * assumption — this is a return to that value, but for a DIFFERENT,
 * now-confirmed reason (the flat-marker precedent above), not a blind
 * revert.
 *
 * STILL genuinely open, requiring physical access, not software (the
 * per-plaque `rotationYawDeg` correction is unaffected either way — see
 * its own doc comment; it corrects a separate, orthogonal world-Y-axis
 * rotation between plaques, not this target-frame convention): whether
 * 8th Wall's image-target rotation convention for a FLAT/horizontal
 * marker actually matches MindAR's (both are common AR-SDK conventions,
 * but this specific cross-engine assumption has no on-device 8th-Wall
 * confirmation yet, only the internal same-project precedent above).
 */
const TARGET_FRAME_TO_WORLD_FIX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

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

// 2026-09-02 correction: this comment previously claimed
// isSampleTrustworthy() "only runs during the brief pre-freeze convergence
// window... a few samples at most" — a real on-device capture refuted that
// directly: a cold start stuck in trackingStatus=LIMITED/INITIALIZING for
// 13-30+ seconds produces 800-1800+ rejected 'updated' samples on its own,
// before the session even reaches anything interesting. The throttle below
// is not "mostly moot," it is load-bearing — see the trackingStatus
// rejection warning further down, which lacked this same throttle and was
// confirmed (same capture) to flood both the on-screen ?debug=1 panel and
// any copy-pasted/exported log with one repeated line per frame, crowding
// out the FOUND/LOST/TrackingStatus-change lines actually needed to
// diagnose anything.
const SCALE_MISMATCH_WARN_INTERVAL_MS = 1000;
let lastScaleMismatchWarnMs = 0;
let lastTrackingStatusRejectWarnMs = 0;
let lastRotationImplausibleWarnMs = 0;

/**
 * §37 follow-up (2026-09-02, docs/log-10.txt): the rotation-consensus gate
 * (see the class doc comment) only ever compared YAW between two samples —
 * nothing checked pitch/roll. A real capture showed a sequence of
 * internally-yaw-agreeing CONFIRMED pairs whose pitch climbed steadily
 * across successive re-detections (4.9° → 2.8° → 17.2° → 20.3° → 33.5° →
 * 35.5°) while yaw stayed roughly put — the model visibly tilting more
 * with every re-ground, reported as "inclinación." Unlike yaw (no ground
 * truth to check one sample against), every physical plaque is mounted
 * FLAT (coworker-confirmed — see TARGET_FRAME_TO_WORLD_FIX's own doc
 * comment), so pitch/roll genuinely DO have a ground truth: both should
 * stay near 0° always, regardless of the phone's own viewing angle, since
 * the anchored content's world orientation doesn't depend on how it's
 * being looked at. Every previously-confirmed-good sample logged across
 * every capture this project has to date stayed under 10°; every
 * corrupted one seen so far was 17°+ — this tolerance sits between the
 * two clusters with margin on both sides.
 */
const PITCH_ROLL_PLAUSIBILITY_MAX_DEG = 15;

function scaleRatio(event: Xr8ImageTrackedEvent, physicalTargetWidthMeters: number): number {
  return event.scale / physicalTargetWidthMeters;
}

/**
 * First real physical-device test (2026-08-14) surfaced a world anchor that
 * drifts/jumps and briefly appears at a drastically wrong scale/distance
 * after tracking correctly at first. Root cause, confirmed against this
 * file's pre-existing behavior and telemetry (docs/research/
 * 8th-wall-troubleshooting.md §4/§10) rather than assumed: applyPose() —
 * below — used to apply every single raw tracked pose (both `found` and
 * every `updated`, i.e. every frame the target is visible) directly to the
 * world anchor with zero plausibility check. §10 of that log already
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
 * This gate still exists after the 2026-08-31/§26 strategy change (see the
 * class doc comment) — it now decides which sample gets to become the
 * initial pose AND which later discrete re-detections are trusted enough
 * to re-ground it, rather than deciding whether to accept each of an
 * unbounded per-frame stream of re-snaps. A ratio far from 1 means the
 * engine's own absolute-scale estimate for this reading hasn't converged
 * (or is actively bad) — exactly the condition the warning already names.
 */
function isScalePlausible(ratio: number): boolean {
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

/** See PITCH_ROLL_PLAUSIBILITY_MAX_DEG's own doc comment (§37 follow-up). */
function isRotationPlausible(pitchDeg: number, rollDeg: number): boolean {
  return Math.abs(pitchDeg) <= PITCH_ROLL_PLAUSIBILITY_MAX_DEG && Math.abs(rollDeg) <= PITCH_ROLL_PLAUSIBILITY_MAX_DEG;
}

function warnIfRotationImplausible(pitchDeg: number, rollDeg: number): void {
  if (!isRotationPlausible(pitchDeg, rollDeg)) {
    const now = performance.now();
    if (now - lastRotationImplausibleWarnMs > SCALE_MISMATCH_WARN_INTERVAL_MS) {
      lastRotationImplausibleWarnMs = now;
      console.warn(
        `[${traceT()}] [ImageTarget] rotation implausible: pitch=${pitchDeg.toFixed(1)}°, roll=${rollDeg.toFixed(1)}° ` +
          `(plaques are mounted flat — expect near 0°, tolerance ±${PITCH_ROLL_PLAUSIBILITY_MAX_DEG}°). ` +
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

const candidateYawScratchQuat = new THREE.Quaternion();
const candidateYawScratchEuler = new THREE.Euler();

/**
 * Euler angles (degrees, YXZ order — matches cameraDiagnosticLine's own
 * euler extraction) of the pose applyPose() WOULD compose for this sample,
 * without mutating the anchor group. Yaw feeds the rotation-consensus gate
 * (§37, comparing a candidate against a still-pending one); pitch/roll
 * feed isRotationPlausible() (§37 follow-up, checked against the known-flat
 * mount, not against another sample).
 */
function computeCandidateEulerDeg(
  event: Xr8ImageTrackedEvent,
  target: ResolvedPlaqueTarget
): { yawDeg: number; pitchDeg: number; rollDeg: number } {
  candidateYawScratchQuat
    .set(event.rotation.x, event.rotation.y, event.rotation.z, event.rotation.w)
    .multiply(TARGET_FRAME_TO_WORLD_FIX)
    .multiply(yawCorrectionQuaternion(target.rotationYawDeg));
  candidateYawScratchEuler.setFromQuaternion(candidateYawScratchQuat, 'YXZ');
  return {
    yawDeg: THREE.MathUtils.radToDeg(candidateYawScratchEuler.y),
    pitchDeg: THREE.MathUtils.radToDeg(candidateYawScratchEuler.x),
    rollDeg: THREE.MathUtils.radToDeg(candidateYawScratchEuler.z),
  };
}

/** Circular difference between two degree angles, always in [0, 180]. */
function angleDiffDeg(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
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
 * **Strategy (2026-08-31, refined 2026-09-01) — anchor once, then only
 * correct on discrete re-detections; never on continuous per-frame
 * sampling.** Weeks of on-device testing under the original strategy
 * (continuously re-snapping the anchor's transform to every
 * plausibility-checked `found`/`updated` sample, most recently with a
 * per-axis/per-quaternion-component One Euro Filter layered on top —
 * docs/research/8th-wall-troubleshooting.md §22/§24) kept surfacing the
 * same failure family in new shapes: drift/scale jumps (§13), a tilted
 * scene from a wrong glue rotation exposed BECAUSE every frame re-applied
 * it (§14), continuous jitter/spin while the camera held still on a target
 * (§22), and an offset plaque amplifying per-frame angular noise into
 * visible positional swim (the `originOffsetMeters` lever-arm effect — the
 * same class of report as 8th Wall's own community forum, see §25). The
 * 2026-08-31 pass (§25) went to the opposite extreme — freeze the
 * transform permanently after the first stable pose, matching
 * `TapPlacedAnchorSource` and 8th Wall's own forum-recommended pattern —
 * which eliminated the jitter but, per the FIRST physical-device retest of
 * that pass (§26), reintroduced the exact SLAM-drift symptom continuous
 * re-snapping used to correct: on a real multi-minute walkaround of the
 * `site` model, the scene visibly follows the user's motion and loses
 * correct scale, because nothing ever re-grounds the anchor against
 * reality again after the first lock.
 *
 * **The refinement (§26): distinguish the EVENT SHAPE, not just gate on
 * `stable`.** `'updated'` fires every frame the target is in view — a
 * continuous stream, and per §22/§24 the proven source of jitter when
 * perpetually re-applied. `'found'` fires only on a DISCRETE transition
 * (first detection, or a fresh re-detection after `imagelost`) — at most
 * a few times per minute during normal use, each one the user directly
 * looking at a known-fixed physical plaque again. Re-grounding the anchor
 * on that discrete signal is a bounded, occasional correction (exactly
 * what SLAM drift needs), not a per-frame perturbation (what caused the
 * jitter). So: once `stable`, `'updated'` samples are PERMANENTLY a pose
 * no-op (unchanged from §25 — this is what actually fixed the jitter, and
 * it stays fixed), but `'found'` — a fresh re-detection of ANY configured
 * plaque, at ANY point in the session — still runs through the same
 * `isSampleTrustworthy()` gate and, if it passes, re-applies the pose and
 * fires `onOriginChanged`, exactly as it did before `stable` existed.
 *
 * Mechanically: the pre-existing bootstrap/convergence/reveal machinery
 * (§19 "Cold-start stabilization") is UNCHANGED — the very first `found`
 * of any configured plaque still applies unconditionally (so the anchor
 * is never left un-placed), the anchor stays hidden until a sample
 * independently passes `isSampleTrustworthy()`, and that first passing
 * sample is still what reveals the group and resolves `whenStable()`.
 * After `imagelost` the group simply stops receiving snaps until the NEXT
 * `found` — SLAM world tracking (`disableWorldTracking: false` in
 * EightWallSession) keeps the frozen-since-last-correction world pose
 * valid in between, so content persists smoothly while the user walks;
 * each fresh sighting of a plaque is then a chance to re-ground it, like
 * a hiker periodically checking a landmark against a map instead of
 * navigating purely by dead reckoning.
 *
 * The One Euro Filter smoothing apparatus this file carried between
 * 2026-08-26 and 2026-08-31 stays removed: `'found'` re-detections are
 * occasional, discrete ground-truth samples that should snap exactly, not
 * lag toward — smoothing belongs on a continuous signal, and there isn't
 * one here anymore.
 *
 * `seenTargetNames` (§24, "Multi-target switching fix") now matters for
 * the FULL session, not just an initial convergence window: a plaque this
 * anchor has never seen before gets its `trackingStatus === 'NORMAL'`
 * requirement waived on first sighting, `stable` or not — walking up to a
 * DIFFERENT plaque than the one that originally acquired the anchor, well
 * into an established session, is exactly the §24 scenario and exactly
 * the periodic re-grounding this refinement restores. It does NOT waive
 * scale plausibility (§33 correction, 2026-09-02) — a real capture showed
 * a new plaque's first sighting applying a 14.9x-implausible scale reading
 * purely because no scale check ran on it at all; every accepted sample,
 * new target or not, must still pass `isScalePlausible()`.
 *
 * onOriginChanged fires on every accepted `'found'` past the very first
 * bootstrap sample, for the lifetime of the anchor — not just during an
 * initial convergence window — since a discrete re-detection is always a
 * potential pose discontinuity for downstream screen-space filter state
 * to reset against, whether it happens 2 seconds or 5 minutes into the
 * session.
 *
 * **Rotation-consensus gate (2026-09-02, §37 — docs/log-9.txt).** Two
 * independent physical captures proved a sample can pass
 * `isSampleTrustworthy()` (scale plausible AND trackingStatus NORMAL) with
 * a badly wrong ROTATION. Capture one: the reveal-triggering sample (yaw
 * 134.2°) was immediately followed 0.23s later by a second accepted
 * re-detection landing 70+ degrees away (yaw -155.8°) — both individually
 * scale-plausible and NORMAL, for the same physically-unmoving plaque.
 * Capture two: the sole reveal-triggering sample carried a -114.3° yaw
 * despite a near-perfect scale ratio (1.03), six seconds into stable
 * NORMAL tracking. Scale plausibility says nothing about rotation
 * quality — 8th Wall's single-frame image-target orientation estimate can
 * be noisy independent of how good the translation/scale reading is.
 * There is no absolute ground truth for yaw to check one sample against
 * (unlike scale, which has `physicalTargetWidthMeters`), so this gate
 * requires TEMPORAL AGREEMENT instead: a candidate sample that would
 * otherwise apply is held pending until a SECOND trustworthy sample for
 * the same target, arriving within `YAW_CONFIRM_WINDOW_MS`, agrees with
 * it in yaw within `YAW_CONFIRM_TOLERANCE_DEG` — at which point the
 * CONFIRMING sample is what actually applies. This filters exactly the
 * single-frame outliers both captures showed without assuming which of
 * two divergent readings is correct. While a target stays in view this
 * costs at most one extra tracked frame (the 'updated' case runs the
 * check every frame, not just once per second like its console.log) — it
 * only meaningfully delays anything in the pathological case this exists
 * to catch: an isolated bad frame with no immediate corroborating
 * follow-up.
 *
 * **§37 follow-up (2026-09-02, docs/log-10.txt): the consensus gate above
 * only ever compared YAW — pitch/roll rode along unchecked on whichever
 * sample confirmed.** A real capture showed a sequence of individually
 * yaw-agreeing CONFIRMED re-detections whose PITCH climbed steadily with
 * each one (4.9° → 2.8° → 17.2° → 20.3° → 33.5° → 35.5°) while yaw stayed
 * roughly put — the model visibly tilting more every time it re-grounded,
 * reported as "inclinación." Unlike yaw, pitch/roll DO have a ground
 * truth here: every plaque is mounted flat (see
 * `TARGET_FRAME_TO_WORLD_FIX`'s own doc comment), so the anchored
 * content's pitch/roll should stay near 0° always, independent of the
 * phone's viewing angle. `isRotationPlausible()` (see
 * `PITCH_ROLL_PLAUSIBILITY_MAX_DEG`'s own doc comment) rejects a sample
 * outright — before it can even become or confirm a consensus candidate —
 * if its pitch or roll falls outside that physically-plausible range,
 * exactly as `isScalePlausible()` already does for scale. Same §33
 * precedent applies: never exempted for a new target's first sighting,
 * same as scale.
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
  // Cold-start stabilization (2026-08-18, see this class's own doc comment
  // and AR_SYSTEM.md §G): whether a pose has ever passed
  // isSampleTrustworthy() SINCE acquisition — distinct from `acquired`,
  // which only means a bootstrap sample was applied. `group.visible` flips
  // true exactly once, here, never on the bootstrap sample alone. Since
  // 2026-08-31/§26 this ALSO permanently gates the CONTINUOUS 'updated'
  // stream (never a discrete 'found' re-detection) — see the class doc
  // comment's strategy section — not just "revealed."
  private stable = false;
  private readonly stableResolvers: Array<() => void> = [];
  // Multi-target switching fix (2026-08-26, physical-device finding — see
  // onImageEvent's 'found' case doc comment): names that have ever produced
  // a trustworthy sample. Matters for the FULL session (§26) — every
  // 'found' still consults this, `stable` or not.
  private readonly seenTargetNames = new Set<string>();
  // Rotation-consensus gate (2026-09-02, §37 — see class doc comment): a
  // candidate sample that passed isSampleTrustworthy() but hasn't yet been
  // corroborated by a second, agreeing sample for the SAME target within
  // YAW_CONFIRM_WINDOW_MS.
  private pendingCandidate: { name: string; yawDeg: number; atMs: number } | null = null;
  private static readonly YAW_CONFIRM_WINDOW_MS = 1000;
  private static readonly YAW_CONFIRM_TOLERANCE_DEG = 20;

  /**
   * Called for every APPLIED pose (bootstrap or checked) — see
   * onImageEvent's call sites: the 'found' case calls this on every
   * accepted discrete re-detection for the FULL session (§26), while the
   * 'updated' case only ever reaches this while `!this.stable`. isBootstrap
   * = true only for the very-first, unconditionally-applied acquisition
   * sample; false for every later accepted sample. The scene/anchor must
   * never be revealed on the bootstrap sample alone (that's the whole
   * cold-start bug this exists to fix) — only the first genuinely-checked
   * sample flips `stable` and reveals the group, and it does so exactly
   * once; `stable` thereafter only means "revealed" and "the continuous
   * 'updated' stream is now permanently ignored" — it does NOT mean this
   * function stops being called altogether.
   */
  private onPoseApplied(isBootstrap: boolean, ratio: number): void {
    // TEMPORARY diagnostic instrumentation — see DiagnosticTimeline.ts.
    // Kept in place (not stripped this pass) specifically so an on-device
    // capture can confirm this new gating actually removes the bad visual
    // window before the instrumentation itself is removed — see the
    // implementation report for why.
    diagMark(
      isBootstrap ? 'first-pose-applied (bootstrap, unchecked)' : 'trustworthy-pose-applied',
      `ratio=${ratio.toFixed(2)}`
    );
    if (isBootstrap || this.stable) return;
    this.stable = true;
    this.group.visible = true;
    console.log(
      `[${traceT()}] [ImageTargetAnchorSource] first trustworthy pose accepted (ratio=${ratio.toFixed(2)}) ` +
        '— revealing anchor group. Continuous per-frame updates are now ignored; a fresh re-detection can still re-ground it (§26).'
    );
    for (const resolve of this.stableResolvers) resolve();
    this.stableResolvers.length = 0;
    // Guarded: this class's own unit tests run under plain Node (node:test),
    // which has no `window` global.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('ar-diag:trustworthy-pose'));
    }
  }

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
    // Re-acquire is a no-op by design: the anchor is placed exactly once
    // (2026-08-31 strategy) — there is nothing to re-run.
    if (this.acquired) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.acquireResolve = resolve;
    });
  }

  /**
   * See AnchorSource.whenStable's own doc comment for the contract. Distinct
   * from acquire(): acquire() resolves on the unchecked bootstrap sample
   * (so the anchor is never left un-placed — same reasoning as
   * isSampleTrustworthy's doc comment); whenStable() resolves only once a
   * pose has independently passed isSampleTrustworthy(), which is also the
   * exact instant `group.visible` flips true AND the transform freezes
   * (onPoseApplied above) — the two are the same event by construction,
   * not two signals that could drift out of sync.
   */
  whenStable(): Promise<void> {
    if (this.stable) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.stableResolvers.push(resolve);
    });
  }

  /**
   * NORMAL SLAM after first detection — visible-or-SLAM-extended. The
   * plaque leaving the camera view must NOT read as tracking loss; that
   * persistence is the whole point of the hybrid design. Unaffected by the
   * 2026-08-31 freeze change — this gates MARKER visibility, not the
   * anchor's own transform.
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

  /**
   * Second-audit finding (2026-08-14, third physical test): whether a
   * tracked sample is trustworthy enough to apply to the world anchor.
   * Three independent gates, any can reject:
   *
   * - Scale plausibility (isScalePlausible): the same
   *   SCALE_MISMATCH_TOLERANCE check as the pre-existing warning.
   * - Rotation plausibility (isRotationPlausible, §37 follow-up,
   *   2026-09-02): pitch/roll checked against the known-flat plaque
   *   mount — see PITCH_ROLL_PLAUSIBILITY_MAX_DEG's own doc comment for
   *   the capture that motivated this (a steadily climbing tilt across
   *   several individually yaw-agreeing confirmed re-detections).
   * - SLAM tracking status: `this.session.trackingStatus === 'NORMAL'`.
   *   isTracking() (above) already reads this exact field to gate marker
   *   VISIBILITY; applyPose() previously never read it at all, so a pose
   *   sample arriving mid-RELOCALIZING (or any other non-NORMAL status —
   *   TOO_MUCH_MOTION, NOT_ENOUGH_TEXTURE, INITIALIZING) could still
   *   silently move the anchor while markers were merely hidden by the
   *   OTHER gate — hiding the symptom, not preventing the corruption. The
   *   anchor would then reveal wherever it drifted to the moment tracking
   *   recovered and isTracking() stopped hiding markers.
   *
   * Since 2026-08-31 this gate is only ever consulted before `stable` —
   * see the class doc comment's strategy section.
   */
  private isSampleTrustworthy(ratio: number, event: Xr8ImageTrackedEvent, target: ResolvedPlaqueTarget): boolean {
    const { pitchDeg, rollDeg } = computeCandidateEulerDeg(event, target);
    return isScalePlausible(ratio) && isRotationPlausible(pitchDeg, rollDeg) && this.session.trackingStatus === 'NORMAL';
  }

  /**
   * Rotation-consensus gate — see the class doc comment's §37 section for
   * the two physical captures that motivated this. Returns true if this
   * call resulted in `applyPose()` actually running (the caller still does
   * its own onPoseApplied/reveal/origin-changed bookkeeping); false if the
   * sample is being held pending confirmation.
   */
  private tryApplyWithRotationConsensus(event: Xr8ImageTrackedEvent, target: ResolvedPlaqueTarget): boolean {
    const { yawDeg } = computeCandidateEulerDeg(event, target);
    const now = performance.now();
    const pending = this.pendingCandidate;
    if (
      pending &&
      pending.name === event.name &&
      now - pending.atMs <= ImageTargetAnchorSource.YAW_CONFIRM_WINDOW_MS &&
      angleDiffDeg(yawDeg, pending.yawDeg) <= ImageTargetAnchorSource.YAW_CONFIRM_TOLERANCE_DEG
    ) {
      this.pendingCandidate = null;
      this.applyPose(event, target);
      return true;
    }
    console.log(
      `[${traceT()}] [ImageTargetAnchorSource] rotation not yet corroborated for "${event.name}" ` +
        `(yaw=${yawDeg.toFixed(1)}°) — awaiting a confirming sample before applying (§37)`
    );
    this.pendingCandidate = { name: event.name, yawDeg, atMs: now };
    return false;
  }

  /**
   * Diagnostic-only (2026-09-01, troubleshooting doc §27): "anchor is lost
   * easily, scale goes miniature" has (at least) two structurally
   * different possible causes that look identical from the visual symptom
   * alone — (a) this class's own gate/composition applying a bad pose, or
   * (b) the CAMERA's own SLAM pose/absolute-scale estimate silently
   * rescaling underneath an otherwise-correct, untouched anchor (a known
   * limitation class of monocular VIO scale estimation, not something any
   * per-sample ratio check on the TRACKED IMAGE can catch, since a global
   * rescale moves the image's apparent size and the camera's own position
   * by the same factor). Logging the camera's live position and its
   * distance to this anchor's group alongside every existing FOUND/updated
   * line is the cheapest way to tell those apart from ONE clean capture,
   * instead of guessing which one it is and shipping another unverified
   * fix. Never read for any tracking decision — logging only.
   *
   * Rotation added (2026-09-02, troubleshooting doc §32/§34): a reported
   * "diagonal tilt" needed the anchor's actual applied WORLD rotation to
   * investigate, and the existing `[ImageTarget] updated (throttled 1/s)`
   * line only shows the RAW incoming event's rotation, sampled at most
   * once/second — a real capture showed the raw sample displayed by that
   * throttle and the sample that actually got accepted moments later were
   * two different events with very different scales, so the accepted
   * transform's rotation was never printed anywhere. This line runs
   * exactly once per applied pose (every accept, not throttled), so it
   * always reflects the transform actually in effect. Euler degrees
   * alongside the raw quaternion purely for human eyeballing ("does this
   * look tilted") — never used for any computation.
   */
  private cameraDiagnosticLine(): string {
    const cam = this.session.getCameraPosition();
    const q = this.group.quaternion;
    const euler = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    const rotStr =
      `rot=(${q.x.toFixed(2)}, ${q.y.toFixed(2)}, ${q.z.toFixed(2)}, ${q.w.toFixed(2)}) ` +
      `euler(YXZ, deg)=(yaw=${THREE.MathUtils.radToDeg(euler.y).toFixed(1)}, ` +
      `pitch=${THREE.MathUtils.radToDeg(euler.x).toFixed(1)}, roll=${THREE.MathUtils.radToDeg(euler.z).toFixed(1)})`;
    if (!cam) return `  camera=unavailable (session not started?) anchor-${rotStr}`;
    const dx = cam.x - this.group.position.x;
    const dy = cam.y - this.group.position.y;
    const dz = cam.z - this.group.position.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return (
      `  camera=(${cam.x.toFixed(2)}, ${cam.y.toFixed(2)}, ${cam.z.toFixed(2)}) ` +
      `anchor=(${this.group.position.x.toFixed(2)}, ${this.group.position.y.toFixed(2)}, ${this.group.position.z.toFixed(2)}) ` +
      `dist=${distance.toFixed(2)}m anchor-${rotStr}`
    );
  }

  /**
   * 2026-09-02 fix: this trackingStatus warning had no throttle of its own
   * — unlike `warnIfScaleMismatch` right above it — so a sustained
   * non-NORMAL stretch (a slow cold start, sustained RELOCALIZING mid-walk)
   * printed this exact line every single 'updated' frame, unbounded. A
   * real on-device capture (troubleshooting doc §27) showed a 13-30s cold
   * start alone producing 800-1800+ copies of this one line, which is what
   * was actually preventing a usable full-session capture — not a mystery
   * about the anchor, a console-flooding bug in the logging itself. Reuses
   * the same 1/s throttle as the scale-mismatch warning right above.
   */
  private logSampleRejected(event: Xr8ImageTrackedEvent, target: ResolvedPlaqueTarget, ratio: number): void {
    warnIfScaleMismatch(event, target.physicalTargetWidthMeters, ratio);
    const { pitchDeg, rollDeg } = computeCandidateEulerDeg(event, target);
    warnIfRotationImplausible(pitchDeg, rollDeg);
    if (this.session.trackingStatus !== 'NORMAL') {
      const now = performance.now();
      if (now - lastTrackingStatusRejectWarnMs > SCALE_MISMATCH_WARN_INTERVAL_MS) {
        lastTrackingStatusRejectWarnMs = now;
        console.warn(
          `[${traceT()}] [ImageTarget] pose sample rejected — trackingStatus=${this.session.trackingStatus} ` +
            `reason=${this.session.trackingReason} (not NORMAL). Anchor holds its last known-good transform.`
        );
      }
    }
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
    this.pendingCandidate = null;
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
        this.imageVisible = true;

        if (!this.acquired) {
          // Bootstrap: the very first sighting of ANY configured plaque,
          // applied unconditionally (isSampleTrustworthy's own reasoning:
          // refusing to ever place the scene would be worse than an
          // imperfect first placement) — anchor stays hidden until a LATER
          // sample independently passes the trust gate below.
          const ratio = scaleRatio(event, target.physicalTargetWidthMeters);
          console.log(
            `[${traceT()}] [ImageTarget] FOUND "${event.name}"\n` +
              `  scale=${event.scale.toFixed(3)}m ${formatPose(event)}\n` +
              `  trackingStatus=${this.session.trackingStatus}\n` +
              '  acquired: false -> true (bootstrap — pose applied, anchor stays hidden until a trustworthy sample lands)'
          );
          this.seenTargetNames.add(event.name);
          this.applyPose(event, target);
          console.log(`[${traceT()}] [ImageTargetAnchorSource]${this.cameraDiagnosticLine()}`);
          this.onPoseApplied(true, ratio);
          this.acquired = true;
          this.acquireResolve?.();
          this.acquireResolve = null;
          break;
        }

        // Every 'found' past bootstrap is a DISCRETE re-detection — the
        // user directly looking at a known-fixed plaque again — never
        // frozen out, `stable` or not (§26 refinement to the class doc
        // comment's strategy section: only the CONTINUOUS 'updated' stream
        // below is frozen after stabilization; a discrete re-detection is
        // exactly the periodic re-grounding a real walkaround session
        // needs against accumulated SLAM drift). Same trust gate as
        // always (scale plausibility AND trackingStatus === 'NORMAL'),
        // with the §24 exemption — a plaque this anchor has never seen
        // before is new information, not suspect continuation of an
        // existing one.
        //
        // §33 correction (2026-09-02, physical-device capture): the §24
        // exemption used to bypass BOTH halves of the gate for a new
        // target (`isNewTarget || isSampleTrustworthy(ratio)`) — not just
        // the trackingStatus half it was built for. A real capture caught
        // this directly: `site-tracking-back`'s first-ever sighting
        // applied a scale ratio of 14.9 (declared 0.03m, engine read
        // 0.448m) while the camera's own position had just jumped by
        // several meters — an obviously corrupt sample — purely because
        // no scale check ever ran on it. `site-tracking-left`'s first
        // sighting (ratio 2.27) then overwrote that with a second,
        // still-implausible reading. §24's actual problem was a plaque
        // switch getting rejected by the trackingStatus half specifically
        // (walking to a different plaque is exactly when trackingStatus
        // commonly deviates from NORMAL) — nothing about that problem
        // required also skipping the scale check. Fixed by exempting only
        // the trackingStatus requirement for a new target's first
        // sighting; scale plausibility is now required unconditionally,
        // for every accepted sample, new target or not. §37 follow-up
        // (2026-09-02): the same reasoning applies to rotation
        // plausibility — a new target's implausible tilt is exactly as
        // corrupt as an implausible scale, so it gets the same
        // unconditional treatment, never exempted.
        const isNewTarget = !this.seenTargetNames.has(event.name);
        const ratio = scaleRatio(event, target.physicalTargetWidthMeters);
        const scalePlausible = isScalePlausible(ratio);
        const { pitchDeg, rollDeg } = computeCandidateEulerDeg(event, target);
        const rotationPlausible = isRotationPlausible(pitchDeg, rollDeg);
        const trustworthy = scalePlausible && rotationPlausible && (isNewTarget || this.session.trackingStatus === 'NORMAL');
        let statusLine: string;
        if (!scalePlausible || !rotationPlausible) {
          const reason = !scalePlausible ? 'scale' : 'pitch/roll';
          statusLine = isNewTarget
            ? `  first sighting of a NEW plaque, but ${reason} implausible — REJECTED, see warning below — keeping previous anchor`
            : `  re-detection REJECTED (${reason} implausible) — see warning below — keeping previous anchor`;
        } else if (isNewTarget) {
          statusLine = '  first sighting of a NEW plaque — applied (trackingStatus exemption), firing onOriginChanged';
        } else if (trustworthy) {
          statusLine = '  re-detection — firing onOriginChanged, pose discontinuity';
        } else {
          statusLine = '  re-detection REJECTED — see warning below — keeping previous anchor';
        }
        console.log(
          `[${traceT()}] [ImageTarget] FOUND "${event.name}"\n` +
            `  scale=${event.scale.toFixed(3)}m ${formatPose(event)}\n` +
            `  trackingStatus=${this.session.trackingStatus}\n` +
            statusLine
        );
        if (trustworthy) {
          if (this.tryApplyWithRotationConsensus(event, target)) {
            this.seenTargetNames.add(event.name);
            console.log(`[${traceT()}] [ImageTargetAnchorSource]${this.cameraDiagnosticLine()}`);
            this.onPoseApplied(false, ratio);
            for (const handler of this.originChangedHandlers) {
              handler();
            }
          }
        } else {
          this.logSampleRejected(event, target, ratio);
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
          this.imageVisible = true;
          if (this.stable) {
            // Frozen PERMANENTLY against this CONTINUOUS event only — see
            // the class doc comment's §26 strategy section. 'found' above
            // (a discrete re-detection) is NOT frozen; only this per-frame
            // stream is, which is what actually fixed the §22/§24 jitter.
            // No per-frame rejection log here on purpose: 'updated' fires
            // every frame the target is visible, and "frozen, ignoring"
            // would flood the console for the entire rest of the session.
            break;
          }
          const ratio = scaleRatio(event, target.physicalTargetWidthMeters);
          if (this.isSampleTrustworthy(ratio, event, target)) {
            if (this.tryApplyWithRotationConsensus(event, target)) {
              console.log(`[${traceT()}] [ImageTargetAnchorSource]${this.cameraDiagnosticLine()}`);
              this.onPoseApplied(false, ratio);
            }
          } else {
            this.logSampleRejected(event, target, ratio);
          }
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
   *
   * Applies the RAW tracked position/rotation directly — no temporal
   * filtering (removed 2026-08-31; see the class doc comment's strategy
   * section for why: this only ever runs during the pre-freeze
   * convergence window, while `group` is still hidden, so there is
   * nothing visible for a filter to smooth).
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
