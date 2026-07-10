import type { RiveFile } from '@rive-app/canvas';
import { RiveController } from './RiveController.js';
import { OneEuroFilter1D } from './OneEuroFilter.js';
import type { Hotspot } from './SceneGraphLoader.js';
import type { ProjectedHotspot } from './HotspotProjector.js';
import { traceT } from './TraceLog.js';

/**
 * Per the Golden Rule (AR_SYSTEM.md §E), everything a marker binds to comes
 * from the hotspot node's own userData (authored as Blender custom
 * properties, exported as glTF extras) — never from the manifest or any
 * configuration payload. Phase 5 keys: the Rive artboard/state-machine
 * binding, the external-content binding key, and the human label (used as
 * the accessible name; the visible text moved into the Card).
 */
const USERDATA_LABEL_KEY = 'label';
const USERDATA_ARTBOARD_KEY = 'riveArtboard';
const USERDATA_STATE_MACHINE_KEY = 'riveStateMachine';
export const USERDATA_CONTENT_KEY = 'contentKey';

const MARKER_SIZE_PX = 96;

// Backing-store pixels per CSS pixel, capped at 2 — retina-sharp without
// tripling fill cost on 3× phones for a 96px graphic.
const MAX_BACKING_SCALE = 2;

// --- Screen-space stabilization (unchanged from the Phase 3 overlay) ---
//
// The 3D pose runs unsmoothed (TRACKING_PROFILE_RIGID_ANCHOR) so the scene
// stays rigidly locked to the physical model; the pose estimator's
// high-frequency noise therefore reaches the 2D projection raw and is
// absorbed here, at the last stage, with a per-axis One Euro filter per
// marker. Initial values = the canonical pointing defaults (Casiez et al.);
// calibrate on device: if rest tremor persists, lower MIN_CUTOFF_HZ (e.g.
// 0.5); if fast pans feel draggy, raise BETA.
const MARKER_FILTER_MIN_CUTOFF_HZ = 1.0;
const MARKER_FILTER_BETA = 0.007;
const MARKER_FILTER_DERIVATIVE_CUTOFF_HZ = 1.0;

const HYSTERESIS_WINDOW_MS = 250; // real grace time before hiding on tracking loss

interface MarkerEntry {
  element: HTMLDivElement;
  rive: RiveController;
  filterX: OneEuroFilter1D;
  filterY: OneEuroFilter1D;
  lostTimeMs: number;
  /**
   * Mirrors element.style.display so the on-device telemetry logs
   * block/none TRANSITIONS only — update() runs per frame and re-assigns
   * the style unconditionally, which is fine for the DOM but would be
   * per-frame spam if logged directly.
   */
  shown: boolean;
}

// Marker state-machine contract (bench-ui.riv, docs/asset-authoring-guide.md).
const INPUT_IS_SELECTED = 'isSelected';
const INPUT_IS_DIMMED = 'isDimmed';

/**
 * Reads the content binding key a hotspot was authored with. MarkerLayer
 * validates presence at attach(), so this is safe on any attached hotspot;
 * it still throws (never returns undefined) if called on one that skipped
 * validation, per §C.
 */
export function contentKeyOf(hotspot: Hotspot): string {
  const key = readString(hotspot.userData, USERDATA_CONTENT_KEY);
  if (key === undefined) {
    throw new Error(
      `Hotspot "${hotspot.name}" has no "${USERDATA_CONTENT_KEY}" custom property — required since ` +
        'Phase 5 (AR_SYSTEM.md §E). Re-export the scene with tools/build_bench_scene.py.'
    );
  }
  return key;
}

/**
 * Screen-space marker layer (Phase 5 successor of HotspotOverlay): one
 * Rive Marker instance per hotspot, pinned each frame at the coordinates
 * HotspotProjector produces — the app owns placement, the artboard owns
 * appearance. Tap detection is DOM-level (each marker is its own element),
 * the single input path per the Phase 3 double-fire lesson; pointer
 * events are also forwarded into the state machine for hover/press
 * visuals only.
 *
 * The layer sits above MindAR's video layer, so markers receive pointer
 * events directly — the document-level workaround InputBridge needs does
 * not apply here.
 */
export class MarkerLayer {
  private readonly container: HTMLDivElement;
  private readonly markers = new Map<Hotspot, MarkerEntry>();
  // markers is indexed by Hotspot object identity — valid today because
  // SceneGraphLoader.load() creates the hotspot array once and that same
  // reference flows to attach() and every projection. If that ever stops
  // being true, the lookup fails; warn once per hotspot instead of
  // breaking the layer silently (see update()).
  private readonly warnedMissingState = new Set<Hotspot>();
  private tapHandler: ((hotspot: Hotspot) => void) | null = null;

  constructor(private readonly riveFile: RiveFile) {
    this.container = document.createElement('div');
    this.container.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:10;overflow:hidden;';
  }

  /**
   * Mounts one marker per hotspot and resolves once every Rive instance is
   * ready — a wrong artboard/state-machine name in the authored scene
   * rejects here, at startup, instead of surfacing as a dead marker later.
   */
  async attach(hotspots: readonly Hotspot[]): Promise<void> {
    document.body.appendChild(this.container);
    for (const hotspot of hotspots) {
      this.container.appendChild(this.createMarker(hotspot));
    }
    await Promise.all([...this.markers.values()].map((entry) => entry.rive.whenReady()));
  }

  detach(): void {
    for (const entry of this.markers.values()) {
      entry.rive.dispose();
    }
    this.markers.clear();
    this.container.remove();
  }

  onMarkerTap(handler: (hotspot: Hotspot) => void): void {
    this.tapHandler = handler;
  }

  /**
   * Reflects the app's selection state into every marker's state machine:
   * the selected hotspot gets isSelected, every other marker is dimmed
   * while a selection exists. null clears both everywhere.
   */
  setSelected(selected: Hotspot | null): void {
    for (const [hotspot, entry] of this.markers) {
      entry.rive.setBool(INPUT_IS_SELECTED, hotspot === selected);
      entry.rive.setBool(INPUT_IS_DIMMED, selected !== null && hotspot !== selected);
    }
  }

  /** True when the event target is (inside) one of the marker elements. */
  containsEventTarget(target: EventTarget | null): boolean {
    return target instanceof Node && this.container.contains(target);
  }

  update(projections: readonly ProjectedHotspot[], deltaMs: number): void {
    for (const projection of projections) {
      const hotspot = projection.hotspot;
      const entry = this.markers.get(hotspot);
      if (!entry) {
        if (!this.warnedMissingState.has(hotspot)) {
          this.warnedMissingState.add(hotspot);
          console.warn(
            `[MarkerLayer] No marker for hotspot "${hotspot.name}" — the Hotspot object identity ` +
              'must have changed between attach() and update(). This hotspot will not render until ' +
              'the app is reloaded.'
          );
        }
        continue;
      }

      if (projection.visible) {
        entry.lostTimeMs = 0;
        if (!entry.shown) {
          entry.shown = true;
          console.log(
            `[${traceT()}] [MarkerLayer] "${hotspot.name}" -> display:block ` +
              `(projection visible at ${projection.screenX.toFixed(0)},${projection.screenY.toFixed(0)})`
          );
        }

        // One Euro per axis: kills at-rest tracking tremor without
        // perceptible lag during fast pans. On the first frame after a
        // reset() the filter anchors directly to the input value, so there
        // is no ghost slide from (0,0).
        const dtSeconds = deltaMs / 1000;
        const smoothedX = entry.filterX.filter(projection.screenX, dtSeconds);
        const smoothedY = entry.filterY.filter(projection.screenY, dtSeconds);

        entry.element.style.display = 'block';
        entry.element.style.left = `${smoothedX}px`;
        entry.element.style.top = `${smoothedY}px`;
        entry.element.style.opacity = projection.occluded ? '0.25' : '1';
      } else {
        // Tracking says not visible: apply the hysteresis grace window.
        entry.lostTimeMs += deltaMs;

        if (entry.lostTimeMs >= HYSTERESIS_WINDOW_MS) {
          // Grace expired: hide and forget the filter history so the next
          // re-detection anchors at the new position instead of sliding
          // over from the old one.
          if (entry.shown) {
            entry.shown = false;
            console.log(
              `[${traceT()}] [MarkerLayer] "${hotspot.name}" -> display:none ` +
                `(hysteresis ${HYSTERESIS_WINDOW_MS}ms expired; cause: ` +
                `${projection.hiddenReason === 'tracking' ? 'tracking=false' : 'frustum=false'})`
            );
          }
          entry.element.style.display = 'none';
          entry.filterX.reset();
          entry.filterY.reset();
        } else {
          // Within grace: hold the last known position, attenuated.
          entry.element.style.opacity = '0.15';
        }
      }
    }
  }

  private createMarker(hotspot: Hotspot): HTMLDivElement {
    // All three bindings are required as of Phase 5 — a hotspot without
    // them can't render a marker or resolve content, so fail at attach
    // time naming the offending node (§C), not with a dead marker later.
    contentKeyOf(hotspot);
    const artboard = requireString(hotspot, USERDATA_ARTBOARD_KEY);
    const stateMachine = requireString(hotspot, USERDATA_STATE_MACHINE_KEY);

    const element = document.createElement('div');
    // Anchor: the marker artboard's visual anchor is its center (see
    // docs/asset-authoring-guide.md), pinned to the projected point.
    element.style.cssText =
      'position:absolute;display:none;transform:translate(-50%,-50%);' +
      'pointer-events:auto;touch-action:none;' +
      `width:${MARKER_SIZE_PX}px;height:${MARKER_SIZE_PX}px;` +
      'transition:opacity 120ms linear;';
    element.setAttribute('role', 'button');
    element.setAttribute('aria-label', readString(hotspot.userData, USERDATA_LABEL_KEY) ?? hotspot.name);

    const backing = MARKER_SIZE_PX * Math.min(window.devicePixelRatio || 1, MAX_BACKING_SCALE);
    const rive = new RiveController({
      riveFile: this.riveFile,
      artboard,
      stateMachine,
      canvasWidth: backing,
      canvasHeight: backing,
    });
    const canvas = rive.canvas;
    canvas.style.cssText = 'width:100%;height:100%;display:block;';
    element.appendChild(canvas);

    const forwardPointer = (event: PointerEvent, isDown: boolean): void => {
      // Isolate the marker's input from everything else: stopPropagation()
      // keeps the event from bubbling to any document-level listener (the
      // tap-outside close in main.ts, InputBridge's raycast path), and
      // preventDefault() on pointerdown suppresses the iOS compatibility
      // mouse-event sequence and default tap behaviors (double-tap zoom)
      // for this touch.
      event.stopPropagation();
      event.preventDefault();

      // Tap-chain telemetry (troubleshooting doc §6): confirms the DOM
      // half of the tap path fired; onMarkerTap/getContent/card.open are
      // logged by the experience wiring in main.ts.
      console.log(
        `[${traceT()}] [Tap] pointer${isDown ? 'down' : 'up'} on marker "${hotspot.name}"`
      );

      if (rive.isReady) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const canvasX = clamp(
            ((event.clientX - rect.left) / rect.width) * rive.canvasWidth,
            0,
            rive.canvasWidth
          );
          const canvasY = clamp(
            ((event.clientY - rect.top) / rect.height) * rive.canvasHeight,
            0,
            rive.canvasHeight
          );
          const artboardPoint = rive.mapCanvasPointToArtboard(canvasX, canvasY);
          if (isDown) {
            rive.pointerDown(artboardPoint.x, artboardPoint.y);
          } else {
            rive.pointerUp(artboardPoint.x, artboardPoint.y);
          }
        }
      }

      // The pointer forwarding above is visual feedback only; the tap
      // itself is a DOM-level decision — single input path (§G Phase 5).
      if (!isDown) {
        this.tapHandler?.(hotspot);
      }
    };

    element.addEventListener('pointerdown', (event) => forwardPointer(event, true));
    element.addEventListener('pointerup', (event) => forwardPointer(event, false));

    this.markers.set(hotspot, {
      element,
      rive,
      filterX: new OneEuroFilter1D(
        MARKER_FILTER_MIN_CUTOFF_HZ,
        MARKER_FILTER_BETA,
        MARKER_FILTER_DERIVATIVE_CUTOFF_HZ
      ),
      filterY: new OneEuroFilter1D(
        MARKER_FILTER_MIN_CUTOFF_HZ,
        MARKER_FILTER_BETA,
        MARKER_FILTER_DERIVATIVE_CUTOFF_HZ
      ),
      lostTimeMs: 0,
      shown: false,
    });
    return element;
  }
}

function requireString(hotspot: Hotspot, key: string): string {
  const value = readString(hotspot.userData, key);
  if (value === undefined) {
    throw new Error(
      `Hotspot "${hotspot.name}" has no "${key}" custom property — required since Phase 5 ` +
        '(AR_SYSTEM.md §E). Re-export the scene with tools/build_bench_scene.py.'
    );
  }
  return value;
}

function readString(userData: Record<string, unknown>, key: string): string | undefined {
  const value = userData[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
