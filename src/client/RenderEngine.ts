import type { WebGLRenderer, Scene, PerspectiveCamera } from 'three';

export type FrameCallback = (deltaMs: number) => void;

/**
 * Drives the Three.js render loop against handles created elsewhere
 * (MindARThree owns renderer/scene/camera creation — see
 * ARSessionManager.ts). This class's only job is the animation loop and
 * per-frame callback fan-out.
 *
 * Deliberately does not attach its own window "resize" listener:
 * MindARThree already does (verified in
 * node_modules/mind-ar/dist/mindar-image-three.prod.js), keeping its
 * renderer size and camera aspect in sync with the AR video feed. A second,
 * independent resize handler here would either do nothing or fight that one.
 */
export class RenderEngine {
  private readonly frameCallbacks: FrameCallback[] = [];
  // null until the first tick after start() — lets callbacks distinguish
  // "no time has passed yet" (deltaMs === 0) from a real elapsed duration,
  // and stops a stale timestamp from a previous run producing one huge
  // deltaMs spike on restart (see stop()).
  private lastTimestamp: number | null = null;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly scene: Scene,
    private readonly camera: PerspectiveCamera
  ) {}

  onFrame(callback: FrameCallback): void {
    this.frameCallbacks.push(callback);
  }

  start(): void {
    this.renderer.setAnimationLoop((timestamp: number) => {
      const deltaMs = this.lastTimestamp === null ? 0 : timestamp - this.lastTimestamp;
      this.lastTimestamp = timestamp;

      for (const callback of this.frameCallbacks) {
        callback(deltaMs);
      }
      this.renderer.render(this.scene, this.camera);
    });
  }

  stop(): void {
    this.renderer.setAnimationLoop(null);
    this.lastTimestamp = null;
  }
}
