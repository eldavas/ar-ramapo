/**
 * AR_SYSTEM.md §G "Cold-start stabilization" follow-up (2026-08-19,
 * physical-device testing): after the scene is first revealed, isTracking()
 * can still drop to false — SLAM's own trackingStatus leaving 'NORMAL'
 * (fast motion, poor texture, the plaque leaving camera view for a while).
 * By design (ImageTargetAnchorSource's own doc comment) the anchor's pose
 * freezes at its last known-good transform and SLAM world tracking keeps
 * it valid — the model is meant to stay put, not need a re-scan. What was
 * missing: zero user-facing explanation when this happens, which reads as
 * "the model got lost" even when the architecture is working as intended.
 *
 * This class changes NO tracking or pose logic whatsoever — it only
 * surfaces the EXISTING isTracking() signal as an actionable hint,
 * reusing the existing UxOverlay.showHint()/hideHint() primitives (no new
 * UI system). Debounced so ordinary camera panning (brief, sub-second
 * dips — the same class of blip MarkerLayer's own 250ms hysteresis
 * already absorbs for markers) never triggers it; only a SUSTAINED loss
 * does, deliberately longer than that marker hysteresis so this coarser,
 * less-frequent hint doesn't fire on every marker flicker.
 */
export class TrackingLossHint {
  private lostForMs = 0;
  private hintShown = false;

  constructor(
    private readonly showHint: (text: string) => void,
    private readonly hideHint: () => void,
    private readonly sustainedLossThresholdMs: number
  ) {}

  /** Call once per frame with the current AnchorSource.isTracking() reading. */
  tick(isTracking: boolean, deltaMs: number): void {
    if (isTracking) {
      this.lostForMs = 0;
      if (this.hintShown) {
        this.hintShown = false;
        this.hideHint();
      }
      return;
    }
    this.lostForMs += deltaMs;
    if (!this.hintShown && this.lostForMs >= this.sustainedLossThresholdMs) {
      this.hintShown = true;
      this.showHint('Lost track of the plaque — point your camera back at it, up close, to re-lock the model.');
    }
  }
}
