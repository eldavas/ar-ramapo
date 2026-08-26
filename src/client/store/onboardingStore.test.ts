/**
 * Verifies the onboarding step-transition table (AR_SYSTEM.md §G onboarding
 * UX entry). Pure logic — no zustand store, no DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextOnboardingStep, previousOnboardingStep, onboardingStore } from './onboardingStore.js';

test('find advances to lock', () => {
  assert.equal(nextOnboardingStep('find'), 'lock');
});

test('lock advances to ready', () => {
  assert.equal(nextOnboardingStep('lock'), 'ready');
});

test('ready clamps at ready — the last step never advances past itself', () => {
  assert.equal(nextOnboardingStep('ready'), 'ready');
});

test('lock goes back to find', () => {
  assert.equal(previousOnboardingStep('lock'), 'find');
});

test('ready goes back to lock', () => {
  assert.equal(previousOnboardingStep('ready'), 'lock');
});

test('find clamps at find — the first step never goes back past itself', () => {
  assert.equal(previousOnboardingStep('find'), 'find');
});

test('reset() returns to the first step from anywhere in the flow', () => {
  onboardingStore.setState({ step: 'ready' });
  onboardingStore.getState().reset();
  assert.equal(onboardingStore.getState().step, 'find');
});
