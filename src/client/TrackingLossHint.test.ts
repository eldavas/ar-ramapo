/**
 * Verifies TrackingLossHint's debounced show/hide contract (AR_SYSTEM.md §G
 * "Cold-start stabilization" follow-up, 2026-08-19). Pure logic, no DOM —
 * the class takes plain callbacks instead of a real UxOverlay.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackingLossHint } from './TrackingLossHint.js';

function makeHint(thresholdMs = 2000): { hint: TrackingLossHint; shown: string[]; hiddenCount: number[] } {
  const shown: string[] = [];
  const hiddenCount = [0];
  const hint = new TrackingLossHint(
    (text) => shown.push(text),
    () => {
      hiddenCount[0] += 1;
    },
    thresholdMs
  );
  return { hint, shown, hiddenCount };
}

test('a brief tracking blip under the threshold never shows the hint', () => {
  const { hint, shown } = makeHint(2000);
  hint.tick(false, 500);
  hint.tick(false, 500);
  hint.tick(true, 16); // recovers before the threshold
  assert.deepEqual(shown, []);
});

test('sustained loss past the threshold shows the hint exactly once', () => {
  const { hint, shown } = makeHint(2000);
  hint.tick(false, 1000);
  hint.tick(false, 1000); // crosses the 2000ms threshold on this tick
  hint.tick(false, 500); // still lost — must not show it again
  hint.tick(false, 500);
  assert.deepEqual(shown, ['Lost track of the plaque — point your camera back at it to re-lock the model.']);
});

test('recovering tracking hides the hint and resets the timer for next time', () => {
  const { hint, shown, hiddenCount } = makeHint(2000);
  hint.tick(false, 2500); // shows
  assert.equal(shown.length, 1);
  hint.tick(true, 16); // recovers
  assert.equal(hiddenCount[0], 1, 'hideHint() must fire exactly once on recovery');

  // A second, independent sustained loss must be able to show it again —
  // this is not a one-shot latch (unlike ImageEventHintGate's reveal gate,
  // a different contract for a different purpose: tracking can legitimately
  // come and go many times over one session).
  hint.tick(false, 2500);
  assert.equal(shown.length, 2);
});

test('recovering before the threshold does not spuriously call hideHint()', () => {
  const { hint, hiddenCount } = makeHint(2000);
  hint.tick(false, 500);
  hint.tick(true, 16); // never shown, so recovery must not call hideHint()
  assert.equal(hiddenCount[0], 0);
});
