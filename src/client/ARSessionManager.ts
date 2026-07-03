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
 * One Euro Filter tuning for MindAR's pose smoothing. minCF sets the
 * baseline smoothing at rest; beta controls how quickly smoothing yields to
 * responsiveness as motion speed rises.
 */
export interface TrackingProfile {
  filterMinCF: number;
  filterBeta: number;
}

/**
 * For spatial scenes rigidly anchored to a physical model (AR_SYSTEM.md §A:
 * the QR plaque center is the absolute origin). These are MindAR's own
 * defaults (verified in the bundled controller: minCF 1e-3, beta 1e3) —
 * beta high enough that the filter gets out of the way during phone motion.
 * A low beta here makes the whole scene visibly lag behind the physical
 * model and "swim" back into place after every movement.
 */
export const TRACKING_PROFILE_RIGID_ANCHOR: TrackingProfile = {
  filterMinCF: 0.001,
  filterBeta: 1000,
};

/**
 * For the legacy floating-card experience: maximum smoothing, tuned in the
 * pre-Phase-1 prototype for a single UI plane where steadiness at rest
 * mattered more than pose fidelity during motion.
 */
export const TRACKING_PROFILE_SMOOTH_UI: TrackingProfile = {
  filterMinCF: 0.001,
  filterBeta: 0.01,
};

/**
 * Owns the MindAR bootstrap, camera-permission request (implicit in
 * MindARThree.start()), and session lifecycle state. Rendering and input are
 * deliberately not this class's job — see RenderEngine.ts and
 * InputBridge.ts.
 */
export class ARSessionManager {
  private readonly mindAR: MindARThree;
  private state: ARSessionState = 'idle';

  constructor(container: HTMLElement, imageTargetSrc: string, tracking: TrackingProfile) {
    this.mindAR = new MindARThree({
      container,
      imageTargetSrc,
      filterMinCF: tracking.filterMinCF,
      filterBeta: tracking.filterBeta,
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
