/**
 * Verifies ImageTargetAnchorSource's multi-target pose composition (§E
 * "Multi-target plaques") is internally consistent: for an assumed
 * ground-truth model placement in world space, every target's own
 * originOffsetMeters/rotationYawDeg should let applyPose() recover that
 * SAME world placement from ITS OWN simulated tracked event — i.e.
 * whichever of the 4 real plaques a visitor scans, the model ends up in
 * the same place. Pure math, no DOM/camera/engine needed (three.js's
 * Quaternion/Vector3/Scene/Group run fine in plain Node) — this is
 * exactly the piece that's software-verifiable without physical hardware;
 * the fixed single-target glue (TARGET_FRAME_TO_WORLD_FIX) it composes
 * with remains "best inference, validate on device" as already documented
 * in ImageTargetAnchorSource.ts.
 *
 * 2026-08-31: rewritten for the "anchor once, then freeze" strategy (see
 * ImageTargetAnchorSource.ts's own class doc comment). The
 * bootstrap/plausibility/multi-target-exemption gates are unchanged and
 * still fully covered below. The One Euro Filter tests that used to live
 * here (2026-08-26–2026-08-31) are gone along with the filter itself —
 * with no more continuous re-snapping there is nothing left for a filter
 * to smooth, so "filter lag" epsilons are gone too: every applied sample
 * now lands exactly.
 *
 * 2026-09-01 (§26): the FIRST physical retest of the pure "freeze
 * forever" strategy above showed the scene drifting/losing scale over a
 * real walkaround — nothing was left to periodically correct SLAM drift.
 * Refined to distinguish the event shape: a continuous 'updated' sample
 * is still permanently a no-op once stabilized (this is what actually
 * fixed the §22/§24 jitter, and it stays fixed), but a discrete 'found'
 * re-detection — of the same plaque or a different one, at any point in
 * the session — still runs through the trust gate and re-grounds the
 * anchor if it passes. The tests below reflect this: "stabilized" now
 * means "the group is revealed and continuous per-frame samples are
 * ignored," not "nothing can ever move it again."
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ImageTargetAnchorSource } from './ImageTargetAnchorSource.js';
import type { ResolvedPlaqueTarget } from './ImageTargetLoader.js';
import type { ImageEventHandler } from './EightWallSession.js';
import type { Xr8ImageTrackedEvent } from './types/xr8.js';

// Mirrors ImageTargetAnchorSource's own private constants (not exported —
// duplicated here deliberately, so this test fails if the source ever
// changes them without this test being updated too). Rx(+90°) as of
// 2026-08-17 (flat-mount correction) — see the source file's own doc
// comment for why.
const TARGET_FRAME_TO_WORLD_FIX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
function yawCorrectionQuaternion(deg: number): THREE.Quaternion {
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(deg));
}

/**
 * Minimal EightWallSession stand-in: onImageEvent() capture + manual fire.
 * `trackingStatus` defaults to 'NORMAL' — the healthy-tracking baseline —
 * so tests focused on the scale gate don't also need to think about the
 * (separate) trackingStatus gate; tests for THAT gate set it explicitly.
 */
class FakeSession {
  trackingStatus: 'UNSPECIFIED' | 'NOT_AVAILABLE' | 'LIMITED' | 'NORMAL' = 'NORMAL';
  trackingReason = 'UNSPECIFIED';
  private handler: ImageEventHandler | null = null;
  onImageEvent(handler: ImageEventHandler): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }
  fire(kind: 'found' | 'updated', event: Xr8ImageTrackedEvent): void {
    this.handler?.(kind, event);
  }
  /** The three pose-less lifecycle kinds — always fire with a null event,
   * matching EightWallSession.emitImage()'s real behavior for these. */
  fireLifecycle(kind: 'loading' | 'scanning' | 'lost'): void {
    this.handler?.(kind, null);
  }
}

/** Builds the Xr8ImageTrackedEvent a real tracker would report for `target`
 * if the model were placed at (modelPos, modelQuat) — the exact inverse of
 * applyPose()'s own composition, worked out by hand and cross-checked
 * against its doc comment. */
function simulateEventFor(
  name: string,
  target: ResolvedPlaqueTarget,
  modelPos: THREE.Vector3,
  modelQuat: THREE.Quaternion
): Xr8ImageTrackedEvent {
  // event.rotation * FIX * yawCorr = modelQuat  =>  event.rotation = modelQuat * yawCorr^-1 * FIX^-1
  const yawCorr = yawCorrectionQuaternion(target.rotationYawDeg);
  const eventRotation = modelQuat
    .clone()
    .multiply(yawCorr.clone().invert())
    .multiply(TARGET_FRAME_TO_WORLD_FIX.clone().invert());
  // event.position = modelPos + modelQuat.rotate(offsetLocal)
  const offsetLocal = new THREE.Vector3(target.originOffsetMeters.x, 0, target.originOffsetMeters.z);
  const eventPosition = offsetLocal.clone().applyQuaternion(modelQuat).add(modelPos);
  return {
    name,
    type: 'FLAT',
    scale: target.physicalTargetWidthMeters,
    position: { x: eventPosition.x, y: eventPosition.y, z: eventPosition.z },
    rotation: { x: eventRotation.x, y: eventRotation.y, z: eventRotation.z, w: eventRotation.w },
  };
}

function assertVectorClose(actual: THREE.Vector3, expected: THREE.Vector3, epsilon = 1e-6): void {
  assert.ok(
    actual.distanceTo(expected) < epsilon,
    `expected ~(${expected.x},${expected.y},${expected.z}), got (${actual.x},${actual.y},${actual.z})`
  );
}

function assertQuatClose(actual: THREE.Quaternion, expected: THREE.Quaternion, epsilon = 1e-6): void {
  // Quaternions q and -q represent the same rotation.
  const d = Math.abs(actual.dot(expected));
  assert.ok(d > 1 - epsilon, `expected quaternion ~equal, dot=${d}`);
}

const FRONT: ResolvedPlaqueTarget = {
  name: 'site-front',
  physicalTargetWidthMeters: 0.05,
  originOffsetMeters: { x: 0.803275, z: -0.0381 },
  rotationYawDeg: 0,
};
const BACK: ResolvedPlaqueTarget = {
  name: 'site-back',
  physicalTargetWidthMeters: 0.05,
  originOffsetMeters: { x: 0.803275, z: 1.381125 },
  rotationYawDeg: 180,
};
const LEFT: ResolvedPlaqueTarget = {
  name: 'site-left',
  physicalTargetWidthMeters: 0.05,
  originOffsetMeters: { x: -0.0381, z: 0.671512 },
  rotationYawDeg: 90,
};
const RIGHT: ResolvedPlaqueTarget = {
  name: 'site-right',
  physicalTargetWidthMeters: 0.05,
  originOffsetMeters: { x: 1.64465, z: 0.671512 },
  rotationYawDeg: -90,
};

test('all 4 targets recover the same assumed world placement from their own simulated event', () => {
  const modelPos = new THREE.Vector3(1.2, 0, -3.4);
  const modelQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.37); // arbitrary world yaw

  for (const target of [FRONT, BACK, LEFT, RIGHT]) {
    const session = new FakeSession();
    const scene = new THREE.Scene();
    const anchor = new ImageTargetAnchorSource(session as never, scene, [target]);
    const event = simulateEventFor(target.name, target, modelPos, modelQuat);
    session.fire('found', event);
    assertVectorClose(anchor.group.position, modelPos);
    assertQuatClose(anchor.group.quaternion, modelQuat);
  }
});

test('a single-target experience (identity offset/rotation) reduces to pre-multi-target behavior', () => {
  const identityTarget: ResolvedPlaqueTarget = {
    name: '8thwall-test-plaque',
    physicalTargetWidthMeters: 0.05,
    originOffsetMeters: { x: 0, z: 0 },
    rotationYawDeg: 0,
  };
  const session = new FakeSession();
  const scene = new THREE.Scene();
  const anchor = new ImageTargetAnchorSource(session as never, scene, [identityTarget]);

  const trackedPosition = { x: 0.5, y: 0.1, z: -0.2 };
  const trackedRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.1);
  session.fire('found', {
    name: identityTarget.name,
    type: 'FLAT',
    scale: 0.05,
    position: trackedPosition,
    rotation: { x: trackedRotation.x, y: trackedRotation.y, z: trackedRotation.z, w: trackedRotation.w },
  });

  // Pre-multi-target formula: group.position = event.position (verbatim).
  assertVectorClose(anchor.group.position, new THREE.Vector3(trackedPosition.x, trackedPosition.y, trackedPosition.z));
  // group.quaternion = event.rotation * TARGET_FRAME_TO_WORLD_FIX (yaw correction is identity).
  const expectedQuat = trackedRotation.clone().multiply(TARGET_FRAME_TO_WORLD_FIX);
  assertQuatClose(anchor.group.quaternion, expectedQuat);
});

test('an event for an unconfigured target name is ignored (group stays unacquired)', () => {
  const session = new FakeSession();
  const scene = new THREE.Scene();
  const anchor = new ImageTargetAnchorSource(session as never, scene, [FRONT]);
  session.fire('found', {
    name: 'not-one-of-the-configured-targets',
    type: 'FLAT',
    scale: 0.05,
    position: { x: 1, y: 1, z: 1 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  });
  assert.equal(anchor.isTracking(), false);
});

// --- Pose-plausibility gating (2026-08-14 physical-device fix), still in
// effect during the pre-freeze convergence window (2026-08-31) -----------
//
// First real hardware test showed the world anchor drifting/jumping and
// briefly appearing at a drastically wrong scale — traced to applyPose()
// previously trusting every single raw tracked sample unconditionally, on
// both 'found' and every per-frame 'updated' (docs/research/
// 8th-wall-troubleshooting.md §10 already logged the underlying engine
// phenomenon in isolation: a re-detection converging onto a bad pose,
// scale ratio 2.12, and staying there for ~a minute). These tests build a
// deliberately implausible event (correct rotation, but a scale far
// outside SCALE_MISMATCH_TOLERANCE of physicalTargetWidthMeters) and
// verify the anchor's transform is unaffected by it once a good anchor
// already exists — the anchor holds its last known-good pose instead of
// jumping to the bad one. This gate is what decides which single sample
// gets to become the ONE frozen pose (2026-08-31) — it still matters, just
// over a much shorter window than before.

function withScale(event: Xr8ImageTrackedEvent, scale: number): Xr8ImageTrackedEvent {
  return { ...event, scale };
}

test('an implausible-scale sample is rejected before freeze — anchor holds its last known-good pose, then a good sample freezes it', () => {
  const goodPos = new THREE.Vector3(1.2, 0, -3.4);
  const goodQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.37);
  const badPos = new THREE.Vector3(50, 12, -80); // physically implausible jump
  const badQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.1);

  const session = new FakeSession();
  const scene = new THREE.Scene();
  const anchor = new ImageTargetAnchorSource(session as never, scene, [FRONT]);

  // Bootstrap (unconditional, hidden).
  session.fire('found', simulateEventFor(FRONT.name, FRONT, goodPos, goodQuat));
  assertVectorClose(anchor.group.position, goodPos);
  assertQuatClose(anchor.group.quaternion, goodQuat);
  assert.equal(anchor.group.visible, false);

  // A bad-scale 'updated' sample (ratio = 3x tolerance) must not move it,
  // even though its position/rotation would otherwise place the anchor
  // somewhere completely different, and must not reveal/freeze it either.
  const badEvent = withScale(
    simulateEventFor(FRONT.name, FRONT, badPos, badQuat),
    FRONT.physicalTargetWidthMeters * 3
  );
  session.fire('updated', badEvent);
  assertVectorClose(anchor.group.position, goodPos);
  assertQuatClose(anchor.group.quaternion, goodQuat);
  assert.equal(anchor.group.visible, false);

  // A bad-scale re-detection ('found' after being already acquired) must
  // be rejected the same way — not just 'updated'.
  session.fire('found', badEvent);
  assertVectorClose(anchor.group.position, goodPos);
  assertQuatClose(anchor.group.quaternion, goodQuat);
  assert.equal(anchor.group.visible, false);

  // The first GOOD sample after bootstrap reveals AND freezes the anchor —
  // exact, no filter lag (2026-08-31: the filter is gone).
  const recoveredPos = new THREE.Vector3(2.0, 0, -1.0);
  const recoveredQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -0.5);
  session.fire('updated', simulateEventFor(FRONT.name, FRONT, recoveredPos, recoveredQuat));
  assert.equal(anchor.group.visible, true);
  assertVectorClose(anchor.group.position, recoveredPos);
  assertQuatClose(anchor.group.quaternion, recoveredQuat);
});

test('the very first acquisition applies even with an implausible scale — bootstrap must not hang forever', () => {
  const session = new FakeSession();
  const scene = new THREE.Scene();
  const anchor = new ImageTargetAnchorSource(session as never, scene, [FRONT]);

  const pos = new THREE.Vector3(1.2, 0, -3.4);
  const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.37);
  const badFirstEvent = withScale(
    simulateEventFor(FRONT.name, FRONT, pos, quat),
    FRONT.physicalTargetWidthMeters * 3
  );
  session.fire('found', badFirstEvent);

  // The transform still applies (bootstrap must not hang forever), but —
  // cold-start stabilization, AR_SYSTEM.md §G — it must NOT be revealed to
  // the user off an unchecked sample. isTracking() (which gates markers)
  // is also true, confirming acquire()'s contract is unaffected: only the
  // GROUP's own visibility flips off the bootstrap sample.
  assert.equal(anchor.group.visible, false, 'bootstrap sample must not reveal the group');
  assertVectorClose(anchor.group.position, pos);
  assertQuatClose(anchor.group.quaternion, quat);
});

// --- Cold-start reveal gating (2026-08-18, AR_SYSTEM.md §G "Cold-start
// stabilization") ---
//
// The bootstrap pose above is intentionally still applied — the anchor
// must never be left un-placed — but it must not be REVEALED. These tests
// cover the whenStable()/group.visible contract layered on top of the
// existing plausibility gates, which stay unmodified.

test('a bootstrap-only pose does not reveal the scene (group stays hidden, whenStable() unresolved)', async () => {
  const session = new FakeSession();
  const scene = new THREE.Scene();
  const anchor = new ImageTargetAnchorSource(session as never, scene, [FRONT]);

  let resolved = false;
  anchor.whenStable().then(() => {
    resolved = true;
  });

  session.fire('found', simulateEventFor(FRONT.name, FRONT, new THREE.Vector3(1, 0, -1), new THREE.Quaternion()));

  assert.equal(anchor.group.visible, false);
  // Flush one microtask turn — whenStable()'s promise must still not have
  // resolved off the bootstrap sample alone.
  await Promise.resolve();
  assert.equal(resolved, false);
});

test('the first trustworthy sample after bootstrap reveals the scene, resolves whenStable(), and freezes the transform exactly', async () => {
  const session = new FakeSession();
  const scene = new THREE.Scene();
  const anchor = new ImageTargetAnchorSource(session as never, scene, [FRONT]);

  let resolved = false;
  anchor.whenStable().then(() => {
    resolved = true;
  });

  // Bootstrap: applied, but hidden (previous test covers this in isolation).
  session.fire('found', simulateEventFor(FRONT.name, FRONT, new THREE.Vector3(1, 0, -1), new THREE.Quaternion()));
  assert.equal(anchor.group.visible, false);

  // First independently-checked sample (an 'updated' — the common case,
  // since 'found' only re-fires on re-detection): scale-plausible,
  // trackingStatus NORMAL (FakeSession's default) — must reveal and freeze.
  const stablePos = new THREE.Vector3(1.2, 0, -3.4);
  const stableQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.2);
  session.fire('updated', simulateEventFor(FRONT.name, FRONT, stablePos, stableQuat));

  assert.equal(anchor.group.visible, true);
  assertVectorClose(anchor.group.position, stablePos);
  assertQuatClose(anchor.group.quaternion, stableQuat);
  await Promise.resolve();
  assert.equal(resolved, true, 'whenStable() must resolve once the group is revealed');

  // whenStable() called again after the fact resolves immediately (latched,
  // not re-armed) — the same idiom acquire() already uses.
  let resolvedAgain = false;
  anchor.whenStable().then(() => {
    resolvedAgain = true;
  });
  await Promise.resolve();
  assert.equal(resolvedAgain, true);
});

test('4. an already-stabilized anchor is unaffected by later scanning/loading/lost lifecycle events', () => {
  const session = new FakeSession();
  const scene = new THREE.Scene();
  const anchor = new ImageTargetAnchorSource(session as never, scene, [FRONT]);

  session.fire('found', simulateEventFor(FRONT.name, FRONT, new THREE.Vector3(1, 0, -1), new THREE.Quaternion()));
  const stablePos = new THREE.Vector3(1.2, 0, -3.4);
  const stableQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.2);
  session.fire('updated', simulateEventFor(FRONT.name, FRONT, stablePos, stableQuat));
  assert.equal(anchor.group.visible, true);

  // Pose-less lifecycle events carry no tracked pose at all (EightWallSession
  // dispatches them with a null event) and, per onImageEvent's switch, only
  // ever log — there is no code path from 'loading'/'scanning'/'lost' to
  // group.visible or the transform. This test asserts that stays true: the
  // already-revealed scene must not hide, move, or otherwise react.
  session.fireLifecycle('scanning');
  session.fireLifecycle('loading');
  session.fireLifecycle('lost');

  assert.equal(anchor.group.visible, true, 'an already-stabilized scene must remain visible');
  assertVectorClose(anchor.group.position, stablePos);
  assertQuatClose(anchor.group.quaternion, stableQuat);
});

test('an implausible sample arriving before any trustworthy one is rejected without reveal or corruption', () => {
  const session = new FakeSession();
  const scene = new THREE.Scene();
  const anchor = new ImageTargetAnchorSource(session as never, scene, [FRONT]);

  const bootstrapPos = new THREE.Vector3(1, 0, -1);
  session.fire('found', simulateEventFor(FRONT.name, FRONT, bootstrapPos, new THREE.Quaternion()));
  assert.equal(anchor.group.visible, false);

  // A second implausible sample before any good one — must stay hidden and
  // must not move the anchor off the bootstrap transform either (the
  // existing scale-rejection gate, unmodified, already prevents the move;
  // this test's own concern is specifically that rejection never
  // accidentally reveals the group).
  const badEvent = withScale(
    simulateEventFor(FRONT.name, FRONT, new THREE.Vector3(50, 12, -80), new THREE.Quaternion()),
    FRONT.physicalTargetWidthMeters * 3
  );
  session.fire('updated', badEvent);
  assert.equal(anchor.group.visible, false);
  assertVectorClose(anchor.group.position, bootstrapPos);
});

// --- trackingStatus gating (2026-08-14, third physical test, second audit
// pass on the anchor-stability bug) ---
//
// isTracking() (consumed by HotspotProjector to hide markers) has always
// gated on session.trackingStatus === 'NORMAL'. applyPose() did not — a
// pose arriving while SLAM is mid-relocalization (or any other non-NORMAL
// status) could still move the anchor, with only the SEPARATE marker-
// visibility gate hiding the result, not preventing it. These tests cover
// the fix: isSampleTrustworthy() now requires trackingStatus === 'NORMAL'
// in addition to a plausible scale. Still enforced during the pre-freeze
// window (2026-08-31).

test('a scale-plausible sample arriving while trackingStatus is not NORMAL is rejected before freeze', () => {
  const goodPos = new THREE.Vector3(1.2, 0, -3.4);
  const goodQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.37);

  const session = new FakeSession();
  const scene = new THREE.Scene();
  const anchor = new ImageTargetAnchorSource(session as never, scene, [FRONT]);

  // Bootstrap (unconditional, hidden).
  session.fire('found', simulateEventFor(FRONT.name, FRONT, goodPos, goodQuat));
  assertVectorClose(anchor.group.position, goodPos);
  assert.equal(anchor.group.visible, false);

  // SLAM enters a relocalization window — scale is still perfectly
  // plausible (ratio 1), but the sample must still be rejected.
  session.trackingStatus = 'LIMITED';
  session.trackingReason = 'RELOCALIZING';
  const duringRelocPos = new THREE.Vector3(9.0, 0, 9.0);
  const duringRelocQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 2.5);
  session.fire('updated', simulateEventFor(FRONT.name, FRONT, duringRelocPos, duringRelocQuat));
  assertVectorClose(anchor.group.position, goodPos);
  assertQuatClose(anchor.group.quaternion, goodQuat);
  assert.equal(anchor.group.visible, false);

  // Tracking recovers to NORMAL — the next good sample applies, revealing
  // and freezing the anchor.
  session.trackingStatus = 'NORMAL';
  session.trackingReason = 'UNSPECIFIED';
  const recoveredPos = new THREE.Vector3(0.5, 0, -0.5);
  const recoveredQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -1.0);
  session.fire('updated', simulateEventFor(FRONT.name, FRONT, recoveredPos, recoveredQuat));
  assert.equal(anchor.group.visible, true);
  assertVectorClose(anchor.group.position, recoveredPos);
  assertQuatClose(anchor.group.quaternion, recoveredQuat);
});

test('the very first acquisition applies even while trackingStatus is not NORMAL yet', () => {
  const session = new FakeSession();
  session.trackingStatus = 'UNSPECIFIED'; // engine hasn't reported a real status yet
  const scene = new THREE.Scene();
  const anchor = new ImageTargetAnchorSource(session as never, scene, [FRONT]);

  const pos = new THREE.Vector3(1.2, 0, -3.4);
  const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.37);
  session.fire('found', simulateEventFor(FRONT.name, FRONT, pos, quat));

  // Transform still applies even before trackingStatus has reported
  // anything real (bootstrap can't hang forever) — but per the cold-start
  // reveal gate, it stays hidden until an independently-checked sample
  // lands, same as the scale-only case above.
  assert.equal(anchor.group.visible, false);
  assertVectorClose(anchor.group.position, pos);
  assertQuatClose(anchor.group.quaternion, quat);
});

// --- Multi-target switching fix (2026-08-26, physical-device finding),
// now in effect for the FULL session (§26, 2026-09-01) ---
//
// On the real four-plaque 'site' entry, once one plaque acquired the
// anchor, scanning any of the OTHER three plaques for the first time used
// to silently fail unless a sample happened to land exactly when
// trackingStatus was NORMAL. The fix: the FIRST sighting of a target name
// this anchor has never seen before is applied unconditionally, the same
// as the anchor's very first-ever sample — only a REPEAT sighting of an
// already-seen name goes through the full scale/trackingStatus gate. These
// tests cover the exemption in the early convergence window; the
// post-stabilization block further below covers the exact scenario §24
// was originally about — a switch happening well after the anchor had
// long stabilized — which §26 restored (§25's freeze had made it
// structurally impossible, which is what caused the regression §26 fixes).

test('a first sighting of a DIFFERENT plaque before stabilization is applied unconditionally even with an implausible scale', () => {
  const session = new FakeSession();
  const scene = new THREE.Scene();
  const anchor = new ImageTargetAnchorSource(session as never, scene, [FRONT, BACK]);

  // Bootstrap via FRONT (hidden — bootstrap never freezes).
  const frontPos = new THREE.Vector3(1.2, 0, -3.4);
  const frontQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.37);
  session.fire('found', simulateEventFor(FRONT.name, FRONT, frontPos, frontQuat));
  assertVectorClose(anchor.group.position, frontPos);
  assert.equal(anchor.group.visible, false);

  // First-ever sighting of BACK, with a wildly implausible scale — the
  // kind of reading isSampleTrustworthy() would reject for a REPEAT
  // sighting of FRONT. It must still apply (and, being the first
  // independently-checked sample since bootstrap, also reveals/freezes):
  // BACK has never been seen before, so there is no existing BACK-derived
  // anchor to protect.
  const backPos = new THREE.Vector3(-5.0, 0, 12.0);
  const backQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -1.4);
  const badFirstBackEvent = withScale(
    simulateEventFor(BACK.name, BACK, backPos, backQuat),
    BACK.physicalTargetWidthMeters * 3
  );
  session.fire('found', badFirstBackEvent);
  assert.equal(anchor.group.visible, true);
  assertVectorClose(anchor.group.position, backPos);
  assertQuatClose(anchor.group.quaternion, backQuat);
});

test('a first sighting of a DIFFERENT plaque before stabilization is applied unconditionally even while trackingStatus is not NORMAL', () => {
  const session = new FakeSession();
  const scene = new THREE.Scene();
  const anchor = new ImageTargetAnchorSource(session as never, scene, [FRONT, BACK]);

  session.fire(
    'found',
    simulateEventFor(FRONT.name, FRONT, new THREE.Vector3(1.2, 0, -3.4), new THREE.Quaternion())
  );

  session.trackingStatus = 'LIMITED';
  session.trackingReason = 'RELOCALIZING';
  const backPos = new THREE.Vector3(2.0, 0, 0.5);
  const backQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.9);
  session.fire('found', simulateEventFor(BACK.name, BACK, backPos, backQuat));
  assert.equal(anchor.group.visible, true);
  assertVectorClose(anchor.group.position, backPos);
  assertQuatClose(anchor.group.quaternion, backQuat);
});

test('a REPEAT sighting of an already-seen plaque still goes through the full trust gate — only the first sighting per name is exempt', () => {
  const session = new FakeSession();
  const scene = new THREE.Scene();
  const anchor = new ImageTargetAnchorSource(session as never, scene, [FRONT, BACK]);

  session.fire(
    'found',
    simulateEventFor(FRONT.name, FRONT, new THREE.Vector3(1.2, 0, -3.4), new THREE.Quaternion())
  );

  // First sighting of BACK — exempt, applies unconditionally AND
  // stabilizes (it's the first independently-checked sample since
  // bootstrap).
  const backGoodPos = new THREE.Vector3(2.0, 0, 0.5);
  const backGoodQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.9);
  session.fire('found', simulateEventFor(BACK.name, BACK, backGoodPos, backGoodQuat));
  assert.equal(anchor.group.visible, true);
  assertVectorClose(anchor.group.position, backGoodPos);

  // A SECOND sighting of BACK with an implausible scale must be rejected —
  // BACK is no longer new, so it's held to the full trust gate like any
  // other re-detection (§26: re-detections are evaluated for the FULL
  // session, not just before stabilization — this rejection is purely the
  // scale gate doing its job, not a freeze).
  const badSecondBackEvent = withScale(
    simulateEventFor(BACK.name, BACK, new THREE.Vector3(99, 0, 99), new THREE.Quaternion()),
    BACK.physicalTargetWidthMeters * 3
  );
  session.fire('found', badSecondBackEvent);
  assertVectorClose(anchor.group.position, backGoodPos);
  assertQuatClose(anchor.group.quaternion, backGoodQuat);
});

// --- Post-stabilization behavior (§26, 2026-09-01 refinement) ------------
//
// The first physical retest of the pure "freeze forever" strategy (§25)
// showed the scene drifting/losing scale over a real walkaround — SLAM
// drift with nothing left to periodically correct it. The fix keeps §25's
// win (no more per-frame jitter) but restores periodic correction on
// DISCRETE re-detections: once stabilized, a continuous 'updated' sample
// is STILL always a no-op, but a 'found' (the user looking directly at a
// known plaque again, or a different one for the first time) still runs
// through the full trust gate and, if it passes, re-grounds the anchor.

test('once stabilized, "updated" (continuous per-frame) samples never move the anchor, however many arrive', async () => {
  const session = new FakeSession();
  const scene = new THREE.Scene();
  const anchor = new ImageTargetAnchorSource(session as never, scene, [FRONT]);

  let resolveCount = 0;
  anchor.whenStable().then(() => {
    resolveCount += 1;
  });

  session.fire('found', simulateEventFor(FRONT.name, FRONT, new THREE.Vector3(1, 0, -1), new THREE.Quaternion()));
  const stablePos = new THREE.Vector3(1.2, 0, -3.4);
  const stableQuat = new THREE.Quaternion();
  session.fire('updated', simulateEventFor(FRONT.name, FRONT, stablePos, stableQuat));
  await Promise.resolve();
  assert.equal(anchor.group.visible, true);
  assert.equal(resolveCount, 1, 'whenStable() handler must fire exactly once');

  // Several more good samples in a row, each at a DIFFERENT simulated
  // position — a real session keeps sending 'updated' every frame while
  // the target is in view, and even small per-frame drift/noise in a real
  // signal would move a continuously-re-snapping anchor. None of these
  // should move it at all — this is what actually fixed the §22/§24
  // jitter and stays true under §26.
  for (let i = 0; i < 5; i += 1) {
    session.fire(
      'updated',
      simulateEventFor(FRONT.name, FRONT, new THREE.Vector3(1.2 + i * 0.5, 0, -3.4 - i * 0.3), new THREE.Quaternion())
    );
  }
  await Promise.resolve();
  assert.equal(anchor.group.visible, true);
  assert.equal(resolveCount, 1, 'whenStable() handler must still have fired exactly once after more samples');
  assertVectorClose(anchor.group.position, stablePos);
  assertQuatClose(anchor.group.quaternion, stableQuat);
});

test('once stabilized, a clean re-detection ("found") of the SAME plaque DOES re-ground the anchor — this is the §26 fix', () => {
  const session = new FakeSession();
  const scene = new THREE.Scene();
  const anchor = new ImageTargetAnchorSource(session as never, scene, [FRONT]);

  session.fire('found', simulateEventFor(FRONT.name, FRONT, new THREE.Vector3(1, 0, -1), new THREE.Quaternion()));
  const stablePos = new THREE.Vector3(1.2, 0, -3.4);
  const stableQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.2);
  session.fire('updated', simulateEventFor(FRONT.name, FRONT, stablePos, stableQuat));
  assert.equal(anchor.group.visible, true);

  // A re-detection carrying a DIFFERENT (but still plausible, still
  // NORMAL-tracking) pose — simulating accumulated SLAM drift being
  // corrected the moment the user looks back at the plaque. Under §25's
  // pure freeze this would have been (wrongly) ignored; §26 restores it.
  const correctedPos = new THREE.Vector3(1.0, 0, -3.1);
  const correctedQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.25);
  session.fire('found', simulateEventFor(FRONT.name, FRONT, correctedPos, correctedQuat));

  assert.equal(anchor.group.visible, true);
  assertVectorClose(anchor.group.position, correctedPos);
  assertQuatClose(anchor.group.quaternion, correctedQuat);
});

test('once stabilized, an implausible re-detection ("found") is still rejected — periodic correction is gated, not blind', () => {
  const session = new FakeSession();
  const scene = new THREE.Scene();
  const anchor = new ImageTargetAnchorSource(session as never, scene, [FRONT]);

  session.fire('found', simulateEventFor(FRONT.name, FRONT, new THREE.Vector3(1, 0, -1), new THREE.Quaternion()));
  const stablePos = new THREE.Vector3(1.2, 0, -3.4);
  const stableQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.2);
  session.fire('updated', simulateEventFor(FRONT.name, FRONT, stablePos, stableQuat));
  assert.equal(anchor.group.visible, true);

  const badPos = new THREE.Vector3(50, 12, -80);
  const badQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.1);
  const badEvent = withScale(
    simulateEventFor(FRONT.name, FRONT, badPos, badQuat),
    FRONT.physicalTargetWidthMeters * 3
  );
  session.fire('found', badEvent);

  assertVectorClose(anchor.group.position, stablePos);
  assertQuatClose(anchor.group.quaternion, stableQuat);
});

test('once stabilized, the first-ever sighting of a DIFFERENT, never-before-seen plaque re-grounds the anchor to it — the exact §24/§26 scenario', () => {
  const session = new FakeSession();
  const scene = new THREE.Scene();
  const anchor = new ImageTargetAnchorSource(session as never, scene, [FRONT, BACK]);

  // Bootstrap + stabilize via FRONT only.
  session.fire('found', simulateEventFor(FRONT.name, FRONT, new THREE.Vector3(1, 0, -1), new THREE.Quaternion()));
  const stablePos = new THREE.Vector3(1.2, 0, -3.4);
  const stableQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.2);
  session.fire('updated', simulateEventFor(FRONT.name, FRONT, stablePos, stableQuat));
  assert.equal(anchor.group.visible, true);

  // This is the exact scenario §24 originally fixed and §25's pure freeze
  // regressed: well into an established session, the user walks up to a
  // DIFFERENT physical plaque (BACK) neither seen nor evaluated before.
  // §26 restores the periodic correction — BACK's composed world position
  // should now be the anchor's position, exactly as if BACK alone had
  // acquired the anchor from the start.
  const backPos = new THREE.Vector3(2.0, 0, 0.5);
  const backQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.9);
  session.fire('found', simulateEventFor(BACK.name, BACK, backPos, backQuat));

  assertVectorClose(anchor.group.position, backPos);
  assertQuatClose(anchor.group.quaternion, backQuat);
});
