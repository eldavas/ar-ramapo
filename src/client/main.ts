import * as THREE from 'three';
import { resolveExperience } from '../../packages/experience-manifest/ManifestResolver.js';
import {
  ARSessionManager,
  TRACKING_PROFILE_RIGID_ANCHOR,
  TRACKING_PROFILE_SMOOTH_UI,
} from './ARSessionManager.js';
import { RenderEngine } from './RenderEngine.js';
import { RiveController, loadRiveFile } from './RiveController.js';
import { InputBridge } from './InputBridge.js';
import { SceneGraphLoader } from './SceneGraphLoader.js';
import { HotspotProjector } from './HotspotProjector.js';
import { MarkerLayer, contentKeyOf } from './MarkerLayer.js';
import { CardPanel, CardImageSlot } from './CardPanel.js';
import { GoogleSheetContentProvider } from './ContentProvider.js';
import type { Hotspot } from './SceneGraphLoader.js';
import type { ExperienceManifest } from '../../packages/experience-manifest/manifest.js';

// 8th Wall path (AR_SYSTEM.md's 8th-wall decision record). Fully isolated
// from the MindAR imports/path above — nothing here executes unless an
// experience declares `placement` (see the fork at the top of main()).
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

// State machine name inside ui-test.riv, the legacy single-card experience
// (proxy-target). Spatial experiences don't use this — their Rive bindings
// are authored per hotspot in the scene asset (Golden Rule, §E), and the
// Card contract lives in CardPanel.ts. Not part of the manifest schema (§E
// only covers asset URLs), so it stays a top-level constant.
const STATE_MACHINE_NAME = 'State Machine 1';

// Single-experience today by design — see AR_SYSTEM.md §E and the
// architecture review's routing-structure finding. Selecting *which*
// experience loads is a later phase.
//
// Phase 3: bench-test is live — its assets (bench-scene.glb,
// bench-target.mind) are in /public/assets and the spatial pipeline below
// activates on any experience that declares modelUrl. Flip back to
// 'proxy-target' to run the pre-Phase-3 anchored-plane experience.
//
// Phase 2C (TEMPORARY, for the 8th Wall infrastructure walkthrough): set to
// '8thwall-test' to route through runEightWallExperience() instead of the
// MindAR path. Flip back to 'bench-test' to resume the MindAR/Rive-Listener
// verification this repo was mid-way through — no other change needed.
const ACTIVE_TARGET_ID = '8thwall-test';

// 8th Wall desk-testing bypasses — query params, not build flags, so the
// same deployed build is testable on any device without rebuilding. Inert
// unless the active experience declares `placement` (see runEightWallExperience).
const QUERY_PARAMS = new URLSearchParams(window.location.search);
const FAKE_GEO = QUERY_PARAMS.has('fakegeo');
const FAKE_AR = QUERY_PARAMS.has('fakear');
const RECORD_GEO = QUERY_PARAMS.has('recordgeo');

async function main(): Promise<void> {
  if (RECORD_GEO) {
    // Site setup, not an AR session — needs no experience or engine at all.
    await runRecordGeoMode(new UxOverlay());
    return;
  }

  const experience = resolveExperience(ACTIVE_TARGET_ID);

  if (experience.placement !== undefined) {
    // 8th Wall path (AR_SYSTEM.md's 8th-wall decision record) — fully
    // isolated from the MindAR path below; see runEightWallExperience().
    await runEightWallExperience(experience);
    return;
  }

  // ---- MindAR path (unchanged since Phase 1) ----
  const container = document.querySelector<HTMLDivElement>('#ar-container');
  if (!container) {
    throw new Error('main(): #ar-container element not found in the DOM.');
  }
  if (!experience.mindTargetUrl) {
    throw new Error(`Experience "${experience.targetId}" has no mindTargetUrl declared in the manifest.`);
  }

  // Spatial scenes are rigidly locked to the physical model, so tracking
  // must stay responsive during phone motion; the legacy floating card
  // prefers maximum smoothing at rest. See ARSessionManager for the two
  // profiles and why the old smooth values made the spatial scene "swim".
  const trackingProfile =
    experience.modelUrl !== undefined ? TRACKING_PROFILE_RIGID_ANCHOR : TRACKING_PROFILE_SMOOTH_UI;

  const session = new ARSessionManager(container, experience.mindTargetUrl, trackingProfile);
  const { renderer, scene, camera, anchor } = await session.start(0);

  const renderEngine = new RenderEngine(renderer, scene, camera);

  // These two branches are mutually exclusive by design: a spatial
  // experience (modelUrl declared) is driven entirely by hotspot_* nodes
  // discovered in its baked scene — it must never also mount the legacy
  // single plane below, or a second, uncontrolled card ends up floating
  // directly over the tracking target/origin (that origin is a reference
  // point, not a hotspot — see AR_SYSTEM.md §A).
  if (experience.modelUrl !== undefined) {
    // Spatial pipeline (Phase 3 + Phase 5, AR_SYSTEM.md §G): the baked
    // scene mesh is mounted on the anchor with the §F glue transform
    // applied; hotspot_* nodes get screen-space Rive markers pinned by
    // per-frame projection, and one screen-fixed Card panel displays the
    // externally-sourced content for whichever marker is selected.
    if (experience.physicalTargetWidthMeters === undefined) {
      // ManifestResolver already enforces this pairing; the recheck exists
      // for type narrowing and to keep the invariant local and loud.
      throw new Error(`Experience "${experience.targetId}" declares modelUrl without physicalTargetWidthMeters.`);
    }
    if (experience.contentUrl === undefined) {
      // Same pattern as above: spatial experiences carry their external
      // content route since Phase 5 (§E).
      throw new Error(`Experience "${experience.targetId}" declares modelUrl without contentUrl.`);
    }

    const loader = new SceneGraphLoader(experience.modelUrl, experience.physicalTargetWidthMeters);
    const { root, hotspots, occluders } = await loader.load();
    anchor.group.add(root);

    // One fetch/parse of the .riv serves all marker instances plus the
    // Card; the image slot captures the Card's `cardImage` referenced
    // asset at parse time for sheet-driven substitution.
    const imageSlot = new CardImageSlot();
    const riveFile = await loadRiveFile(experience.riveUrl, imageSlot.assetLoader);

    const contentProvider = new GoogleSheetContentProvider(experience.contentUrl);
    contentProvider.prefetch();

    const markers = new MarkerLayer(riveFile);
    await markers.attach(hotspots);
    const card = new CardPanel(riveFile, imageSlot);
    await card.attach();

    // Selection state machine (app-owned; the artboards only mirror it).
    let selected: Hotspot | null = null;
    const closeCard = (): void => {
      selected = null;
      markers.setSelected(null);
      card.close();
    };

    markers.onMarkerTap((hotspot) => {
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
          // Loud (§C) but session-preserving: the card simply doesn't
          // open; tracking and markers keep running.
          console.error('[ar-ramapo] content resolution failed:', error);
          if (selected === hotspot) closeCard();
        });
    });

    card.onCloseRequested(closeCard);

    // Tap-outside closes the card. Markers and the card stopPropagation()
    // their own pointerups, so any pointerup that reaches document is
    // outside both by construction; the contains checks are a second
    // guard in case that ever changes.
    document.addEventListener('pointerup', (event) => {
      if (!card.isOpen) return;
      if (markers.containsEventTarget(event.target) || card.containsEventTarget(event.target)) return;
      closeCard();
    });

    const projector = new HotspotProjector(
      camera,
      renderer.domElement,
      hotspots,
      occluders,
      // Polled per frame: MindAR's targetFound/targetLost events do not
      // fire with three r160, so anchor visibility is the tracking signal.
      () => anchor.group.visible
    );
    renderEngine.onFrame((deltaMs) => {
      markers.update(projector.project(), deltaMs);
    });
  } else {
    // Legacy single-card experience (pre-Phase-3, e.g. "proxy-target"): one
    // Rive-textured plane anchored directly above the tracked target,
    // driven by InputBridge's document-level touch raycast.
    const rive = new RiveController({ riveUrl: experience.riveUrl, stateMachine: STATE_MACHINE_NAME });

    const riveTexture = new THREE.CanvasTexture(rive.canvas);
    riveTexture.generateMipmaps = false;
    riveTexture.minFilter = THREE.LinearFilter;

    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: riveTexture,
        transparent: true,
        side: THREE.DoubleSide,
      })
    );

    // Stand the card upright above the target surface. Increase position.z
    // to float it higher above the marker.
    plane.rotation.x = Math.PI / 2;
    plane.position.z = 0.5;
    anchor.group.add(plane);

    const inputBridge = new InputBridge(renderer, camera, plane, rive);
    inputBridge.attach();

    renderEngine.onFrame(() => {
      riveTexture.needsUpdate = true;
    });
  }

  renderEngine.start();
}

/**
 * 8th Wall execution path (AR_SYSTEM.md's 8th-wall decision record),
 * transplanted from the spike's own main.ts. Shares SceneGraphLoader,
 * MarkerLayer, CardPanel, ContentProvider, and HotspotProjector unmodified
 * with the MindAR path above — only the tracking/origin layer differs,
 * behind the AnchorSource seam (TapPlacedAnchorSource / ImageTargetAnchorSource).
 *
 * Not reachable today: no manifest entry declares `placement` yet, and the
 * DOM/#camerafeed canvas + /xr static route this needs are not wired into
 * index.html / server/createServer.ts in this pass (see the design review).
 */
async function runEightWallExperience(experience: ExperienceManifest): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#camerafeed');
  if (!canvas) {
    throw new Error('runEightWallExperience(): #camerafeed canvas element not found in the DOM.');
  }
  if (experience.modelUrl === undefined) {
    throw new Error(`Experience "${experience.targetId}" declares placement but no modelUrl.`);
  }
  if (experience.contentUrl === undefined) {
    throw new Error(`Experience "${experience.targetId}" declares placement but no contentUrl.`);
  }
  const { modelUrl, contentUrl } = experience;

  const overlay = new UxOverlay();

  // Image-target data fetches in parallel with the arrival gate below — it
  // must be ready before the Start AR gesture calls session.start().
  const imageTargetsPromise =
    experience.placement === 'image' && experience.imageTargetUrl !== undefined
      ? loadImageTargetData(experience.imageTargetUrl)
      : null;

  // ---- Arrival gate ------------------------------------------------------
  // Runs whenever the experience declares a geofence, regardless of
  // placement mode: for 'tap' it is the only arrival signal; for 'image' it
  // stops users hunting for a plaque that is miles away. Geolocation
  // permission needs a user gesture on iOS, so the fence never starts
  // watching on page load — the intro button is that gesture.
  if (experience.geo !== undefined) {
    const fence = experience.geo;
    const geo = new GeoFenceService(fence, FAKE_GEO ? new FakePositionSource(fence) : undefined);

    await new Promise<void>((resolve) => {
      overlay.showPanel(
        'This AR experience lives at a physical site.\nWe use your location to check you have arrived.',
        'Find it',
        () => {
          geo.start();
          resolve();
        }
      );
    });

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
              `Walk to the site to start.\nAbout ${Math.round(state.distanceMeters)} m away ` +
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
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let renderer: THREE.WebGLRenderer;
  let anchorSource: AnchorSource;

  if (FAKE_AR) {
    // Desk simulation: no camera, no SLAM, no placement — an always-tracking
    // anchor at the origin behind the same AnchorSource seam, so everything
    // below this branch runs unmodified.
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

    const handles = await new Promise<Awaited<ReturnType<EightWallSession['start']>>>((resolve, reject) => {
      overlay.showPanel(
        imageTargets !== null
          ? "You've arrived!\nNext: camera + motion access, then point your camera at the plaque."
          : "You've arrived!\nNext: camera + motion access, then scan the ground to place the scene.",
        'Start AR',
        () => {
          session
            .start(imageTargets !== null ? { imageTargetData: imageTargets.imageTargetData } : {})
            .then(resolve, (error: unknown) => {
              // Dedicated log for this specific phase, distinct from the
              // generic top-level "fatal startup error" catch in main() —
              // on a small on-screen console, knowing it was
              // EightWallSession.start() specifically (vs. manifest
              // resolution, asset fetch, etc.) narrows the search a lot.
              console.error('[runEightWallExperience] EightWallSession.start() rejected:', error);
              reject(error);
            });
        }
      );
    });
    ({ scene, camera, renderer } = handles);

    if (imageTargets !== null) {
      // ---- Image-target origin ---------------------------------------------
      overlay.showHint('Point your camera at the plaque.');
      session.onImageEvent((kind) => {
        if (kind === 'loading') overlay.showHint('Loading image target…');
        if (kind === 'scanning') overlay.showHint('Point your camera at the plaque.');
      });

      if (experience.physicalTargetWidthMeters === undefined) {
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
      // ---- Tap placement -----------------------------------------------------
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

  // ---- Scene content -------------------------------------------------
  if (experience.physicalTargetWidthMeters === undefined) {
    // ManifestResolver currently enforces this pairing whenever modelUrl is
    // declared, regardless of engine/placement — the recheck exists for
    // type narrowing and to keep the invariant local and loud, same
    // pattern as the MindAR path above.
    throw new Error(`Experience "${experience.targetId}" declares modelUrl without physicalTargetWidthMeters.`);
  }
  // '8thwall': SceneGraphLoader mounts the mesh at identity rotation/scale
  // 1 — anchorSource.group (TapPlacedAnchorSource / ImageTargetAnchorSource)
  // already supplies the correct frame and the real-meters absolute scale
  // (Phase 2B decision record). Piping anchorSource.group in below is the
  // same seam the MindAR path uses with anchor.group.
  const loader = new SceneGraphLoader(modelUrl, experience.physicalTargetWidthMeters, '8thwall');
  const { root, hotspots, occluders } = await loader.load();
  console.log(
    `[runEightWallExperience] SceneGraphLoader found ${hotspots.length} hotspot_* node(s) ` +
      `and ${occluders.length} occluder mesh(es) in ${modelUrl}.`
  );
  anchorSource.group.add(root);

  const imageSlot = new CardImageSlot();
  const riveFile = await loadRiveFile(experience.riveUrl, imageSlot.assetLoader);

  const contentProvider = new GoogleSheetContentProvider(contentUrl);
  contentProvider.prefetch();

  const markers = new MarkerLayer(riveFile);
  await markers.attach(hotspots);
  const card = new CardPanel(riveFile, imageSlot);
  await card.attach();
  console.log('[runEightWallExperience] MarkerLayer and CardPanel attached — content pipeline is live.');

  let selected: Hotspot | null = null;
  const closeCard = (): void => {
    selected = null;
    markers.setSelected(null);
    card.close();
  };

  markers.onMarkerTap((hotspot) => {
    if (selected === hotspot) {
      closeCard();
      return;
    }
    selected = hotspot;
    markers.setSelected(hotspot);
    contentProvider
      .getContent(contentKeyOf(hotspot))
      .then((content) => {
        if (selected === hotspot) card.open(content);
      })
      .catch((error: unknown) => {
        console.error('[ar-ramapo] content resolution failed:', error);
        if (selected === hotspot) closeCard();
      });
  });

  card.onCloseRequested(closeCard);

  document.addEventListener('pointerup', (event) => {
    if (!card.isOpen) return;
    if (markers.containsEventTarget(event.target) || card.containsEventTarget(event.target)) return;
    closeCard();
  });

  const projector = new HotspotProjector(
    camera,
    renderer.domElement,
    hotspots,
    occluders,
    () => anchorSource.isTracking()
  );
  frameBus.onFrame((deltaMs) => {
    markers.update(projector.project(), deltaMs);
  });

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
