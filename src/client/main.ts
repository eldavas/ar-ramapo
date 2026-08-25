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
import { CardPanel } from './CardPanel.js';
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
import { ImageEventHintGate } from './ImageEventHintGate.js';
import { TrackingLossHint } from './TrackingLossHint.js';
import {
  loadImageTargetData,
  loadImageTargetDataForTargets,
  type LoadedMultiImageTargets,
} from './ImageTargetLoader.js';
import { runRecordGeoMode } from './RecordGeoMode.js';
import { traceT } from './TraceLog.js';
// TEMPORARY diagnostic instrumentation — see DiagnosticTimeline.ts's own
// doc comment. Remove this import and every diagMark()/diagPrintTimeline()
// call site once the 5-6s startup investigation is closed.
import { diagMark, diagPrintTimeline } from './DiagnosticTimeline.js';

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
// Phase 3: bench-test's assets (bench-scene.glb, bench-target.mind) are in
// /public/assets and the spatial pipeline below activates on any
// experience that declares modelUrl. Flip to 'proxy-target' to run the
// pre-Phase-3 anchored-plane experience; flip to 'bench-test' or
// '8thwall-test' to resume the synthetic-rig coordinate/engine validation
// rigs (AR_SYSTEM.md §G) — no other change needed for any of these.
//
// 2026-08-14 (§G Phase 3 production-swap): live production default is
// 'site' — the real four-plaque experience, 8th Wall, any of the 4 real
// printed plaques (front/back/left/right) converges on the same
// site-scene/hotspots/Marker/Card/content pipeline, each correctly offset
// from the shared §A reference corner (not re-centered on itself) via
// manifest.ts's `targets[]`. 'site-front'/'site-back'/'site-left'/
// 'site-right' are a separate, single-engine (MindAR) validation harness —
// same real plaque artwork and site-scene, but each independently
// re-centers the WHOLE scene on itself (§A's original single-plaque-center
// rule, not the calibrated four-plaque offsets) — kept for MindAR-specific
// tracking-quality testing, never the production default. 'bench-test'/
// '8thwall-test' remain the synthetic-rig coordinate/engine validation
// rigs (AR_SYSTEM.md §G); 'proxy-target' the pre-Phase-3 anchored-plane
// experience. Flip to any of these for that path — no other change needed.
//
// 2026-08-2x (candidate tracking-artwork validation harness): 'site-tracking-
// front'/'-back'/'-left'/'-right' are 4 new single-image-target 8th Wall
// entries (same shape as 'site-front'/etc. above, i.e. re-center the WHOLE
// scene on themselves — no shared-corner offset composition) for testing the
// abstract Voronoi tracking-target candidates (tools/build_site_tracking_
// targets.py) one side at a time, before recomputing the production 'site'
// entry's targets[] against whichever artwork is ultimately kept. On-device
// test of 'site-tracking-front' (this session): acquisition/tracking felt
// more stable than the old QR-plaque artwork, but pose still visibly
// spins/scales while holding the camera on the target and adjusting angle —
// root-caused to ImageTargetAnchorSource.applyPose() applying every
// trustworthy sample's raw rotation/position with zero temporal filtering
// (only a binary scale+trackingStatus accept/reject gate exists). A fix is
// proposed but NOT YET IMPLEMENTED — see docs/research/
// 8th-wall-troubleshooting.md's latest section and AR_SYSTEM.md §G Phase 6
// for the full write-up, including why naive smoothing isn't safe to just
// add (a low-beta pose filter was already tried and reverted for MindAR's
// rigid-anchor case — see OneEuroFilter.ts/ARSessionManager.ts — so any fix
// here needs the same adaptive/high-beta pattern MindAR already validates,
// not a plain low-pass filter). Flip ACTIVE_TARGET_ID to any of the 4
// site-tracking-* ids to resume testing; reverted to 'site' here since this
// was a desk-testing detour, not a production change.
const ACTIVE_TARGET_ID = 'site';

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

  diagMark('main-start');
  const experience = resolveExperience(ACTIVE_TARGET_ID);
  diagMark('manifest-resolved', experience.targetId);

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

    // One fetch/parse of the .riv serves all marker instances — the Card
    // is plain HTML/CSS (CardPanel.ts), no Rive involved.
    const riveFile = await loadRiveFile(experience.riveUrl);

    const contentProvider = new GoogleSheetContentProvider(experience.contentUrl);
    contentProvider.prefetch();

    const markers = new MarkerLayer(riveFile);
    await markers.attach(hotspots);
    const card = new CardPanel();
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
 * Wraps a legacy single-`imageTargetUrl` experience (e.g. 8thwall-test) in
 * the same LoadedMultiImageTargets shape `targets[]` experiences produce —
 * a one-element map with identity offset/rotation, which
 * ImageTargetAnchorSource.applyPose() composes down to exactly its
 * pre-multi-target behavior (mount origin = tracked plaque position,
 * verbatim). Keeps the single-target manifest fields (never deprecated —
 * §E "Multi-target plaques" is additive, XOR with these, not a
 * replacement) working through the same one code path below instead of a
 * parallel branch.
 */
async function loadSingleImageTargetAsMulti(
  imageTargetUrl: string,
  experience: ExperienceManifest
): Promise<LoadedMultiImageTargets> {
  if (experience.physicalTargetWidthMeters === undefined) {
    throw new Error(
      `Experience "${experience.targetId}" declares placement "image" without physicalTargetWidthMeters.`
    );
  }
  const loaded = await loadImageTargetData(imageTargetUrl);
  return {
    imageTargetData: loaded.imageTargetData,
    targetsByName: new Map([
      [
        loaded.primaryName,
        {
          name: loaded.primaryName,
          physicalTargetWidthMeters: experience.physicalTargetWidthMeters,
          originOffsetMeters: { x: 0, z: 0 },
          rotationYawDeg: 0,
        },
      ],
    ]),
  };
}

interface EightWallSceneContent {
  root: THREE.Group;
  hotspots: Hotspot[];
  occluders: THREE.Object3D[];
  markers: MarkerLayer;
  card: CardPanel;
  contentProvider: GoogleSheetContentProvider;
}

/**
 * Fetches/parses the GLB, fetches/parses the Rive file, prefetches content,
 * and mounts the marker layer + card panel — every piece of scene content
 * that depends only on the manifest, never on the AR session or tracking
 * state. Cold-start stabilization (AR_SYSTEM.md §G): kicked off as early as
 * runEightWallExperience() can call it — before the arrival gate, before
 * "Start AR", before any image target is found — so it runs IN PARALLEL
 * with AR session bootstrap instead of serialized strictly after it, which
 * is where it ran before this pass with no architectural reason to.
 *
 * Internal ordering here is a real dependency graph, not a blind
 * Promise.all of everything: MarkerLayer needs both the GLB's hotspots AND
 * the parsed Rive file, so it waits on both; CardPanel needs neither (it's
 * plain HTML/CSS, §G Phase 3's fifth physical-device-test entry) so it
 * attaches fully in parallel via its own promise, not serialized behind
 * the GLB/Rive fetch at all.
 */
async function loadEightWallSceneContent(
  modelUrl: string,
  sceneWidthMeters: number,
  riveUrl: string,
  contentUrl: string
): Promise<EightWallSceneContent> {
  diagMark('glb-load-start');
  diagMark('rive-file-load-start');
  const loader = new SceneGraphLoader(modelUrl, sceneWidthMeters, '8thwall');
  const contentProvider = new GoogleSheetContentProvider(contentUrl);
  contentProvider.prefetch();
  const cardPromise = (async (): Promise<CardPanel> => {
    const card = new CardPanel();
    await card.attach();
    diagMark('card-attach-end');
    return card;
  })();

  const [{ root, hotspots, occluders }, riveFile] = await Promise.all([loader.load(), loadRiveFile(riveUrl)]);
  diagMark('glb-load-end', `${hotspots.length} hotspots, ${occluders.length} occluders`);
  diagMark('rive-file-load-end');
  console.log(
    `[runEightWallExperience] SceneGraphLoader found ${hotspots.length} hotspot_* node(s) ` +
      `and ${occluders.length} occluder mesh(es) in ${modelUrl}.`
  );

  diagMark('markers-attach-start');
  const markers = new MarkerLayer(riveFile);
  await markers.attach(hotspots);
  diagMark('markers-attach-end');

  const card = await cardPromise;
  console.log('[runEightWallExperience] MarkerLayer and CardPanel attached — content pipeline is live.');
  diagMark('scene-content-ready');

  return { root, hotspots, occluders, markers, card, contentProvider };
}

/**
 * 8th Wall execution path (AR_SYSTEM.md's 8th-wall decision record),
 * transplanted from the spike's own main.ts. Shares SceneGraphLoader,
 * MarkerLayer, CardPanel, ContentProvider, and HotspotProjector unmodified
 * with the MindAR path above — only the tracking/origin layer differs,
 * behind the AnchorSource seam (TapPlacedAnchorSource / ImageTargetAnchorSource).
 *
 * Live today: `8thwall-test` (single image target) and `site` (the real
 * four-plaque production experience, `targets[]`) both route here.
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

  // '8thwall': SceneGraphLoader mounts the mesh at identity rotation/scale
  // 1 — anchorSource.group (TapPlacedAnchorSource / ImageTargetAnchorSource)
  // already supplies the correct frame and the real-meters absolute scale
  // (Phase 2B decision record); physicalTargetWidthMeters is provably
  // unread by SceneGraphLoader's '8thwall' branch (see its own source —
  // only the 'mindar' branch's metersToMarkerWidths() consumes it), so a
  // targets[] experience (§E "Multi-target plaques" — no singular
  // physicalTargetWidthMeters at this level, each plaque has its own) can
  // pass any one of its targets' widths here without it mattering; the
  // singular-field path still requires its own value, same as before.
  const sceneWidthMeters =
    experience.physicalTargetWidthMeters ??
    (experience.targets !== undefined ? experience.targets[0]?.physicalTargetWidthMeters : undefined);
  if (sceneWidthMeters === undefined) {
    // ManifestResolver enforces physicalTargetWidthMeters (singular) or a
    // non-empty targets[] (each validated with its own) whenever modelUrl
    // is declared — the recheck exists for type narrowing and to keep the
    // invariant local and loud, same pattern as the throws below.
    throw new Error(
      `Experience "${experience.targetId}" declares modelUrl without physicalTargetWidthMeters (or a non-empty targets[]).`
    );
  }
  // Kicked off now, deliberately before the arrival gate / "Start AR" tap /
  // any AR session or tracking state — see the function's own doc comment.
  const sceneContentPromise = loadEightWallSceneContent(modelUrl, sceneWidthMeters, experience.riveUrl, contentUrl);

  const overlay = new UxOverlay();

  // Image-target data fetches in parallel with the arrival gate below — it
  // must be ready before the Start AR gesture calls session.start(). Both
  // branches resolve to the same LoadedMultiImageTargets shape (§E
  // "Multi-target plaques"): a single imageTargetUrl becomes a one-element
  // targets map with identity offset/rotation, so everything downstream
  // (session.start(), ImageTargetAnchorSource) is one code path regardless
  // of how many plaques this experience declares.
  diagMark('image-target-json-fetch-start');
  const imageTargetsPromise: Promise<LoadedMultiImageTargets> | null =
    experience.placement !== 'image'
      ? null
      : experience.targets !== undefined
        ? loadImageTargetDataForTargets(experience.targets)
        : experience.imageTargetUrl !== undefined
          ? loadSingleImageTargetAsMulti(experience.imageTargetUrl, experience)
          : null;
  if (imageTargetsPromise !== null) {
    imageTargetsPromise.then(() => diagMark('image-target-json-fetch-end'));
  }

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
  // Only assigned on the image-target path (below) — the one-way latch that
  // stops 'scanning'/'loading' coaching hints from re-entering the loading
  // UX after the first stable reveal (AR_SYSTEM.md §G follow-up,
  // 2026-08-18). null on the tap-placement/FAKE_AR paths, which never
  // register this listener in the first place.
  let hintGate: ImageEventHintGate | null = null;

  if (FAKE_AR) {
    // Desk simulation: no camera, no SLAM, no placement — an always-tracking
    // anchor at the origin behind the same AnchorSource seam, so everything
    // below this branch runs unmodified.
    ({ scene, camera, renderer, anchorSource } = startDevSim(canvas, frameBus));
    await anchorSource.acquire();
  } else {
    // start() must run inside a user gesture: iOS Safari only shows the
    // motion-sensor permission prompt (which 8th Wall requests during
    // XR8.run) from a gesture handler. Camera permission chains from the
    // same tap.
    const session = new EightWallSession(canvas, frameBus);
    const imageTargets = imageTargetsPromise === null ? null : await imageTargetsPromise;
    diagMark('start-ar-button-shown');

    const handles = await new Promise<Awaited<ReturnType<EightWallSession['start']>>>((resolve, reject) => {
      overlay.showPanel(
        imageTargets !== null
          ? "You've arrived!\nNext: camera + motion access, then point your camera at the plaque."
          : "You've arrived!\nNext: camera + motion access, then scan the ground to place the scene.",
        'Start AR',
        () => {
          diagMark('start-ar-tapped');
          // QR first-scan UX (AR_SYSTEM.md §G "Cold-start stabilization"):
          // confirm the tap registered immediately. Before this pass the
          // panel sat unchanged through the whole engine-import +
          // camera/motion-permission gap with no feedback at all — the
          // leading, code-confirmed explanation for users re-scanning the
          // QR, believing nothing happened, when the assets/engine were
          // simply still loading (see the investigation report). showHint()
          // is non-blocking and cannot swallow the OS permission prompts
          // that follow.
          overlay.showHint('Starting camera…');
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
    diagMark('xr8-onstart-fired');

    if (imageTargets !== null) {
      // ---- Image-target origin ---------------------------------------------
      overlay.showHint('Point your camera at the plaque.');
      hintGate = new ImageEventHintGate((text) => overlay.showHint(text));
      session.onImageEvent((kind) => hintGate?.handle(kind));

      const imageAnchor = new ImageTargetAnchorSource(session, scene, [...imageTargets.targetsByName.values()]);
      await imageAnchor.acquire();
      diagMark('first-image-found-acquired (bootstrap, not yet revealed)');
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
  }

  // ---- Cold-start stabilization: reveal gate (AR_SYSTEM.md §G) ----------
  // Neither wait blocks the other: sceneContentPromise has been loading
  // since before the arrival gate even started, and anchorSource.whenStable()
  // resolves independently (immediately for tap-placed/dev-sim — the
  // placement gesture IS the trust signal; only after a checked,
  // non-bootstrap pose sample for an image target — see
  // ImageTargetAnchorSource's own doc comment). The scene is mounted under
  // anchorSource.group (already hidden — ImageTargetAnchorSource keeps
  // group.visible=false through the bootstrap sample) before either wait
  // resolves, so there's nothing to "pop in" once revealed: the transform
  // is already correct, only visibility flips.
  overlay.showHint('Loading…');
  const sceneContent = await sceneContentPromise;
  anchorSource.group.add(sceneContent.root);
  const { hotspots, occluders, markers, card, contentProvider } = sceneContent;

  // Physical-device follow-up (2026-08-19): absolute-scale convergence
  // needs real device parallax (EightWallSession's own comment, and 8th
  // Wall's official world-tracking guidance: "move slowly, especially at
  // startup") — a user holding the phone still can sit on 'Loading…'
  // indefinitely with zero explanation. This changes ONLY the hint TEXT,
  // never the reveal criterion — whenStable() below still gates the
  // actual reveal on a real trustworthy pose, not this timer. If it
  // hasn't resolved shortly after content is ready, swap to an actionable
  // coaching message instead of leaving an unexplained 'Loading…' up
  // forever; cleared the instant whenStable() resolves either way.
  const POSE_COACHING_DELAY_MS = 2500;
  let stableResolved = false;
  const coachingTimer = setTimeout(() => {
    if (!stableResolved) {
      overlay.showHint('Still locking on — try moving your phone slightly closer, then farther from the plaque.');
    }
  }, POSE_COACHING_DELAY_MS);

  await anchorSource.whenStable();
  stableResolved = true;
  clearTimeout(coachingTimer);
  // One-way: the coaching hint listener (if any — only the image-target
  // path registers one) can never re-show the loading UX after this,
  // however many more 'scanning'/'loading' events arrive later. Does not
  // touch the scene/anchor itself — see ImageEventHintGate's own doc
  // comment.
  hintGate?.markRevealed();
  diagMark('scene-revealed');
  diagPrintTimeline();
  overlay.hideAll();

  // Physical-device follow-up (2026-08-19): explain SUSTAINED tracking loss
  // after reveal instead of leaving the user with no signal at all — the
  // anchor/markers already behave correctly by design (frozen pose +
  // SLAM persistence; see TrackingLossHint's own doc comment), this only
  // makes that existing behavior legible. Engine-agnostic via the
  // AnchorSource seam — works identically for image-target and tap-placed
  // origins; inert for the FAKE_AR desk sim (isTracking() always true).
  const TRACKING_LOSS_HINT_DELAY_MS = 2000;
  const trackingLossHint = new TrackingLossHint(
    (text) => overlay.showHint(text),
    () => overlay.hideHint(),
    TRACKING_LOSS_HINT_DELAY_MS
  );
  frameBus.onFrame((deltaMs) => {
    trackingLossHint.tick(anchorSource.isTracking(), deltaMs);
  });

  let selected: Hotspot | null = null;
  const closeCard = (): void => {
    selected = null;
    markers.setSelected(null);
    card.close();
  };

  // Tap-chain telemetry (troubleshooting doc §6): each hop logs once, so
  // an on-device capture can confirm exactly how far a tap that beats the
  // marker's disappearance actually gets.
  //
  // try/catch belt-and-suspenders around the whole handler: a synchronous
  // throw (e.g. contentKeyOf on a mis-authored hotspot) happens before the
  // .catch() below would even be attached, and would otherwise die
  // silently as an uncaught exception in this DOM event handler.
  markers.onMarkerTap((hotspot) => {
    try {
      if (selected === hotspot) {
        console.log(`[${traceT()}] [Tap] onMarkerTap "${hotspot.name}" — re-tap on selected, closing card`);
        closeCard();
        return;
      }
      const contentKey = contentKeyOf(hotspot);
      console.log(
        `[${traceT()}] [Tap] onMarkerTap "${hotspot.name}" — selecting, getContent("${contentKey}")...`
      );
      selected = hotspot;
      markers.setSelected(hotspot);
      contentProvider
        .getContent(contentKey)
        .then((content) => {
          const current = selected === hotspot;
          console.log(
            `[${traceT()}] [Tap] getContent("${contentKey}") resolved — ` +
              (current ? 'calling card.open()' : 'selection changed meanwhile, dropped')
          );
          if (current) card.open(content);
        })
        .catch((error: unknown) => {
          console.error(`[${traceT()}] [Tap] getContent("${contentKey}") failed:`, error);
          if (selected === hotspot) closeCard();
        });
    } catch (error: unknown) {
      console.error(`[${traceT()}] [Tap] onMarkerTap "${hotspot.name}" handler threw synchronously:`, error);
    }
  });

  card.onCloseRequested(closeCard);

  document.addEventListener('pointerup', (event) => {
    if (!card.isOpen) return;
    if (markers.containsEventTarget(event.target) || card.containsEventTarget(event.target)) return;
    console.log(`[${traceT()}] [Tap] pointerup outside markers/card — closing card`);
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
