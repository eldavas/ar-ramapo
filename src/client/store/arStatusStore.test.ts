/**
 * Verifies the AR-phase -> guidance-illustration mapping (AR_SYSTEM.md §G
 * onboarding UX entry). Pure logic — no zustand store, no DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phaseToGuidanceVariant } from './arStatusStore.js';

test('searching shows the orbit illustration', () => {
  assert.equal(phaseToGuidanceVariant('searching'), 'orbit');
});

test('stabilizing shows the voronoi illustration', () => {
  assert.equal(phaseToGuidanceVariant('stabilizing'), 'voronoi');
});

test('idle, starting, loading-target, and stable show no illustration', () => {
  assert.equal(phaseToGuidanceVariant('idle'), null);
  assert.equal(phaseToGuidanceVariant('starting'), null);
  assert.equal(phaseToGuidanceVariant('loading-target'), null);
  assert.equal(phaseToGuidanceVariant('stable'), null);
});
