/**
 * Full-screen DOM overlay for the pre-AR and coaching UX states. Sits at
 * z-index 30, above the camera canvas and both Rive layers (MarkerLayer
 * 10, CardPanel 20). Plain DOM on purpose: these screens are transient
 * scaffolding around the AR session, not part of the Rive design contract
 * ("app owns placement, Rive owns appearance" governs the in-experience
 * UI, not the arrival flow).
 *
 * Two visual modes per state: a blocking panel (banner + optional button,
 * opaque backdrop) for pre-camera states, and a non-blocking hint strip
 * (pointer-events: none) for coaching over the live camera feed —
 * `scanning` and `placing` must never swallow the placement tap.
 */
export class UxOverlay {
  private readonly container: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly message: HTMLParagraphElement;
  private readonly button: HTMLButtonElement;
  private readonly hint: HTMLDivElement;
  private readonly cornerButton: HTMLButtonElement;
  private buttonHandler: (() => void) | null = null;
  private cornerHandler: (() => void) | null = null;

  constructor() {
    this.container = document.createElement('div');
    this.container.style.cssText =
      'position:fixed;inset:0;z-index:30;pointer-events:none;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

    this.panel = document.createElement('div');
    this.panel.style.cssText =
      'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:16px;padding:24px;text-align:center;' +
      'background:rgba(0,0,0,0.82);color:#fff;pointer-events:auto;';

    this.message = document.createElement('p');
    this.message.style.cssText = 'font-size:17px;line-height:1.5;max-width:26em;white-space:pre-line;';

    this.button = document.createElement('button');
    this.button.style.cssText =
      'font-size:17px;font-weight:600;padding:14px 28px;border-radius:999px;border:none;' +
      'background:#4ade80;color:#052e16;cursor:pointer;touch-action:manipulation;';
    // 'click', not 'pointerup': fires for mouse, touch, and assistive tech
    // alike (and stays inside the user-gesture context iOS permission
    // prompts require). The overlay buttons are siblings of the AR canvas,
    // so the tap can't reach the canvas's placement listener anyway;
    // stopPropagation guards the document-level card-close listener.
    this.button.addEventListener('click', (event) => {
      event.stopPropagation();
      this.buttonHandler?.();
    });

    this.hint = document.createElement('div');
    this.hint.style.cssText =
      'position:absolute;left:50%;bottom:48px;transform:translateX(-50%);' +
      'max-width:85vw;padding:10px 18px;border-radius:12px;text-align:center;' +
      'background:rgba(0,0,0,0.6);color:#fff;font-size:15px;line-height:1.4;' +
      'pointer-events:none;white-space:pre-line;';

    this.cornerButton = document.createElement('button');
    this.cornerButton.style.cssText =
      'position:absolute;top:16px;right:16px;font-size:13px;font-weight:600;' +
      'padding:8px 14px;border-radius:999px;border:none;background:rgba(0,0,0,0.6);' +
      'color:#fff;cursor:pointer;pointer-events:auto;touch-action:manipulation;display:none;';
    this.cornerButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.cornerHandler?.();
    });

    this.panel.append(this.message, this.button);
    this.container.append(this.panel, this.hint, this.cornerButton);
    document.body.appendChild(this.container);
    this.hidePanel();
    this.hideHint();
  }

  /** Small persistent corner affordance (e.g. "Re-place") shown while tracking. */
  showCornerButton(label: string, onTap: () => void): void {
    this.cornerButton.textContent = label;
    this.cornerButton.style.display = '';
    this.cornerHandler = onTap;
  }

  hideCornerButton(): void {
    this.cornerButton.style.display = 'none';
    this.cornerHandler = null;
  }

  /** Blocking screen: message plus an optional action button. */
  showPanel(text: string, buttonLabel?: string, onButton?: () => void): void {
    this.message.textContent = text;
    if (buttonLabel && onButton) {
      this.button.textContent = buttonLabel;
      this.button.style.display = '';
      this.buttonHandler = onButton;
    } else {
      this.button.style.display = 'none';
      this.buttonHandler = null;
    }
    this.panel.style.display = 'flex';
    this.hideHint();
  }

  hidePanel(): void {
    this.panel.style.display = 'none';
    this.buttonHandler = null;
  }

  /** Non-blocking coaching strip over the live camera feed. */
  showHint(text: string): void {
    this.hint.textContent = text;
    this.hint.style.display = '';
    this.hidePanel();
  }

  hideHint(): void {
    this.hint.style.display = 'none';
  }

  hideAll(): void {
    this.hidePanel();
    this.hideHint();
  }
}
