/**
 * One Euro filter (Casiez, Roussel & Vogel, CHI 2012) — an adaptive
 * low-pass filter for noisy interactive signals. Its defining property:
 * the cutoff frequency rises with the signal's speed, so it smooths
 * aggressively while the value is near-still (killing high-frequency
 * tracking tremor) yet follows almost lag-free during fast movement.
 *
 * Used here in SCREEN SPACE only (HotspotOverlay card positions). The 3D
 * pose itself stays on MindAR's responsive tracking profile — smoothing
 * the pose was what made the whole scene visibly lag behind the physical
 * model (see TRACKING_PROFILE_RIGID_ANCHOR in ARSessionManager.ts), so
 * jitter absorption belongs at the last 2D stage, not in the tracker.
 */
export class OneEuroFilter1D {
  private prevValue: number | null = null;
  private prevDerivative = 0;

  constructor(
    /** Cutoff (Hz) at zero speed — governs steadiness at rest. */
    private readonly minCutoffHz: number,
    /** How fast the cutoff rises with speed — governs lag during motion. */
    private readonly beta: number,
    /** Cutoff (Hz) for the internal derivative estimate. */
    private readonly derivativeCutoffHz: number
  ) {}

  /** Forget all history; the next filter() call snaps to its input. */
  reset(): void {
    this.prevValue = null;
    this.prevDerivative = 0;
  }

  filter(value: number, dtSeconds: number): number {
    if (this.prevValue === null) {
      this.prevValue = value;
      this.prevDerivative = 0;
      return value;
    }
    if (dtSeconds <= 0) {
      return this.prevValue;
    }

    const derivative = (value - this.prevValue) / dtSeconds;
    const smoothedDerivative = lowpass(
      derivative,
      this.prevDerivative,
      smoothingAlpha(this.derivativeCutoffHz, dtSeconds)
    );
    const cutoffHz = this.minCutoffHz + this.beta * Math.abs(smoothedDerivative);
    const smoothedValue = lowpass(value, this.prevValue, smoothingAlpha(cutoffHz, dtSeconds));

    this.prevDerivative = smoothedDerivative;
    this.prevValue = smoothedValue;
    return smoothedValue;
  }
}

function smoothingAlpha(cutoffHz: number, dtSeconds: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSeconds);
}

function lowpass(value: number, previous: number, alpha: number): number {
  return alpha * value + (1 - alpha) * previous;
}
