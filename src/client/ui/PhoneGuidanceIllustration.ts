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
 *   then farther" hint): the phone PULSES in place — scaling up ("closer")
 *   then back down ("farther") — with a halo ring around it breathing in
 *   sync, instead of any lateral travel.
 *
 * CORRECTED (2026-09-01): `'voronoi'` previously nudged the phone right
 * then left (a lateral, in-plane motion) while the accompanying hint text
 * has always said "move your phone slightly closer, then farther" (a
 * depth motion, toward/away from the plaque) — a genuine mismatch between
 * what the animation showed and what the text asked for, found by reading
 * this file against `main.ts`'s coaching-hint string and
 * `OnboardingFlow.ts`'s `lock` step body, not by inference. Checking this
 * project's own history (AR_SYSTEM.md's 2026-08-25/2026-08-26 onboarding
 * entries) shows this was never actually solved: the FIRST `'voronoi'`
 * design ("phone arcing TOWARD a small abstract cell-pattern glyph") also
 * didn't depict depth motion and was replaced by the lateral nudge
 * specifically because arcing didn't read as "closer, then farther"
 * either — the nudge was a different wrong depiction, not a fix. A 2D
 * line illustration cannot show true depth travel, but a size pulse
 * (bigger = closer, smaller = farther) is the standard, widely-understood
 * substitute — the same convention a camera-focus "breathing" ring uses —
 * so that's what this pass builds: the phone's own scale and a
 * halo ring's scale/opacity both breathe from the SAME `raw` progress
 * value, never a lateral offset.
 *
 * Both motions are driven by ONE small `requestAnimationFrame` loop
 * computing a single linear progress value per frame (`raw`, 0..1 through
 * the current cycle) and deriving EVERY visual element (phone
 * position/rotation/scale, and either the trail's `stroke-dashoffset` or
 * the halo ring's scale/opacity) from that SAME value in the SAME tick —
 * analytic formulas, not discrete sampled keyframes. `'orbit'` eases `raw`
 * internally before using it (a one-shot journey, where an eased start/end
 * reads correctly); `'voronoi'` uses it directly — a plain sine already
 * eases itself at its own extrema (zero rate of change right at the
 * smallest/largest point), which is exactly the "breathing" feel a pulse
 * wants, and avoids the specific bug a stacked ease caused for the
 * previous lateral-nudge design (see the 2026-08-26 git history if ever
 * resurrecting lateral motion: composing `easeInOutCubic` as `sin()`'s own
 * argument produced a front-loaded/back-loaded asymmetry). This is a
 * deliberate choice, not a fallback: two independently-timed animations
 * (framer-motion's keyframe `animate()` for the phone, a separate CSS
 * `@keyframes` for the trail — both tried first, for the orbit variant)
 * cannot GUARANTEE a trailing element never leads the phone; they can only
 * approximate it if both curves happen to line up. A single shared `t`
 * guarantees it by construction. It also sidesteps a real bug hit along
 * the way: framer-motion's default equal-time spacing across an uneven,
 * hand-sampled keyframe array produced a visible stutter — an analytic
 * per-frame formula has no discrete keyframes to mis-space in the first
 * place.
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
 * phone at its variant's rest position, no trail/ring) when the user's
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

// ---- 'voronoi' motion: a "closer, then farther" breathing pulse -----------
//
// 2026-09-01 rewrite (see the class doc comment for the full mismatch this
// fixes): the phone stays at a FIXED position and only its SCALE breathes
// — bigger reads as "closer to the camera," smaller as "farther" — with a
// halo ring around it scaling/fading in the same rhythm, reinforcing the
// same read rather than adding a second, different motion to interpret.
// Driven by RAW (linear) time, not an eased t like 'orbit' uses: a plain
// sine is already "eased" at its own min/max (zero rate of change right at
// the biggest/smallest point, matching how a real breathing/pulsing motion
// actually decelerates at its extremes) and — same lesson as the
// now-removed lateral nudge's own history — stacking an extra ease on top
// of an already-periodic sine is what produced a real, reported
// front-loaded/back-loaded asymmetry bug for that design; there is no
// reason to reintroduce that risk here.
//
// Slower and subtler than 'orbit' on purpose — 8th Wall's own official
// world-tracking guidance (quoted in EightWallSession.ts) says to move
// slowly, especially while pose is converging; this variant's whole job is
// to depict that, not a broad sweeping gesture.
const VORONOI_CYCLE_DURATION_S = 3.2;
const PULSE_CENTER = { x: 82, y: 62 };
// Phone glyph scale range: 1.0 is its natural (rest) size — the pulse
// spends equal time above and below it, so "closer"/"farther" read as two
// equally-weighted directions from a neutral middle, not "grow from
// nothing" or "shrink to nothing."
const PHONE_SCALE_MIN = 0.82;
const PHONE_SCALE_MAX = 1.22;
// The halo ring pulses with a WIDER range than the phone (a halo that
// barely moved would read as static background decoration, not part of
// the same gesture) and fades out at its smallest point so it doesn't sit
// there permanently once the "farther" extreme is fully reached.
const RING_BASE_R = 26;
const RING_SCALE_MIN = 0.78;
const RING_SCALE_MAX = 1.4;
const RING_OPACITY_MIN = 0.15;
const RING_OPACITY_MAX = 0.85;

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

  <!-- In row with the phone (same y as PULSE_CENTER.y=62), to the right of
       the pulsing phone/ring — not stacked below it. -->
  <g data-part="target-voronoi" opacity="0" stroke="currentColor">
    <rect x="148" y="50" width="24" height="24" rx="3" stroke-width="2" />
    <path d="M148 56 L160 50 M148 64 L172 58 M154 72 L162 60 M170 54 L162 60 M164 72 L170 64" stroke-width="1.4" stroke-linecap="round" />
  </g>

  <!-- Halo ring: breathes in sync with the phone's own scale below (data-part
       "pulse-ring"), drawn BEFORE the phone so the phone paints on top of it. -->
  <circle data-part="pulse-ring" cx="0" cy="0" r="${RING_BASE_R}" opacity="0" stroke="currentColor" stroke-width="2" />

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
  private readonly pulseRing: SVGCircleElement;
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
    const pulseRing = this.container.querySelector<SVGCircleElement>('[data-part="pulse-ring"]');
    const targetOrbit = this.container.querySelector<SVGGElement>('[data-part="target-orbit"]');
    const targetVoronoi = this.container.querySelector<SVGGElement>('[data-part="target-voronoi"]');
    if (!svg || !phone || !trail || !pulseRing || !targetOrbit || !targetVoronoi) {
      // Loud, not silent (§C): a markup edit that drops one of these parts
      // must fail immediately, not render a mysteriously incomplete illustration.
      throw new Error('PhoneGuidanceIllustration: expected SVG markup to contain phone/trail/pulse-ring/target parts.');
    }
    const { width, height, maxWidthVw } = SIZE_PX[size];
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.style.cssText = `max-width:${maxWidthVw}vw;height:auto;`;
    this.phone = phone;
    this.trail = trail;
    this.pulseRing = pulseRing;
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
    this.pulseRing.style.display = variant === 'voronoi' ? '' : 'none';

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
   * in/out at the endpoints reads correctly); 'voronoi' uses it directly —
   * a plain sine already eases itself at its own extrema, which is exactly
   * the breathing feel a "closer, then farther" pulse wants (see the
   * constants' own doc comment above for why composing an extra ease on
   * top caused a real bug for this variant's previous, now-removed,
   * lateral-nudge design).
   */
  private setProgress(variant: GuidanceVariant, raw: number): void {
    if (variant === 'orbit') {
      const t = easeInOutCubic(raw);
      const point = bezierPoint(t);
      this.phone.style.transform = `translate(${point.x}px, ${point.y}px) rotate(${bezierTangentDeg(t)}deg)`;
      this.trail.style.strokeDashoffset = String(TRAIL_LENGTH - lengthAtT(t));
      return;
    }

    // 'voronoi': breathe in place — see the constants' own doc comment
    // above for why `raw` is used un-eased here. `pulse` is 0..1, peaking
    // at raw=0.25 ("closer") and bottoming out at raw=0.75 ("farther").
    const pulse = (Math.sin(2 * Math.PI * raw) + 1) / 2;
    const phoneScale = PHONE_SCALE_MIN + (PHONE_SCALE_MAX - PHONE_SCALE_MIN) * pulse;
    this.phone.style.transform = `translate(${PULSE_CENTER.x}px, ${PULSE_CENTER.y}px) scale(${phoneScale})`;

    const ringScale = RING_SCALE_MIN + (RING_SCALE_MAX - RING_SCALE_MIN) * pulse;
    this.pulseRing.style.transform = `translate(${PULSE_CENTER.x}px, ${PULSE_CENTER.y}px) scale(${ringScale})`;
    this.pulseRing.style.opacity = String(RING_OPACITY_MIN + (RING_OPACITY_MAX - RING_OPACITY_MIN) * pulse);
  }
}
