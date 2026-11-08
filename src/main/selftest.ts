import { app, screen, type BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { electronCapturer } from './capture';
import type { OverlayWindow } from './overlay';
import type { SettingsStore } from './settings';

/**
 * Nur mit ITT_SELFTEST=1: treibt die echte UI mit dem Mock-Provider durch
 * (Quelle wählen, Problem eingeben, Schritte bestätigen, Lösung) und schreibt ein Ergebnis nach ITT_SELFTEST_OUT.
 */
export async function runSelfTest(win: BrowserWindow, overlay: OverlayWindow, settings: SettingsStore): Promise<void> {
  const out: Record<string, unknown> = { checks: [] as string[] };
  const checks = out['checks'] as string[];
  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (code: string, ms = 20_000): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await js<boolean>(code)) return true;
      await sleep(150);
    }
    return false;
  };
  try {
    settings.update({ providerId: 'mock' });
    out['displays'] = screen.getAllDisplays().map((d) => ({ b: d.bounds, sf: d.scaleFactor }));
    checks.push((await waitFor('document.querySelectorAll("#sources .source").length > 0')) ? 'quellen-geladen' : 'FEHLER: keine Quellen');
    out['sourceCount'] = await js<number>('document.querySelectorAll("#sources .source").length');
    await js('document.getElementById("problem").value = "Testproblem: Drucker druckt nicht"; document.getElementById("btn-start").click();');
    const gotStep = await waitFor('!document.getElementById("session-panel").hidden');
    checks.push(gotStep ? 'schritt-1-angezeigt' : `FEHLER: kein Schritt (${await js<string>('document.getElementById("status").textContent')})`);
    out['step1'] = await js<string>('document.getElementById("step-text").textContent');
    out['overlay'] = overlay.debugState();
    for (let i = 0; i < 3; i++) {
      const before = await js<string>('document.getElementById("step-heading").textContent');
      await js('document.getElementById("btn-done").click()');
      const ok = await waitFor(`document.getElementById("step-heading").textContent !== ${JSON.stringify(before)}`);
      checks.push(ok ? `weiter-${i + 1}` : `FEHLER: weiter-${i + 1}`);
    }
    out['lastStep'] = await js<string>('document.getElementById("step-text").textContent');
    await js('document.getElementById("comment").value = "ging nicht"; document.getElementById("btn-failed").click()');
    await waitFor('document.querySelectorAll("#history-list li").length >= 4');
    await js('document.getElementById("btn-solved").click()');
    checks.push((await waitFor('!document.getElementById("solved-panel").hidden')) ? 'geloest-angezeigt' : 'FEHLER: nicht gelöst');
    out['historyItems'] = await js<string[]>('[...document.querySelectorAll("#history-list li")].map(l => l.textContent)');
    out['overlayAfter'] = overlay.debugState();

    // Fenster-Aufnahme (echtes Win32-Fensterrect) mit dem ersten verfügbaren Fremdfenster
    const list = await electronCapturer.listSources();
    const w = list.find((s) => s.kind === 'window');
    if (w) {
      const cap = await electronCapturer.capture(w.id);
      out['windowCapture'] = { name: w.name, imageSize: cap.imageSize, boundsDip: cap.geometry.boundsDip, jpegBytes: cap.jpegBase64.length };
      checks.push('fenster-aufnahme-ok');
    } else {
      checks.push('kein-fremdes-fenster-gefunden');
    }
    const scr = list.find((s) => s.kind === 'screen');
    if (scr) {
      const cap = await electronCapturer.capture(scr.id);
      out['screenCapture'] = { imageSize: cap.imageSize, boundsDip: cap.geometry.boundsDip };
      checks.push('bildschirm-aufnahme-ok');
    }
  } catch (e) {
    checks.push(`FEHLER: ${(e as Error).message}`);
  }
  const file = process.env['ITT_SELFTEST_OUT'];
  const json = JSON.stringify(out, null, 2);
  if (file) writeFileSync(file, json);
  console.log(json);
  app.exit(checks.some((c) => c.startsWith('FEHLER')) ? 1 : 0);
}
