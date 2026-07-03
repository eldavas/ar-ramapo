import { RiveController } from './RiveController.js';
import type { Hotspot } from './SceneGraphLoader.js';
import type { ProjectedHotspot } from './HotspotProjector.js';

/**
 * Per the Golden Rule (AR_SYSTEM.md §E), everything a card displays or
 * triggers comes from the hotspot node's own userData (authored as Blender
 * custom properties, exported as glTF extras) — never from the manifest or
 * any configuration payload. These are the userData keys the overlay
 * understands; unknown keys are ignored.
 */
const USERDATA_LABEL_KEY = 'label';
const USERDATA_STATE_MACHINE_KEY = 'riveStateMachine';

const CARD_RIVE_SIZE_PX = 96;

/**
 * Screen-space UI layer: one DOM card per hotspot, pinned each frame at
 * the coordinates HotspotProjector produces. A card shows its authored
 * label and, when the hotspot declares a state machine, an interactive
 * Rive canvas (a RiveController instance per card; pointer input is mapped
 * to artboard space through the same bridge InputBridge uses).
 *
 * The overlay sits above MindAR's video layer, so cards receive pointer
 * events directly — the document-level workaround InputBridge needs does
 * not apply here.
 */
export class HotspotOverlay {
  private readonly container: HTMLDivElement;
  private readonly cards = new Map<Hotspot, HTMLDivElement>();

  constructor(private readonly riveUrl: string) {
    this.container = document.createElement('div');
    this.container.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:10;overflow:hidden;';
  }

  attach(hotspots: readonly Hotspot[]): void {
    document.body.appendChild(this.container);
    for (const hotspot of hotspots) {
      this.container.appendChild(this.createCard(hotspot));
    }
  }

  detach(): void {
    this.cards.clear();
    this.container.remove();
  }

  update(projections: readonly ProjectedHotspot[]): void {
    for (const projection of projections) {
      const card = this.cards.get(projection.hotspot);
      if (!card) continue;

      if (!projection.visible) {
        card.style.display = 'none';
        continue;
      }

      card.style.display = 'block';
      card.style.left = `${projection.screenX}px`;
      card.style.top = `${projection.screenY}px`;
      card.style.opacity = projection.occluded ? '0.25' : '1';
    }
  }

  private createCard(hotspot: Hotspot): HTMLDivElement {
    const card = document.createElement('div');
    card.style.cssText =
      'position:absolute;display:none;transform:translate(-50%,-100%);' +
      'pointer-events:auto;touch-action:none;text-align:center;' +
      'background:rgba(0,0,0,0.65);border-radius:8px;padding:6px 10px;' +
      'color:#fff;font:12px/1.3 system-ui,sans-serif;' +
      'transition:opacity 120ms linear;';

    const label = readString(hotspot.userData, USERDATA_LABEL_KEY) ?? hotspot.name;
    const labelElement = document.createElement('div');
    labelElement.textContent = label;
    card.appendChild(labelElement);

    const stateMachineName = readString(hotspot.userData, USERDATA_STATE_MACHINE_KEY);
    if (stateMachineName !== undefined) {
      card.appendChild(this.createRiveElement(stateMachineName));
    }

    this.cards.set(hotspot, card);
    return card;
  }

  private createRiveElement(stateMachineName: string): HTMLCanvasElement {
    const rive = new RiveController(this.riveUrl, stateMachineName);

    // RiveController parks its canvas off-screen (it is a texture source in
    // the anchored-plane use case); here the canvas *is* the UI, so restyle
    // it into the card. The 512×512 backing store just downscales via CSS.
    const canvas = rive.canvas;
    canvas.style.cssText = `width:${CARD_RIVE_SIZE_PX}px;height:${CARD_RIVE_SIZE_PX}px;display:block;margin:4px auto 0;`;

    const forwardPointer = (event: PointerEvent, isDown: boolean): void => {
      if (!rive.isReady) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const canvasX = ((event.clientX - rect.left) / rect.width) * rive.canvasSize;
      const canvasY = ((event.clientY - rect.top) / rect.height) * rive.canvasSize;
      const artboardPoint = rive.mapCanvasPointToArtboard(canvasX, canvasY);

      if (isDown) {
        rive.pointerDown(artboardPoint.x, artboardPoint.y);
      } else {
        rive.pointerUp(artboardPoint.x, artboardPoint.y);
      }
    };

    canvas.addEventListener('pointerdown', (event) => forwardPointer(event, true));
    canvas.addEventListener('pointerup', (event) => forwardPointer(event, false));

    return canvas;
  }
}

function readString(userData: Record<string, unknown>, key: string): string | undefined {
  const value = userData[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
