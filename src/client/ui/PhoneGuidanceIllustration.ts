import { animate } from 'framer-motion/dom';
import type { AnimationPlaybackControls } from 'framer-motion/dom';

/**
 * Shared vector guidance illustration (AR_SYSTEM.md §G onboarding UX entry).
 * Thin line-art (color from `currentColor`, so each host controls it — see
 * below). Two variants, two different physical gestures, two different
 * motions:
 *
 * - `'orbit'` ("find a target"): the phone travels a left-to-right arc,
 *   leaving a fading trail exactly behind it, never ahead.
 * - `'voronoi'` ("lock it in" / the live "still locking on, move closer
 *   then farther" hint): a PROFILE (edge-on) phone glyph nudges right then
 *   left, in place, toward and away from the tracking-pattern glyph beside
 *   it — the same "small arrow grows in the direction of travel" mechanic
 *   `'orbit'`'s sibling used before, but drawn as if the whole scene were
 *   seen from the side, so lateral screen motion reads as the camera
 *   moving toward/away from the plaque instead of sliding past it.
 *
 * REVISION HISTORY for `'voronoi'` (kept here, not just in git log, because
 * this variant has now been rebuilt three times and the reasons matter for
 * whoever touches it next):
 * 1. Original: phone arcing TOWARD a small target glyph — didn't read as
 *    "closer, then farther" (2026-08-26 physical-device report).
 * 2. Replaced with a lateral (in-plane) right/left nudge — fixed the
 *    "didn't read as depth" complaint's SYMPTOM but not its cause: nudging
 *    sideways isn't depth motion either, it was just a different wrong
 *    depiction that happened to look smoother.
 * 3. (2026-09-01, same day, two passes) Rebuilt as a scale "breathing"
 *    pulse (phone + halo ring grow/shrink in place) — the technically
 *    correct 2D substitute for depth (bigger=closer, smaller=farther) — but
 *    a physical-device review called it ugly and asked for the lateral
 *    nudge back specifically.
 * 4. (this revision) Restores the #2 lateral nudge mechanic exactly (it
 *    was never broken — see OSC_CYCLE's own doc comment on the
 *    right/left-progress asymmetry bug that WAS fixed and stays fixed),
 *    but draws the phone as a narrow PROFILE silhouette instead of the
 *    front-facing glyph `'orbit'` uses, specifically for this variant.
 *    A phone shown edge-on nudging toward/away from the tracking-pattern
 *    glyph beside it reads as approach/retreat along a side-view depth
 *    axis, not as sliding sideways past the target — the same convention
 *    a side-view diagram uses to show "walk toward this."
 *
 * Both motions are driven by ONE small `requestAnimationFrame` loop
 * computing a single linear progress value per frame (`raw`, 0..1 through
 * the current cycle) and deriving EVERY visual element (phone
 * position/rotation, and either the trail's `stroke-dashoffset` or the two
 * arrows' growth) from that SAME value in the SAME tick — analytic
 * formulas, not discrete sampled keyframes. `'orbit'` eases `raw`
 * internally before using it (a one-shot journey, where an eased start/end
 * reads correctly); `'voronoi'` uses it directly (a plain sine already
 * eases itself at its own extrema — composing an extra ease on top of it
 * is what caused a real, reported right/left speed-asymmetry bug the first
 * time this nudge motion was built; do not reintroduce that composition).
 * This is a deliberate choice, not a fallback: two independently-timed
 * animations (framer-motion's keyframe `animate()` for the phone, a
 * separate CSS `@keyframes` for the trail — both tried first, for the
 * orbit variant) cannot GUARANTEE a trailing element never leads the
 * phone; they can only approximate it if both curves happen to line up. A
 * single shared `t` guarantees it by construction. It also sidesteps a
 * real bug hit along the way: framer-motion's default equal-time spacing
 * across an uneven, hand-sampled keyframe array produced a visible
 * stutter — an analytic per-frame formula has no discrete keyframes to
 * mis-space in the first place.
 *
 * All per-frame writes use direct `element.style` assignment for this
 * reason; framer-motion's DOM-only `animate()` (framer-motion/dom — no
 * React in the import graph) is kept for what it's genuinely good at
 * here: the simple show/hide opacity crossfade below, and
 * OnboardingFlow.ts's step-to-step transitions.
 *
 * Mounted from two places: OnboardingFlow.ts (small, steps "find"/"lock")
 * and GuidanceOverlay.ts (large, live during the AR session, driven by
 * arStatusStore's real tracking signals) — one component, two call sites,
 * by design (DRY: the physical instruction is identical whether it's
 * onboarding or a live re-acquisition).
 *
 * `setVariant(null)` hides it; passing a variant shows/crossfades it. Honors
 * prefers-reduced-motion: the loop never starts (the SVG renders static,
 * phone at its variant's rest position, no trail/arrows) when the user's
 * OS setting requests it. Only the show/hide opacity crossfade (a small,
 * non-parallax transition) still runs either way.
 */
export type GuidanceVariant = 'orbit' | 'voronoi';
export type GuidanceSize = 'small' | 'large';

const FADE_MS = 200;
const ORBIT_CYCLE_DURATION_S = 2.6;

// ---- 'orbit' motion: a left-to-right quadratic-bezier arc -----------------

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

// ---- 'voronoi' motion: nudge right, then left, in place -------------------
//
// Deliberately driven by RAW (linear) time, not an eased t like 'orbit'
// uses — a real bug, found from a physical-device report, not a style
// preference: composing an ease-in-out curve as sin()'s own input produces
// a front-loaded-slow / back-loaded-fast velocity profile (the sin peak
// lands near the END of each eased half-interval, not its middle), which
// read as "movement right is slow, but the return left is fast" — exactly
// what was reported. A plain sine of raw time is already naturally
// "eased" at its own extrema (zero velocity at the rightmost/leftmost
// points, matching normal simple-harmonic motion) with no further easing
// needed, and — critically — no asymmetry: `x(1-raw) = 2*center - x(raw)`
// holds exactly, so the right and left excursions are honest mirror
// images in both duration and shape.
//
// Slower and smaller than 'orbit' on purpose — 8th Wall's own official
// world-tracking guidance (quoted in EightWallSession.ts) says to move
// slowly, especially while pose is converging; this variant's whole job
// is to depict that, not a broad sweeping gesture.
const VORONOI_CYCLE_DURATION_S = 3.2;
const OSC_CENTER = { x: 82, y: 62 };
const OSC_AMPLITUDE_X = 18; // phone ranges OSC_CENTER.x ± this
const OSC_ROTATE_DEG = 6;
const ARROW_LENGTH = 28;
// Matches the profile phone glyph's own local half-width (rect x="-3"..."3"
// below) — the arrow now originates at the phone's CURRENT right/left
// edge (recomputed every frame as the phone moves), not its center.
const PHONE_PROFILE_HALF_WIDTH = 3;

/** +1 while nudging right (first half of the cycle), 0 the rest. */
function rightProgress(raw: number): number {
  return Math.max(0, Math.sin(2 * Math.PI * raw));
}
/** +1 while nudging left (second half of the cycle), 0 the rest. */
function leftProgress(raw: number): number {
  return Math.max(0, -Math.sin(2 * Math.PI * raw));
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

// The right/left arrow, each split into a `-shaft` (grown via scaleX,
// anchored at its own base — safe under non-uniform scale because the
// local geometry is perfectly horizontal, so only its length changes, not
// its stroke thickness) and a `-head` (fixed shape, translated to the
// shaft's current tip and opacity-faded in near full growth — an
// arrowhead's angled geometry WOULD visibly distort under scaleX, so it
// never gets scaled, only repositioned).
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

  <g data-part="arrow-right" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <line data-part="arrow-right-shaft" x1="0" y1="0" x2="${ARROW_LENGTH}" y2="0" stroke-width="3.5" />
    <polyline data-part="arrow-right-head" points="-15,-9 0,0 -15,9" stroke-width="3.5" fill="none" />
  </g>
  <g data-part="arrow-left" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <line data-part="arrow-left-shaft" x1="0" y1="0" x2="-${ARROW_LENGTH}" y2="0" stroke-width="3.5" />
    <polyline data-part="arrow-left-head" points="15,-9 0,0 15,9" stroke-width="3.5" fill="none" />
  </g>

  <g data-part="target-orbit" opacity="0" stroke="currentColor">
    <polygon points="100,105 111,110 111,122 100,127 89,122 89,110" stroke-width="2" stroke-linejoin="round" />
    <polyline points="89,110 100,116 111,110" stroke-width="2" stroke-linejoin="round" />
    <line x1="100" y1="116" x2="100" y2="127" stroke-width="2" />
  </g>

  <!-- In row with the phone/arrows (same y as OSC_CENTER.y=62), to the
       right of the oscillation+arrow zone — not stacked below it. -->
  <g data-part="target-voronoi" opacity="0" stroke="currentColor">
    <rect x="148" y="50" width="24" height="24" rx="3" stroke-width="2" />
    <path d="M148 56 L160 50 M148 64 L172 58 M154 72 L162 60 M170 54 L162 60 M164 72 L170 64" stroke-width="1.4" stroke-linecap="round" />
  </g>

  <g data-part="phone" stroke="currentColor">
    <rect x="-10" y="-18" width="20" height="36" rx="5" stroke-width="3" />
    <circle cx="0" cy="-12" r="1.6" fill="currentColor" stroke="none" />
    <line x1="-6" y1="10" x2="6" y2="10" stroke-width="3" stroke-linecap="round" />
  </g>

  <!-- Profile (edge-on) phone silhouette, used ONLY for 'voronoi' — a
       narrow rounded bar instead of the front-facing glyph above, so
       lateral nudging toward/away from target-voronoi reads as depth
       (walking toward/away from the plaque) rather than sliding sideways
       past it. -->
  <g data-part="phone-profile" stroke="currentColor" opacity="0">
    <rect x="-3" y="-18" width="6" height="36" rx="3" stroke-width="3" />
  </g>
</svg>
`.trim();
}

export class PhoneGuidanceIllustration {
  private readonly container: HTMLDivElement;
  private readonly phone: SVGGElement;
  private readonly phoneProfile: SVGGElement;
  private readonly trail: SVGPathElement;
  private readonly arrowRightGroup: SVGGElement;
  private readonly arrowRightShaft: SVGLineElement;
  private readonly arrowRightHead: SVGPolylineElement;
  private readonly arrowLeftGroup: SVGGElement;
  private readonly arrowLeftShaft: SVGLineElement;
  private readonly arrowLeftHead: SVGPolylineElement;
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
    const phoneProfile = this.container.querySelector<SVGGElement>('[data-part="phone-profile"]');
    const trail = this.container.querySelector<SVGPathElement>('[data-part="trail"]');
    const arrowRightGroup = this.container.querySelector<SVGGElement>('[data-part="arrow-right"]');
    const arrowRightShaft = this.container.querySelector<SVGLineElement>('[data-part="arrow-right-shaft"]');
    const arrowRightHead = this.container.querySelector<SVGPolylineElement>('[data-part="arrow-right-head"]');
    const arrowLeftGroup = this.container.querySelector<SVGGElement>('[data-part="arrow-left"]');
    const arrowLeftShaft = this.container.querySelector<SVGLineElement>('[data-part="arrow-left-shaft"]');
    const arrowLeftHead = this.container.querySelector<SVGPolylineElement>('[data-part="arrow-left-head"]');
    const targetOrbit = this.container.querySelector<SVGGElement>('[data-part="target-orbit"]');
    const targetVoronoi = this.container.querySelector<SVGGElement>('[data-part="target-voronoi"]');
    if (
      !svg ||
      !phone ||
      !phoneProfile ||
      !trail ||
      !arrowRightGroup ||
      !arrowRightShaft ||
      !arrowRightHead ||
      !arrowLeftGroup ||
      !arrowLeftShaft ||
      !arrowLeftHead ||
      !targetOrbit ||
      !targetVoronoi
    ) {
      // Loud, not silent (§C): a markup edit that drops one of these parts
      // must fail immediately, not render a mysteriously incomplete illustration.
      throw new Error(
        'PhoneGuidanceIllustration: expected SVG markup to contain phone/phone-profile/trail/arrow/target parts.'
      );
    }
    const { width, height, maxWidthVw } = SIZE_PX[size];
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.style.cssText = `max-width:${maxWidthVw}vw;height:auto;`;
    this.phone = phone;
    this.phoneProfile = phoneProfile;
    this.trail = trail;
    this.arrowRightGroup = arrowRightGroup;
    this.arrowRightShaft = arrowRightShaft;
    this.arrowRightHead = arrowRightHead;
    this.arrowLeftGroup = arrowLeftGroup;
    this.arrowLeftShaft = arrowLeftShaft;
    this.arrowLeftHead = arrowLeftHead;
    this.targetOrbit = targetOrbit;
    this.targetVoronoi = targetVoronoi;
    this.setProgress('orbit', 0); // rest position until a variant is chosen
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
    this.trail.style.display = variant === 'orbit' ? '' : 'none';
    const arrowsDisplay = variant === 'voronoi' ? '' : 'none';
    this.arrowRightGroup.style.display = arrowsDisplay;
    this.arrowLeftGroup.style.display = arrowsDisplay;
    // The two phone glyphs are mutually exclusive: front-facing for
    // 'orbit', profile for 'voronoi' — never both, never neither while a
    // variant is active.
    this.phone.style.display = variant === 'orbit' ? '' : 'none';
    this.phoneProfile.setAttribute('opacity', variant === 'voronoi' ? '1' : '0');
    this.phoneProfile.style.display = variant === 'voronoi' ? '' : 'none';

    this.fadeAnimation?.stop();
    if (variant === null) {
      if (wasVisible) this.fadeAnimation = animate(this.container, { opacity: 0 }, { duration: FADE_MS / 1000 });
      return;
    }

    this.setProgress(variant, 0); // reset to this variant's own rest frame before (re)starting
    if (!this.reducedMotion) this.startMotion(variant);
    if (!wasVisible) this.fadeAnimation = animate(this.container, { opacity: 1 }, { duration: FADE_MS / 1000 });
  }

  dispose(): void {
    this.stopMotion();
    this.fadeAnimation?.stop();
    this.container.remove();
  }

  private startMotion(variant: GuidanceVariant): void {
    const durationMs = (variant === 'orbit' ? ORBIT_CYCLE_DURATION_S : VORONOI_CYCLE_DURATION_S) * 1000;
    const start = performance.now();
    const tick = (now: number): void => {
      const raw = ((now - start) % durationMs) / durationMs;
      this.setProgress(variant, raw);
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

  /**
   * Single source of truth for one frame: every visual element derives
   * from this same `raw` (linear 0..1 progress through the current cycle).
   * 'orbit' eases it internally (a one-shot bezier journey, where easing
   * in/out at the endpoints reads correctly); 'voronoi' uses it directly
   * (a plain sine already eases itself at its own extrema — composing an
   * extra ease on top is what caused the right/left asymmetry bug, see
   * the constants' own doc comment above).
   */
  private setProgress(variant: GuidanceVariant, raw: number): void {
    if (variant === 'orbit') {
      const t = easeInOutCubic(raw);
      const point = bezierPoint(t);
      this.phone.style.transform = `translate(${point.x}px, ${point.y}px) rotate(${bezierTangentDeg(t)}deg)`;
      this.trail.style.strokeDashoffset = String(TRAIL_LENGTH - lengthAtT(t));
      return;
    }

    // 'voronoi': nudge right, then left, in place — see the constants'
    // own doc comment above for why `raw` is used un-eased here. Drives
    // the PROFILE phone glyph, not the front-facing one 'orbit' uses.
    const x = OSC_CENTER.x + OSC_AMPLITUDE_X * Math.sin(2 * Math.PI * raw);
    const rotate = OSC_ROTATE_DEG * Math.cos(2 * Math.PI * raw);
    this.phoneProfile.style.transform = `translate(${x}px, ${OSC_CENTER.y}px) rotate(${rotate}deg)`;

    // Arrow origin tracks the phone's CURRENT edge (its moving position ±
    // half its own width), recomputed every frame — not a fixed point —
    // per the physical-device report: the gesture the arrow illustrates
    // starts at the phone's edge, not its center.
    const right = rightProgress(raw);
    this.arrowRightGroup.style.transform = `translate(${x + PHONE_PROFILE_HALF_WIDTH}px, ${OSC_CENTER.y}px)`;
    this.arrowRightShaft.style.transform = `scaleX(${right})`;
    this.arrowRightHead.style.transform = `translate(${ARROW_LENGTH * right}px, 0)`;
    this.arrowRightHead.style.opacity = String(Math.max(0, (right - 0.5) / 0.5));

    const left = leftProgress(raw);
    this.arrowLeftGroup.style.transform = `translate(${x - PHONE_PROFILE_HALF_WIDTH}px, ${OSC_CENTER.y}px)`;
    this.arrowLeftShaft.style.transform = `scaleX(${left})`;
    this.arrowLeftHead.style.transform = `translate(${-ARROW_LENGTH * left}px, 0)`;
    this.arrowLeftHead.style.opacity = String(Math.max(0, (left - 0.5) / 0.5));
  }
}
