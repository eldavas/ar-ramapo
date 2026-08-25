import { animate } from 'framer-motion/dom';
import type { AnimationPlaybackControls } from 'framer-motion/dom';

/**
 * Shared vector guidance illustration (AR_SYSTEM.md §G onboarding UX entry).
 * Thin white line-art, Apple-Measure-style: a phone glyph plus a target
 * ring, animated with framer-motion's DOM-only `animate()` (framer-motion/dom
 * — no React in the import graph, matching this codebase's plain-TS/DOM
 * style). Mounted from two places: OnboardingFlow.ts (steps "locate" and
 * "stabilize") and GuidanceOverlay.ts (live during the AR session, driven by
 * arStatusStore's real tracking signals) — one component, two call sites, by
 * design (DRY: the physical instruction — "point at / slowly move toward a
 * target" — is identical whether it's first acquisition or reacquisition).
 *
 * `setVariant(null)` hides it; passing a variant shows/crossfades it. Honors
 * prefers-reduced-motion: the looping phone motion is skipped entirely (the
 * SVG renders static) when the user's OS setting requests it — only the
 * show/hide opacity crossfade (a small, non-parallax transition) still runs.
 */
export type GuidanceVariant = 'search' | 'stabilize';

const FADE_MS = 200;

const SVG_MARKUP = `
<svg viewBox="0 0 120 140" width="96" height="112" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g data-part="target">
    <circle cx="60" cy="104" r="20" stroke="#fff" stroke-width="2" stroke-dasharray="4 5" opacity="0.6" />
    <path d="M60 88v6M60 114v6M44 104h6M70 104h6" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity="0.6" />
  </g>
  <g data-part="phone">
    <rect x="40" y="8" width="40" height="72" rx="10" stroke="#fff" stroke-width="3" />
    <circle cx="60" cy="20" r="2" fill="#fff" />
    <line x1="52" y1="70" x2="68" y2="70" stroke="#fff" stroke-width="3" stroke-linecap="round" />
  </g>
</svg>
`.trim();

export class PhoneGuidanceIllustration {
  private readonly container: HTMLDivElement;
  private readonly phone: SVGGElement;
  private readonly target: SVGGElement;
  private readonly reducedMotion: boolean;
  private variant: GuidanceVariant | null = null;
  private phoneAnimation: AnimationPlaybackControls | null = null;
  private targetAnimation: AnimationPlaybackControls | null = null;

  constructor() {
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.container = document.createElement('div');
    this.container.style.cssText = 'opacity:0;pointer-events:none;transition:none;display:flex;';
    this.container.innerHTML = SVG_MARKUP;

    const phone = this.container.querySelector<SVGGElement>('[data-part="phone"]');
    const target = this.container.querySelector<SVGGElement>('[data-part="target"]');
    if (!phone || !target) {
      // Loud, not silent (§C): a markup edit that drops one of these groups
      // must fail immediately, not render a mysteriously inert illustration.
      throw new Error('PhoneGuidanceIllustration: expected SVG markup to contain [data-part="phone"/"target"].');
    }
    this.phone = phone;
    this.target = target;
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
    this.targetAnimation?.stop();
    this.phoneAnimation = null;
    this.targetAnimation = null;
    this.phone.style.transform = '';
    this.target.style.transform = '';
    this.target.style.opacity = '';

    if (variant === null) {
      if (wasVisible) animate(this.container, { opacity: 0 }, { duration: FADE_MS / 1000 });
      return;
    }

    if (!this.reducedMotion) this.startMotion(variant);
    if (!wasVisible) animate(this.container, { opacity: 1 }, { duration: FADE_MS / 1000 });
  }

  dispose(): void {
    this.phoneAnimation?.stop();
    this.targetAnimation?.stop();
    this.container.remove();
  }

  private startMotion(variant: GuidanceVariant): void {
    if (variant === 'search') {
      // Sweeping side-to-side, as if scanning the room for a target — the
      // target ring pulses gently to read as "the thing being looked for."
      this.phoneAnimation = animate(
        this.phone,
        { rotate: [-10, 10, -10], x: [-8, 8, -8] },
        { duration: 2.4, repeat: Infinity, ease: 'easeInOut' }
      );
      this.targetAnimation = animate(
        this.target,
        { scale: [1, 1.06, 1], opacity: [0.4, 0.85, 0.4] },
        { duration: 1.8, repeat: Infinity, ease: 'easeInOut' }
      );
    } else {
      // A small, slow arc/tilt — "keep moving gently while it locks on."
      // The target stays steady (already found, just converging).
      this.phoneAnimation = animate(
        this.phone,
        { rotate: [-5, 5, -5], y: [0, -5, 0] },
        { duration: 2.6, repeat: Infinity, ease: 'easeInOut' }
      );
      this.targetAnimation = animate(this.target, { opacity: [0.7, 1, 0.7] }, { duration: 2.6, repeat: Infinity, ease: 'easeInOut' });
    }
  }
}
