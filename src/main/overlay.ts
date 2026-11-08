import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { IPC, type OverlayPayload, type Point } from '../shared/types';
import { desktopDipToLocal } from '../shared/coords';

export interface OverlayController {
  /** tipDesktopDip: Ziel in Desktop-DIP oder null für reinen Text. */
  show(tipDesktopDip: Point | null, text: string): Promise<void>;
  hide(): void;
}

/**
 * Transparentes, always-on-top, klickdurchlässiges Fenster über dem Bildschirm, auf dem das Ziel liegt.
 * Per setContentProtection aus Screenshots ausgeschlossen, damit das LLM seinen eigenen Pfeil nicht sieht.
 */
export class OverlayWindow implements OverlayController {
  private win: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;

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

  async show(tipDesktopDip: Point | null, text: string): Promise<void> {
    const win = this.ensure();
    await this.ready;
    const display = tipDesktopDip
      ? screen.getDisplayNearestPoint({ x: Math.round(tipDesktopDip.x), y: Math.round(tipDesktopDip.y) })
      : screen.getPrimaryDisplay();
    win.setBounds(display.bounds);
    const payload: OverlayPayload = {
      tip: tipDesktopDip ? desktopDipToLocal(tipDesktopDip, display.bounds) : null,
      text,
      viewport: { width: display.bounds.width, height: display.bounds.height },
    };
    win.webContents.send(IPC.overlayShow, payload);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.showInactive();
  }

  /** Nur für den Selbsttest. */
  debugState(): { exists: boolean; visible: boolean; bounds: Electron.Rectangle | null } {
    const w = this.win && !this.win.isDestroyed() ? this.win : null;
    return { exists: !!w, visible: !!w?.isVisible(), bounds: w ? w.getBounds() : null };
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
