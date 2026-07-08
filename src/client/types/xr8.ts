// Typings for the 8th Wall engine binary (@8thwall/engine-binary).
// The npm package ships no types — this module declares the subset of the
// XR8 API surface this app actually uses, same pattern as the parent
// repo's mind-ar.d.ts. Symbols were verified present in the installed
// dist/xr.js + dist/xr-slam.js; the shapes follow the engine docs at
// https://8thwall.org/docs/engine/ (legacy API retained by the binary).
// The ambient module declaration wiring XR8Promise to these types lives in
// ./engine-binary.d.ts.
//
// Keep this file honest: add members only when the app starts calling
// them, and only after confirming they exist in the installed binary.

import type { Scene, PerspectiveCamera, WebGLRenderer } from 'three';

/** reality.trackingstatus payload — SLAM tracking quality. */
export type Xr8TrackingStatus = 'UNSPECIFIED' | 'NOT_AVAILABLE' | 'LIMITED' | 'NORMAL';

export interface Xr8TrackingStatusEvent {
  status: Xr8TrackingStatus;
  reason?: string;
}

export interface Xr8Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Xr8Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * One parsed entry from a CLI-compiled image-target JSON
 * (npx @8thwall/image-target-cli). The shape is engine-owned; only the
 * fields this app touches are typed and the rest passes through opaquely.
 */
export interface Xr8ImageTargetDataEntry {
  name: string;
  /**
   * Fetched by the engine at runtime via <img crossorigin src=...> — must
   * be a served, same-origin root-relative path after the post-compile
   * fixup (see README's image-target compilation step).
   */
  imagePath: string;
  [key: string]: unknown;
}

export type Xr8ImageTargetType = 'FLAT' | 'CYLINDRICAL' | 'CONICAL' | 'UNSPECIFIED';

/**
 * reality.imagefound / imageupdated / imagelost payload — world-space pose
 * of the target center. `scale` is the engine's meter estimate of the
 * target's larger printed dimension under scale:'absolute' (verified
 * against the installed xr-slam.js).
 */
export interface Xr8ImageTrackedEvent {
  name: string;
  type: Xr8ImageTargetType;
  position: Xr8Vec3;
  rotation: Xr8Quat;
  scale: number;
}

export type Xr8HitTestType =
  | 'FEATURE_POINT'
  | 'ESTIMATED_SURFACE'
  | 'DETECTED_SURFACE'
  | 'UNSPECIFIED';

export interface Xr8HitTestResult {
  type: Xr8HitTestType;
  position: Xr8Vec3;
  rotation: Xr8Quat;
  distance: number;
}

/**
 * A camera pipeline module — 8th Wall's unit of composition. Only the
 * lifecycle hooks this app implements are declared.
 */
export interface Xr8CameraPipelineModule {
  name: string;
  onStart?: (args: { canvas: HTMLCanvasElement }) => void;
  onUpdate?: (args: { processCpuResult?: unknown }) => void;
  onException?: (error: unknown) => void;
  listeners?: Array<{
    event: string;
    process: (event: unknown) => void;
  }>;
}

export interface Xr8ThreejsScene {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
}

export interface Xr8XrControllerConfig {
  /**
   * 'absolute' = world units are real meters (needs a few seconds of
   * device parallax to converge); 'responsive' = arbitrary scale, instant.
   */
  scale?: 'absolute' | 'responsive';
  enableLighting?: boolean;
  enableWorldPoints?: boolean;
  disableWorldTracking?: boolean;
  /**
   * Parsed image-target JSON entries (the self-hosted API — the legacy
   * hosted platform's `imageTargets: string[]` is deprecated in the
   * binary). The engine begins loading/scanning as soon as the session
   * runs; reality.imageloading → imagescanning fire, then per-target
   * imagefound/imageupdated/imagelost.
   */
  imageTargetData?: Xr8ImageTargetDataEntry[];
}

export interface Xr8XrController {
  configure(config: Xr8XrControllerConfig): void;
  pipelineModule(): Xr8CameraPipelineModule;
  /**
   * Screen-relative hit test against SLAM-estimated geometry. x/y are in
   * [0, 1] (0,0 = top-left). Returns nearest-first world-space hits; empty
   * array when the engine has no surface estimate along the ray yet.
   */
  hitTest(x: number, y: number, includedTypes?: Xr8HitTestType[]): Xr8HitTestResult[];
  /** Re-establish the world origin at the current camera pose. */
  recenter(): void;
  updateCameraProjectionMatrix(config: { origin?: Xr8Vec3; facing?: Xr8Quat }): void;
}

export interface Xr8Threejs {
  pipelineModule(): Xr8CameraPipelineModule;
  /** Available after the pipeline's onStart has run. */
  xrScene(): Xr8ThreejsScene;
}

export interface Xr8GlTextureRenderer {
  pipelineModule(): Xr8CameraPipelineModule;
}

export interface Xr8 {
  run(config: { canvas: HTMLCanvasElement }): void;
  stop(): void;
  pause(): void;
  resume(): void;
  addCameraPipelineModule(module: Xr8CameraPipelineModule): void;
  addCameraPipelineModules(modules: Xr8CameraPipelineModule[]): void;
  XrController: Xr8XrController;
  Threejs: Xr8Threejs;
  GlTextureRenderer: Xr8GlTextureRenderer;
}

declare global {
  interface Window {
    /**
     * XR8.Threejs.pipelineModule() constructs its three.js objects from a
     * global THREE — the engine binary does not bundle three. The app
     * assigns its own (bundled) three module here before installing the
     * pipeline (see EightWallSession). Declared as a mutable plain object
     * because the engine may probe optional members (e.g. GLTFLoader).
     */
    THREE?: Record<string, unknown>;
    XR8?: Xr8;
  }
}
