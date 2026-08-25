import type { CardContent } from './ContentProvider.js';
import { traceT } from './TraceLog.js';

// Slide is app-owned (container transform) — a plain transform tracked in
// real time by pointer events, matching how react-spring-bottom-sheet /
// react-native-bottom-sheet work, because a design-tool timeline can't
// cheaply do 1:1 finger-tracking with velocity-based release.
const SLIDE_TRANSITION = 'transform 300ms cubic-bezier(0.32, 0.72, 0, 1)';
// Below this, a pointer sequence on the header is a tap candidate; at or
// above it, it's a confirmed drag and further pointer moves commit to the
// drag instead of being treated as a tap.
const DRAG_TAP_THRESHOLD_PX = 12;
// Release past this fraction of the sheet's own height commits to the next
// snap point down (open->peek, or peek->closed), regardless of velocity.
const DRAG_CLOSE_FRACTION = 0.25;
// Release below the distance threshold but moving downward faster than
// this (px/ms) also commits to the next snap point down — a fast flick
// shouldn't require dragging the full quarter-height first.
const DRAG_CLOSE_VELOCITY_PX_MS = 0.5;
// The sheet never covers more than this fraction of the viewport — the
// header (grabber/title/subtitle/close) is flex:none (natural height),
// the body is flex:1 with its own overflow-y:auto, so plain CSS flexbox
// handles the split; no JS measurement of any kind is needed.
const CARD_MAX_VIEWPORT_HEIGHT_FRACTION = 0.9;

/**
 * Visual/interaction state of the sheet (Figma nodes 6:40 "collapsed" /
 * 6:383 "open", AR_SYSTEM.md §G onboarding UX entry). Three snap points:
 * `closed` (fully off-screen, pointer-events:none), `peek` (only the
 * header — grabber/title/subtitle/close — visible, matching 6:40's "the
 * rest sits below the fold"), `open` (full height, scrollable content,
 * matching 6:383).
 */
export type CardVisualState = 'closed' | 'peek' | 'open';

/**
 * Pure drag-release resolver — given where a drag started (peek or open,
 * the only two states the header is interactive in), the net vertical
 * distance dragged (+down/-up) and release velocity, decides the next snap
 * point. Extracted for unit testing (CardPanel.test.ts). Reuses the exact
 * thresholds the pre-peek binary sheet already shipped with — same feel,
 * one more snap point.
 */
export function resolveSnapPoint(
  fromState: 'peek' | 'open',
  deltaYPx: number,
  velocityPxMs: number,
  sheetHeightPx: number
): CardVisualState {
  if (fromState === 'open') {
    const committedDown = deltaYPx > sheetHeightPx * DRAG_CLOSE_FRACTION || velocityPxMs > DRAG_CLOSE_VELOCITY_PX_MS;
    return committedDown ? 'peek' : 'open';
  }
  // fromState === 'peek'
  if (deltaYPx < 0) return 'open'; // any confirmed upward drag commits to expand
  const committedDown = deltaYPx > sheetHeightPx * DRAG_CLOSE_FRACTION || velocityPxMs > DRAG_CLOSE_VELOCITY_PX_MS;
  return committedDown ? 'closed' : 'peek';
}

/**
 * The single screen-fixed content panel (Phase 5, AR_SYSTEM.md §G),
 * full-width bottom sheet.
 *
 * 2026-08-14, fifth physical-device test: previously rendered through a
 * Rive artboard (title/subtitle/body as Rive text runs on one canvas,
 * `cardImage` as a Rive referenced asset). That went through four
 * increasingly complex fix attempts for one root problem — a single Rive
 * canvas has no native way to keep part of itself fixed while scrolling
 * the rest — including a canvas-mirroring/cropping scheme that itself
 * introduced a browser paint-compositing bug (continuous `drawImage`
 * reads from a scrolling source canvas corrupting its own repaint). The
 * user's own diagnosis was correct: this is fundamentally "put the body
 * text in a scrollable container," which plain HTML/CSS already does
 * natively and reliably. Rebuilt as plain DOM: title/subtitle/body are
 * real text nodes, the image is a real `<img>`, the header/body split is
 * plain CSS flexbox (`flex:none` header, `flex:1; overflow-y:auto`
 * content) — the browser's own layout and scroll engine owns all of this
 * now, not a bespoke synchronization scheme. No Rive, no canvas, no
 * per-frame polling anywhere in this file.
 *
 * State authority: the app owns `state` (closed/peek/open) and the slide
 * position (a CSS `transform: translateY(...)` on `container`, tracked by
 * pointer events during a drag). The close button and drag-to-dismiss both
 * funnel through the same app-level close, same as before peek was added.
 */
export class CardPanel {
  private readonly container: HTMLDivElement;
  private readonly header: HTMLDivElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly titleEl: HTMLHeadingElement;
  private readonly subtitleEl: HTMLParagraphElement;
  private readonly contentWrapper: HTMLDivElement;
  private readonly bodyEl: HTMLParagraphElement;
  private readonly imageEl: HTMLImageElement;

  private state: CardVisualState = 'closed';
  private closeHandler: (() => void) | null = null;

  // Drag-gesture tracking, attached to the header only (the one part of
  // the card that never scrolls, so it can always serve as the swipe
  // handle regardless of how far the content is scrolled). The content
  // area gets no drag listeners at all — native overflow-y:auto owns it
  // completely, so a vertical gesture there can never be misread as a
  // dismiss.
  private dragStartY: number | null = null;
  private dragBaseYPx = 0; // container's translateY, in px, at drag start
  private dragSheetHeightPx = 0;
  private lastMoveY = 0;
  private lastMoveTime = 0;
  private isDragging = false;

  constructor() {
    this.container = document.createElement('div');
    // z-index above the marker layer (10); pointer-events only while open
    // (peek or open), so the closed (invisible) card never swallows taps
    // meant for markers or the scene behind it. transform starts at
    // translateY(100%) — fully below the viewport — synchronously, so
    // there is no first-load flash. display:flex column + max-height: the
    // header (flex:none) takes its natural height, the content wrapper
    // (flex:1, its own overflow-y) takes the rest, capped at 90% of the
    // viewport — plain flexbox, no JS sizing (except the peek offset,
    // which reads the header's own rendered height — see peekTransform()).
    this.container.style.cssText =
      'position:fixed;left:0;bottom:0;width:100vw;max-height:' +
      `${CARD_MAX_VIEWPORT_HEIGHT_FRACTION * 100}vh;display:flex;flex-direction:column;` +
      'background:#fff;border-radius:24px 24px 0 0;box-shadow:0 -2px 24px rgba(0,0,0,0.15);' +
      'overflow:hidden;z-index:20;pointer-events:none;transform:translateY(100%);' +
      `transition:${SLIDE_TRANSITION};padding-bottom:env(safe-area-inset-bottom,0px);`;

    this.header = document.createElement('div');
    this.header.style.cssText =
      'flex:none;position:relative;padding:10px 20px 16px;touch-action:none;';

    const grabber = document.createElement('div');
    grabber.style.cssText =
      'width:36px;height:5px;border-radius:2.5px;background:rgba(61,61,61,0.5);' +
      'margin:0 auto 14px;';
    this.header.appendChild(grabber);

    this.closeButton = document.createElement('button');
    this.closeButton.setAttribute('aria-label', 'Close');
    this.closeButton.textContent = '✕'; // ✕
    this.closeButton.style.cssText =
      'position:absolute;top:10px;right:16px;width:30px;height:30px;border-radius:50%;' +
      'border:none;background:#dedede;color:#3d3d3d;font-size:15px;line-height:30px;' +
      'padding:0;cursor:pointer;touch-action:manipulation;';
    this.header.appendChild(this.closeButton);

    this.titleEl = document.createElement('h2');
    this.titleEl.style.cssText =
      'margin:0 56px 4px 0;font:700 24px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;color:#000;';
    this.header.appendChild(this.titleEl);

    this.subtitleEl = document.createElement('p');
    this.subtitleEl.style.cssText =
      'margin:0 56px 0 0;font:600 15px/1.3 -apple-system,BlinkMacSystemFont,sans-serif;color:#3c3c43;';
    this.header.appendChild(this.subtitleEl);

    this.container.appendChild(this.header);

    this.contentWrapper = document.createElement('div');
    // The ONLY scrollable element in the whole panel — native
    // overflow-y:auto, no JS involved in making this work.
    this.contentWrapper.style.cssText =
      'flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;' +
      'padding:16px 20px 24px;touch-action:pan-y;';

    this.imageEl = document.createElement('img');
    this.imageEl.style.cssText = 'display:none;width:100%;border-radius:12px;margin:0 0 16px;';
    this.imageEl.alt = '';
    this.contentWrapper.appendChild(this.imageEl);

    this.bodyEl = document.createElement('p');
    this.bodyEl.style.cssText =
      'margin:0;font:400 16px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;color:#3c3c43;' +
      'white-space:pre-wrap;';
    this.contentWrapper.appendChild(this.bodyEl);

    this.container.appendChild(this.contentWrapper);
  }

  /** Mounts the panel. Synchronous — there is no asset to wait for. */
  async attach(): Promise<void> {
    document.body.appendChild(this.container);

    this.closeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      console.log(`[${traceT()}] [Card] close button clicked — invoking close handler`);
      this.closeHandler?.();
    });

    const handlePointerDown = (event: PointerEvent): void => {
      // A gesture starting on the close button is never a drag — let the
      // button's own click handler own it entirely.
      if (event.target instanceof Node && this.closeButton.contains(event.target)) return;
      // Only 'peek'/'open' ever attach the header with pointer-events
      // enabled (container.pointerEvents is 'none' while closed), but
      // guard explicitly since this listener stays bound for the panel's
      // whole lifetime.
      if (this.state === 'closed') return;
      event.stopPropagation();
      this.dragStartY = event.clientY;
      this.dragBaseYPx = this.currentTranslateYPx();
      this.dragSheetHeightPx = this.container.getBoundingClientRect().height;
      this.lastMoveY = event.clientY;
      this.lastMoveTime = performance.now();
      this.isDragging = false;
    };

    const handlePointerMove = (event: PointerEvent): void => {
      if (this.dragStartY === null) return;
      const deltaY = event.clientY - this.dragStartY;

      if (!this.isDragging) {
        if (Math.abs(deltaY) < DRAG_TAP_THRESHOLD_PX) return; // still a tap candidate
        console.log(`[${traceT()}] [Card] drag threshold crossed on header`);
        this.isDragging = true;
        this.container.style.transition = 'none';
        this.header.setPointerCapture(event.pointerId);
      }

      event.stopPropagation();
      event.preventDefault();
      this.lastMoveY = event.clientY;
      this.lastMoveTime = performance.now();
      // Clamp between fully open (0) and fully closed (the sheet's own
      // height) — dragging past either end has nothing further to show.
      const clampedY = Math.min(this.dragSheetHeightPx, Math.max(0, this.dragBaseYPx + deltaY));
      this.container.style.transform = `translateY(${clampedY}px)`;
    };

    const handlePointerUp = (event: PointerEvent): void => {
      if (!this.isDragging) {
        this.dragStartY = null;
        // A plain tap (no drag) on the header, while peeked, expands the
        // sheet — the header IS the "show more" affordance in that state.
        // A tap while already open does nothing (no defined behavior).
        if (this.state === 'peek') this.expand();
        return;
      }
      event.stopPropagation();
      event.preventDefault();
      const elapsedMs = Math.max(1, performance.now() - this.lastMoveTime);
      const velocity = (event.clientY - this.lastMoveY) / elapsedMs; // px/ms, + = downward
      const deltaY = event.clientY - (this.dragStartY ?? event.clientY); // signed: +down, -up
      const next = resolveSnapPoint(
        this.state === 'open' ? 'open' : 'peek',
        deltaY,
        velocity,
        this.dragSheetHeightPx
      );
      console.log(
        `[${traceT()}] [Card] drag released — deltaY=${deltaY.toFixed(0)}px ` +
          `velocity=${velocity.toFixed(2)}px/ms — ${this.state} -> ${next}`
      );

      this.dragStartY = null;
      this.isDragging = false;
      if (next === 'closed') {
        this.closeHandler?.();
      } else {
        this.setState(next);
      }
    };

    const handlePointerCancel = (): void => {
      if (this.isDragging) {
        this.setState(this.state); // snap back to the resting transform for the current state
      }
      this.dragStartY = null;
      this.isDragging = false;
    };

    this.header.addEventListener('pointerdown', handlePointerDown);
    this.header.addEventListener('pointermove', handlePointerMove);
    this.header.addEventListener('pointerup', handlePointerUp);
    this.header.addEventListener('pointercancel', handlePointerCancel);
  }

  detach(): void {
    this.container.remove();
  }

  /** True whenever the sheet is showing at all (peek or open) — the tap-outside-to-close contract. */
  get isOpen(): boolean {
    return this.state !== 'closed';
  }

  /**
   * Fills the Card with content and shows it at the `peek` snap point
   * (Figma 6:40 — grabber/title/subtitle visible, body below the fold).
   * Title/subtitle/body may be absent (incomplete editorial content —
   * ContentProvider.ts's CardContent doc comment) — an absent field clears
   * the corresponding element rather than inventing placeholder text, same
   * contract the Rive version had.
   */
  open(content: CardContent): void {
    console.log(
      `[${traceT()}] [Card] open("${content.title ?? ''}") — ` +
        (this.state !== 'closed' ? 'already showing, swapping content' : 'opening: sliding up to peek')
    );
    this.titleEl.textContent = content.title ?? '';
    this.subtitleEl.textContent = content.subtitle ?? '';
    this.subtitleEl.style.display = content.subtitle ? '' : 'none';
    this.bodyEl.textContent = content.body ?? '';
    if (content.imageUrl) {
      this.imageEl.src = content.imageUrl;
      this.imageEl.style.display = 'block';
      this.imageEl.onerror = (): void => {
        console.error(`[CardPanel] card image failed to load: ${content.imageUrl}`);
        this.imageEl.style.display = 'none';
      };
    } else {
      this.imageEl.removeAttribute('src');
      this.imageEl.style.display = 'none';
    }

    // Every open (fresh or content swap while already showing) starts
    // scrolled to the top — otherwise a short article opened right after
    // a long, scrolled-down one would render with its body already
    // scrolled down.
    this.contentWrapper.scrollTop = 0;

    if (this.state === 'closed') {
      this.container.style.pointerEvents = 'auto';
    }
    this.setState('peek');
  }

  /** Expands an already-peeked sheet to full height (Figma 6:383). No-op if closed or already open. */
  expand(): void {
    if (this.state !== 'peek') return;
    console.log(`[${traceT()}] [Card] expand() — peek -> open`);
    this.setState('open');
  }

  /**
   * Idempotent; slides the sheet down and out of view. Called for the
   * close button, a drag-to-dismiss past the threshold from `peek`, or a
   * programmatic close — same transform, same bookkeeping, regardless of
   * which gesture triggered it.
   */
  close(): void {
    if (this.state === 'closed') return;
    console.log(`[${traceT()}] [Card] close() — sliding down, pointerEvents=none`);
    this.container.style.pointerEvents = 'none';
    this.setState('closed');
  }

  /** The app answers the authored close button (click) with this. */
  onCloseRequested(handler: () => void): void {
    this.closeHandler = handler;
  }

  /** True when the event target is (inside) the card panel. */
  containsEventTarget(target: EventTarget | null): boolean {
    return target instanceof Node && this.container.contains(target);
  }

  private setState(next: CardVisualState): void {
    this.state = next;
    this.container.style.transition = SLIDE_TRANSITION;
    this.container.style.transform = this.restingTransform(next);
  }

  /** The header's own rendered height — "peek" shows exactly this much, nothing more. */
  private peekHeightPx(): number {
    return this.header.getBoundingClientRect().height;
  }

  private restingTransform(state: CardVisualState): string {
    if (state === 'open') return 'translateY(0)';
    if (state === 'closed') return 'translateY(100%)';
    return `translateY(calc(100% - ${this.peekHeightPx()}px))`;
  }

  /** The container's current translateY, in px, derived from `state` (not read back from computed style — cheaper and exact). */
  private currentTranslateYPx(): number {
    if (this.state === 'open') return 0;
    if (this.state === 'peek') {
      return this.container.getBoundingClientRect().height - this.peekHeightPx();
    }
    return this.container.getBoundingClientRect().height;
  }
}
