import { RiveController } from './RiveController.js';
import type { Hotspot } from './SceneGraphLoader.js';
import type { ProjectedHotspot } from './HotspotProjector.js';

const USERDATA_LABEL_KEY = 'label';
const USERDATA_STATE_MACHINE_KEY = 'riveStateMachine';

const CARD_RIVE_SIZE_PX = 96;

// --- CONSTANTES DE ESTABILIZACIÓN PARA MÓVIL ---
//
// Ambas constantes están calibradas asumiendo 60fps, pero el tracking en
// iPhone es exactamente el escenario donde el frame rate NO es estable
// (cae bajo carga térmica / cómputo de tracking). Por eso update() no usa
// estos valores directamente por-frame — los convierte usando deltaMs real
// (ver frameLerpFactor() más abajo) para que la velocidad de suavizado y la
// duración de la ventana de gracia sean las mismas en el tiempo real,
// sin importar el framerate del dispositivo.
const REFERENCE_FRAME_MS = 1000 / 60;
const LERP_FACTOR = 0.2; // fracción de la distancia restante cubierta cada REFERENCE_FRAME_MS
const HYSTERESIS_WINDOW_MS = 250; // ~15 frames a 60fps — tiempo de gracia antes de ocultar

interface TrackingState {
  currentX: number;
  currentY: number;
  lostTimeMs: number;
  isFirstFrame: boolean;
}

/**
 * Exponential-smoothing factor compensado por delta de tiempo real.
 * A deltaMs === REFERENCE_FRAME_MS, devuelve exactamente LERP_FACTOR (el
 * valor con el que fue calibrado). A un deltaMs mayor (frame lento/tab en
 * background) se acerca a 1 — es decir, si pasó mucho tiempo real, es
 * correcto que la tarjeta salte más cerca del destino en vez de arrastrar
 * el mismo 20% fijo que arrastraría un frame rápido.
 */
function frameLerpFactor(deltaMs: number): number {
  return 1 - Math.pow(1 - LERP_FACTOR, deltaMs / REFERENCE_FRAME_MS);
}

export class HotspotOverlay {
  private readonly container: HTMLDivElement;
  private readonly cards = new Map<Hotspot, HTMLDivElement>();
  // Almacena el estado de suavizado e historial por cada hotspot de forma aislada
  private readonly trackingStates = new Map<Hotspot, TrackingState>();
  // cards/trackingStates están indexados por identidad de objeto Hotspot —
  // válido hoy porque SceneGraphLoader.load() crea el array de hotspots una
  // sola vez y esa misma referencia fluye a attach() y a cada projection.
  // Si eso deja de ser cierto, un lookup fallaría; se avisa una vez por
  // hotspot en vez de fallar en silencio (ver update()).
  private readonly warnedMissingState = new Set<Hotspot>();

  constructor(private readonly riveUrl: string) {
    this.container = document.createElement('div');
    this.container.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:10;overflow:hidden;';
  }

  attach(hotspots: readonly Hotspot[]): void {
    document.body.appendChild(this.container);
    for (const hotspot of hotspots) {
      this.container.appendChild(this.createCard(hotspot));
      
      // Inicializar el estado de tracking para el suavizado
      this.trackingStates.set(hotspot, {
        currentX: 0,
        currentY: 0,
        lostTimeMs: 0,
        isFirstFrame: true,
      });
    }
  }

  detach(): void {
    this.cards.clear();
    this.trackingStates.clear();
    this.container.remove();
  }

  update(projections: readonly ProjectedHotspot[], deltaMs: number): void {
    for (const projection of projections) {
      const hotspot = projection.hotspot;
      const card = this.cards.get(hotspot);
      const state = this.trackingStates.get(hotspot);
      if (!card || !state) {
        // No debería pasar nunca dado el flujo actual (ver el comentario
        // junto a warnedMissingState), pero si pasa, avisamos una vez por
        // hotspot en vez de dejar el overlay roto en silencio.
        if (!this.warnedMissingState.has(hotspot)) {
          this.warnedMissingState.add(hotspot);
          console.warn(
            `[HotspotOverlay] No card/tracking-state for hotspot "${hotspot.name}" — the Hotspot ` +
              'object identity must have changed between attach() and update(). This hotspot will ' +
              'not render until the app is reloaded.'
          );
        }
        continue;
      }

      if (projection.visible) {
        // Reiniciar el tiempo de gracia ya que el tracking es válido
        state.lostTimeMs = 0;

        // Si es el primer frame detectado, saltamos directo a la posición para evitar un "desplazamiento fantasma"
        if (state.isFirstFrame) {
          state.currentX = projection.screenX;
          state.currentY = projection.screenY;
          state.isFirstFrame = false;
        } else {
          // Filtro Lerp compensado por deltaMs: Posición = actual + (destino - actual) * factor
          const factor = frameLerpFactor(deltaMs);
          state.currentX += (projection.screenX - state.currentX) * factor;
          state.currentY += (projection.screenY - state.currentY) * factor;
        }

        // Renderizar con coordenadas suavizadas
        card.style.display = 'block';
        card.style.left = `${state.currentX}px`;
        card.style.top = `${state.currentY}px`;
        card.style.opacity = projection.occluded ? '0.25' : '1';

      } else {
        // Si el tracking dice que no es visible, aplicamos la ventana de gracia (Histéresis)
        state.lostTimeMs += deltaMs;

        if (state.lostTimeMs >= HYSTERESIS_WINDOW_MS) {
          // Expiró el tiempo de gracia, ocultamos físicamente la tarjeta del DOM
          card.style.display = 'none';
          state.isFirstFrame = true; // Reiniciar para la próxima re-detección
        } else {
          // Mientras esté en tiempo de gracia, la mantenemos en su última posición conocida pero la atenuamos
          card.style.opacity = '0.15';
        }
      }
    }
  }

  private createCard(hotspot: Hotspot): HTMLDivElement {
    const card = document.createElement('div');
    card.style.cssText =
      'position:absolute;display:none;transform:translate(-50%,-100%);' +
      'pointer-events:auto;touch-action:none;text-align:center;' +
      'background:rgba(0,0,0,0.45);border-radius:8px;padding:6px 10px;' + // Subido fondo para mejor contraste en exterior
      'color:#fff;font:12px/1.3 system-ui,sans-serif;' +
      'transition:opacity 120ms linear;';

    const label = readString(hotspot.userData, USERDATA_LABEL_KEY) ?? hotspot.name;
    const labelElement = document.createElement('div');
    labelElement.textContent = label;
    card.appendChild(labelElement);

    const stateMachineName = readString(hotspot.userData, USERDATA_STATE_MACHINE_KEY);
    if (stateMachineName !== undefined) {
      this.attachRiveElement(card, stateMachineName);
    }

    this.cards.set(hotspot, card);
    return card;
  }

  /**
   * Creates the Rive-driven canvas and appends it to `card`, but wires
   * pointer input to the whole `card` — not just that inner canvas.
   * The card's label text and padded pill background all read as tappable,
   * and a fingertip rarely lands with pixel precision on a 96×96 icon; a
   * tap landing on the card but outside the canvas is clamped to the
   * nearest edge point so it still maps to a valid artboard coordinate.
   */
  private attachRiveElement(card: HTMLDivElement, stateMachineName: string): void {
    const rive = new RiveController(this.riveUrl, stateMachineName);
    const canvas = rive.canvas;
    canvas.style.cssText = `width:${CARD_RIVE_SIZE_PX}px;height:${CARD_RIVE_SIZE_PX}px;display:block;margin:4px auto 0;`;
    card.appendChild(canvas);

    const forwardPointer = (event: PointerEvent, isDown: boolean): void => {
      // Isolate the card's input from everything else: stopPropagation()
      // keeps the event from bubbling to any document-level listener
      // (InputBridge's raycast path, if a future experience ever runs
      // both), and preventDefault() on pointerdown suppresses the iOS
      // compatibility mouse-event sequence and default tap behaviors
      // (double-tap zoom) for this touch — the tap belongs to Rive only.
      event.stopPropagation();
      event.preventDefault();

      if (!rive.isReady) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const size = rive.canvasSize;
      const canvasX = clamp(((event.clientX - rect.left) / rect.width) * size, 0, size);
      const canvasY = clamp(((event.clientY - rect.top) / rect.height) * size, 0, size);
      const artboardPoint = rive.mapCanvasPointToArtboard(canvasX, canvasY);

      if (isDown) {
        rive.pointerDown(artboardPoint.x, artboardPoint.y);
      } else {
        rive.pointerUp(artboardPoint.x, artboardPoint.y);
      }
    };

    card.addEventListener('pointerdown', (event) => forwardPointer(event, true));
    card.addEventListener('pointerup', (event) => forwardPointer(event, false));
  }
}

function readString(userData: Record<string, unknown>, key: string): string | undefined {
  const value = userData[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}