import { decodeImage } from '@rive-app/canvas';
import type { AssetLoadCallback, ImageAsset, RiveFile } from '@rive-app/canvas';
import { RiveController } from './RiveController.js';
import type { CardContent } from './ContentProvider.js';
import { traceT } from './TraceLog.js';

// Card contract (bench-ui.riv, docs/asset-authoring-guide.md). These
// strings are the .riv ↔ code contract for the Card artboard; the marker
// side arrives per-hotspot via userData instead (Golden Rule, §E).
const CARD_ARTBOARD = 'Card';
const CARD_STATE_MACHINE = 'CardMachine';
const INPUT_IS_OPEN = 'isOpen';
const TRIGGER_REFRESH = 'refresh';
const TEXT_RUN_TITLE = 'title';
const TEXT_RUN_SUBTITLE = 'subtitle';
const TEXT_RUN_BODY = 'body';
const EVENT_CLOSE_REQUESTED = 'closeRequested';
export const CARD_IMAGE_ASSET_NAME = 'cardImage';

// Authored artboard size (350×480 portrait bottom sheet) — the CSS box
// keeps this aspect and the backing store renders it at up to 2× for
// retina sharpness.
const CARD_CSS_WIDTH = 'min(92vw, 350px)';
const CARD_ARTBOARD_WIDTH = 350;
const CARD_ARTBOARD_HEIGHT = 480;
const MAX_BACKING_SCALE = 2;

/**
 * Captures the Card's `cardImage` referenced asset at .riv parse time and
 * substitutes its bitmap at runtime — how sheet/CMS-driven images reach a
 * Rive artboard. Create one, pass its assetLoader to loadRiveFile(), then
 * hand the slot to CardPanel.
 */
export class CardImageSlot {
  private imageAsset: ImageAsset | null = null;
  private readonly bytesCache = new Map<string, Promise<ArrayBuffer>>();
  private requestToken = 0;

  readonly assetLoader: AssetLoadCallback = (asset, _bytes) => {
    if (asset.isImage && asset.name === CARD_IMAGE_ASSET_NAME) {
      this.imageAsset = asset as ImageAsset;
      // true = this handler owns the asset; the runtime skips its own
      // embedded/CDN resolution and waits for setRenderImage.
      return true;
    }
    return false;
  };

  /**
   * Fetches, decodes, and swaps the image in. Out-of-order completions are
   * dropped (last call wins), so rapid marker taps can't leave a stale
   * image on screen. Throws if the Card's image slot was never captured —
   * i.e. the .riv has no referenced image asset named `cardImage`.
   */
  async setImage(imageUrl: string): Promise<void> {
    if (!this.imageAsset) {
      throw new Error(
        `CardImageSlot: the Rive file exposed no referenced image asset named "${CARD_IMAGE_ASSET_NAME}" ` +
          '— mark the Card image as Referenced (not Embedded) with that exact name (docs/asset-authoring-guide.md).'
      );
    }
    const token = ++this.requestToken;

    let cached = this.bytesCache.get(imageUrl);
    if (!cached) {
      cached = fetch(imageUrl).then((response) => {
        if (!response.ok) {
          throw new Error(`CardImageSlot: image fetch for ${imageUrl} answered HTTP ${response.status}.`);
        }
        return response.arrayBuffer();
      });
      // A failed fetch must not poison the cache for retries on later taps.
      cached.catch(() => this.bytesCache.delete(imageUrl));
      this.bytesCache.set(imageUrl, cached);
    }

    const bytes = await cached;
    if (token !== this.requestToken) return; // superseded by a newer tap

    // Decode fresh per swap (bytes are what's worth caching): the wrapper
    // is unref'd immediately after handoff so the engine can reclaim the
    // previous bitmap.
    const image = await decodeImage(new Uint8Array(bytes));
    if (token !== this.requestToken) {
      image.unref();
      return;
    }
    this.imageAsset.setRenderImage(image);
    image.unref();
  }
}

/**
 * The single screen-fixed content panel (Phase 5, AR_SYSTEM.md §G): a
 * bottom sheet whose canvas never moves — enter/exit/refresh motion lives
 * entirely inside the Card artboard, which is why it always animates from
 * the same screen spot regardless of which marker was tapped.
 *
 * State authority: the app owns `isOpen`. The artboard's close button
 * fires the `closeRequested` Rive Event and the app answers by calling
 * close() — the artboard never mutates its own open state.
 */
export class CardPanel {
  private readonly container: HTMLDivElement;
  private readonly rive: RiveController;
  private open_ = false;
  private closeHandler: (() => void) | null = null;

  constructor(riveFile: RiveFile, private readonly imageSlot: CardImageSlot) {
    this.container = document.createElement('div');
    // z-index above the marker layer (10); pointer-events only while open,
    // so the closed (invisible) card never swallows taps meant for markers
    // or the scene behind it.
    this.container.style.cssText =
      'position:fixed;left:50%;bottom:0;transform:translateX(-50%);' +
      `width:${CARD_CSS_WIDTH};aspect-ratio:${CARD_ARTBOARD_WIDTH}/${CARD_ARTBOARD_HEIGHT};` +
      'z-index:20;pointer-events:none;touch-action:none;';

    const backingScale = Math.min(window.devicePixelRatio || 1, MAX_BACKING_SCALE);
    this.rive = new RiveController({
      riveFile,
      artboard: CARD_ARTBOARD,
      stateMachine: CARD_STATE_MACHINE,
      canvasWidth: CARD_ARTBOARD_WIDTH * backingScale,
      canvasHeight: CARD_ARTBOARD_HEIGHT * backingScale,
    });
  }

  /** Mounts the panel; resolves when the Card artboard is interactive. */
  async attach(): Promise<void> {
    const canvas = this.rive.canvas;
    canvas.style.cssText = 'width:100%;height:100%;display:block;';
    this.container.appendChild(canvas);
    document.body.appendChild(this.container);

    // Same single-input-path forwarding as the markers: pointer events are
    // mapped into artboard space so the Card's authored Rive listeners
    // (the close button) receive them; shouldDisableRiveListeners stays on.
    const forwardPointer = (event: PointerEvent, isDown: boolean): void => {
      event.stopPropagation();
      event.preventDefault();
      // These listeners only receive events while the container has
      // pointer-events:auto — i.e. while the card believes it is open. A
      // capture full of these lines while nothing is visibly on screen is
      // the smoking gun for an invisible-but-open card swallowing every
      // tap in its box (troubleshooting doc §9).
      console.log(
        `[${traceT()}] [Card] pointer${isDown ? 'down' : 'up'} at ` +
          `(${event.clientX.toFixed(0)},${event.clientY.toFixed(0)}) — swallowed by the open ` +
          'card container, forwarded into the artboard'
      );
      if (!this.rive.isReady) return;
      const rect = this.container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const canvasX = ((event.clientX - rect.left) / rect.width) * this.rive.canvasWidth;
      const canvasY = ((event.clientY - rect.top) / rect.height) * this.rive.canvasHeight;
      const artboardPoint = this.rive.mapCanvasPointToArtboard(canvasX, canvasY);
      if (isDown) {
        this.rive.pointerDown(artboardPoint.x, artboardPoint.y);
      } else {
        this.rive.pointerUp(artboardPoint.x, artboardPoint.y);
      }
    };
    this.container.addEventListener('pointerdown', (event) => forwardPointer(event, true));
    this.container.addEventListener('pointerup', (event) => forwardPointer(event, false));

    await this.rive.whenReady();
    this.rive.onRiveEvent((eventName) => {
      if (eventName === EVENT_CLOSE_REQUESTED) {
        console.log(`[${traceT()}] [Card] closeRequested Rive event — invoking close handler`);
        this.closeHandler?.();
      }
    });
  }

  detach(): void {
    this.rive.dispose();
    this.container.remove();
  }

  get isOpen(): boolean {
    return this.open_;
  }

  /**
   * Fills the Card with content and shows it: closed → Enter animation
   * plays; already open → content swaps under the authored refresh pulse.
   * `isOpen` is never toggled for a swap — that would replay Exit/Enter.
   *
   * The image loads asynchronously after the card is already open (text
   * first, never block the tap on an image fetch); an image failure is
   * reported loudly but leaves the card usable rather than tearing down
   * the session.
   */
  open(content: CardContent): void {
    // Logged at entry, before the fail-loud setText/setBool calls, so a
    // capture brackets an authoring-mismatch throw between this line and
    // the red error main.ts's catch prints.
    const bounds = this.rive.bounds;
    console.log(
      `[${traceT()}] [Card] open("${content.title}") — ` +
        (this.open_
          ? 'already open, firing refresh pulse'
          : 'opening: isOpen=true, pointerEvents=auto (container now intercepts every tap in its box)') +
        ` | artboard bounds=${(bounds.maxX - bounds.minX).toFixed(0)}x${(bounds.maxY - bounds.minY).toFixed(0)}` +
        ` container=${this.container.getBoundingClientRect().width.toFixed(0)}x${this.container.getBoundingClientRect().height.toFixed(0)}`
    );
    this.rive.setText(TEXT_RUN_TITLE, content.title);
    this.rive.setText(TEXT_RUN_SUBTITLE, content.subtitle ?? '');
    this.rive.setText(TEXT_RUN_BODY, content.body);
    if (content.imageUrl !== undefined) {
      this.imageSlot.setImage(content.imageUrl).catch((error: unknown) => {
        console.error('[CardPanel] card image failed to load:', error);
      });
    }

    if (this.open_) {
      this.rive.fireTrigger(TRIGGER_REFRESH);
    } else {
      this.open_ = true;
      this.container.style.pointerEvents = 'auto';
      this.rive.setBool(INPUT_IS_OPEN, true);
    }
  }

  /** Idempotent; the Exit animation plays inside the artboard. */
  close(): void {
    if (!this.open_) return;
    console.log(`[${traceT()}] [Card] close() — isOpen=false, pointerEvents=none`);
    this.open_ = false;
    this.container.style.pointerEvents = 'none';
    this.rive.setBool(INPUT_IS_OPEN, false);
  }

  /** The app answers `closeRequested` (authored close button) with this. */
  onCloseRequested(handler: () => void): void {
    this.closeHandler = handler;
  }

  /** True when the event target is (inside) the card panel. */
  containsEventTarget(target: EventTarget | null): boolean {
    return target instanceof Node && this.container.contains(target);
  }
}
