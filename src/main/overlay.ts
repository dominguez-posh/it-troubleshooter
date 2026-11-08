import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { IPC, type OverlayPayload, type Point } from '../shared/types';
import { desktopDipToLocal } from '../shared/coords';

export interface OverlayController {
  /** tipDesktopDip: Ziel in Desktop-DIP oder null für reinen Text. */
  show(tipDesktopDip: Point | null, text: string): Promise<void>;
  /** Blendet den Pfeil aus (ein Statuspill bleibt ggf. stehen). */
  hide(): void;
  /** Kleines Statuspill (z. B. bei längeren Wartezeiten); null blendet es aus. */
  setPill(text: string | null): void;
}

/**
 * Transparentes, always-on-top, klickdurchlässiges Fenster über dem Bildschirm, auf dem das Ziel liegt.
 * Per setContentProtection aus Screenshots ausgeschlossen, damit das LLM seinen eigenen Pfeil nicht sieht.
 */
export class OverlayWindow implements OverlayController {
  private win: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private arrow: { tip: Point | null; text: string } | null = null;
  private pill: string | null = null;
  private displayId: number | null = null;

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      fullscreenable: false,
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'overlay-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    win.setContentProtection(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.ready = win.loadFile(join(__dirname, '..', 'overlay', 'overlay.html'));
    win.on('closed', () => {
      this.win = null;
      this.ready = null;
    });
    this.win = win;
    return win;
  }

  private async refresh(tipDesktopDip?: Point | null): Promise<void> {
    if (!this.arrow && !this.pill) {
      if (this.win && !this.win.isDestroyed()) this.win.hide();
      return;
    }
    const win = this.ensure();
    await this.ready;
    const display =
      tipDesktopDip
        ? screen.getDisplayNearestPoint({ x: Math.round(tipDesktopDip.x), y: Math.round(tipDesktopDip.y) })
        : (screen.getAllDisplays().find((d) => d.id === this.displayId) ?? screen.getPrimaryDisplay());
    this.displayId = display.id;
    win.setBounds(display.bounds);
    const payload: OverlayPayload = {
      tip: this.arrow?.tip ? desktopDipToLocal(this.arrow.tip, display.bounds) : null,
      text: this.arrow?.text ?? '',
      viewport: { width: display.bounds.width, height: display.bounds.height },
      pill: this.pill,
    };
    win.webContents.send(IPC.overlayShow, payload);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.showInactive();
  }

  async show(tipDesktopDip: Point | null, text: string): Promise<void> {
    this.arrow = { tip: tipDesktopDip, text };
    await this.refresh(tipDesktopDip);
  }

  hide(): void {
    this.arrow = null;
    void this.refresh();
  }

  setPill(text: string | null): void {
    if (text === this.pill) return;
    this.pill = text;
    void this.refresh();
  }

  /** Nur für den Selbsttest. */
  debugState(): { exists: boolean; visible: boolean; bounds: Electron.Rectangle | null } {
    const w = this.win && !this.win.isDestroyed() ? this.win : null;
    return { exists: !!w, visible: !!w?.isVisible(), bounds: w ? w.getBounds() : null };
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
