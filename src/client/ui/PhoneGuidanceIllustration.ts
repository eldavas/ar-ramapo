import { animate } from 'framer-motion/dom';
import type { AnimationPlaybackControls } from 'framer-motion/dom';

/**
 * Shared vector guidance illustration (AR_SYSTEM.md §G onboarding UX entry).
 * Thin line-art (color from `currentColor`, so each host controls it — see
 * below), in the spirit of Apple's object-capture guidance screens: a phone
 * glyph carried along a left-to-right arc, leaving a fading trail exactly
 * behind it, never ahead.
 *
 * The arc/trail motion is driven by ONE small `requestAnimationFrame` loop
 * computing a single eased progress value `t` per frame and deriving BOTH
 * the phone's position/rotation (analytic quadratic-bezier point + tangent
 * — a continuous formula, not discrete sampled keyframes) AND the trail's
 * `stroke-dashoffset` (from a precomputed arc-length-vs-t table) from that
 * SAME `t` in the SAME tick. This is a deliberate choice, not a fallback:
 * two independently-timed animations (framer-motion's keyframe `animate()`
 * for the phone, a separate CSS `@keyframes` for the trail — both tried
 * first) cannot GUARANTEE the trail never leads the phone; they can only
 * approximate it if both curves happen to line up. A single shared `t`
 * guarantees it by construction. It also sidesteps a real bug hit along
 * the way: framer-motion's default equal-time spacing across an uneven,
 * hand-sampled keyframe array (needed for the bezier's denser mid-arc
 * region) produced a visible stutter — an analytic per-frame formula has
 * no discrete keyframes to mis-space in the first place.
 *
 * The phone's transform and the trail's dash both use direct
 * `element.style` writes for this reason; framer-motion's DOM-only
 * `animate()` (framer-motion/dom — no React in the import graph) is kept
 * for what it's genuinely good at here: the simple show/hide opacity
 * crossfade below, and OnboardingFlow.ts's step-to-step transitions.
 *
 * Mounted from two places: OnboardingFlow.ts (small, steps "find"/"lock")
 * and GuidanceOverlay.ts (large, live during the AR session, driven by
 * arStatusStore's real tracking signals) — one component, two call sites,
 * by design (DRY: the physical instruction is identical whether it's
 * onboarding or a live re-acquisition).
 *
 * `setVariant(null)` hides it; passing a variant shows/crossfades it. Honors
 * prefers-reduced-motion: the loop never starts (the SVG renders static,
 * phone resting at the arc's start, no trail) when the user's OS setting
 * requests it. Only the show/hide opacity crossfade (a small, non-parallax
 * transition) still runs either way.
 */
export type GuidanceVariant = 'orbit' | 'voronoi';
export type GuidanceSize = 'small' | 'large';

const FADE_MS = 200;
const ARC_DURATION_S = 2.6;

// Quadratic bezier: P0 (arc start) -> P1 (control, the apex) -> P2 (arc end).
const P0 = { x: 20, y: 100 };
const P1 = { x: 100, y: 20 };
const P2 = { x: 180, y: 100 };

function bezierPoint(t: number): { x: number; y: number } {
  const mt = 1 - t;
  return {
    x: mt * mt * P0.x + 2 * mt * t * P1.x + t * t * P2.x,
    y: mt * mt * P0.y + 2 * mt * t * P1.y + t * t * P2.y,
  };
}

/** Tangent angle in degrees — the phone's natural "carried by the path" tilt. */
function bezierTangentDeg(t: number): number {
  const dx = 2 * (1 - t) * (P1.x - P0.x) + 2 * t * (P2.x - P1.x);
  const dy = 2 * (1 - t) * (P1.y - P0.y) + 2 * t * (P2.y - P1.y);
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

// Cumulative arc length vs. t, sampled finely once at module load — lets
// the trail's stroke-dashoffset track the phone's REAL position along the
// curve (length units), not just its t parameter (which is not
// proportional to on-screen distance for a bezier).
const LENGTH_SAMPLES = 64;
const CUMULATIVE_LENGTH: number[] = [0];
{
  let prev = bezierPoint(0);
  for (let i = 1; i <= LENGTH_SAMPLES; i++) {
    const point = bezierPoint(i / LENGTH_SAMPLES);
    CUMULATIVE_LENGTH.push(CUMULATIVE_LENGTH[i - 1] + Math.hypot(point.x - prev.x, point.y - prev.y));
    prev = point;
  }
}
const TRAIL_LENGTH = CUMULATIVE_LENGTH[LENGTH_SAMPLES];

function lengthAtT(t: number): number {
  const index = Math.min(t, 1) * LENGTH_SAMPLES;
  const i0 = Math.floor(index);
  const i1 = Math.min(i0 + 1, LENGTH_SAMPLES);
  const frac = index - i0;
  return CUMULATIVE_LENGTH[i0] + (CUMULATIVE_LENGTH[i1] - CUMULATIVE_LENGTH[i0]) * frac;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Nominal (unscaled) render size per context — GuidanceOverlay ("large",
// live over the camera feed) needs to read clearly over a busy background;
// OnboardingFlow ("small") sits on an otherwise-empty white step. Capped
// responsively via CSS max-width (see mount()) so neither ever overflows a
// narrow phone viewport regardless of these nominal numbers.
const VIEWBOX_W = 200;
const VIEWBOX_H = 140;
const SIZE_PX: Record<GuidanceSize, { width: number; height: number; maxWidthVw: number }> = {
  small: { width: 260, height: 182, maxWidthVw: 78 },
  large: { width: 460, height: 322, maxWidthVw: 88 },
};

/**
 * The exact CSS box a mounted instance will occupy at the given size —
 * for a host (OnboardingFlow) that needs to reserve matching layout space
 * even while the illustration itself is hidden (`setVariant(null)`), so
 * showing/hiding it never changes surrounding layout height. Single
 * source of truth with the SVG's own sizing above, not a duplicated guess.
 */
export function guidanceSlotStyle(size: GuidanceSize): string {
  const { width, maxWidthVw } = SIZE_PX[size];
  return `width:min(${maxWidthVw}vw, ${width}px);aspect-ratio:${VIEWBOX_W} / ${VIEWBOX_H};`;
}

// Two instances of this component are mounted at once (OnboardingFlow +
// GuidanceOverlay), each with its own `color` (dark vs. white — see the
// class doc comment). SVG `id`s must be document-unique: with a shared
// literal id, `url(#trailFade)` in EITHER instance resolves to whichever
// <linearGradient> is first in the DOM, and its <stop stop-color=
// "currentColor"> stops resolve against THAT gradient's own ancestor
// `color` — so both trails would silently render in the SAME (wrong, for
// one of them) color regardless of which instance's SVG they're actually
// painting into. Confirmed by direct observation during development: with
// a shared id, forcing a fully-drawn trail with the real gradient
// (bypassing the dash logic entirely) still rendered nothing on the white
// onboarding background, while an ad hoc solid-color stroke on the exact
// same path rendered fine — isolating the bug to the id collision.
let nextInstanceId = 0;

function buildSvgMarkup(gradientId: string): string {
  return `
<svg viewBox="0 0 ${VIEWBOX_W} ${VIEWBOX_H}" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="${gradientId}" x1="20" y1="0" x2="180" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="currentColor" stop-opacity="0.12" />
      <stop offset="1" stop-color="currentColor" stop-opacity="0.95" />
    </linearGradient>
  </defs>

  <path data-part="trail" d="M 20 100 Q 100 20 180 100" stroke="url(#${gradientId})" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="${TRAIL_LENGTH}" stroke-dashoffset="${TRAIL_LENGTH}" />

  <g data-part="target-orbit" opacity="0" stroke="currentColor">
    <polygon points="100,105 111,110 111,122 100,127 89,122 89,110" stroke-width="2" stroke-linejoin="round" />
    <polyline points="89,110 100,116 111,110" stroke-width="2" stroke-linejoin="round" />
    <line x1="100" y1="116" x2="100" y2="127" stroke-width="2" />
  </g>

  <g data-part="target-voronoi" opacity="0" stroke="currentColor">
    <rect x="166" y="88" width="24" height="24" rx="3" stroke-width="2" />
    <path d="M166 94 L178 88 M166 102 L190 96 M172 112 L180 100 M188 92 L180 100 M182 112 L188 104" stroke-width="1.4" stroke-linecap="round" />
  </g>

  <g data-part="phone" stroke="currentColor">
    <rect x="-10" y="-18" width="20" height="36" rx="5" stroke-width="3" />
    <circle cx="0" cy="-12" r="1.6" fill="currentColor" stroke="none" />
    <line x1="-6" y1="10" x2="6" y2="10" stroke-width="3" stroke-linecap="round" />
  </g>
</svg>
`.trim();
}

export class PhoneGuidanceIllustration {
  private readonly container: HTMLDivElement;
  private readonly phone: SVGGElement;
  private readonly trail: SVGPathElement;
  private readonly targetOrbit: SVGGElement;
  private readonly targetVoronoi: SVGGElement;
  private readonly reducedMotion: boolean;
  private variant: GuidanceVariant | null = null;
  private rafId: number | null = null;
  private fadeAnimation: AnimationPlaybackControls | null = null;

  constructor(size: GuidanceSize = 'small') {
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.container = document.createElement('div');
    this.container.style.cssText = 'opacity:0;pointer-events:none;display:flex;';
    this.container.innerHTML = buildSvgMarkup(`ar-guidance-trail-fade-${nextInstanceId++}`);

    const svg = this.container.querySelector('svg');
    const phone = this.container.querySelector<SVGGElement>('[data-part="phone"]');
    const trail = this.container.querySelector<SVGPathElement>('[data-part="trail"]');
    const targetOrbit = this.container.querySelector<SVGGElement>('[data-part="target-orbit"]');
    const targetVoronoi = this.container.querySelector<SVGGElement>('[data-part="target-voronoi"]');
    if (!svg || !phone || !trail || !targetOrbit || !targetVoronoi) {
      // Loud, not silent (§C): a markup edit that drops one of these parts
      // must fail immediately, not render a mysteriously incomplete illustration.
      throw new Error('PhoneGuidanceIllustration: expected SVG markup to contain phone/trail/target parts.');
    }
    const { width, height, maxWidthVw } = SIZE_PX[size];
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.style.cssText = `max-width:${maxWidthVw}vw;height:auto;`;
    this.phone = phone;
    this.trail = trail;
    this.targetOrbit = targetOrbit;
    this.targetVoronoi = targetVoronoi;
    this.setProgress(0); // rest position: arc start, matches the loop's t=0 frame
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.container);
  }

  /** Sets which guidance to show; null hides it. No-ops if unchanged (no flicker by construction). */
  setVariant(variant: GuidanceVariant | null): void {
    if (variant === this.variant) return;
    const wasVisible = this.variant !== null;
    this.variant = variant;

    this.stopMotion();
    this.targetOrbit.setAttribute('opacity', variant === 'orbit' ? '1' : '0');
    this.targetVoronoi.setAttribute('opacity', variant === 'voronoi' ? '1' : '0');

    this.fadeAnimation?.stop();
    if (variant === null) {
      if (wasVisible) this.fadeAnimation = animate(this.container, { opacity: 0 }, { duration: FADE_MS / 1000 });
      return;
    }

    if (!this.reducedMotion) this.startMotion();
    if (!wasVisible) this.fadeAnimation = animate(this.container, { opacity: 1 }, { duration: FADE_MS / 1000 });
  }

  dispose(): void {
    this.stopMotion();
    this.fadeAnimation?.stop();
    this.container.remove();
  }

  private startMotion(): void {
    // Both variants share the identical arc/trail motion — only which
    // target glyph is visible differs (toggled in setVariant above). The
    // physical gesture ("carry the phone left to right along an arc") is
    // the same instruction either way; DRY, not a coincidence.
    const durationMs = ARC_DURATION_S * 1000;
    const start = performance.now();
    const tick = (now: number): void => {
      const raw = ((now - start) % durationMs) / durationMs;
      this.setProgress(easeInOutCubic(raw));
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopMotion(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /** Single source of truth for one frame: phone position/rotation AND the trail's reveal, from the same t. */
  private setProgress(t: number): void {
    const point = bezierPoint(t);
    this.phone.style.transform = `translate(${point.x}px, ${point.y}px) rotate(${bezierTangentDeg(t)}deg)`;
    this.trail.style.strokeDashoffset = String(TRAIL_LENGTH - lengthAtT(t));
  }
}
