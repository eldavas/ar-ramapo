import { Rive, RuntimeLoader } from '@rive-app/canvas-lite';
import type { RiveCanvas, Artboard, StateMachineInstance, AABB } from '@rive-app/canvas-lite/rive_advanced.mjs';

const RIVE_CANVAS_SIZE = 512;

// Served by the existing /rive static route (server/createServer.ts), which
// points at node_modules/@rive-app/canvas-lite — unchanged since Phase 0.
// Disabling the CDN fallback keeps every runtime dependency self-hosted, per
// AR_SYSTEM.md's "no unpinned CDN dependency at runtime" direction.
RuntimeLoader.setWasmUrl('/rive/rive.wasm');
RuntimeLoader.setWasmFallbackUrl(null);

interface RiveInternals {
  runtime: RiveCanvas;
  artboard: Artboard;
  animator: { stateMachines: Array<{ name: string; instance: StateMachineInstance | null }> };
}

/**
 * Rive's public API exposes no way to map a canvas-space point into
 * artboard space, or to call pointerDown/pointerUp with pre-mapped
 * coordinates directly — the `runtime`, `artboard`, and `animator` handles
 * that make that possible are marked `private` in Rive's own .d.ts. This
 * narrow, documented cast is a deliberate interop point with that specific
 * undocumented (but stable) surface — not a general `any` escape hatch.
 */
function internals(instance: Rive): RiveInternals {
  return instance as unknown as RiveInternals;
}

export interface ArtboardPoint {
  x: number;
  y: number;
}

export class RiveController {
  readonly canvas: HTMLCanvasElement;
  private readonly stateMachineName: string;
  private runtime: RiveCanvas | null = null;
  private artboard: Artboard | null = null;
  private stateMachine: StateMachineInstance | null = null;

  constructor(riveUrl: string, stateMachineName: string) {
    this.stateMachineName = stateMachineName;

    this.canvas = document.createElement('canvas');
    this.canvas.width = RIVE_CANVAS_SIZE;
    this.canvas.height = RIVE_CANVAS_SIZE;
    // Must be in the DOM or Rive's visibility check pauses its render loop.
    this.canvas.style.cssText = 'position:fixed;top:-9999px;pointer-events:none;';
    document.body.appendChild(this.canvas);

    const rive = new Rive({
      src: riveUrl,
      canvas: this.canvas,
      stateMachines: this.stateMachineName,
      autoplay: true,
      onLoad: (): void => this.handleLoad(rive),
    });
  }

  private handleLoad(rive: Rive): void {
    const { runtime, artboard, animator } = internals(rive);
    this.runtime = runtime;
    this.artboard = artboard;
    const wrapper = animator.stateMachines.find((sm) => sm.name === this.stateMachineName);
    this.stateMachine = wrapper?.instance ?? null;
  }

  get isReady(): boolean {
    return this.runtime !== null && this.artboard !== null && this.stateMachine !== null;
  }

  get canvasSize(): number {
    return RIVE_CANVAS_SIZE;
  }

  get bounds(): AABB {
    if (!this.artboard) {
      throw new Error('RiveController.bounds accessed before the artboard finished loading.');
    }
    return this.artboard.bounds;
  }

  pointerDown(artboardX: number, artboardY: number): void {
    this.stateMachine?.pointerDown(artboardX, artboardY, 0);
  }

  pointerUp(artboardX: number, artboardY: number): void {
    this.stateMachine?.pointerUp(artboardX, artboardY, 0);
  }

  mapCanvasPointToArtboard(canvasX: number, canvasY: number): ArtboardPoint {
    if (!this.runtime || !this.artboard) {
      throw new Error('RiveController.mapCanvasPointToArtboard called before Rive finished loading.');
    }

    const rt = this.runtime;
    const frame: AABB = { minX: 0, minY: 0, maxX: RIVE_CANVAS_SIZE, maxY: RIVE_CANVAS_SIZE };

    const forward = rt.computeAlignment(rt.Fit.contain, rt.Alignment.center, frame, this.artboard.bounds, 1.0);
    const inverse = new rt.Mat2D();
    forward.invert(inverse);

    const point = new rt.Vec2D(canvasX, canvasY);
    const mapped = rt.mapXY(inverse, point);
    const result: ArtboardPoint = { x: mapped.x(), y: mapped.y() };

    mapped.delete();
    point.delete();
    inverse.delete();
    forward.delete();

    return result;
  }
}
