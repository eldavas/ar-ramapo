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
const CARD_CSS_WIDTH = '100vw';
const CARD_ARTBOARD_WIDTH = 350;
const CARD_ARTBOARD_HEIGHT = 480;
const MAX_BACKING_SCALE = 2;

// Slide is app-owned (container transform), not Rive-owned — see the class
// doc comment. The curve matches the deceleration most native bottom
// sheets use (react-spring-bottom-sheet, iOS sheets), not a generic ease.
const SLIDE_TRANSITION = 'transform 300ms cubic-bezier(0.32, 0.72, 0, 1)';
// Below this, a pointer sequence is a tap candidate (forwarded into the
// artboard as usual for the close button); at or above it, it's a
// confirmed drag and the artboard stops receiving events for the rest of
// this gesture.
const DRAG_TAP_THRESHOLD_PX = 12;
// The close button (Card_Close_Button_Container, artboard rect
// x:[304,334] y:[17,47] of 350x480 — ~30x30 units, under Apple's 44pt
// minimum target size) sits in this corner. A gesture starting here is
// never promoted to a drag, however much the finger jitters while aiming
// at a small target — without this, an accidental drag classification
// mid-tap suppresses the paired pointerUp forward and the button silently
// doesn't fire (intermittently, exactly as small-target mis-taps do). The
// grabber handle (top-center, ~45-55% x) is well clear of this zone.
const NO_DRAG_ZONE_MIN_X_FRACTION = 0.8;
const NO_DRAG_ZONE_MAX_Y_FRACTION = 0.15;
// Release past this fraction of the sheet's own height commits to close,
// regardless of velocity.
const DRAG_CLOSE_FRACTION = 0.25;
// Release below the distance threshold but moving downward faster than
// this (px/ms) also commits to close — a fast flick shouldn't require
// dragging the full quarter-height first.
const DRAG_CLOSE_VELOCITY_PX_MS = 0.5;

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
 * The single screen-fixed content panel (Phase 5, AR_SYSTEM.md §G),
 * full-width bottom sheet. Unlike the original design, the artboard is
 * pure content display now — no open/close animation lives in Rive at all
 * (the `Closed`/`OpenIdle` states are visually identical, both just show
 * `Card_Body` at rest). Slide position is entirely app-owned: a CSS
 * `transform: translateY(...)` on `container`, matching how
 * react-spring-bottom-sheet / react-native-bottom-sheet work — a plain
 * transform tracked in real time by pointer events, not a design-tool
 * timeline, because a state machine can't cheaply do 1:1 finger-tracking
 * with velocity-based release. `RefreshPulse` is the one remaining
 * Rive-owned motion (a small in-place bounce on content swap while
 * already open) — unrelated to the container's position.
 *
 * State authority: the app owns open/closed. The artboard's close button
 * fires the `closeRequested` Rive Event; a drag-to-dismiss past the
 * threshold fires the same `closeHandler` callback — both routes funnel
 * through the same app-level close, same as the original design.
 */
export class CardPanel {
  private readonly container: HTMLDivElement;
  private readonly rive: RiveController;
  private open_ = false;
  private closeHandler: (() => void) | null = null;

  // Drag-gesture tracking (see attach()). dragStartY !== null means a
  // pointer sequence is in progress; isDragging distinguishes "still a tap
  // candidate" from "confirmed drag, artboard forwarding suspended."
  // dragEligible is fixed for the whole gesture at pointerdown (see
  // NO_DRAG_ZONE_* — a gesture starting on the close button can never
  // become a drag, however far it wanders).
  private dragStartY: number | null = null;
  private dragStartTime = 0;
  private isDragging = false;
  private dragEligible = true;
  private lastMoveY = 0;
  private lastMoveTime = 0;

  constructor(riveFile: RiveFile, private readonly imageSlot: CardImageSlot) {
    this.container = document.createElement('div');
    // z-index above the marker layer (10); pointer-events only while open,
    // so the closed (invisible) card never swallows taps meant for markers
    // or the scene behind it.
    // transform starts at translateY(100%) — fully below the viewport —
    // synchronously, before Rive even loads, so there is no first-load
    // flash regardless of any Rive/state-machine timing.
    this.container.style.cssText =
      'position:fixed;left:0;bottom:0;' +
      `width:${CARD_CSS_WIDTH};aspect-ratio:${CARD_ARTBOARD_WIDTH}/${CARD_ARTBOARD_HEIGHT};` +
      `z-index:20;pointer-events:none;touch-action:none;transform:translateY(100%);` +
      `transition:${SLIDE_TRANSITION};`;

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
    // Only reached for a genuine tap (see handlePointerUp) — once a
    // gesture is recognized as a drag, the artboard stops receiving
    // events for the rest of it, so it can't get stuck in a half-pressed
    // click state.
    const forwardPointer = (event: PointerEvent, isDown: boolean): void => {
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

    const handlePointerDown = (event: PointerEvent): void => {
      event.stopPropagation();
      event.preventDefault();
      this.container.setPointerCapture(event.pointerId);
      this.dragStartY = event.clientY;
      this.dragStartTime = performance.now();
      this.lastMoveY = event.clientY;
      this.lastMoveTime = this.dragStartTime;
      this.isDragging = false;

      const rect = this.container.getBoundingClientRect();
      const xFraction = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
      const yFraction = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;
      this.dragEligible = !(
        xFraction >= NO_DRAG_ZONE_MIN_X_FRACTION && yFraction <= NO_DRAG_ZONE_MAX_Y_FRACTION
      );

      forwardPointer(event, true);
    };

    const handlePointerMove = (event: PointerEvent): void => {
      if (this.dragStartY === null) return;
      const deltaY = event.clientY - this.dragStartY;

      if (!this.isDragging) {
        if (!this.dragEligible || Math.abs(deltaY) < DRAG_TAP_THRESHOLD_PX) return; // still a tap candidate
        console.log(`[${traceT()}] [Card] drag threshold crossed — suspending artboard forwarding`);
        this.isDragging = true;
        this.container.style.transition = 'none';
      }

      event.stopPropagation();
      event.preventDefault();
      this.lastMoveY = event.clientY;
      this.lastMoveTime = performance.now();
      const clampedDelta = Math.max(0, deltaY); // no dragging past fully open
      this.container.style.transform = `translateY(${clampedDelta}px)`;
    };

    const handlePointerUp = (event: PointerEvent): void => {
      event.stopPropagation();
      event.preventDefault();

      if (this.isDragging) {
        const elapsedMs = Math.max(1, performance.now() - this.lastMoveTime);
        const velocity = (event.clientY - this.lastMoveY) / elapsedMs; // px/ms, + = downward
        const deltaY = Math.max(0, event.clientY - (this.dragStartY ?? event.clientY));
        const closeThresholdPx = this.container.getBoundingClientRect().height * DRAG_CLOSE_FRACTION;
        const shouldClose = deltaY > closeThresholdPx || velocity > DRAG_CLOSE_VELOCITY_PX_MS;
        console.log(
          `[${traceT()}] [Card] drag released — deltaY=${deltaY.toFixed(0)}px ` +
            `velocity=${velocity.toFixed(2)}px/ms — ${shouldClose ? 'closing' : 'snapping back open'}`
        );

        this.container.style.transition = SLIDE_TRANSITION;
        if (shouldClose) {
          // Same app-level close path as the authored close button —
          // main.ts's handler decides what "closed" means (deselect the
          // marker, etc.) and calls close(), which sets the final
          // transform; the transition picks up smoothly from wherever
          // the drag left off.
          this.closeHandler?.();
        } else {
          this.container.style.transform = 'translateY(0)';
        }
      } else {
        // A genuine tap: forward the paired pointerUp for the artboard's
        // click detection (the close button).
        forwardPointer(event, false);
      }

      this.dragStartY = null;
      this.isDragging = false;
    };

    const handlePointerCancel = (): void => {
      if (this.isDragging) {
        this.container.style.transition = SLIDE_TRANSITION;
        this.container.style.transform = this.open_ ? 'translateY(0)' : 'translateY(100%)';
      }
      this.dragStartY = null;
      this.isDragging = false;
    };

    this.container.addEventListener('pointerdown', handlePointerDown);
    this.container.addEventListener('pointermove', handlePointerMove);
    this.container.addEventListener('pointerup', handlePointerUp);
    this.container.addEventListener('pointercancel', handlePointerCancel);

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
          : 'opening: sliding up, pointerEvents=auto (container now intercepts every tap in its box)') +
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
      this.container.style.transition = SLIDE_TRANSITION;
      this.container.style.transform = 'translateY(0)';
      // Kept even though Closed/OpenIdle are now visually identical: it's
      // what keeps the state machine in OpenIdle so the refresh trigger's
      // Any-state-free transition path (OpenIdle -> RefreshPulse) is
      // reachable at all.
      this.rive.setBool(INPUT_IS_OPEN, true);
    }
  }

  /**
   * Idempotent; slides the sheet down and out of view. Called both for
   * the authored close button (via onCloseRequested) and for a
   * drag-to-dismiss past the threshold (see attach()) — same transform,
   * same bookkeeping, regardless of which gesture triggered it.
   */
  close(): void {
    if (!this.open_) return;
    console.log(`[${traceT()}] [Card] close() — sliding down, pointerEvents=none`);
    this.open_ = false;
    this.container.style.pointerEvents = 'none';
    this.container.style.transition = SLIDE_TRANSITION;
    this.container.style.transform = 'translateY(100%)';
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
