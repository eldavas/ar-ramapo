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
    // ?debug=1 — field-testing on-screen console. The engine binary ships
    // no native debug UI: @8thwall/engine-binary's dist/xr.js references
    // "XRExtras.FullWindowCanvas" only as a deprecation-shim string
    // (verified by grepping the installed binary — window.XRExtras is
    // never assigned anywhere in it); XRExtras itself is a separate,
    // hosted-platform-only script this self-hosted setup doesn't load. A
    // phone has no devtools console, so this mirrors console.log/warn/error
    // and uncaught errors onto the screen instead.
    if (new URLSearchParams(window.location.search).has('debug')) {
      installDebugConsole();
    }
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

let debugConsoleInstalled = false;

/**
 * Patches console.log/warn/error (plus window.onerror and
 * unhandledrejection) to also render onto a fixed on-screen strip — the
 * only way to see runtime output on a phone with no attached devtools.
 * z-index 40: above everything else in the app (UxOverlay panel 30, Card
 * 20, markers 10). pointer-events:none so it can never swallow the
 * placement tap or a marker tap underneath it. Idempotent: main() only
 * constructs one UxOverlay per session, but this guards a future caller
 * from double-patching console methods.
 */
function installDebugConsole(): void {
  if (debugConsoleInstalled) return;
  debugConsoleInstalled = true;

  const log = document.createElement('div');
  log.id = 'ar-debug-console';
  log.style.cssText =
    'position:fixed;top:0;left:0;right:0;max-height:38vh;overflow-y:auto;z-index:40;' +
    'background:rgba(0,0,0,0.78);color:#8f8;font:11px/1.4 ui-monospace,monospace;' +
    'padding:4px 6px;white-space:pre-wrap;word-break:break-word;pointer-events:none;';
  document.body.appendChild(log);

  const MAX_LINES = 200;
  const append = (text: string, color: string): void => {
    const row = document.createElement('div');
    row.style.color = color;
    row.textContent = `${new Date().toISOString().slice(11, 23)}  ${text}`;
    log.appendChild(row);
    while (log.childElementCount > MAX_LINES) {
      log.removeChild(log.firstChild as ChildNode);
    }
    log.scrollTop = log.scrollHeight;
  };

  const stringify = (args: unknown[]): string =>
    args
      .map((arg) => {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(' ');

  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args: unknown[]): void => {
    original.log(...args);
    append(stringify(args), '#8f8');
  };
  console.warn = (...args: unknown[]): void => {
    original.warn(...args);
    append(stringify(args), '#fc5');
  };
  console.error = (...args: unknown[]): void => {
    original.error(...args);
    append(stringify(args), '#f66');
  };

  window.addEventListener('error', (event) => {
    append(`[uncaught] ${event.message} (${event.filename}:${event.lineno}:${event.colno})`, '#f66');
  });
  window.addEventListener('unhandledrejection', (event) => {
    append(`[unhandled rejection] ${String(event.reason)}`, '#f66');
  });

  console.log('[ar-debug-console] on-screen logging active');
}
