import * as THREE from 'three';
import type { AnchorSource, OriginKind } from './AnchorSource.js';
import type { FrameBus } from './FrameBus.js';

export interface DevSimHandles {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  anchorSource: AnchorSource;
}

/**
 * Desk-testing stand-in for the 8th Wall session (?fakear=1). The engine's
 * SLAM world tracking is mobile-only — desktop browsers are rejected with
 * "No valid session manager" — so this harness swaps the tracking layer
 * for a plain three.js scene with a slowly orbiting camera and an
 * always-tracking anchor at the origin. Because everything downstream
 * consumes only the AnchorSource seam plus {scene, camera, renderer}
 * handles, the entire content pipeline (SceneGraphLoader,
 * HotspotProjector, Rive markers, Card, ContentProvider) runs unmodified —
 * which is exactly what makes it a valid desk verification of parity.
 *
 * Never reachable without the explicit query flag; phones always exercise
 * the real engine path.
 */
class SimulatedAnchorSource implements AnchorSource {
  readonly kind: OriginKind = 'tap-placed';
  readonly group = new THREE.Group();

  constructor(scene: THREE.Scene) {
    this.group.name = 'dev-sim-anchor';
    scene.add(this.group);
  }

  acquire(): Promise<void> {
    return Promise.resolve();
  }

  isTracking(): boolean {
    return true;
  }

  onOriginChanged(): void {
    // The simulated origin never moves.
  }

  dispose(): void {
    this.group.removeFromParent();
  }
}

export function startDevSim(canvas: HTMLCanvasElement, frameBus: FrameBus): DevSimHandles {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1c2733);

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.01,
    100
  );

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  const resize = (): void => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

  // The bench GLB may carry lit materials; the real AR scene renders them
  // against the camera feed without lights, but on a solid sim background
  // unlit-black geometry would be unreadable.
  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(2, 4, 3);
  scene.add(sun);

  const gridHelper = new THREE.GridHelper(4, 16, 0x445566, 0x2c3a48);
  scene.add(gridHelper);

  // Slow orbit at eye height around the anchor origin — makes the
  // world→screen projection, marker smoothing, and occlusion behavior
  // visible without device motion.
  const ORBIT_RADIUS_METERS = 1.6;
  const ORBIT_PERIOD_MS = 30_000;
  const lookTarget = new THREE.Vector3(0, 0.15, 0);
  frameBus.onFrame(() => {
    const angle = (performance.now() / ORBIT_PERIOD_MS) * Math.PI * 2;
    camera.position.set(
      Math.sin(angle) * ORBIT_RADIUS_METERS,
      1.1,
      Math.cos(angle) * ORBIT_RADIUS_METERS
    );
    camera.lookAt(lookTarget);
  });

  const tick = (timestampMs: number): void => {
    frameBus.tick(timestampMs);
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(tick);

  return { scene, camera, renderer, anchorSource: new SimulatedAnchorSource(scene) };
}
