import { EventType, Rive, RiveFile, RuntimeLoader, StateMachineInputType } from '@rive-app/canvas';
import type { AssetLoadCallback, Event, RiveEventPayload, StateMachineInput } from '@rive-app/canvas';
import type { RiveCanvas, Artboard, StateMachineInstance, AABB } from '@rive-app/canvas/rive_advanced.mjs';

const DEFAULT_CANVAS_SIZE = 512;

// Served by the existing /rive static route (server/createServer.ts), which
// points at node_modules/@rive-app/canvas (the full build since Phase 5 —
// the Card artboard renders Rive Text, which canvas-lite cannot).
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

export interface RiveControllerOptions {
  /**
   * Where the Rive file comes from — exactly one of the two:
   * `riveUrl` fetches and parses per instance; `riveFile` reuses a file
   * already parsed via loadRiveFile(), so experiences that instantiate
   * several artboards from one .riv (Phase 5: four Markers + one Card)
   * fetch and parse it once.
   */
  riveUrl?: string;
  riveFile?: RiveFile;
  stateMachine: string;
  /** Named artboard to instantiate. Omitted = the file's default artboard. */
  artboard?: string;
  /** Backing-store pixels. Default 512×512 (the pre-Phase-5 behavior). */
  canvasWidth?: number;
  canvasHeight?: number;
}

/**
 * Fetches and parses a .riv file once, for sharing across several
 * RiveController instances. The optional assetLoader intercepts referenced
 * (non-embedded) assets at parse time — Phase 5's CardPanel uses it to
 * capture the `cardImage` ImageAsset handle for runtime substitution.
 */
export async function loadRiveFile(riveUrl: string, assetLoader?: AssetLoadCallback): Promise<RiveFile> {
  const file = new RiveFile({ src: riveUrl, assetLoader });
  await file.init();
  return file;
}

export class RiveController {
  readonly canvas: HTMLCanvasElement;
  private readonly stateMachineName: string;
  private readonly rive: Rive;
  private readonly ready: Promise<void>;
  private runtime: RiveCanvas | null = null;
  private artboard: Artboard | null = null;
  private stateMachine: StateMachineInstance | null = null;

  constructor(options: RiveControllerOptions) {
    this.stateMachineName = options.stateMachine;

    this.canvas = document.createElement('canvas');
    this.canvas.width = options.canvasWidth ?? DEFAULT_CANVAS_SIZE;
    this.canvas.height = options.canvasHeight ?? DEFAULT_CANVAS_SIZE;
    // Must be in the DOM or Rive's visibility check pauses its render loop.
    this.canvas.style.cssText = 'position:fixed;top:-9999px;pointer-events:none;';
    document.body.appendChild(this.canvas);

    let resolveReady: () => void;
    let rejectReady: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const rive = new Rive({
      src: options.riveUrl,
      riveFile: options.riveFile,
      canvas: this.canvas,
      artboard: options.artboard,
      stateMachines: this.stateMachineName,
      autoplay: true,
      // This class's pointerDown/pointerUp methods are the ONLY input path
      // into the state machine. By default Rive also attaches its own
      // touch/mouse/pointer listeners to the canvas; once the canvas sits
      // inside an on-screen element (MarkerLayer/CardPanel), one iPhone tap
      // would then reach the state machine several times — Rive's own
      // touchstart handler, our forwarded pointerdown, and the iOS
      // compatibility mousedown — making click-driven transitions fire and
      // immediately re-fire (visually "the animation doesn't trigger").
      shouldDisableRiveListeners: true,
      onLoad: (): void => {
        this.handleLoad(rive);
        resolveReady();
      },
    });
    rive.on(EventType.LoadError, () => {
      rejectReady(
        new Error(
          `RiveController: failed to load ${options.riveUrl ?? 'shared RiveFile'}` +
            (options.artboard !== undefined ? ` (artboard "${options.artboard}")` : '') +
            ` with state machine "${this.stateMachineName}".`
        )
      );
    });
    this.rive = rive;
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

  /**
   * Resolves once the file, artboard, and state machine are instantiated —
   * inputs, text runs, and events are addressable only after this. Rejects
   * (instead of leaving isReady false forever) on a load failure, per §C's
   * no-silent-failure rule.
   */
  whenReady(): Promise<void> {
    return this.ready;
  }

  get canvasWidth(): number {
    return this.canvas.width;
  }

  get canvasHeight(): number {
    return this.canvas.height;
  }

  get bounds(): AABB {
    if (!this.artboard) {
      throw new Error('RiveController.bounds accessed before the artboard finished loading.');
    }
    return this.artboard.bounds;
  }

  /** Sets a boolean state-machine input; throws if it doesn't exist. */
  setBool(name: string, value: boolean): void {
    this.findInput(name, StateMachineInputType.Boolean).value = value;
  }

  /** Sets a number state-machine input; throws if it doesn't exist. */
  setNumber(name: string, value: number): void {
    this.findInput(name, StateMachineInputType.Number).value = value;
  }

  /** Fires a trigger state-machine input; throws if it doesn't exist. */
  fireTrigger(name: string): void {
    this.findInput(name, StateMachineInputType.Trigger).fire();
  }

  /**
   * Sets a named text run on the artboard. Rive's own setTextRunValue
   * silently no-ops when the run doesn't exist (checked against the
   * installed 2.38 source), so the existence check here is what turns an
   * authoring mismatch into a loud error instead of a card that quietly
   * never updates (§C).
   */
  setText(runName: string, value: string): void {
    this.assertReady('setText');
    if (this.rive.getTextRunValue(runName) === undefined) {
      throw new Error(
        `RiveController.setText: no text run named "${runName}" on the artboard. ` +
          'Text runs must exist at the artboard root with an exported name (see docs/asset-authoring-guide.md).'
      );
    }
    this.rive.setTextRunValue(runName, value);
  }

  /**
   * Subscribes to Rive Events reported by the state machine (e.g. the
   * Card's authored close button). The handler receives the event's name.
   */
  onRiveEvent(handler: (eventName: string) => void): void {
    this.rive.on(EventType.RiveEvent, (event: Event) => {
      const payload = event.data as RiveEventPayload | undefined;
      if (payload && typeof payload.name === 'string') {
        handler(payload.name);
      }
    });
  }

  /**
   * Subscribes to the runtime's per-frame Advance event — the only point
   * where Auto Layout results (artboard bounds on a Hug-sized artboard)
   * are guaranteed fresh. Text-run writes do NOT recompute layout
   * synchronously, so bounds read right after setText are stale.
   */
  onAdvance(handler: () => void): void {
    this.rive.on(EventType.Advance, () => handler());
  }

  /**
   * Resizes the canvas backing store to its current CSS box × pixelRatio,
   * through Rive's own resize path so the renderer's alignment state stays
   * coherent (a bare canvas.width write would leave a stale draw).
   */
  resizeDrawingSurface(pixelRatio: number): void {
    this.rive.resizeDrawingSurfaceToCanvas(pixelRatio);
  }

  /** Stops the render loop, releases the file handle, removes the canvas. */
  dispose(): void {
    this.rive.cleanup();
    this.canvas.remove();
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
    const frame: AABB = { minX: 0, minY: 0, maxX: this.canvas.width, maxY: this.canvas.height };

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

  private assertReady(method: string): void {
    if (!this.isReady) {
      throw new Error(
        `RiveController.${method} called before the Rive file finished loading — await whenReady() first.`
      );
    }
  }

  private findInput(name: string, expectedType: StateMachineInputType): StateMachineInput {
    this.assertReady('findInput');
    const inputs = this.rive.stateMachineInputs(this.stateMachineName);
    const input = inputs.find((candidate) => candidate.name === name);
    if (!input) {
      const known = inputs.map((candidate) => candidate.name).join(', ') || '(none)';
      throw new Error(
        `RiveController: state machine "${this.stateMachineName}" has no input named "${name}". ` +
          `Available inputs: ${known}.`
      );
    }
    if (input.type !== expectedType) {
      throw new Error(
        `RiveController: input "${name}" on state machine "${this.stateMachineName}" is not of the ` +
          'expected type (bool/number/trigger mismatch with the .riv file).'
      );
    }
    return input;
  }
}
