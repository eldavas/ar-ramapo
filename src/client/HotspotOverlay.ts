import { RiveController } from './RiveController.js';
import { OneEuroFilter1D } from './OneEuroFilter.js';
import type { Hotspot } from './SceneGraphLoader.js';
import type { ProjectedHotspot } from './HotspotProjector.js';

const USERDATA_LABEL_KEY = 'label';
const USERDATA_STATE_MACHINE_KEY = 'riveStateMachine';

const CARD_RIVE_SIZE_PX = 96;

// --- ESTABILIZACIÓN HÍBRIDA DE TARJETAS (pantalla, no pose) ---
//
// La pose 3D corre SIN amortiguar (TRACKING_PROFILE_RIGID_ANCHOR) para que
// la escena quede rígida al modelo físico; el precio es que el ruido de
// alta frecuencia del estimador de pose llega crudo a la proyección 2D.
// Ese temblor se absorbe aquí, en la última etapa, con un filtro One Euro
// por eje y por tarjeta: a baja velocidad el cutoff mínimo aplasta el
// micro-temblor; al panear rápido el cutoff sube con la velocidad y la
// tarjeta sigue la proyección casi sin rezago. Valores iniciales = los
// defaults canónicos del paper (Casiez et al.) para pointing en pantalla;
// calibrar en dispositivo: si aún tiembla en reposo, bajar MIN_CUTOFF_HZ
// (p. ej. 0.5); si se siente "arrastre" al mover rápido, subir BETA.
const CARD_FILTER_MIN_CUTOFF_HZ = 1.0;
const CARD_FILTER_BETA = 0.007;
const CARD_FILTER_DERIVATIVE_CUTOFF_HZ = 1.0;

const HYSTERESIS_WINDOW_MS = 250; // tiempo de gracia real antes de ocultar por pérdida de tracking

interface TrackingState {
  filterX: OneEuroFilter1D;
  filterY: OneEuroFilter1D;
  lostTimeMs: number;
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
        filterX: new OneEuroFilter1D(
          CARD_FILTER_MIN_CUTOFF_HZ,
          CARD_FILTER_BETA,
          CARD_FILTER_DERIVATIVE_CUTOFF_HZ
        ),
        filterY: new OneEuroFilter1D(
          CARD_FILTER_MIN_CUTOFF_HZ,
          CARD_FILTER_BETA,
          CARD_FILTER_DERIVATIVE_CUTOFF_HZ
        ),
        lostTimeMs: 0,
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

        // One Euro por eje: aplasta el micro-temblor del tracking en reposo
        // sin introducir rezago perceptible durante movimiento rápido. En
        // el primer frame tras un reset() el filtro ancla directo al valor
        // de entrada, así que no hay "desplazamiento fantasma" desde (0,0).
        const dtSeconds = deltaMs / 1000;
        const smoothedX = state.filterX.filter(projection.screenX, dtSeconds);
        const smoothedY = state.filterY.filter(projection.screenY, dtSeconds);

        card.style.display = 'block';
        card.style.left = `${smoothedX}px`;
        card.style.top = `${smoothedY}px`;
        card.style.opacity = projection.occluded ? '0.25' : '1';

      } else {
        // Si el tracking dice que no es visible, aplicamos la ventana de gracia (Histéresis)
        state.lostTimeMs += deltaMs;

        if (state.lostTimeMs >= HYSTERESIS_WINDOW_MS) {
          // Expiró el tiempo de gracia: ocultamos la tarjeta y olvidamos el
          // historial del filtro para que la próxima re-detección ancle
          // directo a la nueva posición en vez de deslizarse desde la vieja.
          card.style.display = 'none';
          state.filterX.reset();
          state.filterY.reset();
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