import type { GeoFenceSpec } from '../../packages/experience-manifest/manifest.js';

export type GeoState =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'locating' }
  | { kind: 'outside'; distanceMeters: number; accuracyMeters: number }
  | { kind: 'inside'; distanceMeters: number; accuracyMeters: number };

export type GeoStateHandler = (state: GeoState) => void;

export interface PositionFix {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
}

/**
 * A source of position fixes. The default wraps
 * navigator.geolocation.watchPosition; tests and the ?fakegeo=1 desk-mode
 * bypass inject their own.
 */
export interface PositionSource {
  start(onFix: (fix: PositionFix) => void, onError: (reason: string) => void): void;
  stop(): void;
}

export class BrowserPositionSource implements PositionSource {
  private watchId: number | null = null;

  start(onFix: (fix: PositionFix) => void, onError: (reason: string) => void): void {
    if (!('geolocation' in navigator)) {
      onError('Geolocation is not available in this browser.');
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (position) => {
        onFix({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy,
        });
      },
      (error) => {
        onError(error.message);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 2_000,
        timeout: 30_000,
      }
    );
  }

  stop(): void {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }
}

/**
 * Reports the fence-center position once, immediately — the desk-testing
 * bypass (?fakegeo=1). A real PositionSource keeps streaming fixes; one
 * fix is enough here because the fence state can never change.
 */
export class FakePositionSource implements PositionSource {
  constructor(private readonly fence: GeoFenceSpec) {}

  start(onFix: (fix: PositionFix) => void): void {
    onFix({
      latitude: this.fence.latitude,
      longitude: this.fence.longitude,
      accuracyMeters: 5,
    });
  }

  stop(): void {
    // Nothing to tear down — the single fix was delivered synchronously.
  }
}

/** Great-circle distance in meters (haversine). Pure — unit-testable. */
export function haversineMeters(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number
): number {
  const EARTH_RADIUS_METERS = 6_371_000;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const sinHalfLat = Math.sin(dLat / 2);
  const sinHalfLng = Math.sin(dLng / 2);
  const h =
    sinHalfLat * sinHalfLat +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * sinHalfLng * sinHalfLng;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * GPS arrival gate for a single experience. Emits GeoState transitions to
 * its handlers; the UX state machine in main.ts renders them.
 *
 * Hysteresis: enter at distance ≤ radius, but exit only at
 * distance > radius + max(accuracy, 10 m). Without the asymmetric exit
 * threshold, 10–30 m GPS noise makes the gate flap open/closed while the
 * user stands exactly at the fence edge.
 *
 * The fence is a *gate*, never a positioning source — the AR origin comes
 * from tap-placement/SLAM, not from any coordinate here.
 */
export class GeoFenceService {
  private readonly handlers: GeoStateHandler[] = [];
  private state: GeoState = { kind: 'locating' };
  private readonly source: PositionSource;

  constructor(
    private readonly fence: GeoFenceSpec,
    positionSource?: PositionSource
  ) {
    this.source = positionSource ?? new BrowserPositionSource();
  }

  start(): void {
    this.emit({ kind: 'locating' });
    this.source.start(
      (fix) => this.onFix(fix),
      (reason) => this.emit({ kind: 'unavailable', reason })
    );
  }

  onChange(handler: GeoStateHandler): void {
    this.handlers.push(handler);
    handler(this.state);
  }

  stop(): void {
    this.source.stop();
  }

  private onFix(fix: PositionFix): void {
    const distanceMeters = haversineMeters(
      fix.latitude,
      fix.longitude,
      this.fence.latitude,
      this.fence.longitude
    );
    const accuracyMeters = fix.accuracyMeters;

    const wasInside = this.state.kind === 'inside';
    const exitThreshold = this.fence.radiusMeters + Math.max(accuracyMeters, 10);
    const inside = wasInside ? distanceMeters <= exitThreshold : distanceMeters <= this.fence.radiusMeters;

    this.emit(
      inside
        ? { kind: 'inside', distanceMeters, accuracyMeters }
        : { kind: 'outside', distanceMeters, accuracyMeters }
    );
  }

  private emit(state: GeoState): void {
    this.state = state;
    for (const handler of this.handlers) {
      handler(state);
    }
  }
}
