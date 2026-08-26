import { animate } from 'framer-motion/dom';
import { onboardingStore, type OnboardingState, type OnboardingStep } from './store/onboardingStore.js';
import { PhoneGuidanceIllustration, guidanceSlotStyle, type GuidanceVariant } from './ui/PhoneGuidanceIllustration.js';

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
 * `onComplete` immediately.
 *
 * "Back" (top-left, hidden on the first step) steps back one via
 * `onboardingStore.back()` — plain in-flow navigation, not the corner
 * "Help" affordance (that one lives only in the live-AR screen, wired in
 * main.ts via `UxOverlay.showCornerButton`, and re-opens this class in
 * `replay: true` mode — see `show()`'s doc comment).
 */
interface StepContent {
  readonly heading: string;
  readonly body: string;
  readonly illustration: GuidanceVariant | null;
}

const STEPS: Record<OnboardingStep, StepContent> = {
  find: {
    heading: 'Find a target',
    body: 'Point your camera at one of the 4 image references on the model.',
    illustration: 'orbit',
  },
  lock: {
    heading: 'Lock it in',
    // Matches the live in-AR "still locking on" hint wording exactly
    // (main.ts's POSE_COACHING_DELAY_MS text) — same illustration variant,
    // same instruction, same words.
    body: 'Move your phone slightly closer, then farther, to help it lock on.',
    illustration: 'voronoi',
  },
  ready: {
    heading: 'Ready when you are',
    body: "Tap Start AR to begin. You'll be asked to allow camera access — tap Allow to continue.",
    illustration: null,
  },
};

const STEP_ORDER: readonly OnboardingStep[] = ['find', 'lock', 'ready'];
const STEP_TRANSITION_S = 0.22;
const READY_CTA_LABEL = 'Start AR';
const READY_CTA_LABEL_REPLAY = 'Got it';

export class OnboardingFlow {
  private readonly container: HTMLDivElement;
  private readonly backButton: HTMLButtonElement;
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
  private isReplay = false;

  constructor(private readonly store = onboardingStore) {
    this.container = document.createElement('div');
    this.container.style.cssText =
      'position:fixed;inset:0;z-index:31;display:flex;flex-direction:column;' +
      'background:#fff;color:#000;' +
      'padding:calc(env(safe-area-inset-top,0px) + 16px) 24px calc(env(safe-area-inset-bottom,0px) + 32px);' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

    this.backButton = document.createElement('button');
    this.backButton.textContent = 'Back';
    this.backButton.style.cssText =
      'position:absolute;top:calc(env(safe-area-inset-top,0px) + 16px);left:24px;' +
      'background:none;border:none;color:#1764e4;font-size:16px;font-weight:600;' +
      'cursor:pointer;touch-action:manipulation;padding:4px;';
    this.backButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.store.getState().back();
    });
    this.container.appendChild(this.backButton);

    // Vertically centers the icon/stepper/heading/body as one group in the
    // space above the button block — matches the reference's composition
    // (content sits in the upper/middle area, buttons pinned near the
    // bottom, not immediately following the text).
    const content = document.createElement('div');
    content.style.cssText = 'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:0;';

    this.stepEl = document.createElement('div');
    this.stepEl.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:20px;max-width:26em;text-align:center;';

    // Fixed footprint (matches PhoneGuidanceIllustration's own "small" box
    // exactly, via the shared guidanceSlotStyle helper) regardless of
    // whether a step shows an illustration — the "ready" step has none,
    // and without this the content block's total height would change when
    // the icon disappears, causing everything below it to jump. Physical-
    // device report: this jump also visibly caught the illustration's own
    // fade mid-transition ("se queda pasmada").
    this.illustrationSlot = document.createElement('div');
    this.illustrationSlot.style.cssText = `display:flex;align-items:center;justify-content:center;${guidanceSlotStyle('small')}`;
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

  /**
   * Mounts the flow and resolves control to onComplete once finished (last
   * step's CTA, or "Finish"). `replay: true` is how main.ts's live-AR
   * "Help" corner button re-opens this flow without re-triggering the
   * Start-AR gesture: the last step's CTA reads "Got it" instead of
   * "Start AR" (the AR session is already running — there is nothing left
   * to start), and `onComplete` is expected to be a plain dismiss, not
   * `session.start()`. `onboardingStore` is a module-level singleton, so
   * the caller is responsible for calling `onboardingStore.getState()
   * .reset()` before a replay `show()` if it should start over from step 1
   * rather than resuming wherever the flow last left off.
   */
  show(onComplete: () => void, options?: { replay?: boolean }): void {
    this.onComplete = onComplete;
    this.isReplay = options?.replay ?? false;
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
    // Outside replay mode, this IS the Start-AR gesture. Synchronous, no
    // await/microtask before onComplete() — see class doc comment.
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
      this.cta.textContent = step === 'ready' ? (this.isReplay ? READY_CTA_LABEL_REPLAY : READY_CTA_LABEL) : 'Continue';
      this.backButton.style.visibility = step === 'find' ? 'hidden' : 'visible';
      this.illustration.setVariant(content.illustration);
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
    // scene transition; no layout thrash since heading/body/CTA/illustration
    // slot all keep their box sizes (the illustration slot's footprint is
    // fixed regardless of content — see its own comment above — and
    // max-width is fixed on the text, which just re-flows).
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
