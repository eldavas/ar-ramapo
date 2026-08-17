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

// Authored artboard DESIGN size (350×480 portrait bottom sheet) — only the
// initial CSS aspect and backing store, valid until the first frame. The
// Card artboard's Auto Layout height is authored as Hug: at runtime its
// bounds height tracks the content (measured 408–669 across real sheet
// rows), and syncAspectToArtboard() re-derives the CSS aspect and backing
// from the live bounds every time they change. The backing renders at up
// to 2× for retina sharpness.
const CARD_CSS_WIDTH = '100vw';
const CARD_ARTBOARD_WIDTH = 350;
const CARD_ARTBOARD_HEIGHT = 480;
const MAX_BACKING_SCALE = 2;
// Height cap: the sheet never covers more than this fraction of the
// viewport. Without it, a Hug-grown artboard on a small screen pushes the
// container's top edge ABOVE the viewport (bottom-anchored box taller
// than the screen), cutting off the grabber, title, and close button.
// The cap clips the container only — the canvas keeps its natural
// aspect-true height inside it (see syncAspectToArtboard), because
// shrinking the canvas box instead would re-create the §12 Fit.contain
// letterbox this file just fixed.
const CARD_MAX_VIEWPORT_HEIGHT_FRACTION = 0.9;

/**
 * Fixed-header height, in artboard DESIGN units (of the 350-wide artboard,
 * scale-invariant per docs/asset-authoring-guide.md's canvas-aspect
 * contract). Everything above this line (grabber, title, subtitle, close
 * button) is meant to be the part of the artboard whose height does NOT
 * depend on BODY content length; everything below it is the Hug-growing
 * body/image region that needs to scroll rather than push the header
 * off-screen (2026-08-14, second physical test — see the class doc
 * comment).
 *
 * Measured empirically twice, not guessed, and wrong the first two times
 * — both real device tests, both the exact same symptom (a header line
 * frozen/duplicated at the seam while scrolling, because the fixed header
 * crop clipped into text that should have been part of the scrollable
 * body):
 *
 * - Pass 1 (112): measured by eye from a screenshot comparison. Too
 *   imprecise — the true boundary for single-line title/subtitle was
 *   109.75, already past it.
 * - Pass 2 (95): `tools/inspect_card_header_boundary.mjs` was rewritten to
 *   scan rendered pixels for the subtitle/body text runs' own authored
 *   fill color (#3C3C43, confirmed via `tools/dump_riv_objects.py`) and
 *   report exact bands — precise, but ONLY tested a single-line subtitle.
 *   A real device test with a subtitle long enough to WRAP to 2 lines
 *   clipped into that second line: the boundary isn't a fixed artboard
 *   constant independent of content after all — it depends on how many
 *   lines the title/subtitle actually wrap to.
 * - Pass 3 (this value): the probe now measures a deliberately generous
 *   worst case — a title AND a subtitle both long enough to wrap to 2
 *   lines each (asset-authoring-guide.md documents subtitle as meant to
 *   be a short "date/category tag"; 2 lines each is a realistic,
 *   generously-margined ceiling for that contract, not an arbitrary
 *   number). Measured: subtitle's 2nd line ends at 130.25 design units,
 *   body starts at 160.5 — a comfortable 30-unit gap either way of this
 *   constant's value. **Known remaining limitation, not fixed by this
 *   pass:** a title or subtitle that wraps to 3+ lines would still clip.
 *   Considered and deliberately not solved with a fully dynamic runtime
 *   measurement (would need a second, hidden Rive instance or a two-pass
 *   render per open() with a visible flash) given no realistic Card
 *   content requires it — re-run the probe and raise this constant, or
 *   revisit with a dynamic measurement, if that assumption ever breaks.
 * Re-run `tools/inspect_card_header_boundary.mjs` after any bench-ui.riv
 * re-export that touches the header, and confirm the reported gap still
 * safely contains this constant.
 */
const HEADER_HEIGHT_ARTBOARD_UNITS = 148;

// Slide is app-owned (container transform), not Rive-owned — see the class
// doc comment. The curve matches the deceleration most native bottom
// sheets use (react-spring-bottom-sheet, iOS sheets), not a generic ease.
const SLIDE_TRANSITION = 'transform 300ms cubic-bezier(0.32, 0.72, 0, 1)';
// Below this, a pointer sequence on the header is a tap candidate
// (forwarded into the artboard as usual for the close button); at or
// above it, it's a confirmed drag and the artboard stops receiving events
// for the rest of this gesture.
const DRAG_TAP_THRESHOLD_PX = 12;
// The close button (Card_Close_Button_Container, artboard rect
// x:[304,334] y:[17,47] of the full 350x480 design — ~30x30 units, under
// Apple's 44pt minimum target size) sits in this corner OF THE HEADER
// (y:[17,47] of the header's own HEADER_HEIGHT_ARTBOARD_UNITS, not the
// full 480 — the header canvas below is a crop, so button fractions are
// relative to ITS OWN height). A gesture starting here is never promoted
// to a drag, however much the finger jitters while aiming at a small
// target — without this, an accidental drag classification mid-tap
// suppresses the paired pointerUp forward and the button silently doesn't
// fire (intermittently, exactly as small-target mis-taps do). The grabber
// handle (top-center, ~45-55% x, near y=0) is well clear of this zone.
const NO_DRAG_ZONE_MIN_X_FRACTION = 0.8;
const NO_DRAG_ZONE_MAX_Y_FRACTION = 47 / HEADER_HEIGHT_ARTBOARD_UNITS + 0.05; // ~47%, with margin
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
 *
 * DOM structure (2026-08-14, second physical test — the shell/content
 * split below replaces a first attempt that scrolled the WHOLE sheet,
 * which dragged the grabber/close button off-screen along with the body,
 * an actual regression from what a fixed bottom-sheet header must do):
 *
 *   container (fixed shell — position, size, open/close slide; NEVER
 *              scrolls; drag-to-dismiss transform lives here)
 *     ├── headerCanvas (small canvas, fixed height, ALWAYS visible —
 *     │                 a live top-crop mirror of `rive.canvas`, see
 *     │                 refreshHeaderMirror()) — grabber + title/
 *     │                 subtitle + close button all live in this crop
 *     └── contentWrapper (overflow-y:auto — the ONLY scrollable element)
 *           └── rive.canvas (the real, interactive Rive canvas — full
 *                             artboard height, pulled up by exactly the
 *                             header's own height via a negative
 *                             margin-top, so contentWrapper's own natural
 *                             top edge shows body content, not a second
 *                             copy of the header)
 *
 * There is only ONE underlying artboard/state-machine instance
 * (`rive.canvas`, inside contentWrapper) — headerCanvas is a passive
 * pixel mirror, not a second Rive instance, so both are always in sync by
 * construction and there is exactly one place text runs/inputs are set.
 * Pointer input on the header is remapped onto the SAME instance's
 * coordinate space (see forwardPointer's `sourceRect` parameter) since
 * headerCanvas shows an identical top-left-aligned crop of the same
 * raster — a tap at (x,y) on either canvas corresponds to the same
 * artboard point.
 */
export class CardPanel {
  private readonly container: HTMLDivElement;
  private readonly headerCanvas: HTMLCanvasElement;
  private readonly headerCtx: CanvasRenderingContext2D;
  private readonly contentWrapper: HTMLDivElement;
  private readonly rive: RiveController;
  private open_ = false;
  private closeHandler: (() => void) | null = null;

  // Drag-gesture tracking (see attach()). Attached ONLY to the fixed
  // header now — the content area never participates in this gesture, so
  // (unlike the first, whole-sheet-scroll attempt) there is no need to
  // arbitrate "is this a scroll or a dismiss" here at all: the header has
  // nothing of its own to scroll. dragStartY !== null means a pointer
  // sequence is in progress on the header; isDragging distinguishes
  // "still a tap candidate" (e.g. aiming for the close button) from
  // "confirmed drag, artboard forwarding suspended." dragEligible is
  // fixed for the whole gesture at pointerdown (see NO_DRAG_ZONE_* — a
  // gesture starting on the close button can never become a drag).
  private dragStartY: number | null = null;
  private dragStartTime = 0;
  private isDragging = false;
  private dragEligible = true;
  private lastMoveY = 0;
  private lastMoveTime = 0;

  // Inputs the layout was last computed for. Bounds height is seeded with
  // the design height; the first Advance replaces it with the real
  // Hug-resolved height (the placeholder content resolves to ~408, not
  // 480, so the very first frame already re-syncs). Viewport values are
  // tracked too: the 90% height cap and the natural CSS height both depend
  // on them (rotation, iOS URL-bar collapse).
  private appliedBoundsHeight = CARD_ARTBOARD_HEIGHT;
  private appliedViewportWidth = 0;
  private appliedViewportHeight = 0;

  // Burst counter for the header mirror — see requestHeaderMirrorRefresh's
  // doc comment for why this must NOT be a persistent per-frame refresh.
  private headerRefreshFramesRemaining = 0;

  constructor(riveFile: RiveFile, private readonly imageSlot: CardImageSlot) {
    this.container = document.createElement('div');
    // z-index above the marker layer (10); pointer-events only while open,
    // so the closed (invisible) card never swallows taps meant for markers
    // or the scene behind it. overflow:hidden (the shell itself never
    // scrolls — only contentWrapper below does) doubles as the rounded-
    // corner/height-cap clip for whatever contentWrapper doesn't fit.
    // transform starts at translateY(100%) — fully below the viewport —
    // synchronously, before Rive even loads, so there is no first-load
    // flash regardless of any Rive/state-machine timing.
    this.container.style.cssText =
      'position:fixed;left:0;bottom:0;overflow:hidden;display:flex;flex-direction:column;' +
      `width:${CARD_CSS_WIDTH};aspect-ratio:${CARD_ARTBOARD_WIDTH}/${CARD_ARTBOARD_HEIGHT};` +
      `z-index:20;pointer-events:none;transform:translateY(100%);` +
      `transition:${SLIDE_TRANSITION};`;

    this.headerCanvas = document.createElement('canvas');
    // flex:none — fixed height (set in syncAspectToArtboard), never grows
    // with the flex layout; touch-action:none, this is the drag handle.
    this.headerCanvas.style.cssText = 'flex:none;display:block;width:100%;touch-action:none;';
    const headerCtx = this.headerCanvas.getContext('2d');
    if (!headerCtx) {
      throw new Error('CardPanel: 2D context unavailable for the header mirror canvas.');
    }
    this.headerCtx = headerCtx;
    this.container.appendChild(this.headerCanvas);

    this.contentWrapper = document.createElement('div');
    // flex:1 — takes whatever height the header didn't use, up to the
    // container's own (possibly capped) height; overflow-y:auto is the
    // ONLY scrolling surface in this whole panel. -webkit-overflow-
    // scrolling:touch for iOS momentum scrolling.
    this.contentWrapper.style.cssText =
      'flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;touch-action:pan-y;';
    this.container.appendChild(this.contentWrapper);

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
    // display:block — width/height/margin are set by syncAspectToArtboard
    // once real bounds are known (full artboard height, pulled up by the
    // header's height so contentWrapper's own top shows body content, not
    // a redundant copy of the header).
    //
    // will-change:transform + translateZ(0) (2026-08-14, fourth physical
    // test): a real device test showed the FIRST line of scrolled body
    // content staying frozen on screen while the rest scrolled correctly
    // underneath it — reproduced in headless Chrome too, and confirmed by
    // measurement to NOT be a layout bug (canvas.getBoundingClientRect()
    // moves by exactly the scroll delta) but a paint/compositing one: the
    // browser's GPU layer for a canvas that both scrolls AND redraws every
    // animation frame (Rive's own render loop) can leave a stale raster
    // in the region that just scrolled out of its old position, instead
    // of repainting it. Forcing this canvas onto its own explicit
    // compositing layer makes the browser re-tile it correctly on scroll
    // instead of reusing a stale tile from before the scroll.
    canvas.style.cssText = 'display:block;width:100%;will-change:transform;transform:translateZ(0);';
    this.contentWrapper.appendChild(canvas);
    document.body.appendChild(this.container);

    // Same single-input-path forwarding as the markers: pointer events are
    // mapped into artboard space so the Card's authored Rive listeners
    // (the close button) receive them; shouldDisableRiveListeners stays
    // on. headerCanvas is a top-left-aligned 1:1 CROP of the main canvas's
    // own backing pixels (see refreshHeaderMirror) — a point at backing
    // pixel (x,y) in EITHER canvas is the same point in the main canvas's
    // own frame, which is what mapCanvasPointToArtboard's Fit.contain
    // math is built against (RiveController.canvasWidth/canvasHeight,
    // i.e. the MAIN canvas's full backing size). The conversion below
    // must therefore scale by the TAPPED element's own backing size
    // (`backingWidth`/`backingHeight`) — using the main canvas's full
    // size here for a tap that landed on the much-shorter header crop
    // would inflate its Y fraction into the body region and miss the
    // close button entirely (caught by headless verification, not
    // assumed correct).
    const forwardPointer = (
      sourceRect: DOMRect,
      backingWidth: number,
      backingHeight: number,
      event: PointerEvent,
      isDown: boolean
    ): void => {
      console.log(
        `[${traceT()}] [Card] pointer${isDown ? 'down' : 'up'} at ` +
          `(${event.clientX.toFixed(0)},${event.clientY.toFixed(0)}) — forwarded into the artboard`
      );
      if (!this.rive.isReady) return;
      if (sourceRect.width === 0 || sourceRect.height === 0) return;

      const canvasX = ((event.clientX - sourceRect.left) / sourceRect.width) * backingWidth;
      const canvasY = ((event.clientY - sourceRect.top) / sourceRect.height) * backingHeight;
      const artboardPoint = this.rive.mapCanvasPointToArtboard(canvasX, canvasY);
      if (isDown) {
        this.rive.pointerDown(artboardPoint.x, artboardPoint.y);
      } else {
        this.rive.pointerUp(artboardPoint.x, artboardPoint.y);
      }
    };
    const forwardHeaderPointer = (event: PointerEvent, isDown: boolean): void => {
      forwardPointer(
        this.headerCanvas.getBoundingClientRect(),
        this.headerCanvas.width,
        this.headerCanvas.height,
        event,
        isDown
      );
    };

    // Drag-to-dismiss + tap forwarding, both attached to headerCanvas
    // ONLY: the grabber and the close button both live inside it, and it
    // is the one part of the Card that never scrolls, so it can always
    // serve as the swipe handle regardless of how far the content is
    // scrolled. The content area (contentWrapper) never gets these
    // listeners at all — it is native-scroll-only, so a vertical gesture
    // there can never be misread as a dismiss.
    const handlePointerDown = (event: PointerEvent): void => {
      event.stopPropagation();
      // No preventDefault/setPointerCapture yet — only once a gesture is
      // confirmed as a drag (see handlePointerMove), so a plain tap on
      // the close button isn't obstructed by gesture bookkeeping.
      this.dragStartY = event.clientY;
      this.dragStartTime = performance.now();
      this.lastMoveY = event.clientY;
      this.lastMoveTime = this.dragStartTime;
      this.isDragging = false;

      const rect = this.headerCanvas.getBoundingClientRect();
      const xFraction = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
      const yFraction = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0;
      this.dragEligible = !(
        xFraction >= NO_DRAG_ZONE_MIN_X_FRACTION && yFraction <= NO_DRAG_ZONE_MAX_Y_FRACTION
      );

      forwardHeaderPointer(event, true);
    };

    const handlePointerMove = (event: PointerEvent): void => {
      if (this.dragStartY === null) return;
      const deltaY = event.clientY - this.dragStartY;

      if (!this.isDragging) {
        if (!this.dragEligible || Math.abs(deltaY) < DRAG_TAP_THRESHOLD_PX) return; // still a tap candidate
        console.log(`[${traceT()}] [Card] drag threshold crossed on header — suspending artboard forwarding`);
        this.isDragging = true;
        this.container.style.transition = 'none';
        this.headerCanvas.setPointerCapture(event.pointerId);
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
      if (this.isDragging) {
        event.preventDefault();
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
        // A genuine tap (never crossed the drag threshold): forward the
        // paired pointerUp for the artboard's click detection (the close
        // button).
        forwardHeaderPointer(event, false);
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

    this.headerCanvas.addEventListener('pointerdown', handlePointerDown);
    this.headerCanvas.addEventListener('pointermove', handlePointerMove);
    this.headerCanvas.addEventListener('pointerup', handlePointerUp);
    this.headerCanvas.addEventListener('pointercancel', handlePointerCancel);

    await this.rive.whenReady();
    this.rive.onRiveEvent((eventName) => {
      if (eventName === EVENT_CLOSE_REQUESTED) {
        console.log(`[${traceT()}] [Card] closeRequested Rive event — invoking close handler`);
        this.closeHandler?.();
      }
    });
    // The Card artboard's Auto Layout height is Hug: every content change
    // (open() setting text runs) re-resolves the artboard bounds on a later
    // frame, never synchronously — so this listens to the runtime's own
    // Advance tick instead of hooking open(). Without the re-sync, the
    // default Fit.contain letterboxes the now-taller artboard horizontally
    // inside the fixed-aspect canvas: visible width fraction = 480/H, i.e.
    // ~10% camera-feed margins per side at H≈604 (troubleshooting doc §12).
    this.syncAspectToArtboard();
    this.requestHeaderMirrorRefresh();
    this.rive.onAdvance(() => {
      this.syncAspectToArtboard();
      if (this.headerRefreshFramesRemaining > 0) {
        this.headerRefreshFramesRemaining--;
        this.refreshHeaderMirror();
      }
    });
  }

  /**
   * Arms a short burst of header-mirror refreshes on the next few Advance
   * ticks — NOT a persistent per-frame subscription (2026-08-14, fourth
   * physical test — a real device showed the first line of scrolled body
   * content frozen in place, reproduced in headless Chrome and root-caused
   * by isolation, not assumed: continuously calling `drawImage` with the
   * scrolling main canvas as its SOURCE, every single Advance tick
   * forever, corrupts the browser's own scroll-repaint for that same
   * canvas — disabling the mirror refresh entirely made the scrolling
   * artifact disappear). The header's content (grabber/title/subtitle/
   * close) is static between `open()` calls, so it only needs re-copying
   * for the handful of frames right after content changes (Hug layout
   * settling, same "not synchronous" reasoning `syncAspectToArtboard`
   * already documents) — not forever afterward, while the user may be
   * scrolling. `open()` calls this again on every content swap.
   */
  private requestHeaderMirrorRefresh(): void {
    this.headerRefreshFramesRemaining = 10;
  }

  /**
   * Copies the top HEADER_HEIGHT_ARTBOARD_UNITS-worth of the main canvas's
   * CURRENT backing-store pixels into headerCanvas. @rive-app/canvas
   * renders through a plain CanvasRenderingContext2D (confirmed against
   * the installed rive.js, not assumed — no WebGL buffer-preservation
   * caveat applies), so drawImage from one 2D canvas into another always
   * shows the latest committed frame. Only called for a short burst after
   * content changes (see requestHeaderMirrorRefresh) — never on every
   * frame indefinitely.
   */
  private refreshHeaderMirror(): void {
    const source = this.rive.canvas;
    const headerBackingHeight = this.headerCanvas.height;
    if (source.width === 0 || headerBackingHeight === 0) return;
    this.headerCtx.clearRect(0, 0, this.headerCanvas.width, this.headerCanvas.height);
    this.headerCtx.drawImage(
      source,
      0,
      0,
      source.width,
      Math.min(headerBackingHeight, source.height),
      0,
      0,
      this.headerCanvas.width,
      Math.min(headerBackingHeight, source.height)
    );
  }

  /**
   * Re-derives the fixed header's size, the scrollable content wrapper's
   * size, and the main canvas's backing store from the live artboard
   * bounds, so canvas aspect === artboard aspect (Fit.contain fills the
   * full width by construction) and the header/body split stays aligned
   * with HEADER_HEIGHT_ARTBOARD_UNITS at any viewport width. Two regimes
   * for the total (header + content) height:
   *
   * - Natural height fits under 90% of the viewport: contentWrapper is
   *   exactly tall enough for the remaining (non-header) content — no
   *   scrolling occurs, matching a short article's "just fits" case.
   * - It doesn't: contentWrapper is pinned to (90%-of-viewport minus the
   *   header), and the canvas inside it keeps its full natural height —
   *   overflow-y:auto on contentWrapper makes the remainder reachable by
   *   scrolling instead of clipping it away unreachably (the original
   *   bug) or dragging the header off-screen with it (the first, wrong
   *   fix).
   *
   * Cheap no-op (float compares) on frames where nothing changed;
   * viewport dimensions participate because both the cap and the natural
   * CSS height move with them (rotation, iOS URL-bar collapse).
   */
  private syncAspectToArtboard(): void {
    if (!this.rive.isReady) return;
    const bounds = this.rive.bounds;
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    if (width <= 0 || height <= 0) return;
    if (
      Math.abs(height - this.appliedBoundsHeight) < 0.5 &&
      window.innerWidth === this.appliedViewportWidth &&
      window.innerHeight === this.appliedViewportHeight
    ) {
      return;
    }
    this.appliedBoundsHeight = height;
    this.appliedViewportWidth = window.innerWidth;
    this.appliedViewportHeight = window.innerHeight;

    const canvas = this.rive.canvas;
    // px-per-design-unit is set by WIDTH alone (canvas width is always
    // 100% of the viewport) and is identical in both axes once canvas
    // aspect === artboard aspect — the same invariant the header-height
    // conversion below relies on.
    const pxPerDesignUnit = window.innerWidth / width;
    const headerHeightPx = HEADER_HEIGHT_ARTBOARD_UNITS * pxPerDesignUnit;
    const naturalTotalCssHeight = height * pxPerDesignUnit;
    const maxTotalCssHeight = window.innerHeight * CARD_MAX_VIEWPORT_HEIGHT_FRACTION;
    const capped = naturalTotalCssHeight > maxTotalCssHeight;
    const contentWrapperCssHeight = Math.max(
      0,
      (capped ? maxTotalCssHeight : naturalTotalCssHeight) - headerHeightPx
    );

    this.headerCanvas.style.height = `${headerHeightPx}px`;
    this.contentWrapper.style.height = `${contentWrapperCssHeight}px`;
    canvas.style.height = `${naturalTotalCssHeight}px`;
    // Pulls the canvas's own top HEADER_HEIGHT_ARTBOARD_UNITS out of
    // contentWrapper's visible area (permanently — this is layout, not a
    // user scroll position) so its natural top edge shows body content;
    // the identical top crop is what headerCanvas mirrors instead.
    canvas.style.marginTop = `-${headerHeightPx}px`;

    const backingScale = Math.min(window.devicePixelRatio || 1, MAX_BACKING_SCALE);
    // Through Rive's resize path (reads the CANVAS's just-reflowed CSS
    // box) so its renderer alignment state stays coherent.
    this.rive.resizeDrawingSurface(backingScale);
    this.headerCanvas.width = Math.round(window.innerWidth * backingScale);
    this.headerCanvas.height = Math.round(headerHeightPx * backingScale);
    console.log(
      `[${traceT()}] [Card] artboard bounds ${width.toFixed(0)}x${height.toFixed(0)} — re-synced ` +
        `header=${headerHeightPx.toFixed(0)}px content=${contentWrapperCssHeight.toFixed(0)}px` +
        `${capped ? ` (total capped at ${maxTotalCssHeight.toFixed(0)}px, canvas ${naturalTotalCssHeight.toFixed(0)}px)` : ''} ` +
        `backing=${this.rive.canvasWidth}x${this.rive.canvasHeight}`
    );
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
        ` container=${this.container.getBoundingClientRect().width.toFixed(0)}x${this.container.getBoundingClientRect().height.toFixed(0)}` +
        // viewport + backing alongside the container: one line decides the
        // width-bug class on a device capture. container < viewport = a
        // real layout constraint (report the numbers); equal but margins
        // visible = artwork/raster (tools/run_width_probe.mjs measures
        // that); this segment absent entirely = the device loaded a stale
        // bundle (the 2026-07-14 "not full width" report's likely cause).
        ` viewport=${window.innerWidth}x${window.innerHeight}` +
        ` canvasBacking=${this.rive.canvasWidth}x${this.rive.canvasHeight} dpr=${window.devicePixelRatio}`
    );
    // title/body may now be absent (incomplete editorial content —
    // ContentProvider.ts's CardContent doc comment), same "clear the run
    // rather than invent placeholder text" treatment subtitle already had.
    this.rive.setText(TEXT_RUN_TITLE, content.title ?? '');
    this.rive.setText(TEXT_RUN_SUBTITLE, content.subtitle ?? '');
    this.rive.setText(TEXT_RUN_BODY, content.body ?? '');
    if (content.imageUrl !== undefined) {
      this.imageSlot.setImage(content.imageUrl).catch((error: unknown) => {
        console.error('[CardPanel] card image failed to load:', error);
      });
    }

    // Every open (fresh or content swap while already open) starts
    // scrolled to the top — otherwise a short article opened right after a
    // long, scrolled-down one would render with its body content already
    // scrolled down. The header mirror is re-armed for a short burst too
    // (title/subtitle may have just changed) — see
    // requestHeaderMirrorRefresh's doc comment for why this is bounded,
    // not a persistent per-frame refresh.
    this.contentWrapper.scrollTop = 0;
    this.requestHeaderMirrorRefresh();

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
