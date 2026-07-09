import * as THREE from 'three';
import type {
  Xr8,
  Xr8HitTestResult,
  Xr8ImageTargetDataEntry,
  Xr8ImageTrackedEvent,
  Xr8ThreejsScene,
  Xr8TrackingStatus,
  Xr8TrackingStatusEvent,
} from './types/xr8.js';
import type { FrameBus } from './FrameBus.js';

export type TrackingStatusHandler = (status: Xr8TrackingStatus) => void;

export interface EightWallStartOptions {
  /**
   * Parsed image-target JSON entries (see ImageTargetLoader), forwarded to
   * XrController.configure. Omit for tap-placed experiences — the image
   * listeners are still registered but stay inert.
   */
  imageTargetData?: Xr8ImageTargetDataEntry[];
}

export type ImageEventKind = 'found' | 'updated' | 'lost' | 'loading' | 'scanning';
/** event is null for the pose-less lifecycle kinds ('loading'/'scanning'). */
export type ImageEventHandler = (kind: ImageEventKind, event: Xr8ImageTrackedEvent | null) => void;

/**
 * 8th Wall engine bootstrap + lifecycle — the successor to the parent
 * repo's ARSessionManager (MindAR). Owns the camera pipeline module list,
 * the tracking-status signal, and the hit-test surface PlacementController
 * builds on.
 *
 * Ownership note (same constraint class as MindAR, recorded here on
 * purpose): XR8.Threejs.pipelineModule() creates and owns the three.js
 * renderer/scene/camera and issues the render call in its own onRender
 * stage — the app never calls renderer.render(). Handles are read back via
 * XR8.Threejs.xrScene() after the pipeline starts.
 *
 * CORRECTION (Phase 2D): this class previously also claimed the app "never
 * attaches its own resize handler," on the assumption the engine handled
 * full-window canvas sizing automatically. Verified false by grepping the
 * installed dist/xr.js: "FullWindowCanvas" appears exactly once, as
 * `PQ(r, "FullWindowCanvas", "XRExtras.FullWindowCanvas", ...)` — a
 * deprecation-shim pointer, not an implementation; `window.XRExtras` is
 * never assigned anywhere in the binary. That utility lives only in a
 * separate, hosted-platform-only script this self-hosted setup doesn't
 * load. Without it, the renderer keeps whatever size
 * XR8.Threejs.pipelineModule() measured the canvas at ONCE, at onStart —
 * if that predates layout settling, the camera feed and every overlay stay
 * pinned to that smaller size for the rest of the session (the reported
 * "camera feed fills ~1/3 of the screen" symptom). installFullWindowResize()
 * below is this app's replacement for the missing FullWindowCanvas: it
 * mutates the SAME renderer/camera instance XR8 already owns and renders
 * with every frame, so it is not a second resize authority fighting the
 * engine — it is the resize handling the engine doesn't provide.
 *
 * start() must be called from a user gesture: on iOS Safari the engine
 * requests DeviceMotionEvent permission during XR8.run(), and that prompt
 * only fires inside a gesture handler. The "Start AR" button in the UX
 * flow is that gesture.
 */
export class EightWallSession {
  private xr8: Xr8 | null = null;
  private status: Xr8TrackingStatus = 'UNSPECIFIED';
  private readonly statusHandlers: TrackingStatusHandler[] = [];
  private readonly imageHandlers: ImageEventHandler[] = [];
  private removeResizeListeners: (() => void) | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly frameBus: FrameBus
  ) {}

  async start(options: EightWallStartOptions = {}): Promise<Xr8ThreejsScene> {
    // The engine binary constructs its three.js objects from a global
    // THREE (verified against the installed dist/xr.js — it reads
    // window.THREE.Group, .BufferGeometry, …). Expose the bundled module
    // as a plain mutable object: a frozen module-namespace object would
    // throw if the engine ever probes/extends optional members like
    // GLTFLoader.
    if (window.THREE === undefined) {
      window.THREE = { ...THREE };
    }

    const { XR8Promise } = await import('@8thwall/engine-binary');
    const xr8 = await XR8Promise;
    this.xr8 = xr8;

    xr8.XrController.configure({
      // Real meters, so the Blender-authored (meter-scale) GLB mounts at
      // scale 1 — the MindAR marker-width conversion is gone. Absolute
      // scale needs a few seconds of device parallax to converge; the
      // 'scanning' UX state coaches that motion.
      scale: 'absolute',
      enableLighting: false,
      // Must stay false even for image-target experiences: SLAM world
      // tracking is what keeps the anchor's world pose valid after
      // reality.imagelost (scan the plaque once, walk around the model).
      disableWorldTracking: false,
      ...(options.imageTargetData !== undefined
        ? { imageTargetData: options.imageTargetData }
        : {}),
    });

    const started = new Promise<Xr8ThreejsScene>((resolve, reject) => {
      xr8.addCameraPipelineModules([
        // Camera feed → canvas. Ordering matters: texture renderer first,
        // then the three.js scene composited over it, then SLAM updates.
        xr8.GlTextureRenderer.pipelineModule(),
        xr8.Threejs.pipelineModule(),
        xr8.XrController.pipelineModule(),
        {
          name: 'bench-app',
          onStart: () => {
            const handles = xr8.Threejs.xrScene();
            // Eye-height start pose: with absolute scale the estimated
            // ground then lands near y≈0, which keeps hit-test results and
            // placed content in an intuitive frame.
            handles.camera.position.set(0, 1.6, 0);
            xr8.XrController.updateCameraProjectionMatrix({
              origin: { x: 0, y: 1.6, z: 0 },
            });
            this.installFullWindowResize(handles);
            resolve(handles);
          },
          onUpdate: () => {
            this.frameBus.tick(performance.now());
          },
          onException: (error: unknown) => {
            reject(error instanceof Error ? error : new Error(String(error)));
          },
          listeners: [
            {
              event: 'reality.trackingstatus',
              process: (event: unknown) => {
                const { status } = event as Xr8TrackingStatusEvent;
                if (status === this.status) return;
                this.status = status;
                for (const handler of this.statusHandlers) {
                  handler(status);
                }
              },
            },
            // Registered unconditionally (inert when no imageTargetData was
            // configured) so the pipeline module list stays assembled in
            // exactly one place.
            { event: 'reality.imagefound', process: (e: unknown) => this.emitImage('found', e) },
            { event: 'reality.imageupdated', process: (e: unknown) => this.emitImage('updated', e) },
            { event: 'reality.imagelost', process: (e: unknown) => this.emitImage('lost', e) },
            { event: 'reality.imageloading', process: () => this.emitImage('loading', null) },
            { event: 'reality.imagescanning', process: () => this.emitImage('scanning', null) },
          ],
        },
      ]);

      xr8.run({ canvas: this.canvas });
    });

    return started;
  }

  get trackingStatus(): Xr8TrackingStatus {
    return this.status;
  }

  onTrackingStatus(handler: TrackingStatusHandler): void {
    this.statusHandlers.push(handler);
  }

  /**
   * Subscribe to image-target lifecycle events. Returns an unsubscribe
   * function (ImageTargetAnchorSource.dispose() detaches with it).
   */
  onImageEvent(handler: ImageEventHandler): () => void {
    this.imageHandlers.push(handler);
    return () => {
      const index = this.imageHandlers.indexOf(handler);
      if (index !== -1) this.imageHandlers.splice(index, 1);
    };
  }

  private emitImage(kind: ImageEventKind, raw: unknown): void {
    // Defensive payload read: the trackingstatus listener receives its
    // struct directly, but some 8th Wall docs show image payloads nested
    // under .detail. Lock the type (and drop the fallback) after the
    // Phase D on-device checkpoint confirms which shape the binary sends.
    const detail =
      raw === null
        ? null
        : (((raw as { detail?: unknown }).detail ?? raw) as Xr8ImageTrackedEvent);
    for (const handler of this.imageHandlers) {
      handler(kind, detail);
    }
  }

  /**
   * Hit test against SLAM-estimated geometry at screen-relative (0..1)
   * coordinates. Returns the nearest usable hit, or null while the engine
   * has no surface estimate along that ray.
   */
  hitTest(screenX01: number, screenY01: number): Xr8HitTestResult | null {
    if (!this.xr8) return null;
    const hits = this.xr8.XrController.hitTest(screenX01, screenY01, [
      'FEATURE_POINT',
      'ESTIMATED_SURFACE',
      'DETECTED_SURFACE',
    ]);
    return hits.length > 0 ? hits[0] : null;
  }

  /** Re-establish the world origin at the current camera pose. */
  recenter(): void {
    this.xr8?.XrController.recenter();
  }

  stop(): void {
    this.removeResizeListeners?.();
    this.removeResizeListeners = null;
    this.xr8?.stop();
    this.frameBus.reset();
  }

  /**
   * This app's replacement for the engine's missing FullWindowCanvas
   * utility (see the class doc comment's Phase 2D correction). Sets the
   * renderer's drawing-buffer size and the camera's aspect to match the
   * actual viewport, once immediately (in case onStart fired before layout
   * settled — e.g. mid-transition out of a UxOverlay panel) and again on
   * every resize/orientationchange.
   *
   * `updateStyle: false` on setSize deliberately leaves the canvas's CSS
   * box alone — #camerafeed's stylesheet rule (100vw/100vh) already owns
   * visual layout; this only syncs the internal drawing buffer + the
   * camera's aspect ratio to match it, avoiding a second source of truth
   * for the canvas's on-screen size.
   */
  private installFullWindowResize(handles: Xr8ThreejsScene): void {
    const { renderer, camera } = handles;
    const resize = (): void => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);
    this.removeResizeListeners = () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('orientationchange', resize);
    };
  }
}
