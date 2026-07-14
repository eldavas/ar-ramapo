import { resolveExperience } from '../../packages/experience-manifest/ManifestResolver.js';
import { EightWallSession } from './EightWallSession.js';
import type { AnchorSource } from './AnchorSource.js';
import { startDevSim } from './DevSimSession.js';
import { FrameBus } from './FrameBus.js';
import { GeoFenceService, FakePositionSource, type GeoState } from './GeoFenceService.js';
import { UxOverlay } from './UxOverlay.js';
import { PlacementController } from './PlacementController.js';
import { TapPlacedAnchorSource } from './TapPlacedAnchorSource.js';
import { ImageTargetAnchorSource } from './ImageTargetAnchorSource.js';
import { loadImageTargetData } from './ImageTargetLoader.js';
import { runRecordGeoMode } from './RecordGeoMode.js';
import { SceneGraphLoader } from './SceneGraphLoader.js';
import { HotspotProjector } from './HotspotProjector.js';
import { MarkerLayer, contentKeyOf } from './MarkerLayer.js';
import { CardPanel, CardImageSlot } from './CardPanel.js';
import { GoogleSheetContentProvider } from './ContentProvider.js';
import { loadRiveFile } from './RiveController.js';
import type { Hotspot } from './SceneGraphLoader.js';

// Single-experience today by design, same as the parent repo (AR_SYSTEM.md
// §E and the routing-structure finding). Selecting *which* experience loads
// — eventually by comparing the phone's position against every entry's
// geofence — is a later phase.
const ACTIVE_TARGET_ID = 'bench-park';

// Desk-testing bypasses — query params, not build flags, so the same
// deployed build is testable on any device without rebuilding:
//  - ?fakegeo=1 swaps the browser geolocation source for one that reports
//    the fence center.
//  - ?fakear=1 swaps the 8th Wall session for a plain three.js scene with
//    an orbiting camera (see DevSimSession) — the engine's SLAM is
//    mobile-only, so this is the only way to exercise the content pipeline
//    in a desktop browser.
//  - ?recordgeo=1 enters the site-setup GPS recording mode instead of the
//    AR flow (see RecordGeoMode).
const QUERY_PARAMS = new URLSearchParams(window.location.search);
const FAKE_GEO = QUERY_PARAMS.has('fakegeo');
const FAKE_AR = QUERY_PARAMS.has('fakear');
const RECORD_GEO = QUERY_PARAMS.has('recordgeo');

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#camerafeed');
  if (!canvas) {
    throw new Error('main(): #camerafeed canvas element not found in the DOM.');
  }

  const overlay = new UxOverlay();

  if (RECORD_GEO) {
    // Site setup, not an AR session — needs no experience at all.
    await runRecordGeoMode(overlay);
    return;
  }

  const experience = resolveExperience(ACTIVE_TARGET_ID);
  if (experience.modelUrl === undefined) {
    throw new Error(`Experience "${experience.targetId}" declares no modelUrl.`);
  }
  if (experience.contentUrl === undefined) {
    throw new Error(`Experience "${experience.targetId}" declares no contentUrl.`);
  }
  const { modelUrl, contentUrl } = experience;

  // Image-target data fetches in parallel with the arrival gate below —
  // it must be ready before the Start AR gesture calls session.start().
  const imageTargetsPromise =
    experience.placement === 'image' && experience.imageTargetUrl !== undefined
      ? loadImageTargetData(experience.imageTargetUrl)
      : null;

  // ---- Arrival gate ------------------------------------------------------
  // Runs whenever the experience declares a geofence, regardless of
  // placement mode: for 'tap' it is the only arrival signal; for 'image'
  // it stops users from staring at a camera view hunting for a plaque
  // that is miles away. Geolocation permission needs a user gesture on
  // iOS, so the fence never starts watching on page load — the intro
  // button is that gesture.
  if (experience.geo !== undefined) {
    const fence = experience.geo;
    const geo = new GeoFenceService(fence, FAKE_GEO ? new FakePositionSource(fence) : undefined);

    await new Promise<void>((resolve) => {
      overlay.showPanel(
        'This AR experience lives at a campus bench.\nWe use your location to check you have arrived.',
        'Find the bench',
        () => {
          geo.start();
          resolve();
        }
      );
    });

    // Wait for the fence to open, narrating distance while outside. The
    // handler keeps firing after arrival too (GPS keeps streaming), so the
    // "arrived" resolution is one-shot.
    await new Promise<void>((resolve) => {
      let arrived = false;
      geo.onChange((state: GeoState) => {
        if (arrived) return;
        switch (state.kind) {
          case 'locating':
            overlay.showPanel('Locating you…');
            break;
          case 'unavailable':
            overlay.showPanel(
              `Location unavailable: ${state.reason}\n` +
                'Enable location services and reload — or reopen with ?fakegeo=1 to bypass for testing.'
            );
            break;
          case 'outside':
            overlay.showPanel(
              `Walk to the bench to start.\nAbout ${Math.round(state.distanceMeters)} m away ` +
                `(GPS accuracy ±${Math.round(state.accuracyMeters)} m).`
            );
            break;
          case 'inside':
            arrived = true;
            resolve();
            break;
        }
      });
    });
  }

  // ---- AR session --------------------------------------------------------
  const frameBus = new FrameBus();
  let scene: import('three').Scene;
  let camera: import('three').PerspectiveCamera;
  let renderer: import('three').WebGLRenderer;
  let anchorSource: AnchorSource;

  if (FAKE_AR) {
    // Desk simulation: no camera, no SLAM, no placement — an
    // always-tracking anchor at the origin behind the same AnchorSource
    // seam, so everything below this branch runs unmodified.
    ({ scene, camera, renderer, anchorSource } = startDevSim(canvas, frameBus));
    await anchorSource.acquire();
    overlay.hideAll();
  } else {
    // start() must run inside a user gesture: iOS Safari only shows the
    // motion-sensor permission prompt (which 8th Wall requests during
    // XR8.run) from a gesture handler. Camera permission chains from the
    // same tap.
    const session = new EightWallSession(canvas, frameBus);
    const imageTargets = imageTargetsPromise === null ? null : await imageTargetsPromise;

    const handles = await new Promise<Awaited<ReturnType<EightWallSession['start']>>>(
      (resolve, reject) => {
        overlay.showPanel(
          imageTargets !== null
            ? "You've arrived!\nNext: camera + motion access, then point your camera at the plaque on the model."
            : "You've arrived!\nNext: camera + motion access, then scan the ground to place the scene.",
          'Start AR',
          () => {
            session
              .start(imageTargets !== null ? { imageTargetData: imageTargets.imageTargetData } : {})
              .then(resolve, reject);
          }
        );
      }
    );
    ({ scene, camera, renderer } = handles);

    if (imageTargets !== null) {
      // ---- Image-target origin (the fixed 3D-printed model's plaque) ------
      overlay.showHint('Point your camera at the plaque on the model.');
      session.onImageEvent((kind) => {
        // Coaching only: the anchor source owns all pose state.
        if (kind === 'loading') overlay.showHint('Loading image target…');
        if (kind === 'scanning') overlay.showHint('Point your camera at the plaque on the model.');
      });

      if (experience.physicalTargetWidthMeters === undefined) {
        // ManifestResolver enforces this for 'image' placement; recheck
        // narrows the type and keeps the invariant local and loud.
        throw new Error(
          `Experience "${experience.targetId}" declares placement "image" without physicalTargetWidthMeters.`
        );
      }
      const imageAnchor = new ImageTargetAnchorSource(
        session,
        scene,
        imageTargets.primaryName,
        experience.physicalTargetWidthMeters
      );
      await imageAnchor.acquire();
      anchorSource = imageAnchor;
    } else {
      // ---- Tap placement ---------------------------------------------------
      overlay.showHint(
        'Move your phone slowly to scan the ground.\nTap when the ring appears to place the scene.'
      );

      const placement = new PlacementController(session, scene, camera, frameBus, canvas);
      const tapAnchor = new TapPlacedAnchorSource(session, scene, placement);
      await tapAnchor.acquire();
      anchorSource = tapAnchor;
    }
    overlay.hideAll();
  }

  // ---- Scene content -----------------------------------------------------
  const loader = new SceneGraphLoader(modelUrl);
  const { root, hotspots, occluders } = await loader.load();
  anchorSource.group.add(root);

  // One fetch/parse of the .riv serves all marker instances plus the Card;
  // the image slot captures the Card's `cardImage` referenced asset at
  // parse time for sheet-driven substitution.
  const imageSlot = new CardImageSlot();
  const riveFile = await loadRiveFile(experience.riveUrl, imageSlot.assetLoader);

  const contentProvider = new GoogleSheetContentProvider(contentUrl);
  contentProvider.prefetch();

  const markers = new MarkerLayer(riveFile);
  await markers.attach(hotspots);
  const card = new CardPanel(riveFile, imageSlot);
  await card.attach();

  // Selection state machine (app-owned; the artboards only mirror it).
  // Transplanted from the parent repo's spatial pipeline.
  let selected: Hotspot | null = null;
  const closeCard = (): void => {
    selected = null;
    markers.setSelected(null);
    card.close();
  };

  // try/catch belt-and-suspenders around the whole handler: a synchronous
  // throw (e.g. contentKeyOf on a mis-authored hotspot) happens before the
  // .catch() below would even be attached, and would otherwise die
  // silently as an uncaught exception in this DOM event handler.
  const reportTapError = (error: unknown): void => {
    console.error('[ar-ramapo] tap handling failed:', error);
  };

  markers.onMarkerTap((hotspot) => {
    try {
      if (selected === hotspot) {
        // Re-tapping the selected marker toggles the card away.
        closeCard();
        return;
      }
      selected = hotspot;
      markers.setSelected(hotspot);
      contentProvider
        .getContent(contentKeyOf(hotspot))
        .then((content) => {
          // A slower fetch must not overwrite a newer selection.
          if (selected === hotspot) card.open(content);
        })
        .catch((error: unknown) => {
          // Loud (§C) but session-preserving: the card simply doesn't open;
          // tracking and markers keep running.
          reportTapError(error);
          if (selected === hotspot) closeCard();
        });
    } catch (error: unknown) {
      reportTapError(error);
    }
  });

  card.onCloseRequested(closeCard);

  // Tap-outside closes the card. Markers and the card stopPropagation()
  // their own pointerups, so any pointerup that reaches document is
  // outside both by construction; the contains checks are a second guard
  // in case that ever changes.
  document.addEventListener('pointerup', (event) => {
    if (!card.isOpen) return;
    if (markers.containsEventTarget(event.target) || card.containsEventTarget(event.target)) return;
    closeCard();
  });

  // ---- Projection loop ---------------------------------------------------
  const projector = new HotspotProjector(
    camera,
    renderer.domElement,
    hotspots,
    occluders,
    // Polled per frame, exactly as the parent polled anchor.group.visible
    // for MindAR; here the signal is SLAM tracking quality + placement.
    () => anchorSource.isTracking()
  );
  frameBus.onFrame((deltaMs) => {
    markers.update(projector.project(), deltaMs);
  });

  // ---- Re-place escape hatch ---------------------------------------------
  // Cheap insurance against a bad first tap-placement (wrong spot, drifted
  // origin): re-runs the same placement interaction and moves the anchor
  // group; scene + markers follow because they are parented under it.
  // Meaningless in the desk sim (the simulated origin never moves) and for
  // image-target origins (re-alignment is automatic on every sighting of
  // the plaque).
  if (FAKE_AR || anchorSource.kind !== 'tap-placed') return;
  let rePlacing = false;
  overlay.showCornerButton('Re-place', () => {
    if (rePlacing) return;
    rePlacing = true;
    closeCard();
    overlay.showHint('Tap when the ring appears to re-place the scene.');
    anchorSource
      .acquire()
      .catch((error: unknown) => {
        console.error('[ar-ramapo] re-placement failed:', error);
      })
      .finally(() => {
        overlay.hideHint();
        rePlacing = false;
      });
  });
}

main().catch((error: unknown) => {
  console.error('[ar-ramapo] fatal startup error:', error);
});
