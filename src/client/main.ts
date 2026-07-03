import * as THREE from 'three';
import { resolveExperience } from '../../packages/experience-manifest/ManifestResolver.js';
import { ARSessionManager } from './ARSessionManager.js';
import { RenderEngine } from './RenderEngine.js';
import { RiveController } from './RiveController.js';
import { InputBridge } from './InputBridge.js';
import { SceneGraphLoader } from './SceneGraphLoader.js';
import { HotspotProjector } from './HotspotProjector.js';
import { HotspotOverlay } from './HotspotOverlay.js';

// TODO: replace with the state machine name from your .riv file. Not part
// of the experience-manifest schema (§E only covers asset URLs), so this
// stays a top-level constant, same as before Phase 1.
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

  const rive = new RiveController(experience.riveUrl, STATE_MACHINE_NAME);

  const session = new ARSessionManager(container, experience.mindTargetUrl);
  const { renderer, scene, camera, anchor } = await session.start(0);

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

  // Stand the card upright above the target surface. Increase position.z to
  // float it higher above the marker.
  plane.rotation.x = Math.PI / 2;
  plane.position.z = 0.5;
  anchor.group.add(plane);

  const inputBridge = new InputBridge(renderer, camera, plane, rive);
  inputBridge.attach();

  const renderEngine = new RenderEngine(renderer, scene, camera);
  renderEngine.onFrame(() => {
    riveTexture.needsUpdate = true;
  });

  // Spatial pipeline (Phase 3, AR_SYSTEM.md §G): experiences that declare a
  // baked scene mesh get it mounted on the anchor with the §F glue
  // transform applied, plus screen-space hotspot cards pinned by per-frame
  // projection.
  if (experience.modelUrl !== undefined) {
    if (experience.physicalTargetWidthMeters === undefined) {
      // ManifestResolver already enforces this pairing; the recheck exists
      // for type narrowing and to keep the invariant local and loud.
      throw new Error(`Experience "${experience.targetId}" declares modelUrl without physicalTargetWidthMeters.`);
    }

    const loader = new SceneGraphLoader(experience.modelUrl, experience.physicalTargetWidthMeters);
    const { root, hotspots, occluders } = await loader.load();
    anchor.group.add(root);

    const overlay = new HotspotOverlay(experience.riveUrl);
    overlay.attach(hotspots);

    const projector = new HotspotProjector(
      camera,
      renderer.domElement,
      hotspots,
      occluders,
      // Polled per frame: MindAR's targetFound/targetLost events do not
      // fire with three r160, so anchor visibility is the tracking signal.
      () => anchor.group.visible
    );
    renderEngine.onFrame(() => {
      overlay.update(projector.project());
    });
  }

  renderEngine.start();
}

main().catch((error: unknown) => {
  console.error('[ar-ramapo] fatal startup error:', error);
});
