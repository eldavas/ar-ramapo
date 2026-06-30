import * as THREE from 'three';
import { MindARThree } from 'https://cdn.jsdelivr.net/npm/mind-ar@1.2.5/dist/mindar-image-three.prod.js';

// window.rive is set by /rive/rive.js (UMD), loaded before this module
const { Rive } = window.rive;

// TODO: replace with the state machine name from your .riv file
const SM_NAME = 'State Machine 1';

const RIVE_CANVAS_SIZE = 512;

const riveCanvas = document.createElement('canvas');
riveCanvas.width = RIVE_CANVAS_SIZE;
riveCanvas.height = RIVE_CANVAS_SIZE;
// Must be in the DOM or Rive's visibility check pauses its render loop
riveCanvas.style.cssText = 'position:fixed;top:-9999px;pointer-events:none;';
document.body.appendChild(riveCanvas);

// Grabbed in onLoad so the AR side can call into them
let riveRuntime = null;
let riveArtboard = null;
let riveStateMachine = null;

function initRive() {
  const r = new Rive({
    src: '/assets/ui-test.riv',
    canvas: riveCanvas,
    stateMachines: SM_NAME,
    autoplay: true,
    onLoad: () => {
      riveRuntime = r.runtime;
      riveArtboard = r.artboard;
      // animator.stateMachines holds JS wrappers; .instance is the native WASM object
      const smWrapper = r.animator.stateMachines.find((sm) => sm.name === SM_NAME);
      riveStateMachine = smWrapper?.instance ?? null;
    },
  });
}

// StateMachineInstance.pointerDown/Up expects artboard-space coords, not canvas
// pixels. Replicate Rive's own event-handler path: computeAlignment → invert →
// mapXY, then call the native method directly.
function pointerToRive(canvasX, canvasY, isDown) {
  if (!riveStateMachine || !riveRuntime || !riveArtboard) return;

  const rt = riveRuntime;
  const frame = { minX: 0, minY: 0, maxX: RIVE_CANVAS_SIZE, maxY: RIVE_CANVAS_SIZE };

  const fwd = rt.computeAlignment(
    rt.Fit.contain,
    rt.Alignment.center,
    frame,
    riveArtboard.bounds,
    1.0
  );
  const inv = new rt.Mat2D();
  fwd.invert(inv);

  const vec = new rt.Vec2D(canvasX, canvasY);
  const mapped = rt.mapXY(inv, vec);

  if (isDown) {
    riveStateMachine.pointerDown(mapped.x(), mapped.y(), 0);
  } else {
    riveStateMachine.pointerUp(mapped.x(), mapped.y(), 0);
  }

  // Clean up WASM heap objects
  mapped.delete();
  vec.delete();
  inv.delete();
  fwd.delete();
}

async function initAR() {
  const mindarThree = new MindARThree({
    container: document.querySelector('#ar-container'),
    imageTargetSrc: '/assets/proxy-target.mind',
    // One Euro Filter: lower minCF = smoother at rest; lower beta = less jitter on slow movement
    filterMinCF: 0.001,
    filterBeta: 0.01,
  });

  const { renderer, scene, camera } = mindarThree;
  const anchor = mindarThree.addAnchor(0);

  const riveTexture = new THREE.CanvasTexture(riveCanvas);
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

  // Stand the card upright above the target surface.
  // Increase position.z to float it higher above the marker.
  plane.rotation.x = Math.PI / 2;
  plane.position.z = 0.5;

  anchor.group.add(plane);

  await mindarThree.start();

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  function uvFromTouch(touch) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(plane);
    return hits.length > 0 ? hits[0].uv : null;
  }

  // Listen on document — MindAR's video layer sits on top of renderer.domElement
  // and swallows touch events before they reach the canvas.
  document.addEventListener('touchstart', (e) => {
    const touch = e.changedTouches[0];
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const intersects = raycaster.intersectObject(plane);
    if (!intersects.length) return;
    const uv = intersects[0].uv;
    pointerToRive(uv.x * riveCanvas.width, (1 - uv.y) * riveCanvas.height, true);
    riveTexture.needsUpdate = true;
  });

  document.addEventListener('touchend', (e) => {
    const touch = e.changedTouches[0];
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const intersects = raycaster.intersectObject(plane);
    if (!intersects.length) return;
    const uv = intersects[0].uv;
    pointerToRive(uv.x * riveCanvas.width, (1 - uv.y) * riveCanvas.height, false);
    riveTexture.needsUpdate = true;
  });

  renderer.setAnimationLoop(() => {
    riveTexture.needsUpdate = true;
    renderer.render(scene, camera);
  });
}

initRive();
initAR();
