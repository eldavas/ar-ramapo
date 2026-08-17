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
// changes them without this test being updated too). identity() as of
// 2026-08-14 — see the source file's own doc comment for why.
const TARGET_FRAME_TO_WORLD_FIX = new THREE.Quaternion();
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

// --- Pose-plausibility gating (2026-08-14 physical-device fix) -----------
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
// jumping to the bad one.

function withScale(event: Xr8ImageTrackedEvent, scale: number): Xr8ImageTrackedEvent {
  return { ...event, scale };
}

test('an implausible-scale updated sample is rejected — anchor holds its last known-good pose', () => {
  const goodPos = new THREE.Vector3(1.2, 0, -3.4);
  const goodQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.37);
  const badPos = new THREE.Vector3(50, 12, -80); // physically implausible jump
  const badQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.1);

  const session = new FakeSession();
  const scene = new THREE.Scene();
  const anchor = new ImageTargetAnchorSource(session as never, scene, [FRONT]);

  // Establish a good anchor first.
  session.fire('found', simulateEventFor(FRONT.name, FRONT, goodPos, goodQuat));
  assertVectorClose(anchor.group.position, goodPos);
  assertQuatClose(anchor.group.quaternion, goodQuat);

  // A bad-scale 'updated' sample (ratio = 3x tolerance) must not move it,
  // even though its position/rotation would otherwise place the anchor
  // somewhere completely different.
  const badEvent = withScale(
    simulateEventFor(FRONT.name, FRONT, badPos, badQuat),
    FRONT.physicalTargetWidthMeters * 3
  );
  session.fire('updated', badEvent);
  assertVectorClose(anchor.group.position, goodPos);
  assertQuatClose(anchor.group.quaternion, goodQuat);

  // A bad-scale re-detection ('found' after being already acquired) must
  // be rejected the same way — not just 'updated'.
  session.fire('found', badEvent);
  assertVectorClose(anchor.group.position, goodPos);
  assertQuatClose(anchor.group.quaternion, goodQuat);

  // A subsequent GOOD sample still applies normally — rejection is
  // per-sample, not a permanent lockout.
  const recoveredPos = new THREE.Vector3(2.0, 0, -1.0);
  const recoveredQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -0.5);
  session.fire('updated', simulateEventFor(FRONT.name, FRONT, recoveredPos, recoveredQuat));
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

  assert.equal(anchor.group.visible, true); // acquired, not stuck waiting forever
  assertVectorClose(anchor.group.position, pos);
  assertQuatClose(anchor.group.quaternion, quat);
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
// in addition to a plausible scale.

test('a scale-plausible sample arriving while trackingStatus is not NORMAL is rejected', () => {
  const goodPos = new THREE.Vector3(1.2, 0, -3.4);
  const goodQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.37);

  const session = new FakeSession();
  const scene = new THREE.Scene();
  const anchor = new ImageTargetAnchorSource(session as never, scene, [FRONT]);

  // Establish a good anchor while tracking is healthy.
  session.fire('found', simulateEventFor(FRONT.name, FRONT, goodPos, goodQuat));
  assertVectorClose(anchor.group.position, goodPos);

  // SLAM enters a relocalization window — scale is still perfectly
  // plausible (ratio 1), but the sample must still be rejected.
  session.trackingStatus = 'LIMITED';
  session.trackingReason = 'RELOCALIZING';
  const duringRelocPos = new THREE.Vector3(9.0, 0, 9.0);
  const duringRelocQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 2.5);
  session.fire('updated', simulateEventFor(FRONT.name, FRONT, duringRelocPos, duringRelocQuat));
  assertVectorClose(anchor.group.position, goodPos);
  assertQuatClose(anchor.group.quaternion, goodQuat);

  // Tracking recovers to NORMAL — the next good sample applies again
  // (rejection is per-sample, not a permanent lockout, same as the scale
  // gate above).
  session.trackingStatus = 'NORMAL';
  session.trackingReason = 'UNSPECIFIED';
  const recoveredPos = new THREE.Vector3(0.5, 0, -0.5);
  const recoveredQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -1.0);
  session.fire('updated', simulateEventFor(FRONT.name, FRONT, recoveredPos, recoveredQuat));
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

  assert.equal(anchor.group.visible, true);
  assertVectorClose(anchor.group.position, pos);
  assertQuatClose(anchor.group.quaternion, quat);
});
