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
  /** Feeds HotspotProjector's isTrackingActive closure, polled per frame. */
  isTracking(): boolean;
  /** Origin moved after acquire() — e.g. re-place, or image re-detection. */
  onOriginChanged(handler: () => void): void;
  dispose(): void;
}
