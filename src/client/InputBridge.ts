import * as THREE from 'three';
import type { RiveController } from './RiveController.js';

/**
 * Translates raw touch coordinates into a 3D raycast against the AR plane,
 * then hands the resulting UV hit to RiveController to convert into
 * artboard-space pointer input.
 *
 * Listens on `document`, not the renderer's canvas: MindAR's video layer
 * sits on top of renderer.domElement and swallows touch events before they
 * reach it — unchanged from the pre-Phase-1 prototype.
 */
export class InputBridge {
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();

  private readonly handleTouchStart = (event: TouchEvent): void => {
    this.forwardTouch(event, true);
  };

  private readonly handleTouchEnd = (event: TouchEvent): void => {
    this.forwardTouch(event, false);
  };

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly plane: THREE.Mesh,
    private readonly rive: RiveController
  ) {}

  attach(): void {
    document.addEventListener('touchstart', this.handleTouchStart);
    document.addEventListener('touchend', this.handleTouchEnd);
  }

  detach(): void {
    document.removeEventListener('touchstart', this.handleTouchStart);
    document.removeEventListener('touchend', this.handleTouchEnd);
  }

  private forwardTouch(event: TouchEvent, isDown: boolean): void {
    const touch = event.changedTouches[0];
    if (!touch) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((touch.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((touch.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.plane);
    const uv = hits[0]?.uv;
    if (!uv) return;

    const size = this.rive.canvasSize;
    const artboardPoint = this.rive.mapCanvasPointToArtboard(uv.x * size, (1 - uv.y) * size);

    if (isDown) {
      this.rive.pointerDown(artboardPoint.x, artboardPoint.y);
    } else {
      this.rive.pointerUp(artboardPoint.x, artboardPoint.y);
    }
  }
}
