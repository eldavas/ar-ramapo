import { animate } from 'framer-motion/dom';
import { onboardingStore, type OnboardingState, type OnboardingStep } from './store/onboardingStore.js';
import { PhoneGuidanceIllustration, type GuidanceVariant } from './ui/PhoneGuidanceIllustration.js';

/**
 * Full-screen pre-AR onboarding (AR_SYSTEM.md §G onboarding UX entry).
 * Deliberately its own module, not folded into UxOverlay.ts: UxOverlay's
 * shape (one message + one button + one hint strip) is a good fit for
 * short blocking/coaching text, but not for three illustrated steps with
 * their own transitions — forcing it in would violate UxOverlay's own
 * single responsibility (its doc comment). Same layering convention
 * (fixed, inset:0, above the AR canvas) but a separate class; z-index 31,
 * one above UxOverlay's 30, so it can never be hidden behind a lingering
 * geofence panel if one is still up when onboarding starts.
 *
 * Three steps, each a short human-language instruction plus (for the
 * tracking-relevant steps) the shared PhoneGuidanceIllustration — the same
 * component GuidanceOverlay.ts reuses live during the AR session. The last
 * step's CTA is the actual Start-AR gesture: `show()`'s `onComplete`
 * callback is invoked synchronously from that button's own click handler
 * (no await/microtask boundary before it), so main.ts's relocated
 * `session.start()` call stays inside a real user gesture — required for
 * iOS's motion-permission prompt exactly as it was before this change.
 */
interface StepContent {
  readonly heading: string;
  readonly body: string;
  readonly ctaLabel: string;
  readonly illustration: GuidanceVariant | null;
}

const STEPS: Record<OnboardingStep, StepContent> = {
  intro: {
    heading: 'Welcome',
    body: "You're about to start an AR experience overlaid on the physical site model.",
    ctaLabel: 'Continue',
    illustration: null,
  },
  locate: {
    heading: 'Find a target',
    body: 'Point your camera at one of the 4 image references on the model.',
    ctaLabel: 'Continue',
    illustration: 'search',
  },
  stabilize: {
    heading: 'Almost there',
    body: 'Move your phone slowly to help it lock on.',
    ctaLabel: 'Start AR',
    illustration: 'stabilize',
  },
};

const STEP_TRANSITION_S = 0.22;

export class OnboardingFlow {
  private readonly container: HTMLDivElement;
  private readonly stepEl: HTMLDivElement;
  private readonly heading: HTMLHeadingElement;
  private readonly body: HTMLParagraphElement;
  private readonly cta: HTMLButtonElement;
  private readonly illustration: PhoneGuidanceIllustration;
  private readonly illustrationSlot: HTMLDivElement;
  private unsubscribe: (() => void) | null = null;
  private onComplete: (() => void) | null = null;

  constructor(private readonly store = onboardingStore) {
    this.container = document.createElement('div');
    this.container.style.cssText =
      'position:fixed;inset:0;z-index:31;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:flex-end;gap:24px;padding:calc(env(safe-area-inset-top,0px) + 24px) 24px ' +
      'calc(env(safe-area-inset-bottom,0px) + 32px);text-align:center;' +
      'background:linear-gradient(to bottom, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 30%, rgba(0,0,0,0) 60%, rgba(0,0,0,0.85) 100%);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fff;';

    this.stepEl = document.createElement('div');
    this.stepEl.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:16px;max-width:26em;';

    this.illustrationSlot = document.createElement('div');
    this.illustrationSlot.style.cssText = 'display:flex;align-items:center;justify-content:center;min-height:112px;';
    this.illustration = new PhoneGuidanceIllustration();
    this.illustration.mount(this.illustrationSlot);

    this.heading = document.createElement('h1');
    this.heading.style.cssText = "font:700 22px/1.3 -apple-system,BlinkMacSystemFont,sans-serif;margin:0;";

    this.body = document.createElement('p');
    this.body.style.cssText = 'font:400 16px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;margin:0;opacity:0.9;';

    this.stepEl.append(this.illustrationSlot, this.heading, this.body);

    this.cta = document.createElement('button');
    this.cta.style.cssText =
      'width:100%;max-width:26em;font-size:17px;font-weight:700;padding:16px 28px;border-radius:999px;' +
      'border:none;background:#1764e4;color:#fff;cursor:pointer;touch-action:manipulation;';
    this.cta.addEventListener('click', (event) => {
      event.stopPropagation();
      this.handleCtaTap();
    });

    this.container.append(this.stepEl, this.cta);
  }

  /** Mounts the flow and resolves control to onComplete once the final step's CTA is tapped. */
  show(onComplete: () => void): void {
    this.onComplete = onComplete;
    document.body.appendChild(this.container);
    this.render(this.store.getState().step, false);
    this.unsubscribe = this.store.subscribe((state: OnboardingState) => this.render(state.step, true));
  }

  private handleCtaTap(): void {
    const { step, advance } = this.store.getState();
    if (step === 'stabilize') {
      // Final step: this IS the Start-AR gesture. Synchronous, no
      // await/microtask before onComplete() — see class doc comment.
      const onComplete = this.onComplete;
      this.dispose();
      onComplete?.();
      return;
    }
    advance();
  }

  private render(step: OnboardingStep, animated: boolean): void {
    const content = STEPS[step];
    const apply = (): void => {
      this.heading.textContent = content.heading;
      this.body.textContent = content.body;
      this.cta.textContent = content.ctaLabel;
      this.illustration.setVariant(content.illustration);
    };
    if (!animated) {
      apply();
      return;
    }
    // Small crossfade + rise between steps — a microinteraction, not a
    // scene transition; no layout thrash since heading/body/CTA keep their
    // box sizes (max-width is fixed, text just re-flows).
    animate(this.stepEl, { opacity: [1, 0] }, { duration: STEP_TRANSITION_S / 2, ease: 'easeIn' }).then(() => {
      apply();
      void animate(this.stepEl, { opacity: [0, 1], y: [8, 0] }, { duration: STEP_TRANSITION_S, ease: 'easeOut' });
    });
  }

  private dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.illustration.dispose();
    this.container.remove();
  }
}
