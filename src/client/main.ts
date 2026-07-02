import * as THREE from 'three';
import { resolveExperience } from '../../packages/experience-manifest/ManifestResolver.js';
import { ARSessionManager } from './ARSessionManager.js';
import { RenderEngine } from './RenderEngine.js';
import { RiveController } from './RiveController.js';
import { InputBridge } from './InputBridge.js';

// TODO: replace with the state machine name from your .riv file. Not part
// of the experience-manifest schema (§E only covers asset URLs), so this
// stays a top-level constant, same as before Phase 1.
const STATE_MACHINE_NAME = 'State Machine 1';

// Single-experience today by design — see AR_SYSTEM.md §E and the
// architecture review's routing-structure finding. Selecting *which*
// experience loads is a later phase; resolving its assets through the
// manifest instead of hardcoded paths is this phase's job.
const ACTIVE_TARGET_ID = 'proxy-target';

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
  renderEngine.start();
}

main().catch((error: unknown) => {
  console.error('[ar-ramapo] fatal startup error:', error);
});
