import type * as THREE from 'three';

export type OriginKind = 'tap-placed' | 'image-target';

/**
 * The swappable world-origin seam. Everything downstream of tracking —
 * SceneGraphLoader mounting, HotspotProjector's isTrackingActive closure,
 * the Rive layer — consumes only this interface, so the origin's source
 * (SLAM tap-placement today, an 8th Wall image target on the printed
 * plaque for the hybrid path later) is a one-line constructor swap in
 * main.ts.
 */
export interface AnchorSource {
  readonly kind: OriginKind;
  /**
   * World-space mount point. Scene content parents under this; the source
   * owns its transform and never hands it out for external mutation.
   */
  readonly group: THREE.Group;
  /**
   * Establish the origin. Resolves after tap-placement completes (or, for
   * an image-target source, after first detection). The group is not a
   * valid mount point until this resolves.
   */
  acquire(): Promise<void>;
  /**
   * Resolves once the group's transform is trustworthy enough to reveal to
   * the user — distinct from acquire(), which only means "some pose
   * exists." For a tap-placed origin the two are the same instant (the
   * user's tap against a confirmed hit-test ring already IS the trust
   * signal). For an image-target origin, acquire() resolves on the first
   * detection's unchecked bootstrap pose (kept, so the anchor is never
   * left un-placed — see ImageTargetAnchorSource's own doc comment), while
   * whenStable() resolves only once a pose has passed the source's own
   * plausibility/tracking-quality gate — the signal callers should gate a
   * scene reveal on, never acquire() alone.
   */
  whenStable(): Promise<void>;
  /** Feeds HotspotProjector's isTrackingActive closure, polled per frame. */
  isTracking(): boolean;
  /** Origin moved after acquire() — e.g. re-place, or image re-detection. */
  onOriginChanged(handler: () => void): void;
  dispose(): void;
}
