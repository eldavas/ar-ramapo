import { createStore } from 'zustand/vanilla';

/**
 * UI-only state for the pre-AR onboarding flow (OnboardingFlow.ts). Never
 * read by engine code (EightWallSession, AnchorSource implementations,
 * SceneGraphLoader, etc.) — those stay framework-agnostic, unchanged.
 * Deliberately separate from arStatusStore.ts (derived AR/tracking status):
 * two small, cohesive stores instead of one general-purpose one.
 */
export type OnboardingStep = 'find' | 'lock' | 'ready';

const STEP_ORDER: readonly OnboardingStep[] = ['find', 'lock', 'ready'];
const FIRST_STEP: OnboardingStep = STEP_ORDER[0];

/** Pure step-transition table — unit-testable in isolation. Clamps at the last step. */
export function nextOnboardingStep(step: OnboardingStep): OnboardingStep {
  const index = STEP_ORDER.indexOf(step);
  return STEP_ORDER[Math.min(index + 1, STEP_ORDER.length - 1)];
}

export interface OnboardingState {
  step: OnboardingStep;
  advance(): void;
  /** The corner "Help" affordance — restarts the flow from the first step. */
  reset(): void;
}

export const onboardingStore = createStore<OnboardingState>((set) => ({
  step: FIRST_STEP,
  advance: (): void => set((state) => ({ step: nextOnboardingStep(state.step) })),
  reset: (): void => set({ step: FIRST_STEP }),
}));
