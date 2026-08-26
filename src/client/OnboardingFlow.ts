import { animate } from 'framer-motion/dom';
import { onboardingStore, type OnboardingState, type OnboardingStep } from './store/onboardingStore.js';
import { PhoneGuidanceIllustration, type GuidanceVariant } from './ui/PhoneGuidanceIllustration.js';

/**
 * Full-screen pre-AR onboarding (AR_SYSTEM.md §G onboarding UX entry).
 * Deliberately its own module, not folded into UxOverlay.ts: UxOverlay's
 * shape (one message + one button + one hint strip, dark blocking panel)
 * is a good fit for short blocking/coaching text over the live camera, but
 * not for three illustrated steps with their own stepper/transitions —
 * forcing it in would violate UxOverlay's own single responsibility. Same
 * layering convention (fixed, inset:0, above the AR canvas) but a separate
 * class; z-index 31, one above UxOverlay's 30, so it can never be hidden
 * behind a lingering geofence panel if one is still up when onboarding
 * starts. White background (no camera feed exists yet at this point in the
 * flow), matching the supplied reference design for object-capture-style
 * guidance screens.
 *
 * Three steps, each a short human-language instruction plus (for the
 * tracking-relevant steps) the shared PhoneGuidanceIllustration — the same
 * component GuidanceOverlay.ts reuses live during the AR session, just
 * mounted at its "small" size here. The last step's CTA is the actual
 * Start-AR gesture: `show()`'s `onComplete` callback is invoked
 * synchronously from that button's own click handler (no await/microtask
 * boundary before it), so main.ts's `session.start()` call stays inside a
 * real user gesture — required for iOS's motion-permission prompt exactly
 * as it was before this change. The "Finish" link (present on every step,
 * matching the reference) skips any remaining steps and invokes the same
 * `onComplete` immediately. The "Help" corner button restarts the flow via
 * `onboardingStore.reset()` — it does not call `onComplete`.
 */
interface StepContent {
  readonly heading: string;
  readonly body: string;
  readonly ctaLabel: string;
  readonly illustration: GuidanceVariant | null;
}

const STEPS: Record<OnboardingStep, StepContent> = {
  find: {
    heading: 'Find a target',
    body: 'Point your camera at one of the 4 image references on the model.',
    ctaLabel: 'Continue',
    illustration: 'orbit',
  },
  lock: {
    heading: 'Lock it in',
    body: 'Move your phone slowly toward the pattern to help it lock on.',
    ctaLabel: 'Continue',
    illustration: 'voronoi',
  },
  ready: {
    heading: 'Ready when you are',
    body: 'Tap Start AR to begin.',
    ctaLabel: 'Start AR',
    illustration: null,
  },
};

const STEP_ORDER: readonly OnboardingStep[] = ['find', 'lock', 'ready'];
const STEP_TRANSITION_S = 0.22;

export class OnboardingFlow {
  private readonly container: HTMLDivElement;
  private readonly stepEl: HTMLDivElement;
  private readonly heading: HTMLHeadingElement;
  private readonly body: HTMLParagraphElement;
  private readonly stepperDots: HTMLDivElement[];
  private readonly cta: HTMLButtonElement;
  private readonly finishButton: HTMLButtonElement;
  private readonly illustration: PhoneGuidanceIllustration;
  private readonly illustrationSlot: HTMLDivElement;
  private unsubscribe: (() => void) | null = null;
  private onComplete: (() => void) | null = null;

  constructor(private readonly store = onboardingStore) {
    this.container = document.createElement('div');
    this.container.style.cssText =
      'position:fixed;inset:0;z-index:31;display:flex;flex-direction:column;' +
      'background:#fff;color:#000;' +
      'padding:calc(env(safe-area-inset-top,0px) + 16px) 24px calc(env(safe-area-inset-bottom,0px) + 32px);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

    const helpButton = document.createElement('button');
    helpButton.textContent = 'Help';
    helpButton.style.cssText =
      'position:absolute;top:calc(env(safe-area-inset-top,0px) + 16px);right:24px;' +
      'background:none;border:none;color:#1764e4;font-size:16px;font-weight:600;' +
      'cursor:pointer;touch-action:manipulation;padding:4px;';
    helpButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.store.getState().reset();
    });
    this.container.appendChild(helpButton);

    // Vertically centers the icon/stepper/heading/body as one group in the
    // space above the button block — matches the reference's composition
    // (content sits in the upper/middle area, buttons pinned near the
    // bottom, not immediately following the text).
    const content = document.createElement('div');
    content.style.cssText = 'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:0;';

    this.stepEl = document.createElement('div');
    this.stepEl.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:20px;max-width:26em;text-align:center;';

    this.illustrationSlot = document.createElement('div');
    this.illustrationSlot.style.cssText = 'display:flex;align-items:center;justify-content:center;min-height:0;';
    this.illustration = new PhoneGuidanceIllustration('small');
    this.illustration.mount(this.illustrationSlot);

    const stepper = document.createElement('div');
    stepper.style.cssText = 'display:flex;align-items:center;gap:10px;';
    this.stepperDots = STEP_ORDER.map((_, index) => {
      const dot = document.createElement('div');
      dot.textContent = String(index + 1);
      dot.style.cssText =
        'width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;' +
        'font-size:13px;font-weight:700;transition:background-color 150ms,color 150ms,border-color 150ms;';
      stepper.appendChild(dot);
      return dot;
    });

    this.heading = document.createElement('h1');
    this.heading.style.cssText = 'font:700 24px/1.3 -apple-system,BlinkMacSystemFont,sans-serif;margin:0;';

    this.body = document.createElement('p');
    this.body.style.cssText = 'font:400 16px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;margin:0;color:#3c3c43;';

    this.stepEl.append(this.illustrationSlot, stepper, this.heading, this.body);
    content.appendChild(this.stepEl);
    this.container.appendChild(content);

    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:16px;';

    this.cta = document.createElement('button');
    this.cta.style.cssText =
      'width:100%;max-width:26em;font-size:17px;font-weight:700;padding:16px 28px;border-radius:999px;' +
      'border:none;background:#1764e4;color:#fff;cursor:pointer;touch-action:manipulation;';
    this.cta.addEventListener('click', (event) => {
      event.stopPropagation();
      this.handleCtaTap();
    });

    this.finishButton = document.createElement('button');
    this.finishButton.textContent = 'Finish';
    this.finishButton.style.cssText =
      'background:none;border:none;color:#1764e4;font-size:16px;font-weight:600;' +
      'cursor:pointer;touch-action:manipulation;padding:4px;';
    this.finishButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.finishNow();
    });

    buttons.append(this.cta, this.finishButton);
    this.container.appendChild(buttons);
  }

  /** Mounts the flow and resolves control to onComplete once finished (last step's CTA, or "Finish"). */
  show(onComplete: () => void): void {
    this.onComplete = onComplete;
    document.body.appendChild(this.container);
    this.render(this.store.getState().step, false);
    this.unsubscribe = this.store.subscribe((state: OnboardingState) => this.render(state.step, true));
  }

  private handleCtaTap(): void {
    const { step } = this.store.getState();
    if (step === 'ready') {
      this.finishNow();
      return;
    }
    this.store.getState().advance();
  }

  /** Shared by the last step's CTA and the "Finish" link — see class doc comment. */
  private finishNow(): void {
    // This IS the Start-AR gesture. Synchronous, no await/microtask before
    // onComplete() — see class doc comment.
    const onComplete = this.onComplete;
    this.dispose();
    onComplete?.();
  }

  private render(step: OnboardingStep, animated: boolean): void {
    const content = STEPS[step];
    const stepIndex = STEP_ORDER.indexOf(step);
    const apply = (): void => {
      this.heading.textContent = content.heading;
      this.body.textContent = content.body;
      this.cta.textContent = content.ctaLabel;
      this.illustration.setVariant(content.illustration);
      this.illustrationSlot.style.display = content.illustration ? 'flex' : 'none';
      this.stepperDots.forEach((dot, index) => {
        const isCurrent = index === stepIndex;
        dot.style.background = isCurrent ? '#000' : 'transparent';
        dot.style.color = isCurrent ? '#fff' : '#9a9a9a';
        dot.style.border = isCurrent ? 'none' : '1.5px solid #d0d0d0';
      });
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
