export type FrameCallback = (deltaMs: number) => void;

/**
 * Per-frame callback fan-out with real elapsed time — the successor to the
 * parent repo's RenderEngine. Unlike MindAR (where the app owned
 * renderer.setAnimationLoop and issued the render call), the 8th Wall
 * pipeline both drives the frame cadence and renders: XR8.Threejs's
 * pipelineModule renders in its own onRender stage. What remains the app's
 * job is exactly this fan-out, ticked from the app pipeline module's
 * onUpdate (see EightWallSession).
 */
export class FrameBus {
  private readonly frameCallbacks: FrameCallback[] = [];
  // null until the first tick — lets callbacks distinguish "no time has
  // passed yet" (deltaMs === 0) from a real elapsed duration, and stops a
  // stale timestamp from a previous run producing one huge deltaMs spike
  // after reset().
  private lastTimestamp: number | null = null;

  onFrame(callback: FrameCallback): void {
    this.frameCallbacks.push(callback);
  }

  tick(timestampMs: number): void {
    const deltaMs = this.lastTimestamp === null ? 0 : timestampMs - this.lastTimestamp;
    this.lastTimestamp = timestampMs;
    for (const callback of this.frameCallbacks) {
      callback(deltaMs);
    }
  }

  reset(): void {
    this.lastTimestamp = null;
  }
}
