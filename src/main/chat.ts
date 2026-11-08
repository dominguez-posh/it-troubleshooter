import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import type { Rect } from '../shared/coords';
import { IPC, type ChatMoveRequest } from '../shared/types';
import { CHAT_MIN_SIZE, validateChatBounds } from '../shared/windowBounds';

export interface ChatBoundsStore {
  readonly chatBounds: Rect | null;
  setChatBounds(r: Rect): void;
}

const HISTORY_EXTRA = 170;
const STEP = 24;

/**
 * Kleines Begleit-Chatfenster: frameless, always-on-top, verschiebbar (Titelleiste, Alt+Pfeile) und in der Größe änderbar.
 * Standardmäßig minimal; der Verlauf klappt nur auf Wunsch auf und das Fenster springt danach auf die Minimalgröße zurück.
 * Per setContentProtection aus Aufnahmen ausgeschlossen.
 */
export class ChatWindow {
  private win: BrowserWindow | null = null;
  private expanded = false;
  private compactHeight = 0;
  /** Tatsächliche Höhe nach dem letzten Zuklappen (zur Erkennung manueller Größenänderung, Rundungsfehler ignorieren). */
  private lastCollapsedHeight = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly store: ChatBoundsStore) {}

  get webContents(): Electron.WebContents | null {
    return this.win && !this.win.isDestroyed() ? this.win.webContents : null;
  }
  get isOpen(): boolean {
    return !!this.webContents;
  }

  private areas(): { all: Rect[]; primary: Rect } {
    return { all: screen.getAllDisplays().map((d) => d.workArea), primary: screen.getPrimaryDisplay().workArea };
  }

  open(focusInput = false): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.showInactive();
      if (focusInput) this.focusInput();
      return;
    }
    const { all, primary } = this.areas();
    const b = validateChatBounds(this.store.chatBounds, all, primary);
    const win = new BrowserWindow({
      ...b,
      minWidth: CHAT_MIN_SIZE.width,
      minHeight: CHAT_MIN_SIZE.height,
      frame: false,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      title: 'IT-Troubleshooter Chat',
      backgroundColor: '#1a202b',
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'chat-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.setContentProtection(true);
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.once('ready-to-show', () => {
      win.showInactive();
      if (focusInput) this.focusInput();
    });
    const scheduleSave = () => {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.save(), 400);
    };
    win.on('moved', scheduleSave);
    win.on('resized', scheduleSave);
    win.on('closed', () => {
      this.win = null;
      this.expanded = false;
    });
    this.expanded = false;
    this.win = win;
    void win.loadFile(join(__dirname, '..', 'chat', 'chat.html'));
  }

  /** Gemerkt wird immer die kompakte Größe, nie die aufgeklappte. */
  private save(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const b = this.win.getBounds();
    this.store.setChatBounds({ ...b, height: this.expanded ? this.compactHeight : b.height });
  }

  close(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.save();
    if (this.win && !this.win.isDestroyed()) this.win.close();
    this.win = null;
  }

  destroy(): void {
    this.close();
  }

  focusInput(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.show();
    this.win.focus();
    this.win.webContents.focus();
    this.win.webContents.send(IPC.chatFocusInput);
  }

  /** Tastatursteuerung: Alt+Pfeile verschieben, Alt+Umschalt+Pfeile ändern die Größe. */
  move(req: ChatMoveRequest): void {
    if (!this.win || this.win.isDestroyed()) return;
    const b = this.win.getBounds();
    const next = { ...b };
    if (req.mode === 'move') {
      next.x += req.dx * STEP;
      next.y += req.dy * STEP;
    } else {
      next.width += req.dx * STEP;
      next.height += req.dy * STEP;
      if (this.expanded) this.compactHeight += req.dy * STEP;
    }
    const { all, primary } = this.areas();
    const ok = validateChatBounds(next, all, primary);
    this.win.setBounds(ok);
    this.save();
  }

  /** Verlauf auf- oder zuklappen; zu springt auf die kompakte Höhe zurück. */
  setExpanded(on: boolean): void {
    if (!this.win || this.win.isDestroyed() || on === this.expanded) return;
    const b = this.win.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    if (on) {
      if (!this.compactHeight || Math.abs(b.height - this.lastCollapsedHeight) > 3) this.compactHeight = b.height;
      const h = Math.min(b.height + HISTORY_EXTRA, area.height);
      const y = Math.min(b.y, area.y + area.height - h);
      this.expanded = true;
      this.win.setBounds({ ...b, y: Math.max(area.y, y), height: h });
    } else {
      this.expanded = false;
      const target = Math.max(CHAT_MIN_SIZE.height, this.compactHeight);
      this.win.setBounds({ ...b, height: target });
      // DPI-Rundung: einmal korrigieren, damit das Fenster nicht bei jedem Auf-/Zuklappen wächst.
      const diff = this.win.getBounds().height - target;
      if (diff !== 0) this.win.setBounds({ ...this.win.getBounds(), height: target - diff });
      this.lastCollapsedHeight = this.win.getBounds().height;
    }
  }

  /** Nur für den Selbsttest. */
  debugState(): { open: boolean; bounds: Electron.Rectangle | null } {
    return { open: this.isOpen, bounds: this.win && !this.win.isDestroyed() ? this.win.getBounds() : null };
  }
}
