import { app, BrowserWindow, ipcMain, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { IPC, type AppError, type Result, type SettingsPatch, type StepOutcome } from '../shared/types';
import { electronCapturer, OWN_WINDOW_TITLE } from './capture';
import { KeyStore } from './keystore';
import { createDefaultRegistry, LlmError } from './llm';
import { OverlayWindow } from './overlay';
import { SessionService } from './session';
import { SettingsStore } from './settings';

let mainWindow: BrowserWindow | null = null;

const registry = createDefaultRegistry();
let keys: KeyStore;
let settings: SettingsStore;
let sessions: SessionService;
const overlay = new OverlayWindow();

function userError(e: unknown): AppError {
  if (e instanceof LlmError) return { code: e.code, message: e.message };
  // Eigene, deutsche Fehlermeldungen aus KeyStore/SettingsStore sind unkritisch.
  if (e instanceof Error && /^[A-ZÄÖÜ]/.test(e.message) && e.message.length < 200) return { code: 'internal', message: e.message };
  return { code: 'internal', message: 'Unerwarteter Fehler.' };
}

async function wrap<T>(fn: () => T | Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: userError(e) };
  }
}

function trusted(e: IpcMainInvokeEvent): void {
  if (!mainWindow || e.sender !== mainWindow.webContents) throw new Error('Nicht erlaubter Aufrufer.');
}

const str = (v: unknown, max = 5000): string => {
  if (typeof v !== 'string' || v.length > max) throw new Error('Ungültiger Parameter.');
  return v;
};

function applyCaptureProtection(): void {
  // Hauptfenster aus Screenshots/Aufnahme ausnehmen (SetWindowDisplayAffinity unter Windows).
  mainWindow?.setContentProtection(settings.excludeMainWindow);
}

function registerIpc(): void {
  ipcMain.handle(IPC.getSettings, (e) => {
    trusted(e);
    return settings.view();
  });
  ipcMain.handle(IPC.updateSettings, (e, patch: SettingsPatch) =>
    wrap(() => {
      trusted(e);
      const p: SettingsPatch = {};
      if (patch?.providerId !== undefined) p.providerId = str(patch.providerId, 40);
      if (patch?.model !== undefined) p.model = str(patch.model, 100);
      if (patch?.excludeMainWindow !== undefined) p.excludeMainWindow = patch.excludeMainWindow === true;
      settings.update(p);
      applyCaptureProtection();
      return settings.view();
    }),
  );
  ipcMain.handle(IPC.setApiKey, (e, providerId: unknown, key: unknown) =>
    wrap(() => {
      trusted(e);
      const id = str(providerId, 40);
      if (!registry.has(id)) throw new Error('Unbekannter Provider.');
      keys.set(id, str(key, 500));
      return settings.view();
    }),
  );
  ipcMain.handle(IPC.clearApiKey, (e, providerId: unknown) =>
    wrap(() => {
      trusted(e);
      const id = str(providerId, 40);
      if (!registry.has(id)) throw new Error('Unbekannter Provider.');
      keys.clear(id);
      return settings.view();
    }),
  );
  ipcMain.handle(IPC.listModels, (e, providerId: unknown) =>
    wrap(async () => {
      trusted(e);
      const id = str(providerId, 40);
      const def = registry.get(id);
      if (def.requiresKey && !keys.get(id)) throw new LlmError('no_key', 'Bitte zuerst einen API-Key hinterlegen.');
      const provider = def.create({ getApiKey: () => keys.get(id), getModel: () => settings.modelFor(id) });
      return provider.listModels ? await provider.listModels() : def.knownModels;
    }),
  );
  ipcMain.handle(IPC.listSources, (e) =>
    wrap(() => {
      trusted(e);
      return electronCapturer.listSources();
    }),
  );
  ipcMain.handle(IPC.startSession, async (e, problem: unknown, sourceId: unknown) => {
    try {
      trusted(e);
      return await sessions.start(str(problem, 10_000), str(sourceId, 100));
    } catch (err) {
      return { ok: false, error: userError(err) } satisfies Result<never>;
    }
  });
  ipcMain.handle(IPC.reportStep, async (e, outcome: unknown, comment: unknown) => {
    try {
      trusted(e);
      if (outcome !== 'done' && outcome !== 'failed') throw new Error('Ungültiges Ergebnis.');
      const c = comment === undefined || comment === null ? undefined : str(comment, 2000);
      return await sessions.report(outcome as StepOutcome, c);
    } catch (err) {
      return { ok: false, error: userError(err) } satisfies Result<never>;
    }
  });
  ipcMain.handle(IPC.markSolved, (e) =>
    wrap(async () => {
      trusted(e);
      const r = await sessions.markSolved();
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    }),
  );
  ipcMain.handle(IPC.resetSession, async (e) => {
    try {
      trusted(e);
      return await sessions.reset();
    } catch (err) {
      return { ok: false, error: userError(err) } satisfies Result<never>;
    }
  });
  ipcMain.handle(IPC.toggleOverlay, async (e) => {
    try {
      trusted(e);
      return await sessions.toggleOverlay();
    } catch (err) {
      return { ok: false, error: userError(err) } satisfies Result<never>;
    }
  });
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 980,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    title: OWN_WINDOW_TITLE,
    backgroundColor: '#f6f7f9',
    show: false,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    mainWindow = null;
    overlay.destroy();
  });
  void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}

async function boot(): Promise<void> {
  const dir = app.getPath('userData');
  keys = new KeyStore(dir, safeStorage);
  settings = new SettingsStore(dir, registry, keys);
  sessions = new SessionService({
    registry,
    capturer: electronCapturer,
    overlay,
    getProviderId: () => settings.providerId,
    getModel: (id) => settings.modelFor(id),
    getApiKey: (id) => keys.get(id),
  });

  // Keine Berechtigungen für Webinhalte, keine fremden Verbindungen aus dem Renderer.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  registerIpc();
  mainWindow = createMainWindow();
  applyCaptureProtection();

  if (process.env['ITT_SELFTEST'] === '1') {
    const { runSelfTest } = await import('./selftest');
    mainWindow.webContents.once('did-finish-load', () => {
      void runSelfTest(mainWindow!, overlay, settings);
    });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on('window-all-closed', () => app.quit());
  void app.whenReady().then(boot);
}
