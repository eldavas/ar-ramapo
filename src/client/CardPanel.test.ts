/**
 * Verifies the Card's drag-release snap-point resolver (AR_SYSTEM.md §G
 * onboarding UX entry — the peek/open bottom sheet). Pure logic, no DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSnapPoint } from './CardPanel.js';

const SHEET_HEIGHT = 520; // px, arbitrary — only the fraction/velocity thresholds matter

test('from open: a small downward drag snaps back to open', () => {
  assert.equal(resolveSnapPoint('open', 20, 0.05, SHEET_HEIGHT), 'open');
});

test('from open: dragging past the close fraction commits down to peek', () => {
  assert.equal(resolveSnapPoint('open', SHEET_HEIGHT * 0.3, 0.05, SHEET_HEIGHT), 'peek');
});

test('from open: a fast flick below the distance threshold still commits down to peek', () => {
  assert.equal(resolveSnapPoint('open', 20, 0.8, SHEET_HEIGHT), 'peek');
});

test('from open: dragging upward (already fully open) stays open', () => {
  assert.equal(resolveSnapPoint('open', -40, 0.05, SHEET_HEIGHT), 'open');
});

test('from peek: any confirmed upward drag expands to open', () => {
  assert.equal(resolveSnapPoint('peek', -1, 0, SHEET_HEIGHT), 'open');
  assert.equal(resolveSnapPoint('peek', -80, 0.4, SHEET_HEIGHT), 'open');
});

test('from peek: a small downward drag snaps back to peek', () => {
  assert.equal(resolveSnapPoint('peek', 20, 0.05, SHEET_HEIGHT), 'peek');
});

test('from peek: dragging past the close fraction commits to closed', () => {
  assert.equal(resolveSnapPoint('peek', SHEET_HEIGHT * 0.3, 0.05, SHEET_HEIGHT), 'closed');
});

test('from peek: a fast downward flick commits to closed even under the distance threshold', () => {
  assert.equal(resolveSnapPoint('peek', 20, 0.8, SHEET_HEIGHT), 'closed');
});
