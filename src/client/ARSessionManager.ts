import { MindARThree } from 'mind-ar/dist/mindar-image-three.prod.js';
import type { MindARThreeAnchor } from 'mind-ar/dist/mindar-image-three.prod.js';
import type { WebGLRenderer, Scene, PerspectiveCamera } from 'three';

export type ARSessionState = 'idle' | 'starting' | 'running' | 'stopped' | 'error';

export interface ARSessionHandles {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  anchor: MindARThreeAnchor;
}

/**
 * Owns the MindAR bootstrap, camera-permission request (implicit in
 * MindARThree.start()), and session lifecycle state. Rendering and input are
 * deliberately not this class's job — see RenderEngine.ts and
 * InputBridge.ts.
 */
export class ARSessionManager {
  private readonly mindAR: MindARThree;
  private state: ARSessionState = 'idle';

  constructor(container: HTMLElement, imageTargetSrc: string) {
    this.mindAR = new MindARThree({
      container,
      imageTargetSrc,
      // One Euro Filter: lower minCF = smoother at rest; lower beta = less
      // jitter on slow movement. Tuned values carried over unchanged from
      // the pre-Phase-1 prototype.
      filterMinCF: 0.001,
      filterBeta: 0.01,
    });
  }

  get sessionState(): ARSessionState {
    return this.state;
  }

  async start(anchorTargetIndex: number): Promise<ARSessionHandles> {
    if (this.state === 'starting' || this.state === 'running') {
      throw new Error(`ARSessionManager.start() called while session state is already "${this.state}".`);
    }

    this.state = 'starting';
    const anchor = this.mindAR.addAnchor(anchorTargetIndex);

    try {
      await this.mindAR.start();
    } catch (error) {
      this.state = 'error';
      throw error;
    }

    this.state = 'running';
    return {
      renderer: this.mindAR.renderer,
      scene: this.mindAR.scene,
      camera: this.mindAR.camera,
      anchor,
    };
  }

  stop(): void {
    this.mindAR.stop();
    this.state = 'stopped';
  }
}
