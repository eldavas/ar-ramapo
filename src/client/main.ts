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
const ACTIVE_TARGET_ID = 'bench-test';

async function main(): Promise<void> {
  const container = document.querySelector<HTMLDivElement>('#ar-container');
  if (!container) {
    throw new Error('main(): #ar-container element not found in the DOM.');
  }

  const experience = resolveExperience(ACTIVE_TARGET_ID);
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

main().catch((error: unknown) => {
  console.error('[ar-ramapo] fatal startup error:', error);
});
