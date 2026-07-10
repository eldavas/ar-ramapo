/**
 * Session-relative timestamp for on-device telemetry (?debug=1). The
 * on-screen console already prefixes every entry with wall-clock time, but
 * captures routinely lose that prefix (screenshots, transcription, remote
 * inspectors) — a compact in-message marker keeps the timeline
 * reconstructable from the message text alone. T0 is bundle evaluation,
 * so every module shares one clock.
 */
const T0 = performance.now();

export function traceT(): string {
  return `+${((performance.now() - T0) / 1000).toFixed(1)}s`;
}
