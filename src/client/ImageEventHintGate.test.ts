/**
 * Verifies ImageEventHintGate's one-way reveal contract (AR_SYSTEM.md §G
 * "Cold-start stabilization" follow-up, 2026-08-18): the 'scanning'/
 * 'loading' coaching hint must be able to drive UX before the first stable
 * reveal, and must be permanently inert after it — never re-entering, never
 * resetting. Pure logic, no DOM — the class takes a plain callback instead
 * of a real UxOverlay.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImageEventHintGate } from './ImageEventHintGate.js';

test('1. scanning/loading before reveal can update the loading hint', () => {
  const hints: string[] = [];
  const gate = new ImageEventHintGate((text) => hints.push(text));

  gate.handle('scanning');
  gate.handle('loading');
  gate.handle('scanning');

  assert.deepEqual(hints, [
    'Point your camera at the plaque.',
    'Loading image target…',
    'Point your camera at the plaque.',
  ]);
});

test('2. markRevealed() is one-way — calling it more than once does not misbehave or re-arm', () => {
  const hints: string[] = [];
  const gate = new ImageEventHintGate((text) => hints.push(text));

  gate.markRevealed();
  gate.markRevealed(); // idempotent — must not throw or flip back
  gate.handle('scanning');

  assert.deepEqual(hints, []);
});

test('3. scanning/loading after reveal cannot bring back the initial loading hint', () => {
  const hints: string[] = [];
  const gate = new ImageEventHintGate((text) => hints.push(text));

  gate.handle('scanning'); // before reveal: allowed, asserted above already
  gate.markRevealed();
  gate.handle('scanning'); // after reveal: must be a no-op
  gate.handle('loading'); // after reveal: must be a no-op

  assert.deepEqual(hints, ['Point your camera at the plaque.']);
});

test('found/updated/lost kinds never drive this hint, before or after reveal (this gate only ever acts on scanning/loading)', () => {
  const hints: string[] = [];
  const gate = new ImageEventHintGate((text) => hints.push(text));

  gate.handle('found');
  gate.handle('updated');
  gate.handle('lost');
  gate.markRevealed();
  gate.handle('found');
  gate.handle('updated');
  gate.handle('lost');

  assert.deepEqual(hints, []);
});
