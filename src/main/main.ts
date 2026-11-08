import { app, BrowserWindow, dialog, globalShortcut, ipcMain, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeActivity } from '../shared/activityText';
import { fallbackSummary } from '../shared/timeEntry';
import { MANUAL_STATUSES, type IncidentStatus, type TimeEntryDraft, type TimeEntryStatus } from '../shared/incident';
import {
  IPC,
  type AppError,
  type CostAction,
  type RecResponse,
  type Result,
  type ServerAccess,
  type SessionView,
  type SettingsPatch,
  type StepOutcome,
} from '../shared/types';
import { ActivityTracker } from './activity';
import { AutoAdvance } from './autoAdvance';
import { electronCapturer, OWN_WINDOW_TITLE } from './capture';
import type { Capturer } from './captureTypes';
import { ChatWindow } from './chat';
import { CostGuard, formatEur } from './cost';
import { createFakeCapturer } from './fakeCapture';
import { WindowsForegroundProbe } from './foreground';
import { IncidentManager } from './incidents';
import { IncidentStore } from './incidentStore';
import { KeyStore } from './keystore';
import { createDefaultRegistry, LlmError } from './llm';
import { OverlayWindow } from './overlay';
import { SessionService, toAppError } from './session';
import { CALL_SHORTCUT, CHAT_SHORTCUT, SettingsStore } from './settings';

void ActivityTracker;

// Selbsttest: eigener, temporärer Datenordner (keine echten Fälle oder Einstellungen berühren).
const selftestDir = process.env['ITT_SELFTEST'] === '1' ? mkdtempSync(join(tmpdir(), 'itt-selftest-')) : null;
if (selftestDir) app.setPath('userData', selftestDir);

let mainWindow: BrowserWindow | null = null;
const registry = createDefaultRegistry();
let keys: KeyStore;
let settings: SettingsStore;
let sessions: SessionService;
let incidents: IncidentManager;
let cost: CostGuard;
const overlay = new OverlayWindow();
let chat: ChatWindow;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let pillTimer: ReturnType<typeof setInterval> | null = null;

/** Echte Aufnahme nur im normalen Betrieb. Selbsttest: Fake-Frames, außer ITT_SELFTEST_CAPTURE=1 (ausdrückliches Opt-in). */
const useFakeCapture = process.env['ITT_SELFTEST'] === '1' && process.env['ITT_SELFTEST_CAPTURE'] !== '1';
const capturer: Capturer = useFakeCapture ? createFakeCapturer() : electronCapturer;

function userError(e: unknown): AppError {
  return toAppError(e);
}

const isMain = (e: IpcMainInvokeEvent): boolean => !!mainWindow && e.sender === mainWindow.webContents;
const isChat = (e: IpcMainInvokeEvent): boolean => !!chat.webContents && e.sender === chat.webContents;

const str = (v: unknown, max = 5000): string => {
  if (typeof v !== 'string' || v.length > max) throw new Error('Ungültiger Parameter.');
  return v;
};
const optStr = (v: unknown, max = 5000): string | undefined => (v === undefined || v === null ? undefined : str(v, max));

type Who = 'main' | 'chat' | 'any';
function allowed(e: IpcMainInvokeEvent, who: Who): void {
  const ok = who === 'main' ? isMain(e) : who === 'chat' ? isChat(e) : isMain(e) || isChat(e);
  if (!ok) throw new Error('Nicht erlaubter Aufrufer.');
}

/** Handler, der einen Wert liefert (wird in Result verpackt). */
function hv<T>(channel: string, who: Who, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => T | Promise<T>): void {
  ipcMain.handle(channel, async (e, ...a): Promise<Result<T>> => {
    try {
      allowed(e, who);
      return { ok: true, value: await fn(e, ...a) };
    } catch (err) {
      return { ok: false, error: userError(err) };
    }
  });
}
/** Handler, der selbst ein Result liefert. */
function hr<T>(channel: string, who: Who, fn: (e: IpcMainInvokeEvent, ...a: unknown[]) => Promise<Result<T>>): void {
  ipcMain.handle(channel, async (e, ...a): Promise<Result<T>> => {
    try {
      allowed(e, who);
      return await fn(e, ...a);
    } catch (err) {
      return { ok: false, error: userError(err) };
    }
  });
}

function broadcast(view: SessionView): void {
  for (const wc of [mainWindow?.webContents, chat.webContents]) {
    if (wc && !wc.isDestroyed()) wc.send(IPC.sessionChanged, view);
  }
}

function applyCaptureProtection(): void {
  mainWindow?.setContentProtection(settings.excludeMainWindow);
}

function applyShortcuts(): void {
  globalShortcut.unregisterAll();
  if (settings.chatShortcut) globalShortcut.register(CHAT_SHORTCUT, () => chat.open(true));
  if (settings.callShortcut) {
    globalShortcut.register(CALL_SHORTCUT, () => {
      chat.open(true);
      void sessions.startCall();
    });
  }
}

/** Statuspill im Overlay: erst bei längerer Wartezeit sichtbar (> 3 s) oder bei Kostenwarnung. */
function updatePill(): void {
  if (!settings.activityPill) return overlay.setPill(null);
  const v = sessions.view();
  const a = v.activity;
  if (v.cost.level !== 'ok' && v.cost.unacknowledged) {
    const lim = v.cost.limitEur;
    return overlay.setPill(v.cost.level === 'limit' ? 'Limit erreicht - pausiert' : `Warnung: ${formatEur(v.cost.periodEur)}${lim !== null ? ` von ${formatEur(lim)}` : ''}`);
  }
  const busy = !['idle', 'paused', 'waiting_customer', 'please_click'].includes(a.kind);
  if (busy && Date.now() - a.since > 3000) overlay.setPill(describeActivity(a, Date.now()).text);
  else overlay.setPill(null);
}

function registerIpc(): void {
  ipcMain.handle(IPC.getSettings, (e) => {
    allowed(e, 'main');
    return settings.view();
  });
  hv(IPC.updateSettings, 'main', (_e, patch) => {
    const p = patch as SettingsPatch;
    if (!p || typeof p !== 'object') throw new Error('Ungültiger Parameter.');
    if (p.providerId !== undefined) str(p.providerId, 40);
    settings.update(p);
    applyCaptureProtection();
    applyShortcuts();
    sessions['notify']();
    return settings.view();
  });
  hv(IPC.setApiKey, 'main', (_e, providerId, key) => {
    const id = str(providerId, 40);
    if (!registry.has(id)) throw new Error('Unbekannter Provider.');
    keys.set(id, str(key, 500));
    return settings.view();
  });
  hv(IPC.clearApiKey, 'main', (_e, providerId) => {
    const id = str(providerId, 40);
    if (!registry.has(id)) throw new Error('Unbekannter Provider.');
    keys.clear(id);
    return settings.view();
  });
  hv(IPC.listModels, 'main', async (_e, providerId) => {
    const id = str(providerId, 40);
    const def = registry.get(id);
    if (def.requiresKey && !keys.get(id)) throw new LlmError('no_key', 'Bitte zuerst einen API-Key hinterlegen.');
    const models = settings.tierModels(id);
    const p = def.create({ getApiKey: () => keys.get(id), getModel: (t) => models[t] });
    return p.listModels ? await p.listModels() : def.knownModels;
  });
  hv(IPC.listSources, 'main', () => capturer.listSources());

  // ----- Sitzung (Hauptfenster) -----
  ipcMain.handle(IPC.getSession, (e) => {
    allowed(e, 'any');
    return sessions.view();
  });
  hr(IPC.startSession, 'main', (_e, problem) => sessions.start(str(problem, 10_000)));
  hr(IPC.startRemote, 'any', (_e, sourceId) => sessions.startRemote(optStr(sourceId, 100)));
  hr(IPC.askFirst, 'main', () => sessions.askFirst());
  hr(IPC.addNote, 'main', (_e, text) => sessions.note(str(text, 2000)));
  hr(IPC.react, 'main', (_e, r, c, ack) => reactArgs(r, c, ack));
  hr(IPC.serverAccess, 'main', (_e, a) => sessions.setServerAccess(accessArg(a)));
  hr(IPC.retryLast, 'any', () => sessions.retryLast());
  hr(IPC.abortRequest, 'any', (_e, manual) => sessions.abortRequest(manual === true));
  hr(IPC.costAction, 'main', (_e, a) => sessions.costAction(costArg(a)));
  hr(IPC.startCall, 'main', () => sessions.startCall());
  hr(IPC.callInput, 'main', (_e, t, q) => sessions.callInput(str(t, 2000), optStr(q, 300)));
  hr(IPC.endCall, 'main', (_e, to) => sessions.endCall(to === true));
  hr(IPC.reportStep, 'main', (_e, o, c) => sessions.report(outcomeArg(o), optStr(c, 2000)));
  hr(IPC.finishSession, 'main', (_e, r) => sessions.finish(r === 'unsolved' ? 'unsolved' : 'solved'));
  hr(IPC.pauseSession, 'main', () => sessions.pause());
  hr(IPC.setTimerRunning, 'main', (_e, r) => sessions.setTimerRunning(r === true));
  hr(IPC.resetSession, 'main', () => sessions.reset());
  hr(IPC.toggleOverlay, 'main', () => sessions.toggleOverlay());
  hv(IPC.openChat, 'main', () => {
    chat.open(true);
    return null;
  });

  // ----- Begleit-Chat -----
  ipcMain.handle(IPC.chatState, (e) => {
    allowed(e, 'chat');
    return { session: sessions.view(), reevaluate: settings.chatReevaluate };
  });
  hr(IPC.chatReport, 'chat', (_e, o, c) => sessions.report(outcomeArg(o), optStr(c, 2000)));
  hr(IPC.chatAddNote, 'chat', (_e, text) => sessions.note(str(text, 2000)));
  hr(IPC.chatReact, 'chat', (_e, r, c, ack) => reactArgs(r, c, ack));
  hr(IPC.chatServerAccess, 'chat', (_e, a) => sessions.setServerAccess(accessArg(a)));
  hr(IPC.chatRetry, 'chat', () => sessions.retryLast());
  hr(IPC.chatAbort, 'chat', (_e, manual) => sessions.abortRequest(manual === true));
  hr(IPC.chatStartCall, 'chat', () => sessions.startCall());
  hr(IPC.chatCallInput, 'chat', (_e, t, q) => sessions.callInput(str(t, 2000), optStr(q, 300)));
  hr(IPC.chatEndCall, 'chat', (_e, to) => sessions.endCall(to === true));
  hv(IPC.chatSetReevaluate, 'chat', (_e, v) => {
    settings.update({ chatReevaluate: v === true });
    return settings.chatReevaluate;
  });
  ipcMain.handle(IPC.chatMove, (e, req) => {
    allowed(e, 'chat');
    const r = req as { mode?: unknown; dx?: unknown; dy?: unknown };
    const ok = (v: unknown): v is -1 | 0 | 1 => v === -1 || v === 0 || v === 1;
    if ((r.mode === 'move' || r.mode === 'resize') && ok(r.dx) && ok(r.dy)) chat.move({ mode: r.mode, dx: r.dx, dy: r.dy });
  });
  ipcMain.handle(IPC.chatHistory, (e, on) => {
    allowed(e, 'chat');
    chat.setExpanded(on === true);
  });
  ipcMain.handle(IPC.chatClose, (e) => {
    allowed(e, 'chat');
    chat.close();
  });

  // ----- Incidents -----
  hv(IPC.listIncidents, 'main', () => incidents.list());
  hv(IPC.getIncident, 'main', (_e, id) => incidents.get(str(id, 60)));
  hv(IPC.updateIncident, 'main', (_e, id, patch) => {
    const p = (patch ?? {}) as Record<string, unknown>;
    const out: { title?: string; customer?: string; supporterNotes?: string } = {};
    if (p['title'] !== undefined) out.title = str(p['title'], 200);
    if (p['customer'] !== undefined) out.customer = str(p['customer'], 200);
    if (p['supporterNotes'] !== undefined) out.supporterNotes = str(p['supporterNotes'], 5000);
    return incidents.update(str(id, 60), out);
  });
  hv(IPC.setIncidentStatus, 'main', (_e, id, status) => {
    if (!MANUAL_STATUSES.includes(status as IncidentStatus)) throw new Error('Ungültiger Status.');
    return incidents.setStatus(str(id, 60), status as IncidentStatus);
  });
  hv(IPC.setIncidentDuration, 'main', (_e, id, minutes) => incidents.setDuration(str(id, 60), Number(minutes)));
  hv(IPC.deleteIncident, 'main', (_e, id) => {
    incidents.delete(str(id, 60));
    return null;
  });
  hr(IPC.resumeIncident, 'main', (_e, id, reason) => sessions.resume(str(id, 60), optStr(reason, 1000)));
  hv(IPC.finishIncident, 'main', (_e, id, r) => incidents.finishInactive(str(id, 60), r === 'unsolved' ? 'unsolved' : 'solved'));

  // ----- Zeiterfassung -----
  hv(IPC.prepareTimeEntry, 'main', async (_e, id, result) => {
    const r = result === 'unsolved' ? 'unsolved' : 'solved';
    const inc = incidents.get(str(id, 60));
    const llm = await sessions.summarize(inc, r);
    return incidents.draftFor(inc.id, r, llm ?? fallbackSummary(inc, r), llm ? 'llm' : 'fallback');
  });
  hv(IPC.saveTimeEntry, 'main', (_e, draft) => incidents.saveEntry(draft as TimeEntryDraft));
  hv(IPC.listTimeEntries, 'main', () => incidents.listEntries());
  hv(IPC.setTimeEntriesStatus, 'main', (_e, ids, status) => {
    if (!Array.isArray(ids) || status !== 'open' && status !== 'transferred') throw new Error('Ungültiger Parameter.');
    return incidents.setEntriesStatus(ids.map((i) => str(i, 60)), status as TimeEntryStatus);
  });
  hv(IPC.deleteTimeEntry, 'main', (_e, id) => incidents.deleteEntry(str(id, 60)));
  hv(IPC.exportTimeEntriesCsv, 'main', async (_e, ids) => {
    if (!Array.isArray(ids)) throw new Error('Ungültiger Parameter.');
    return incidents.exportCsv(ids.map((i) => str(i, 60)), async () => {
      const r = await dialog.showSaveDialog(mainWindow!, { title: 'Zeiterfassung exportieren', defaultPath: 'zeiterfassung.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
      return r.canceled || !r.filePath ? null : r.filePath;
    });
  });
}

function reactArgs(r: unknown, c: unknown, ack: unknown): Promise<Result<SessionView>> {
  if (r !== 'done' && r !== 'other' && r !== 'later') throw new Error('Ungültige Reaktion.');
  return sessions.react(r as RecResponse, optStr(c, 1000), ack === true);
}

function accessArg(a: unknown): ServerAccess {
  const o = (a ?? {}) as Record<string, unknown>;
  const out: ServerAccess = { state: o['state'] as ServerAccess['state'] };
  if (o['kind'] !== undefined) out.kind = o['kind'] as NonNullable<ServerAccess['kind']>;
  if (o['note'] !== undefined) out.note = str(o['note'], 100);
  return out;
}

function costArg(a: unknown): CostAction {
  const o = (a ?? {}) as Record<string, unknown>;
  if (o['type'] === 'ack' || o['type'] === 'once' || o['type'] === 'reset') return { type: o['type'] };
  if (o['type'] === 'raise' && typeof o['eur'] === 'number') return { type: 'raise', eur: o['eur'] };
  throw new Error('Ungültige Aktion.');
}

function outcomeArg(o: unknown): StepOutcome {
  if (o !== 'done' && o !== 'failed') throw new Error('Ungültiges Ergebnis.');
  return o;
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1040,
    height: 800,
    minWidth: 760,
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
  });
  void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}

async function boot(): Promise<void> {
  const dir = app.getPath('userData');
  keys = new KeyStore(dir, safeStorage);
  settings = new SettingsStore(dir, registry, keys);
  const store = new IncidentStore(dir);
  store.load();
  incidents = new IncidentManager(store);
  incidents.recoverAfterCrash();
  cost = new CostGuard(dir, () => settings.costConfig(), Date.now, () => settings.priceOverrides());
  chat = new ChatWindow({
    get chatBounds() {
      return settings.chatBounds;
    },
    setChatBounds: (r) => settings.setChatBounds(r),
  });

  const auto = new AutoAdvance({
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    grab: (sid) => capturer.grabFrame(sid),
    foreground: new WindowsForegroundProbe(),
    allow: () => cost.canAfford(0.02),
  });

  sessions = new SessionService({
    registry,
    capturer,
    overlay,
    persistence: incidents,
    cost,
    autoAdvance: auto,
    getProviderId: () => settings.providerId,
    getApiKey: (id) => keys.get(id),
    getModels: (id) => settings.tierModels(id),
    getRouting: () => settings.routing(),
    getFailedThreshold: () => settings.failedThreshold,
    getDropBack: () => settings.dropBackToBase,
    getCaptureOptions: () => settings.captureOptions(),
    getReevaluate: () => settings.chatReevaluate,
    getAutoAdvance: () => settings.autoAdvance,
    getPriceOverrides: () => settings.priceOverrides(),
    onChange: broadcast,
    onStart: () => chat.open(false),
    onEnd: () => chat.close(),
  });

  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  registerIpc();
  mainWindow = createMainWindow();
  applyCaptureProtection();
  applyShortcuts();
  heartbeat = setInterval(() => incidents.heartbeat(), 30_000);
  pillTimer = setInterval(updatePill, 1000);

  if (process.env['ITT_SELFTEST'] === '1') {
    const { runSelfTest } = await import('./selftest');
    mainWindow.webContents.once('did-finish-load', () => {
      void runSelfTest({ win: mainWindow!, overlay, chat, settings, sessions, incidents, capturer });
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
  app.on('before-quit', () => {
    if (heartbeat) clearInterval(heartbeat);
    if (pillTimer) clearInterval(pillTimer);
    globalShortcut.unregisterAll();
    // Laufende Sitzung sauber als "pausiert" ablegen (Zeitmessung stoppt, Status bleibt erhalten).
    void sessions?.pause();
    overlay.destroy();
  });
  void app.whenReady().then(boot);
}
