import * as THREE from 'three';
import type { AnchorSource, OriginKind } from './AnchorSource.js';
import type { EightWallSession } from './EightWallSession.js';
import type { PlacementController } from './PlacementController.js';

/**
 * AnchorSource whose origin is a SLAM tap-placement (the spike's default).
 * acquire() runs the PlacementController interaction to completion and
 * freezes the resulting pose on the mount group; SLAM keeps world
 * coordinates stable thereafter, so the group's transform is static
 * between placements.
 *
 * isTracking(): NORMAL only. LIMITED dips (fast motion, low texture) read
 * as tracking loss — MarkerLayer's existing 250 ms hysteresis absorbs the
 * flicker, exactly as it absorbed MindAR's per-frame visibility polling in
 * the parent repo.
 */
export class TapPlacedAnchorSource implements AnchorSource {
  readonly kind: OriginKind = 'tap-placed';
  readonly group = new THREE.Group();

  private placed = false;
  private readonly originChangedHandlers: Array<() => void> = [];

  constructor(
    private readonly session: EightWallSession,
    private readonly scene: THREE.Scene,
    private readonly placement: PlacementController
  ) {
    this.group.name = 'tap-placed-anchor';
    this.group.visible = false;
    this.scene.add(this.group);
  }

  async acquire(): Promise<void> {
    const pose = await this.placement.run();
    this.group.position.copy(pose.position);
    this.group.quaternion.copy(pose.quaternion);
    this.group.visible = true;

    if (this.placed) {
      // A re-placement after the initial acquire — downstream consumers
      // (e.g. marker filters holding screen-space state) get a reset cue.
      for (const handler of this.originChangedHandlers) {
        handler();
      }
    }
    this.placed = true;
  }

  isTracking(): boolean {
    return this.placed && this.session.trackingStatus === 'NORMAL';
  }

  onOriginChanged(handler: () => void): void {
    this.originChangedHandlers.push(handler);
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.originChangedHandlers.length = 0;
    this.placed = false;
  }
}
