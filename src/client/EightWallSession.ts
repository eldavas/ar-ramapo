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
import { traceT } from './TraceLog.js';

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
 * CORRECTION (Phase 3D, supersedes both the Phase 2D and Phase 2E notes):
 * Phase 2D added a manual installFullWindowResize(), reasoning the engine
 * had no resize handling of its own. Phase 2E removed it, having found
 * `addEventListener("resize"/"orientationchange", ...)` strings inside
 * dist/xr.js and concluding the engine owned resize end to end — but that
 * only proved those listeners exist SOMEWHERE in a ~1MB bundle covering
 * several unrelated features (face effects, world effects, sky effects),
 * not that they're wired to the Threejs pipeline module this app uses.
 * On-device measurement (?debug=1, three reads: onStart, first
 * requestAnimationFrame, +1000ms) settled it with hard numbers: renderer.
 * getSize() stayed at exactly 300x150 (the raw, unstyled HTML canvas
 * default) and camera.aspect stayed at exactly 2.000 (=300/150),
 * unchanged across a full second — proof nothing resizes this pipeline on
 * its own. Separately, getBoundingClientRect() ALSO measured 300x150 on
 * the confirmed-correct #camerafeed element (renderer.domElement ===
 * canvas, verified true), meaning the external stylesheet rule wasn't
 * winning the layout box either, for a reason not yet isolated. Restored
 * installFullWindowResize() below, now calling renderer.setSize(..., true)
 * (updateStyle: true, not Phase 2D's false) so it also rewrites the
 * canvas's inline style directly — authoritative regardless of whether the
 * stylesheet cascade or the engine's own (apparently inactive, for this
 * pipeline) resize handling was the gap.
 *
 * start() must be called from a user gesture: on iOS Safari the engine
 * requests DeviceMotionEvent permission during XR8.run(), and that prompt
 * only fires inside a gesture handler. The "Start AR" button in the UX
 * flow is that gesture.
 */
export class EightWallSession {
  private xr8: Xr8 | null = null;
  private status: Xr8TrackingStatus = 'UNSPECIFIED';
  // The engine's own reason for the current status. The binary's enum is
  // richer than the two documented values (INITIALIZING/UNSPECIFIED): the
  // installed xr-slam.js also ships RELOCALIZING, TOO_MUCH_MOTION and
  // NOT_ENOUGH_TEXTURE — exactly the field that discriminates between
  // "absolute scale never converged", "environment texture too poor" and
  // "relocalization churn" during the marker-visibility investigation
  // (troubleshooting doc §5–6). Previously discarded; never discard again.
  private statusReason = 'UNSPECIFIED';
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
            // Phase 3D: log-fix-log in the same pass, so this single deploy
            // both proves the pre-fix state and confirms (or refutes) the
            // fix, instead of spending another round trip on one half.
            this.logCanvasDiagnostics('onStart, BEFORE installFullWindowResize', handles);
            this.installFullWindowResize(handles);
            this.logCanvasDiagnostics('onStart, AFTER installFullWindowResize', handles);
            requestAnimationFrame(() => {
              this.logCanvasDiagnostics('first requestAnimationFrame after onStart', handles);
            });
            window.setTimeout(() => {
              this.logCanvasDiagnostics('+1000ms after onStart', handles);
            }, 1000);
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
                const { status, reason } = event as Xr8TrackingStatusEvent;
                const reasonText = reason ?? 'UNSPECIFIED';
                // Dedupe on the (status, reason) pair — the same pair the
                // binary's own dispatcher dedupes on — so a reason-only
                // change (LIMITED/INITIALIZING → LIMITED/NOT_ENOUGH_TEXTURE)
                // is captured instead of silently swallowed.
                if (status === this.status && reasonText === this.statusReason) return;
                const previous = `${this.status} (${this.statusReason})`;
                this.status = status;
                this.statusReason = reasonText;
                console.log(
                  `[${traceT()}] [TrackingStatus] ${status} reason=${reasonText} — was ${previous}`
                );
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

  /** The engine's reason for the current trackingStatus (see field note). */
  get trackingReason(): string {
    return this.statusReason;
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
   * See the class doc comment's Phase 3D correction. `updateStyle: true`
   * deliberately rewrites canvas.style.width/height via JS on every call —
   * the most authoritative sizing mechanism available, since it runs after
   * whatever the engine does internally and doesn't depend on winning a
   * CSS cascade we haven't fully isolated. Runs once immediately (onStart
   * may have measured the canvas before layout/engine init settled) and
   * again on every resize/orientationchange.
   */
  private installFullWindowResize(handles: Xr8ThreejsScene): void {
    const { renderer, camera } = handles;
    const resize = (): void => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      renderer.setSize(width, height, true);
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

  /**
   * Phase 3C diagnostic (?debug=1): measures the exact discrepancy behind
   * the "canvas locked to ~1/3 screen, markers flash in the black area"
   * report, instead of guessing further. Two competing theories on the
   * table: (a) our own CSS box for #camerafeed isn't actually full-screen
   * (a layout bug we could fix), or (b) the CSS box IS full-screen but
   * XR8's internal drawing-buffer/viewport is smaller (an engine-internal
   * issue no CSS change here can touch). rect vs. canvas.width/height vs.
   * window.innerWidth/innerHeight/devicePixelRatio settles which one it
   * is, with numbers.
   */
  private logCanvasDiagnostics(label: string, handles: Xr8ThreejsScene): void {
    const rect = this.canvas.getBoundingClientRect();
    const rendererSize = new THREE.Vector2();
    handles.renderer.getSize(rendererSize);
    const rendererCanvas = handles.renderer.domElement;
    const sameElement = rendererCanvas === this.canvas;
    // Identity was confirmed true in the previous capture, and
    // getBoundingClientRect() still came back 300x150 anyway — meaning the
    // #camerafeed stylesheet rule isn't the thing determining this
    // element's layout box at all. getComputedStyle is the only way to see
    // what the browser actually resolved (our rule, an inline override
    // from somewhere, or neither), instead of inferring it indirectly.
    const computed = window.getComputedStyle(this.canvas);
    console.log(
      `[EightWallSession] canvas diagnostics @ ${label}:\n` +
        `  canvas.getBoundingClientRect() = ${rect.width.toFixed(1)} x ${rect.height.toFixed(1)} ` +
        `(left=${rect.left.toFixed(1)}, top=${rect.top.toFixed(1)})\n` +
        `  canvas.width/height (drawing buffer) = ${this.canvas.width} x ${this.canvas.height}\n` +
        `  window.innerWidth/innerHeight = ${window.innerWidth} x ${window.innerHeight}\n` +
        `  window.devicePixelRatio = ${window.devicePixelRatio}\n` +
        `  renderer.getSize() = ${rendererSize.x.toFixed(1)} x ${rendererSize.y.toFixed(1)}, ` +
        `renderer.getPixelRatio() = ${handles.renderer.getPixelRatio()}\n` +
        `  camera.aspect = ${handles.camera.aspect.toFixed(3)}\n` +
        `  renderer.domElement === #camerafeed -> ${sameElement}` +
        (sameElement
          ? ''
          : ` (MISMATCH! renderer.domElement.id="${rendererCanvas.id}", ` +
            `tagName=${rendererCanvas.tagName}, isConnected=${rendererCanvas.isConnected}, ` +
            `parentElement=${rendererCanvas.parentElement?.tagName ?? 'null'} — ` +
            'our #camerafeed CSS rule can never reach this element if true.)') +
        `\n  canvas.id="${this.canvas.id}" canvas.isConnected=${this.canvas.isConnected}\n` +
        `  canvas.style.cssText (inline) = "${this.canvas.style.cssText}"\n` +
        `  getComputedStyle: position=${computed.position} display=${computed.display} ` +
        `width=${computed.width} height=${computed.height} inset=${computed.inset || '(n/a)'}`
    );
  }
}
