import { BrowserPositionSource, haversineMeters, type PositionFix } from './GeoFenceService.js';
import type { UxOverlay } from './UxOverlay.js';

/**
 * ?recordgeo=1 — dev/setup mode for a new installation site. Stand at the
 * 3D-printed model, let it average GPS fixes for up to 30 s, and copy the
 * resulting `geo:` literal into the experience manifest. Short-circuits
 * main() before manifest resolution: recording a location needs no
 * experience at all.
 *
 * Averaging: accuracy-weighted mean (weight 1/accuracy²) over raw lat/lng
 * degrees — numerically fine at campus scale; would need wrap handling at
 * the ±180° meridian, which Mahwah NJ is comfortably far from. Fixes worse
 * than MAX_ACCEPTED_ACCURACY_METERS are discarded (indoor/cold-start GPS
 * would otherwise drag the mean tens of meters).
 */
const MAX_ACCEPTED_ACCURACY_METERS = 50;
const RECORDING_DURATION_MS = 30_000;

export async function runRecordGeoMode(overlay: UxOverlay): Promise<void> {
  // Geolocation permission needs a user gesture on iOS — same rule the
  // main flow's "Find the bench" button follows.
  await new Promise<void>((resolve) => {
    overlay.showPanel(
      'GEO RECORDING MODE (dev)\nStand at the model and hold still.\nRecords for 30 s (or stop early).',
      'Start recording',
      resolve
    );
  });

  const source = new BrowserPositionSource();
  let weightSum = 0;
  let weightedLatSum = 0;
  let weightedLngSum = 0;
  let accepted = 0;
  let rejected = 0;
  let lastAccuracy = Number.NaN;
  let spreadMeters = 0;
  let stopped = false;

  const meanLat = (): number => weightedLatSum / weightSum;
  const meanLng = (): number => weightedLngSum / weightSum;

  const finish = (): void => {
    if (stopped) return;
    stopped = true;
    source.stop();
    window.clearTimeout(timerId);

    if (accepted === 0) {
      overlay.showPanel(
        'No usable fixes recorded.\nEvery fix had accuracy worse than ' +
          `${MAX_ACCEPTED_ACCURACY_METERS} m — move to open sky and reload to retry.`
      );
      return;
    }

    const literal =
      `geo: {\n` +
      `  latitude: ${meanLat().toFixed(7)},\n` +
      `  longitude: ${meanLng().toFixed(7)},\n` +
      `  radiusMeters: 30,\n` +
      `},`;
    const summary =
      `Recorded ${accepted} fixes (${rejected} rejected)\n` +
      `spread ${spreadMeters.toFixed(1)} m\n\n${literal}\n\n` +
      'Paste into packages/experience-manifest/manifest.ts';

    overlay.showPanel(summary, 'Copy to clipboard', () => {
      navigator.clipboard.writeText(literal).then(
        () => overlay.showPanel(`Copied!\n\n${literal}`),
        () => overlay.showPanel(`Clipboard blocked — copy manually:\n\n${literal}`)
      );
    });
  };

  const timerId = window.setTimeout(finish, RECORDING_DURATION_MS);
  const startedAt = performance.now();

  const onFix = (fix: PositionFix): void => {
    if (stopped) return;
    lastAccuracy = fix.accuracyMeters;
    if (fix.accuracyMeters > MAX_ACCEPTED_ACCURACY_METERS) {
      rejected += 1;
    } else {
      const weight = 1 / (fix.accuracyMeters * fix.accuracyMeters);
      weightSum += weight;
      weightedLatSum += weight * fix.latitude;
      weightedLngSum += weight * fix.longitude;
      accepted += 1;
      spreadMeters = Math.max(
        spreadMeters,
        haversineMeters(fix.latitude, fix.longitude, meanLat(), meanLng())
      );
    }

    const remaining = Math.max(
      0,
      Math.ceil((RECORDING_DURATION_MS - (performance.now() - startedAt)) / 1000)
    );
    const position =
      accepted > 0
        ? `lat ${meanLat().toFixed(7)}  lng ${meanLng().toFixed(7)}\nspread ${spreadMeters.toFixed(1)} m`
        : 'waiting for a usable fix…';
    overlay.showPanel(
      `Recording… ${accepted} fixes (${rejected} rejected > ${MAX_ACCEPTED_ACCURACY_METERS} m)\n` +
        `${position}\nlast accuracy ±${Math.round(lastAccuracy)} m · ${remaining}s remaining`,
      'Stop & copy',
      finish
    );
  };

  source.start(onFix, (reason) => {
    if (stopped) return;
    stopped = true;
    window.clearTimeout(timerId);
    overlay.showPanel(`Location unavailable: ${reason}\nEnable location services and reload.`);
  });
}
