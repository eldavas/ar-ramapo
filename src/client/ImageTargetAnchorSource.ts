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

// isSampleTrustworthy() only runs during the brief pre-freeze convergence
// window (see the class doc comment's 2026-08-31 strategy note) — a few
// samples at most, not an entire session — so the once-per-second warning
// throttle a continuous-re-snap regime needed is mostly moot now, but it's
// harmless to keep and avoids flooding the console if convergence ever
// takes an unusually long run of rejected samples.
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
 * This gate still exists after the 2026-08-31 strategy change (see the
 * class doc comment) — it now decides which single sample gets to become
 * the ONE frozen pose, rather than deciding whether to accept each of an
 * unbounded stream of re-snaps. A ratio far from 1 means the engine's own
 * absolute-scale estimate for this reading hasn't converged (or is
 * actively bad) — exactly the condition the warning already names.
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
 * **Strategy change (2026-08-31) — anchor once, then freeze; SLAM owns
 * persistence from there.** Weeks of on-device testing under the previous
 * strategy (continuously re-snapping the anchor's transform to every
 * plausibility-checked `found`/`updated` sample, most recently with a
 * per-axis/per-quaternion-component One Euro Filter layered on top —
 * docs/research/8th-wall-troubleshooting.md §22/§24) kept surfacing the
 * same failure family in new shapes: drift/scale jumps (§13), a tilted
 * scene from a wrong glue rotation exposed BECAUSE every frame re-applied
 * it (§14), continuous jitter/spin while the camera held still on a target
 * (§22), and an offset plaque amplifying per-frame angular noise into
 * visible positional swim (the `originOffsetMeters` lever-arm effect — the
 * same class of report as 8th Wall's own community forum, see §25). This
 * is not a filter-tuning problem: it is a direct trade-off of the
 * "continuously re-apply" design itself, which was chosen specifically so
 * the anchor could self-correct SLAM drift on every glance back at a
 * plaque — but that same mechanism is also what lets one noisy frame move
 * a supposedly-settled anchor.
 *
 * The new strategy matches this file's sibling implementation exactly:
 * `TapPlacedAnchorSource` has always placed its anchor ONCE (the user's
 * tap) and let `disableWorldTracking: false` SLAM hold that transform
 * static for the rest of the session — no re-snap logic exists there at
 * all, and it has never been a source of any drift/jitter report in this
 * log. It is also 8th Wall's own documented/community-recommended pattern
 * for this exact symptom (§25): anchor once on image detection, then rely
 * on world tracking for persistence, rather than perpetually re-applying
 * marker pose.
 *
 * Mechanically: the pre-existing bootstrap/convergence/reveal machinery
 * (§19 "Cold-start stabilization") is UNCHANGED — the very first `found`
 * of any configured plaque still applies unconditionally (so the anchor
 * is never left un-placed), the anchor stays hidden until a sample
 * independently passes `isSampleTrustworthy()` (scale plausibility AND
 * `trackingStatus === 'NORMAL'`), and that first passing sample is still
 * what reveals the group and resolves `whenStable()`. What changed is what
 * happens AFTER that reveal: previously every later trustworthy sample
 * kept re-writing `group.position`/`group.quaternion` (now smoothed, but
 * still perpetual); now, the instant `stable` flips true, `onImageEvent`
 * stops touching the transform ENTIRELY, forever, for this anchor
 * instance — every later `found` (a fresh detection of any plaque,
 * including one never seen before) and `updated` event still updates
 * `imageVisible`/telemetry (so `isTracking()`, `isImageVisible()`, and the
 * console log stream are unaffected) but is a pose no-op. After `imagelost`
 * the group already simply stopped receiving snaps — SLAM world tracking
 * (`disableWorldTracking: false` in EightWallSession) keeps the frozen
 * world pose valid, so content persists while the user walks around the
 * model; that half of the design is unchanged, it now also covers the
 * plaque coming back INTO view, not just it leaving.
 *
 * Trade-off, stated plainly (not hidden): this anchor no longer
 * self-corrects accumulated SLAM drift over a long session by re-scanning
 * a plaque. For the `site` experience (walking around a ~1.6×1.3m physical
 * model), if SLAM drift over a multi-minute session turns out to be
 * visible in practice, the next lever is NOT reverting to continuous
 * re-snap (already tried, already the source of this rewrite) but a
 * bounded, user-intentional recenter — `EightWallSession.recenter()`
 * already exists and is unused — which is a deliberately separate,
 * future decision, not part of this pass.
 *
 * The One Euro Filter smoothing apparatus this file carried between
 * 2026-08-26 and 2026-08-31 is removed entirely, not just unused: with no
 * more continuous re-snapping there is nothing left for it to smooth
 * (the group is hidden for the ENTIRE pre-freeze convergence window, so a
 * user never sees any of the handful of samples the filter used to act
 * on), and keeping dead smoothing code around a since-abandoned strategy
 * would misdocument the current design to the next reader.
 *
 * `seenTargetNames` (§24, "Multi-target switching fix") is kept, but its
 * scope is now implicitly narrower: it can only ever matter DURING the
 * brief pre-freeze convergence window (a second plaque sighted for the
 * first time before the first plaque ever produced a trustworthy sample)
 * — once `stable` is true, every `found`/`updated` short-circuits before
 * `seenTargetNames` is even consulted, which is exactly what makes the
 * ORIGINAL §24 bug (a different plaque's first-ever sighting, scanned
 * well after the anchor had long been established, silently rejected)
 * structurally impossible now: after freeze, no plaque's sighting — new
 * or already-seen — is ever "rejected", because none of them are
 * evaluated against the pose gate at all.
 *
 * onOriginChanged fires only during that same pre-freeze convergence
 * window (a discontinuity while still converging) — never after freeze,
 * since there are no more pose changes to announce once frozen.
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
  // true exactly once, here, never on the bootstrap sample alone.
  // Since 2026-08-31 this ALSO means "frozen forever" — see the class doc
  // comment's strategy section — not just "revealed."
  private stable = false;
  private readonly stableResolvers: Array<() => void> = [];
  // Multi-target switching fix (2026-08-26, physical-device finding — see
  // onImageEvent's 'found' case doc comment): names that have ever produced
  // a trustworthy sample. Since 2026-08-31 this only matters BEFORE
  // `stable` — see the class doc comment's strategy section for why the
  // original bug this fixed can no longer occur after freeze.
  private readonly seenTargetNames = new Set<string>();

  /**
   * Called for every APPLIED pose (bootstrap or checked) — see
   * onImageEvent's call sites, all of which run only while `!this.stable`
   * (2026-08-31 — see the class doc comment). isBootstrap = true only for
   * the very-first, unconditionally-applied acquisition sample; false for
   * the later sample that independently passed isSampleTrustworthy() (or,
   * for a never-before-seen plaque during the same convergence window,
   * the §24 first-sighting exemption). The scene/anchor must never be
   * revealed on the bootstrap sample alone (that's the whole cold-start
   * bug this exists to fix) — only the first genuinely-checked sample
   * flips `stable` and reveals the group, and it does so exactly once,
   * permanently freezing the transform from that point on.
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
        '— revealing anchor group and FREEZING its transform (2026-08-31 strategy: anchor once, SLAM persists).'
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
   * Two independent gates, either can reject:
   *
   * - Scale plausibility (isScalePlausible): the same
   *   SCALE_MISMATCH_TOLERANCE check as the pre-existing warning.
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
  private isSampleTrustworthy(ratio: number): boolean {
    return isScalePlausible(ratio) && this.session.trackingStatus === 'NORMAL';
  }

  private logSampleRejected(event: Xr8ImageTrackedEvent, target: ResolvedPlaqueTarget, ratio: number): void {
    warnIfScaleMismatch(event, target.physicalTargetWidthMeters, ratio);
    if (this.session.trackingStatus !== 'NORMAL') {
      console.warn(
        `[${traceT()}] [ImageTarget] pose sample rejected — trackingStatus=${this.session.trackingStatus} ` +
          `reason=${this.session.trackingReason} (not NORMAL). Anchor holds its last known-good transform.`
      );
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
          this.onPoseApplied(true, ratio);
          this.acquired = true;
          this.acquireResolve?.();
          this.acquireResolve = null;
          break;
        }

        if (this.stable) {
          // Anchor is frozen (2026-08-31 strategy — see the class doc
          // comment): SLAM persists the world pose from here on, so this
          // sighting — whether a re-detection of the same plaque or the
          // first-ever sighting of a different one — never touches the
          // transform. imageVisible/telemetry above still update normally.
          console.log(
            `[${traceT()}] [ImageTarget] FOUND "${event.name}" — anchor frozen, pose not re-applied.`
          );
          break;
        }

        // Pre-freeze convergence window: same trust gate as always (scale
        // plausibility AND trackingStatus === 'NORMAL'), with the §24
        // exemption — a plaque this anchor has never seen before is new
        // information, not suspect continuation of an existing one, so its
        // first sighting is applied unconditionally too.
        const isNewTarget = !this.seenTargetNames.has(event.name);
        const ratio = scaleRatio(event, target.physicalTargetWidthMeters);
        const trustworthy = isNewTarget || this.isSampleTrustworthy(ratio);
        console.log(
          `[${traceT()}] [ImageTarget] FOUND "${event.name}"\n` +
            `  scale=${event.scale.toFixed(3)}m ${formatPose(event)}\n` +
            `  trackingStatus=${this.session.trackingStatus}\n` +
            (isNewTarget
              ? '  first sighting of a NEW plaque — applied unconditionally, firing onOriginChanged'
              : trustworthy
                ? '  re-detection — firing onOriginChanged, pose discontinuity'
                : '  re-detection REJECTED — see warning below — keeping previous anchor')
        );
        if (trustworthy) {
          this.seenTargetNames.add(event.name);
          this.applyPose(event, target);
          this.onPoseApplied(false, ratio);
          for (const handler of this.originChangedHandlers) {
            handler();
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
            // Frozen — see the class doc comment's strategy section. No
            // per-frame rejection log here on purpose: 'updated' fires every
            // frame the target is visible, and "frozen, ignoring" would
            // flood the console for the entire rest of the session.
            break;
          }
          const ratio = scaleRatio(event, target.physicalTargetWidthMeters);
          if (this.isSampleTrustworthy(ratio)) {
            this.applyPose(event, target);
            this.onPoseApplied(false, ratio);
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
