/**
 * Verifies the onboarding step-transition table (AR_SYSTEM.md §G onboarding
 * UX entry). Pure logic — no zustand store, no DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextOnboardingStep } from './onboardingStore.js';

test('intro advances to locate', () => {
  assert.equal(nextOnboardingStep('intro'), 'locate');
});

test('locate advances to stabilize', () => {
  assert.equal(nextOnboardingStep('locate'), 'stabilize');
});

test('stabilize clamps at stabilize — the last step never advances past itself', () => {
  assert.equal(nextOnboardingStep('stabilize'), 'stabilize');
});
