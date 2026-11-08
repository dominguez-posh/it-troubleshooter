import { app, type BrowserWindow } from 'electron';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Capturer } from './captureTypes';
import type { ChatWindow } from './chat';
import { buildDocModel, writeDocPackage } from './docs';
import { electronImageOps } from './imageOps';
import type { IncidentManager } from './incidents';
import type { OverlayWindow } from './overlay';
import type { SessionService } from './session';
import type { SettingsStore } from './settings';
import type { ShotStore } from './shots';

interface Ctx {
  win: BrowserWindow;
  overlay: OverlayWindow;
  chat: ChatWindow;
  settings: SettingsStore;
  sessions: SessionService;
  incidents: IncidentManager;
  capturer: Capturer;
  shotStore: ShotStore;
}

/**
 * Nur mit ITT_SELFTEST=1: treibt die echte (neue) Oberfläche mit dem Mock-Provider durch – Willkommens-Assistent, Start, Klären,
 * Fernwartung, Abschluss, Arbeitszeit, Wiederöffnen, Telefonat, Doku. Die Aufnahme ist SIMULIERT (Fake-Quelle), außer
 * ITT_SELFTEST_CAPTURE=1 wurde ausdrücklich gesetzt. Mit ITT_SELFTEST_SHOTS=<Ordner> rendert der Test die EIGENEN App-Fenster
 * (webContents.capturePage, kein desktopCapturer) als PNG in diesen Ordner, um Layout und Texte zu prüfen.
 */
export async function runSelfTest(c: Ctx): Promise<void> {
  const out: Record<string, unknown> = { checks: [] as string[], capture: process.env['ITT_SELFTEST_CAPTURE'] === '1' ? 'echt (Opt-in)' : 'simuliert' };
  const checks = out['checks'] as string[];
  const shotsDir = process.env['ITT_SELFTEST_SHOTS'];
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  const js = <T>(code: string): Promise<T> => c.win.webContents.executeJavaScript(code, true) as Promise<T>;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (code: string, ms = 15_000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await js<boolean>(code)) return true;
      await sleep(120);
    }
    return false;
  };
  const check = (ok: boolean, name: string) => checks.push(ok ? name : `FEHLER: ${name}`);
  c.win.webContents.on('console-message', (_e, level, message) => {
    if (level < 3) return;
    const arr = (out['rendererErrors'] ??= []) as string[];
    arr.push(message.slice(0, 200));
  });
  /** Rendert NUR das App-Fenster (eigener Inhalt, Mock-Daten) in eine PNG-Datei im Temp-Ordner. */
  const snap = async (name: string, win: { webContents: Electron.WebContents } | null = c.win) => {
    if (!shotsDir || !win) return;
    await sleep(250);
    try {
      const img = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      writeFileSync(join(shotsDir, `${name}.png`), img.toPNG());
    } catch (e) {
      ((out['snapErrors'] ??= []) as string[]).push(`${name}: ${(e as Error).message}`);
    }
  };
  const text = (id: string) => js<string>(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const clickText = (scope: string, label: string) =>
    js<boolean>(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find(x => x.textContent.trim() === ${JSON.stringify(label)} && !x.disabled); if (!b) return false; b.click(); return true; })()`);
  try {
    await js('window.confirm = () => true; 0');

    // 1. Willkommens-Assistent beim ersten Start
    check(await waitFor('document.getElementById("wizard").open'), 'assistent-erscheint-beim-ersten-start');
    out['wizardAtStart'] = !c.settings.view().onboardingDone;
    await snap('01-assistent-anbieter');
    await js('document.getElementById("wiz-next").click(); 0'); // Anbieter -> Datenschutz
    check((await text('wiz-count')).includes('2 von 4'), 'assistent-schritt-2');
    await snap('02-assistent-datenschutz');
    await js('document.getElementById("wiz-next").click(); 0'); // -> Kosten
    await js('document.getElementById("wiz-warn").value = "5"; document.getElementById("wiz-next").click(); 0'); // -> Testlauf
    await snap('03-assistent-testlauf');
    check((await text('wiz-next')).includes('Testlauf starten'), 'assistent-testlauf-button');
    await js('document.getElementById("wiz-next").click(); 0');
    check(await waitFor('!document.getElementById("wizard").open'), 'assistent-schliesst');
    check(c.settings.view().onboardingDone && c.settings.view().costWarnEur === 5, 'assistent-einmalig-und-warnung-gespeichert');

    // 2. Erste Einschätzung (ohne Screenshot): die eine Anweisung
    check(await waitFor('!document.getElementById("view-case").hidden && document.getElementById("card").textContent.includes("Fernwartung")'), 'testlauf-zeigt-anweisung');
    check((await text('where')).length > 20, 'wo-bin-ich-satz');
    check((await js<number>('document.querySelectorAll("#stepper li").length')) === 4, 'vier-schritte-im-fortschritt');
    await sleep(500);
    out['chat'] = c.chat.debugState();
    await snap('04-fall-einschaetzung');
    await snap('05-mini-fenster', c.chat.webContents ? { webContents: c.chat.webContents } : null);

    // 3. Gemeinsam lösen: Fernwartung mit simulierten Frames
    check(await clickText('#card', 'Fernwartung starten'), 'hero-button-fernwartung');
    check(await waitFor('document.getElementById("card").textContent.includes("Startmenü")'), 'schritt-1-mit-pfeil');
    out['overlay'] = c.overlay.debugState();
    await snap('06-fall-schritt');
    await snap('07-mini-fenster-schritt', c.chat.webContents ? { webContents: c.chat.webContents } : null);
    for (let i = 0; i < 3; i++) {
      const before = await text('card');
      check(await clickText('#card', 'Erledigt'), `erledigt-klick-${i + 1}`);
      check(await waitFor(`document.getElementById("card").textContent !== ${JSON.stringify(before)}`), `weiter-${i + 1}`);
    }
    check(await waitFor('document.getElementById("card").textContent.includes("abschließen")'), 'abschluss-vorschlag');

    // 3b. Bildschirmfotos (simuliert) lokal gespeichert, lesbar, Schwärzen, Doku-Export
    const pre = c.incidents.list()[0]!;
    const refs = c.incidents.shotRefs(pre.id);
    out['shots'] = refs.length;
    check(refs.length >= 3, 'bildschirmfotos-pro-schritt-gespeichert');
    const first = refs[0]!;
    const raw = c.shotStore.read(pre.id, first, 'original');
    check(raw.length > 0, 'bildschirmfoto-lesbar-und-entschluesselt');
    const red = c.shotStore.redact(pre.id, first, [{ x: 0, y: 0, w: 1, h: 1 }], electronImageOps);
    c.incidents.replaceShot(pre.id, red);
    check(c.shotStore.read(pre.id, red, 'original').equals(raw) && c.shotStore.read(pre.id, red, 'redacted').length > 0, 'schwaerzen-original-bleibt');
    const model = buildDocModel(c.incidents.get(pre.id), { variant: 'full', steps: [1, 2, 3], summary: 'Selbsttest' }, (r) => c.shotStore.exportImage(pre.id, r, electronImageOps), Date.now());
    const pkg = writeDocPackage(mkdtempSync(join(tmpdir(), 'itt-doc-')), 'Selbsttest-Doku', model, false);
    check(pkg.files >= 3, 'doku-export');
    rmSync(join(pkg.dir, '..'), { recursive: true, force: true });

    // 4. Abschließen und dokumentieren: Arbeitszeit-Dialog
    check(await clickText('#card', 'Fall abschließen'), 'hero-button-abschliessen');
    check(await waitFor('document.getElementById("time-dialog").open && document.getElementById("td-desc").value.length > 0'), 'arbeitszeit-dialog-mit-vorschlag');
    await snap('08-arbeitszeit-dialog');
    await js('document.getElementById("td-save").click(); 0');
    check(await waitFor('!document.getElementById("time-dialog").open'), 'zeiteintrag-gespeichert');
    check(c.incidents.listEntries().length === 1, 'ein-zeiteintrag');
    await snap('09-fall-gelöst');

    // 5. Fallliste (Karten), Einstellungen einfach/erweitert, Arbeitszeit-Ansicht
    check(await waitFor('document.querySelectorAll("#case-list .case").length === 1'), 'fall-als-karte');
    const card = await text('case-list');
    check(card.includes('Gelöst') && card.includes('zuletzt'), 'karte-zeigt-status-und-zeit');
    await js('document.getElementById("btn-new-case").click(); 0');
    check(await waitFor('!document.getElementById("view-home").hidden'), 'neuer-fall-zeigt-startbildschirm');
    await snap('10-startbildschirm');
    await js('document.getElementById("btn-settings").click(); 0');
    const advHidden = await js<boolean>('getComputedStyle(document.getElementById("adv-settings")).display === "none"');
    check(advHidden, 'einfach-modus-versteckt-erweitertes');
    await snap('11-einstellungen-einfach');
    await js('document.getElementById("chk-advanced").click(); 0');
    check(await waitFor('getComputedStyle(document.getElementById("adv-settings")).display !== "none"'), 'erweitert-zeigt-erweitertes');
    await snap('12-einstellungen-erweitert');
    await js('document.getElementById("chk-advanced").click(); 0');
    await js('document.getElementById("btn-close-settings").click(); 0');
    await js('document.getElementById("nav-time").click(); 0');
    check(await waitFor('!document.getElementById("view-time").hidden && document.querySelectorAll("#te-list .case").length === 1'), 'arbeitszeit-ansicht');
    await snap('13-arbeitszeit');
    await js('document.getElementById("btn-new-case").click(); 0');
    await js('document.querySelector("#case-list .case").click(); 0');
    check(await waitFor('document.getElementById("inc-dialog").open'), 'fall-dialog');
    await snap('14-fall-dialog');
    await js('document.getElementById("inc-dialog").close(); 0');

    // 6. Wieder öffnen mit Begründung, Telefonat
    const id = c.incidents.list()[0]!.id;
    check(!(await c.sessions.resume(id, '   ')).ok, 'wiederaufnahme-ohne-begruendung-abgelehnt');
    const ok = await c.sessions.resume(id, 'Problem trat nach dem Neustart erneut auf');
    check(ok.ok && ok.value.reopenCount === 1, 'wiederaufnahme-mit-begruendung');
    await c.sessions.pause();
    const call = await c.sessions.startCall();
    check(call.ok && (call.value.call?.questions.length ?? 0) === 5, 'telefonat-startet-mit-5-fragen');
    await js('0');
    await snap('15-telefonat');
    const next = await c.sessions.callInput('Seit gestern, nach dem Update');
    check(next.ok && (next.value.call?.questions.length ?? 0) >= 1, 'telefonat-naechste-fragen');
    await c.sessions.endCall(false);
    await c.sessions.pause();
    out['incidents'] = c.incidents.list().map((i) => ({ status: i.status, durationMs: i.durationMs }));
  } catch (e) {
    checks.push(`FEHLER: ${(e as Error).message}`);
  }
  const file = process.env['ITT_SELFTEST_OUT'];
  const json = JSON.stringify(out, null, 2);
  if (file) writeFileSync(file, json);
  console.log(json);
  process.env['ITT_SELFTEST_CODE'] = checks.some((x) => x.startsWith('FEHLER')) ? '1' : '0';
  app.quit();
}
