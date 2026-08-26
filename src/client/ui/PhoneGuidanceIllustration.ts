import { animate } from 'framer-motion/dom';
import type { AnimationPlaybackControls } from 'framer-motion/dom';

/**
 * Shared vector guidance illustration (AR_SYSTEM.md §G onboarding UX entry).
 * Thin line-art (color from `currentColor`, so each host controls it — see
 * below), in the spirit of Apple's object-capture guidance screens: a phone
 * glyph carried along a left-to-right arc (a quadratic bezier, sampled into
 * x/y/rotate keyframes so the phone's tilt follows the arc's tangent —
 * climbing, leveling at the apex, descending — instead of oscillating in
 * place), leaving a fading trail behind it (a native CSS `@keyframes`
 * animation on `stroke-dashoffset` — see the embedded `<style>` in
 * buildSvgMarkup() for why this is plain CSS and not framer-motion's
 * `animate()` — colored by a gradient that fades toward the trailing/older
 * end). The
 * phone's transform and the show/hide opacity crossfade use framer-motion's
 * DOM-only `animate()` (framer-motion/dom — no React in the import graph).
 *
 * Mounted from two places: OnboardingFlow.ts (small, steps "find"/"lock")
 * and GuidanceOverlay.ts (large, live during the AR session, driven by
 * arStatusStore's real tracking signals) — one component, two call sites,
 * by design (DRY: the physical instruction is identical whether it's
 * onboarding or a live re-acquisition).
 *
 * `setVariant(null)` hides it; passing a variant shows/crossfades it. Honors
 * prefers-reduced-motion via the embedded stylesheet's own media query (the
 * trail) and a JS gate on `startMotion()` (the phone, framer-motion) —
 * under reduced motion the SVG renders static: phone resting at the arc's
 * start, no trail. Only the show/hide opacity crossfade (a small,
 * non-parallax transition) still runs either way.
 */
export type GuidanceVariant = 'orbit' | 'voronoi';
export type GuidanceSize = 'small' | 'large';

const FADE_MS = 200;
const ARC_DURATION_S = 2.6;

// Quadratic bezier P0=(20,100) P1=(100,20) P2=(180,100) sampled at
// t=[0,0.2,0.4,0.5,0.6,0.8,1] — a symmetric left-to-right dome. Rotation is
// the arc's own tangent angle at each sample (atan2(dy/dt, dx/dt)), so the
// phone visually climbs, levels at the apex, and descends, carried by the
// path rather than spinning in place.
const ARC_X = [20, 52, 84, 100, 116, 148, 180];
const ARC_Y = [100, 74.4, 61.6, 60, 61.6, 74.4, 100];
const ARC_ROTATE = [-45, -31, -11, 0, 11, 31, 45];

const VIEWBOX_W = 200;
const VIEWBOX_H = 140;
const SIZE_PX: Record<GuidanceSize, { width: number; height: number }> = {
  small: { width: 130, height: 91 },
  large: { width: 280, height: 196 },
};

// Real length of the trail path's `d` below (`M 20 100 Q 100 20 180 100`),
// measured once via SVGPathElement.getTotalLength() and hardcoded — the
// path never changes at runtime, so there is nothing to gain from
// re-measuring it in JS on every mount. Re-measure and update this constant
// if ARC path geometry above ever changes. Rounded up slightly so the
// dasharray never leaves a 1px gap at the fully-drawn end.
const TRAIL_LENGTH = 184;

// currentColor throughout — each host sets its own `color` (OnboardingFlow:
// dark, on its white background; GuidanceOverlay: white, over the live
// camera feed) rather than this component hardcoding one. `stop-color:
// currentColor` is supported the same way `stroke`/`fill` are.
//
// The trail's draw-on animation is plain CSS (`@keyframes`), not
// framer-motion: verified empirically (headless-Chrome capture,
// `element.getAnimations()` + inline-style inspection) that passing an
// arbitrary property like `strokeDashoffset` to framer-motion/dom's vanilla
// `animate()` creates no native Animation and never advances past the first
// frame — framer-motion's transform properties (x/y/rotate, used for the
// phone below) and `opacity` do work reliably through the same call, so
// this is scoped narrowly to the one property that didn't. A hand-rolled
// `requestAnimationFrame` loop was tried next and also proved unreliable in
// an unfocused/backgrounded browser tab (Chrome throttles rAF delivery
// there); a native CSS animation is driven by the browser's own animation
// engine rather than app JS ticks, sidestepping both issues.
// Two instances of this component are mounted at once (OnboardingFlow +
// GuidanceOverlay), each with its own `color` (dark vs. white — see the
// class doc comment). SVG `id`s must be document-unique: with a shared
// literal id, `url(#trailFade)` in EITHER instance resolves to whichever
// <linearGradient> is first in the DOM, and its <stop stop-color=
// "currentColor"> stops resolve against THAT gradient's own ancestor
// `color` — so both trails would silently render in the SAME (wrong, for
// one of them) color regardless of which instance's SVG they're actually
// painting into. Confirmed by direct observation: with a shared id, forcing
// a fully-drawn trail with the real gradient (bypassing the dash animation
// entirely) still rendered nothing on the white onboarding background,
// while an ad hoc solid-color stroke on the exact same path rendered fine —
// isolating the bug to the id collision, not the animation or geometry.
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
  <style>
    [data-part="trail"] {
      stroke-dasharray: ${TRAIL_LENGTH};
      stroke-dashoffset: ${TRAIL_LENGTH};
      animation: ar-guidance-trail-draw ${ARC_DURATION_S}s cubic-bezier(0.65, 0, 0.35, 1) infinite;
    }
    @keyframes ar-guidance-trail-draw {
      to { stroke-dashoffset: 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      [data-part="trail"] { animation: none; stroke-dashoffset: ${TRAIL_LENGTH}; }
    }
  </style>

  <path data-part="trail" d="M 20 100 Q 100 20 180 100" stroke="url(#${gradientId})" stroke-width="3.5" stroke-linecap="round" />

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
  private phoneAnimation: AnimationPlaybackControls | null = null;

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
    const { width, height } = SIZE_PX[size];
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    this.phone = phone;
    this.trail = trail;
    this.targetOrbit = targetOrbit;
    this.targetVoronoi = targetVoronoi;
    // Rest position: arc start, matches ARC_X[0]/ARC_Y[0] — avoids a jump
    // on the first frame of the first animate() call.
    this.phone.style.transform = `translate(${ARC_X[0]}px, ${ARC_Y[0]}px) rotate(${ARC_ROTATE[0]}deg)`;
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.container);
  }

  /** Sets which guidance to show; null hides it. No-ops if unchanged (no flicker by construction). */
  setVariant(variant: GuidanceVariant | null): void {
    if (variant === this.variant) return;
    const wasVisible = this.variant !== null;
    this.variant = variant;

    this.phoneAnimation?.stop();
    this.phoneAnimation = null;
    this.targetOrbit.setAttribute('opacity', variant === 'orbit' ? '1' : '0');
    this.targetVoronoi.setAttribute('opacity', variant === 'voronoi' ? '1' : '0');

    if (variant === null) {
      if (wasVisible) animate(this.container, { opacity: 0 }, { duration: FADE_MS / 1000 });
      return;
    }

    if (!this.reducedMotion) this.startMotion();
    if (!wasVisible) animate(this.container, { opacity: 1 }, { duration: FADE_MS / 1000 });
  }

  dispose(): void {
    this.phoneAnimation?.stop();
    this.container.remove();
  }

  private startMotion(): void {
    // Both variants share the identical arc/trail motion — only which
    // target glyph is visible differs (toggled in setVariant above). The
    // physical gesture ("carry the phone left to right along an arc") is
    // the same instruction either way; DRY, not a coincidence. The trail
    // itself is the always-on CSS animation embedded in SVG_MARKUP (see
    // that constant's own doc comment) — restarted here (the classic
    // "toggle animation off, force reflow, toggle it back on" trick) so it
    // stays in phase with the phone's own animate() call restarting below,
    // instead of resuming mid-cycle from whenever it was last hidden.
    this.trail.style.animation = 'none';
    this.trail.getBoundingClientRect(); // forces the reflow the restart trick depends on
    this.trail.style.animation = '';
    this.phoneAnimation = animate(
      this.phone,
      { x: ARC_X, y: ARC_Y, rotate: ARC_ROTATE },
      { duration: ARC_DURATION_S, repeat: Infinity, repeatType: 'loop', ease: 'easeInOut' }
    );
  }
}

