import type { ImageEventKind } from './EightWallSession.js';

/**
 * Gates the image-target `'loading'`/`'scanning'` → coaching-hint mapping
 * so it only ever drives UX before the experience's first stable reveal.
 *
 * AR_SYSTEM.md §G "Cold-start stabilization" (2026-08-18) landed a
 * one-shot `'Loading…'` overlay gated on `AnchorSource.whenStable()`; this
 * closes the follow-up gap flagged the same day: `EightWallSession
 * .onImageEvent`'s `'loading'`/`'scanning'` listener is registered once
 * and stays live for the rest of the session. Without this gate, a later
 * `'scanning'` event (e.g. the plaque is briefly lost and the engine
 * resumes searching) would re-show the "point your camera at the plaque"
 * hint over an ALREADY-REVEALED scene — the hint UI had no memory of "we
 * already got past this once."
 *
 * This class IS that memory. `markRevealed()` is one-way — once called,
 * every subsequent `handle()` is an inert no-op, permanently. It never
 * resets, never re-arms, and never touches the scene/anchor itself:
 * marker visibility and tracking-loss behavior after reveal are owned
 * entirely by the existing, unmodified `HotspotProjector`/`MarkerLayer`
 * hysteresis — this gate only ever suppresses a coaching HINT, nothing
 * about tracking or rendering.
 */
export class ImageEventHintGate {
  private revealed = false;

  constructor(private readonly showHint: (text: string) => void) {}

  /** Call once, exactly when the scene is first revealed. Idempotent. */
  markRevealed(): void {
    this.revealed = true;
  }

  /** Wire directly as an EightWallSession.onImageEvent handler. */
  handle(kind: ImageEventKind): void {
    if (this.revealed) return;
    if (kind === 'loading') this.showHint('Loading image target…');
    if (kind === 'scanning') this.showHint("Point your camera at the plaque — get close, it's small.");
  }
}
