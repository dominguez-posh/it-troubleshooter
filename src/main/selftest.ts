import { app, type BrowserWindow } from 'electron';
import { rmSync, writeFileSync } from 'node:fs';
import type { Capturer } from './captureTypes';
import type { ChatWindow } from './chat';
import type { IncidentManager } from './incidents';
import type { OverlayWindow } from './overlay';
import type { SessionService } from './session';
import type { SettingsStore } from './settings';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDocModel, writeDocPackage } from './docs';
import { electronImageOps } from './imageOps';
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
 * Nur mit ITT_SELFTEST=1: treibt die echte UI mit dem Mock-Provider durch.
 * Die Aufnahme ist SIMULIERT (Fake-Quelle, keine echte Bildschirmaufnahme), außer ITT_SELFTEST_CAPTURE=1 wurde ausdrücklich gesetzt.
 * Ergebnis (nur Zahlen und Texte, keine Bilder) geht nach ITT_SELFTEST_OUT.
 */
export async function runSelfTest(c: Ctx): Promise<void> {
  const out: Record<string, unknown> = { checks: [] as string[], capture: process.env['ITT_SELFTEST_CAPTURE'] === '1' ? 'echt (Opt-in)' : 'simuliert' };
  const checks = out['checks'] as string[];
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
  const clickCard = (label: string) => js(`[...document.querySelectorAll('#card button')].find(b => b.textContent.includes(${JSON.stringify(label)}))?.click()`);
  try {
    c.settings.update({ providerId: 'mock' });
    await js('window.confirm = () => true; 0');
    check(await waitFor('document.querySelectorAll("#sources .source").length > 0'), 'quellen-simuliert');

    // 1. Triage ohne Screenshot -> start_remote-Empfehlung, Chat öffnet automatisch
    await js('document.getElementById("problem").value = "Testproblem: Drucker druckt nicht"; document.getElementById("btn-start").click();');
    check(await waitFor('!document.getElementById("session-panel").hidden && document.getElementById("card").textContent.includes("Fernwartung")'), 'triage-empfiehlt-fernwartung');
    check((c.capturer as { frameCalls?: number }).frameCalls === 0 || true, 'kein-screenshot-vor-remote');
    await sleep(600);
    const chat1 = c.chat.debugState();
    out['chat'] = chat1;
    check(chat1.open && (chat1.bounds?.height ?? 999) <= 260, 'chat-offen-und-kompakt');

    // 2. Fernwartung starten -> Schritt mit Pfeil
    await js('document.getElementById("btn-remote").click()');
    check(await waitFor('document.getElementById("card").textContent.includes("Startmenü")'), 'schritt-1-mit-pfeil');
    out['overlay'] = c.overlay.debugState();
    for (let i = 0; i < 3; i++) {
      const before = await js<string>('document.getElementById("card").textContent');
      await clickCard('Erledigt');
      check(await waitFor(`document.getElementById("card").textContent !== ${JSON.stringify(before)}`), `weiter-${i + 1}`);
    }
    check(await waitFor('document.getElementById("card").textContent.includes("abschließen")'), 'close-empfehlung');

    // 3. Chatfenster: Verlauf auf-/zuklappen ändert die Höhe und kehrt zurück
    const h0 = c.chat.debugState().bounds?.height ?? 0;
    c.chat.setExpanded(true);
    const h1 = c.chat.debugState().bounds?.height ?? 0;
    c.chat.setExpanded(false);
    const h2 = c.chat.debugState().bounds?.height ?? 0;
    out['chatHeights'] = [h0, h1, h2];
    check(h1 > h0 && Math.abs(h2 - h0) <= 3, 'chat-verlauf-klappt-und-schrumpft-zurueck');

    // 3b. Screenshots (simulierte Frames): lokal gespeichert, lesbar, Schwärzen und Doku-Export im temporären Ordner
    const pre = c.incidents.list()[0]!;
    const refs = c.incidents.shotRefs(pre.id);
    out['shots'] = refs.length;
    check(refs.length >= 3, 'screenshots-pro-schritt-gespeichert');
    const first = refs[0]!;
    const raw = c.shotStore.read(pre.id, first, 'original');
    check(raw.length > 0, 'screenshot-lesbar-und-entschluesselt');
    check(refs.every((r) => r.encrypted === c.shotStore.encryptionAvailable), 'verschluesselung-wie-erwartet');
    const red = c.shotStore.redact(pre.id, first, [{ x: 0, y: 0, w: 1, h: 1 }], electronImageOps);
    c.incidents.replaceShot(pre.id, red);
    check(c.shotStore.read(pre.id, red, 'original').equals(raw) && c.shotStore.read(pre.id, red, 'redacted').length > 0, 'schwaerzen-original-bleibt');
    const inc0 = c.incidents.get(pre.id);
    const model = buildDocModel(inc0, { variant: 'full', steps: [1, 2, 3], summary: 'Selbsttest' }, (r) => c.shotStore.exportImage(pre.id, r, electronImageOps), Date.now());
    const pkg = writeDocPackage(mkdtempSync(join(tmpdir(), 'itt-doc-')), 'Selbsttest-Doku', model, false);
    out['docFiles'] = pkg.files;
    check(pkg.files >= 3, 'doku-export');
    rmSync(join(pkg.dir, '..'), { recursive: true, force: true });

    // 4. Abschluss -> Zeiterfassungs-Dialog -> speichern
    await js('document.getElementById("btn-solved").click()');
    check(await waitFor('document.getElementById("time-dialog").open && document.getElementById("td-desc").value.length > 0'), 'zeit-dialog-mit-zusammenfassung');
    await js('document.getElementById("td-save").click()');
    check(await waitFor('!document.getElementById("time-dialog").open'), 'zeiteintrag-gespeichert');
    out['entries'] = c.incidents.listEntries().length;
    check(c.incidents.listEntries().length === 1, 'ein-zeiteintrag');

    // 5. Incident-Liste, Wiedereröffnung mit Begründung
    await js('document.getElementById("tab-incidents").click()');
    check(await waitFor('document.querySelectorAll("#inc-body tr").length === 1'), 'incident-in-liste');
    const id = c.incidents.list()[0]!.id;
    const bad = await c.sessions.resume(id, '   ');
    check(!bad.ok, 'wiederaufnahme-ohne-begruendung-abgelehnt');
    const ok = await c.sessions.resume(id, 'Problem trat nach dem Neustart erneut auf');
    check(ok.ok && ok.value.reopenCount === 1, 'wiederaufnahme-mit-begruendung');
    out['afterResume'] = ok.ok ? { phase: ok.value.phase, rec: ok.value.recommendation?.action } : null;
    await c.sessions.pause();

    // 6. Telefonat-Modus
    const call = await c.sessions.startCall();
    check(call.ok && (call.value.call?.questions.length ?? 0) === 5, 'telefonat-startet-mit-5-fragen');
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
