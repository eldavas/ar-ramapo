import { arStatusStore, phaseToGuidanceVariant, type ArStatusState } from './store/arStatusStore.js';
import { PhoneGuidanceIllustration } from './ui/PhoneGuidanceIllustration.js';

/**
 * Live in-AR guidance illustration (AR_SYSTEM.md §G onboarding UX entry).
 * Purely additive: a small, non-blocking sibling of UxOverlay — never a
 * wrapper or a modification of it. Renders ONLY the shared
 * PhoneGuidanceIllustration; hint TEXT keeps flowing through the existing
 * `overlay.showHint()`/`hideHint()` exactly as before this change, so there
 * is no duplicated text-rendering path. Positioned just above UxOverlay's
 * hint strip (UxOverlay.ts's own hint sits at `bottom:48px`).
 *
 * Subscribes to arStatusStore, which main.ts writes to only from real
 * existing signals (ImageEventHintGate, TrackingLossHint, the pre-existing
 * POSE_COACHING_DELAY_MS timer, and whenStable()'s reveal) — this class
 * itself starts no timers and invents no new signal.
 */
export class GuidanceOverlay {
  private readonly container: HTMLDivElement;
  private readonly illustration: PhoneGuidanceIllustration;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly store = arStatusStore) {
    this.container = document.createElement('div');
    // Large and roughly mid-screen — a live camera overlay reads very
    // differently from the onboarding icon (small, on a white page): it
    // needs to be prominent over a busy camera feed, per the supplied
    // reference. Sits above UxOverlay's hint strip (UxOverlay.ts's own
    // hint is anchored to bottom:48px) so the two never overlap.
    this.container.style.cssText =
      'position:fixed;left:50%;top:38%;transform:translate(-50%,-50%);z-index:30;' +
      'pointer-events:none;display:flex;align-items:center;justify-content:center;color:#fff;';
    this.illustration = new PhoneGuidanceIllustration('large');
    this.illustration.mount(this.container);
  }

  mount(): void {
    document.body.appendChild(this.container);
    this.illustration.setVariant(phaseToGuidanceVariant(this.store.getState().phase));
    this.unsubscribe = this.store.subscribe((state: ArStatusState) => {
      this.illustration.setVariant(phaseToGuidanceVariant(state.phase));
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.illustration.dispose();
    this.container.remove();
  }
}
