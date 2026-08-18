/**
 * TEMPORARY diagnostic instrumentation — added 2026-08-18 to investigate the
 * "buildings render tiny/mis-oriented and markers are absent for ~5-6s after
 * a plaque is first found, then self-correct" startup bug. NOT part of the
 * permanent architecture (AR_SYSTEM.md is silent on this module on purpose).
 *
 * STILL PRESENT after the cold-start-stabilization fix landed the same day
 * (AR_SYSTEM.md §G, Phase 6 "Progress (2026-08-18)"; docs/research/
 * 8th-wall-troubleshooting.md §19) — deliberately, not an oversight. The
 * fix (ImageTargetAnchorSource.whenStable(), the parallelized
 * loadEightWallSceneContent(), the "Starting camera…" hint) was verified
 * in software (typecheck/build/test) but NOT on a physical device — no
 * camera/AR hardware was available to run the real 8th Wall session this
 * fix changes the timing of. Remove this file and every call site
 * (`main.ts`, `EightWallSession.ts`, `ImageTargetAnchorSource.ts`,
 * `MarkerLayer.ts`) once a real on-device capture (via `?debug=1` or
 * `window.__arDiagPrintTimeline()` over Safari remote debugging) confirms
 * the reveal now happens meaningfully faster than the reported 5–6s and
 * without regressing pose/marker correctness.
 *
 * Wraps the standard Performance API (`performance.mark`) instead of ad hoc
 * `console.log` + manual arithmetic, so the timeline is also inspectable in
 * Safari's own Web Inspector Timelines/Performance panel over a real USB
 * remote-debugging session, not only via the on-screen ?debug=1 console.
 * Every mark's timestamp is relative to `performance.timeOrigin`
 * (navigation start) by construction — the same "T+Xms since page load"
 * baseline every milestone in this investigation is measured against.
 *
 * Each label is recorded once — the FIRST time it fires — because the
 * milestones under investigation ("first image found", "first trustworthy
 * pose applied") are meaningful as first-occurrence events; a bootstrap
 * pose and a later correction are deliberately two different labels rather
 * than the same label firing twice.
 */

const DIAG_PREFIX = 'ar-diag:';

export function diagMark(label: string, detail?: string): void {
  const name = `${DIAG_PREFIX}${label}`;
  if (performance.getEntriesByName(name, 'mark').length > 0) return;
  performance.mark(name);
  const line = `[DIAG T+${performance.now().toFixed(0)}ms] ${label}${detail ? ` — ${detail}` : ''}`;
  console.log(line);
}

/**
 * Prints every diagnostic mark recorded so far, in chronological order,
 * with the delta from the previous mark — the actual "line 1 → line 2 →
 * ..." timeline the investigation needs. Call this once the experience
 * looks visually settled (or from the console manually at any point).
 */
export function diagPrintTimeline(): void {
  const marks = performance
    .getEntriesByType('mark')
    .filter((entry) => entry.name.startsWith(DIAG_PREFIX))
    .sort((a, b) => a.startTime - b.startTime);
  console.log(`[DIAG] ---- timeline (${marks.length} marks) ----`);
  let previous = 0;
  for (const mark of marks) {
    const label = mark.name.slice(DIAG_PREFIX.length);
    console.log(
      `[DIAG] T+${mark.startTime.toFixed(0)}ms  (+${(mark.startTime - previous).toFixed(0)}ms)  ${label}`
    );
    previous = mark.startTime;
  }
  console.log('[DIAG] ---- end timeline ----');
}

// Expose on window so the timeline can be dumped from a real device without
// needing a code path that calls diagPrintTimeline() automatically — e.g.
// after visually confirming the scene looks stable, run
// `window.__arDiagPrintTimeline()` in a remote-debugging console, or paste
// it into the ?debug=1 on-screen console isn't possible (no input), so
// remote debugging (Safari Web Inspector over USB) is the intended capture
// path for this one.
declare global {
  interface Window {
    __arDiagPrintTimeline?: () => void;
  }
}
// Guarded: ImageTargetAnchorSource.test.ts imports this module transitively
// and runs under plain Node (node:test), which has no `window`/`performance`
// globals in this project's test harness.
if (typeof window !== 'undefined') {
  window.__arDiagPrintTimeline = diagPrintTimeline;
}
