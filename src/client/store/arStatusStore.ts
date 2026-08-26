import { createStore } from 'zustand/vanilla';

/**
 * Derived AR session/guidance status — written ONLY from main.ts's existing
 * callback call sites (ImageEventHintGate's hint callback, TrackingLossHint's
 * show/hide callbacks, the pre-existing POSE_COACHING_DELAY_MS timer, and the
 * whenStable()/reveal moment). Those classes stay exactly as
 * framework-agnostic as they are today — this store is a thin mirror of
 * signals that already exist, never a new source of truth for tracking
 * itself. Read by GuidanceOverlay.ts only. See AR_SYSTEM.md §G for the full
 * rationale and signal-to-phase mapping.
 */
export type ArPhase = 'idle' | 'starting' | 'loading-target' | 'searching' | 'stabilizing' | 'stable';

/**
 * The two shared guidance illustration variants (ui/PhoneGuidanceIllustration.ts):
 * 'orbit' — phone arcing around a generic target, for "find one of the 4
 * image references"; 'voronoi' — phone arcing toward the abstract tracking
 * pattern, for "move slowly to lock on." Same two variants OnboardingFlow's
 * "find"/"lock" steps use — one shared visual language, onboarding and live.
 */
export type GuidanceVariant = 'orbit' | 'voronoi';

/**
 * Pure phase -> illustration mapping, unit-testable in isolation. 'idle' /
 * 'starting' / 'loading-target' / 'stable' show no illustration: 'idle' and
 * 'starting' precede any tracking signal worth illustrating, 'loading-target'
 * is a brief, non-actionable engine state (ImageEventHintGate's own
 * doc comment), and 'stable' is the already-converged, "don't compete with
 * the revealed scene" state.
 */
export function phaseToGuidanceVariant(phase: ArPhase): GuidanceVariant | null {
  switch (phase) {
    case 'searching':
      return 'orbit';
    case 'stabilizing':
      return 'voronoi';
    default:
      return null;
  }
}

export interface ArStatusState {
  phase: ArPhase;
  hintText: string;
  setPhase(phase: ArPhase, hintText?: string): void;
}

export const arStatusStore = createStore<ArStatusState>((set) => ({
  phase: 'idle',
  hintText: '',
  setPhase: (phase, hintText = ''): void => set({ phase, hintText }),
}));
