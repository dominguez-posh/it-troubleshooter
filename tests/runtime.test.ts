import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityTracker, safeDetail } from '../src/main/activity';
import { AutoAdvance, diffFrames, type ForegroundProbe } from '../src/main/autoAdvance';
import type { GrayFrame } from '../src/main/captureTypes';
import { CostGuard, estimateCostUsd, formatEur, periodKey, precheckUsd, validateCostConfig, type CostConfig } from '../src/main/cost';
import { describeActivity } from '../src/shared/activityText';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itt-rt-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Kostenberechnung (Schätzung)', () => {
  it('je Modell aus Input und Output (USD pro 1 Mio. Tokens)', () => {
    expect(estimateCostUsd('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 }).usd).toBeCloseTo(12); // 2 + 10
    expect(estimateCostUsd('claude-haiku-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 }).usd).toBeCloseTo(0.6);
    expect(estimateCostUsd('claude-opus-5-5', { inputTokens: 500_000, outputTokens: 100_000 }).usd).toBeCloseTo(4);
  });
  it('Cache-Tokens: Lesen billiger, Schreiben teurer; Bildtokens stecken im Input', () => {
    const base = estimateCostUsd('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 0 }).usd;
    expect(estimateCostUsd('claude-opus-5-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }).usd).toBeCloseTo(0.2);
    expect(estimateCostUsd('claude-opus-5-5', { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 1_000_000 }).usd).toBeCloseTo(base * 1.25);
  });
  it('unbekanntes Modell: konservativ mit der teuersten Stufe, markiert', () => {
    const r = estimateCostUsd('irgendwas-neues', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(r.unknownModel).toBe(true);
    expect(r.usd).toBeCloseTo(10);
    expect(estimateCostUsd('claude-haiku-5-5', { inputTokens: 1, outputTokens: 1 }).unknownModel).toBe(false);
  });
  it('Nutzer-Preise überschreiben die Tabelle; Mock ist kostenlos', () => {
    expect(estimateCostUsd('claude-haiku-5-5', { inputTokens: 1_000_000, outputTokens: 0 }, { 'claude-haiku-5-5': { input: 3, output: 1 } }).usd).toBeCloseTo(3);
    expect(estimateCostUsd('mock-small', { inputTokens: 5e6, outputTokens: 5e6 }).usd).toBe(0);
  });
  it('Vorabprüfung: Eingabeschätzung plus volle max_tokens als Obergrenze', () => {
    expect(precheckUsd('claude-sonnet-5-5', 100_000, 2048)).toBeCloseTo(0.2 + 0.02048);
  });
  it('Euro-Format und Rundung', () => {
    expect(formatEur(1.005)).toMatch(/^1,0[01] €$/);
    expect(formatEur(12.3)).toBe('12,30 €');
  });
});

const cfg = (over: Partial<CostConfig> = {}): CostConfig => ({ warnEur: 1, limitEur: 2, incidentLimitEur: null, period: 'month', usdEurRate: 1, ...over });
const entry = (usd: number, model = 'm') => ({ model, inputTokens: 10, outputTokens: 1, costUsd: usd });

describe('CostGuard: Schwellen, Limit, Perioden', () => {
  function guard(c: CostConfig = cfg(), t = { now: Date.UTC(2026, 10, 8, 12) }) {
    return { g: new CostGuard(dir, () => c, () => t.now), t };
  }
  it('Warnung genau einmal, dann 90 % des Limits, dann Limit', () => {
    const { g } = guard();
    g.record(entry(0.5));
    expect(g.view(0)).toMatchObject({ level: 'ok', unacknowledged: false });
    g.record(entry(0.6)); // 1,10 -> Warnung
    expect(g.view(0)).toMatchObject({ level: 'warn', unacknowledged: true });
    g.ack();
    g.record(entry(0.1)); // 1,20 -> weiterhin nur Warnung, kein erneuter Hinweis
    expect(g.view(0).unacknowledged).toBe(false);
    g.record(entry(0.7)); // 1,90 >= 90 % von 2
    expect(g.view(0)).toMatchObject({ level: 'warn90', unacknowledged: true });
    g.ack();
    g.record(entry(0.2)); // 2,10
    expect(g.view(0)).toMatchObject({ level: 'limit', unacknowledged: true });
  });
  it('Vorabprüfung blockiert Anfragen, die das Limit sprengen würden, Aufruf wird nicht abgebrochen', () => {
    const { g } = guard();
    g.record(entry(1.9));
    expect(g.check(0.05).allowed).toBe(true);
    expect(g.check(0.2)).toMatchObject({ allowed: false, reason: 'Limit erreicht' });
    expect(g.canAfford(0.2)).toBe(false);
  });
  it('Freigabe: "Einmal fortfahren" gilt für eine Anfrage; "Limit anheben" gilt für die Periode', () => {
    const { g } = guard();
    g.record(entry(2.5));
    expect(g.check(0.1).allowed).toBe(false);
    g.allowOnce();
    expect(g.check(0.1).allowed).toBe(true);
    g.consumeOnceIfNeeded(0.1);
    expect(g.check(0.1).allowed).toBe(false);
    g.raise(5);
    expect(g.check(0.1).allowed).toBe(true);
    expect(g.view(0).limitEur).toBe(7);
    expect(() => g.raise(-1)).toThrow();
  });
  it('Limit pro Incident', () => {
    const { g } = guard(cfg({ incidentLimitEur: 0.5, limitEur: null, warnEur: null }));
    expect(g.check(0.1, 0.45)).toMatchObject({ allowed: false, reason: 'Limit für diesen Incident erreicht' });
    expect(g.check(0.1, 0.1).allowed).toBe(true);
    expect(g.view(0.6).level).toBe('limit');
  });
  it('Wechselkurs: Euro-Werte aus USD * Kurs', () => {
    const { g } = guard(cfg({ usdEurRate: 0.5, warnEur: null, limitEur: null }));
    g.record(entry(10));
    expect(g.view(4).periodEur).toBe(5);
    expect(g.view(4).incidentEur).toBe(2);
  });
  it('Periodenwechsel setzt Zähler und Hinweise zurück (Tag und Monat)', () => {
    const t = { now: Date.UTC(2026, 10, 8, 12) };
    const day = new CostGuard(dir, () => cfg({ period: 'day' }), () => t.now);
    day.record(entry(1.5));
    expect(day.view(0).periodEur).toBe(1.5);
    t.now += 24 * 3600_000;
    expect(day.view(0)).toMatchObject({ periodEur: 0, level: 'ok', unacknowledged: false });
    expect(periodKey('month', Date.UTC(2026, 10, 30, 12))).toBe('2026-11');
    expect(periodKey('total', 1)).toBe('total');
  });
  it('speichert nur Zahlen, übersteht Neustart; defekte Datei wird beiseitegelegt', () => {
    const t = { now: Date.UTC(2026, 10, 8, 12) };
    const a = new CostGuard(dir, () => cfg(), () => t.now);
    a.record(entry(0.7, 'claude-haiku-5-5'));
    const raw = readFileSync(join(dir, 'costs.json'), 'utf8');
    expect(raw).not.toMatch(/apiKey|api_key|screenshot|jpeg|base64/i);
    expect(new CostGuard(dir, () => cfg(), () => t.now).view(0).periodEur).toBe(0.7);
    writeFileSync(join(dir, 'costs.json'), '{kaputt');
    expect(new CostGuard(dir, () => cfg(), () => t.now).view(0).periodEur).toBe(0);
  });
  it('Zähler zurücksetzen per Aktion', () => {
    const { g } = guard();
    g.record(entry(1.5));
    g.reset();
    expect(g.view(0).periodEur).toBe(0);
  });
  it('Validierung der Einstellungen', () => {
    expect(() => validateCostConfig(cfg({ warnEur: 5, limitEur: 2 }))).toThrow(/Limit/);
    expect(() => validateCostConfig(cfg({ warnEur: -1 }))).toThrow();
    expect(() => validateCostConfig(cfg({ usdEurRate: 0 }))).toThrow(/Kurs/);
    expect(() => validateCostConfig(cfg({ period: 'woche' as never }))).toThrow();
    expect(validateCostConfig(cfg({ warnEur: null, limitEur: 3 })).limitEur).toBe(3);
    expect(validateCostConfig(cfg({ warnEur: 2, limitEur: 2 })).warnEur).toBe(2);
  });
});

describe('Aktivitätsanzeige: Zustandsmaschine', () => {
  const mk = () => {
    const c = { t: 1_000_000 };
    let changes = 0;
    const a = new ActivityTracker(() => c.t, () => changes++);
    return { a, c, changes: () => changes };
  };
  it('Übergänge, Protokoll mit Dauern, Rückkehr zu Bereit', () => {
    const { a, c, changes } = mk();
    a.set('capturing');
    c.t += 800;
    a.set('resizing');
    c.t += 200;
    a.set('requesting', { detail: 'claude-haiku-5-5 (small)' });
    c.t += 5000;
    a.set('validating');
    a.idle();
    expect(a.current().kind).toBe('idle');
    expect(a.entries().map((e) => [e.kind, e.durationMs])).toEqual([['idle', 0], ['capturing', 800], ['resizing', 200], ['requesting', 5000], ['validating', 0]]);
    expect(changes()).toBe(5);
  });
  it('Wiederholung (Versuch n von m) und Eskalation werden angezeigt', () => {
    const { a, c } = mk();
    a.set('retrying', { attempt: { n: 2, of: 2 }, detail: 'ungültige Antwort' });
    expect(describeActivity(a.current(), c.t).text).toBe('Wiederholung nach Fehler (Versuch 2 von 2): ungültige Antwort');
    a.set('escalating', { detail: '2x nicht geklappt' });
    expect(describeActivity(a.current(), c.t).text).toContain('Eskalation auf größeres Modell');
  });
  it('Sekundenzähler und Hänger-Erkennung (Zeitlimit)', () => {
    const { a, c } = mk();
    a.set('requesting', { detail: 'modell' });
    c.t += 12_000;
    expect(describeActivity(a.current(), c.t).text).toContain('(12 s)');
    expect(a.isStuck(60_000)).toBe(false);
    c.t += 50_000;
    expect(a.isStuck(60_000)).toBe(true);
    expect(describeActivity(a.current(), c.t).tone).toBe('warn');
  });
  it('Rate-Limit-Countdown läuft herunter', () => {
    const { a, c } = mk();
    a.error('rate_limit', 20);
    expect(a.current().kind).toBe('ratelimit');
    expect(a.remainingSec()).toBe(20);
    expect(describeActivity(a.current(), c.t).text).toBe('Rate-Limit: noch 20 s Wartezeit');
    c.t += 7_500;
    expect(a.remainingSec()).toBe(13);
    c.t += 20_000;
    expect(a.remainingSec()).toBe(0);
    expect(describeActivity(a.current(), c.t).text).toContain('erneut versuchen');
  });
  it('Fehler mit Handlungshinweis (Key, Netzwerk, Zeitlimit)', () => {
    const { a, c } = mk();
    a.error('auth');
    expect(describeActivity(a.current(), c.t)).toMatchObject({ tone: 'error' });
    expect(describeActivity(a.current(), c.t).text).toContain('API-Key prüfen');
    a.error('timeout');
    expect(describeActivity(a.current(), c.t).text).toContain('Erneut versuchen');
    a.error('network');
    expect(describeActivity(a.current(), c.t).text).toContain('Netzwerkverbindung');
  });
  it('Statuszeilen für Warten, Klick, Änderung, Chat', () => {
    const { a, c } = mk();
    a.set('waiting_target', { detail: 'TeamViewer' });
    expect(describeActivity(a.current(), c.t).text).toBe('wartet, bis TeamViewer vorne ist …');
    a.set('please_click', { detail: 'Startmenü' });
    expect(describeActivity(a.current(), c.t).text).toBe('Bitte klicken: Startmenü');
    a.set('change_detected');
    expect(describeActivity(a.current(), c.t).text).toBe('Klick erkannt – denkt nach …');
    a.set('no_change');
    expect(describeActivity(a.current(), c.t).text).toContain('keine Änderung erkannt');
    a.set('chat_writing');
    expect(describeActivity(a.current(), c.t).text).toBe('schreibt dir im Chat');
    a.set('paused');
    a.set('waiting_customer');
    expect(describeActivity(a.current(), c.t).text).toBe('Wartet auf den Kunden');
  });
  it('keine sensiblen Daten im Protokoll: Keys und Sonderzeichen werden entfernt, Länge begrenzt', () => {
    const { a } = mk();
    a.set('requesting', { detail: 'sk-ant-api03-GEHEIMERKEY12345 <script>alert(1)</script> ' + 'x'.repeat(300) });
    a.set('idle');
    const log = JSON.stringify(a.entries());
    expect(log).not.toContain('GEHEIMERKEY');
    expect(log).not.toContain('<script>');
    expect(safeDetail('x'.repeat(300))!.length).toBeLessThanOrEqual(80);
    expect(safeDetail('')).toBeUndefined();
  });
});

const frame = (fill: number | ((i: number) => number), w = 10, h = 10): GrayFrame => ({
  width: w,
  height: h,
  data: Uint8Array.from({ length: w * h }, (_, i) => (typeof fill === 'number' ? fill : fill(i))),
});

describe('Bildvergleich (nur im Speicher)', () => {
  it('Schwelle für Pixelunterschied und Anteil geänderter Pixel', () => {
    const a = frame(100);
    expect(diffFrames(a, frame(100)).changed).toBe(false);
    expect(diffFrames(a, frame(110)).changed).toBe(false); // unter Pixel-Schwelle 24
    expect(diffFrames(a, frame(200)).changed).toBe(true);
    const oneRow = frame((i) => (i < 10 ? 250 : 100)); // 10 % geändert
    expect(diffFrames(a, oneRow).changedFraction).toBeCloseTo(0.1);
    expect(diffFrames(a, oneRow, { minChangedFraction: 0.5 }).changed).toBe(false);
    expect(diffFrames(a, frame(100, 5, 5)).changed).toBe(true); // andere Größe
  });
  it('ignorierte Bereiche (eigene Fenster) zählen nicht', () => {
    const a = frame(100);
    const b = frame((i) => (i % 10 < 5 ? 250 : 100)); // linke Hälfte geändert
    expect(diffFrames(a, b).changed).toBe(true);
    expect(diffFrames(a, b, { ignore: [{ x: 0, y: 0, width: 5, height: 10 }] }).changed).toBe(false);
  });
});

describe('Auto-Weiter', () => {
  function setup(frames: GrayFrame[], fgTitles: Array<string | null> = [], cfgOver = {}, allow = () => true) {
    const clock = { t: 0 };
    let fi = 0;
    let gi = 0;
    const statuses: string[] = [];
    const triggers: number[] = [];
    const probe: ForegroundProbe = {
      get: async () => {
        const title = fgTitles[Math.min(gi++, fgTitles.length - 1)];
        return title ? { processName: 'x', title } : null;
      },
    };
    const aa = new AutoAdvance({
      now: () => clock.t,
      sleep: async (ms) => void (clock.t += ms),
      grab: async () => frames[Math.min(fi++, frames.length - 1)]!,
      foreground: probe,
      allow,
      config: { pollMs: 1000, settleMs: 1500, minIntervalMs: 4000, maxPerMinute: 2, timeoutMs: 20_000, foregroundTimeoutMs: 5000, ...cfgOver },
    });
    const watch = (target: string | null = null) =>
      (() => {
        fi = 0;
        return aa.watch({ sourceId: 's', targetWindow: target, stepText: 'Start', onStatus: (k) => statuses.push(k), onTrigger: () => triggers.push(clock.t) });
      })();
    return { aa, clock, statuses, triggers, watch };
  }
  const calm = frame(100);
  const changed = frame(220);

  it('löst nach erkannter Änderung und ruhigem Bildschirm genau einen Schritt aus (Entprellen)', async () => {
    const s = setup([calm, calm, changed, frame(180), changed, changed, changed, changed]);
    expect(await s.watch()).toBe('triggered');
    expect(s.triggers).toHaveLength(1);
    expect(s.statuses).toEqual(['please_click', 'change_detected']);
    expect(s.triggers[0]!).toBeGreaterThanOrEqual(3000 + 1500); // erst nach Beruhigung
  });
  it('Timeout ohne Änderung: "keine Änderung erkannt", kein Auslösen', async () => {
    const s = setup([calm]);
    expect(await s.watch()).toBe('timeout');
    expect(s.triggers).toHaveLength(0);
    expect(s.statuses).toContain('no_change');
  });
  it('wartet, bis das Zielfenster vorne ist; Timeout bei falschem Fenster', async () => {
    const ok = setup([calm, changed, changed, changed, changed], ['Notepad', 'Notepad', 'TeamViewer - Verbindung']);
    expect(await ok.watch('TeamViewer')).toBe('triggered');
    expect(ok.statuses[0]).toBe('waiting_target');
    const wrong = setup([calm], ['Notepad']);
    expect(await wrong.watch('TeamViewer')).toBe('foreground-timeout');
    expect(wrong.triggers).toHaveLength(0);
  });
  it('Mindestabstand und Obergrenze pro Minute', async () => {
    const s = setup([calm, changed, changed, changed, changed, changed, changed], [], { timeoutMs: 120_000 });
    expect(await s.watch()).toBe('triggered');
    const t1 = s.triggers[0]!;
    // zweiter Lauf direkt danach: Mindestabstand 4 s wird eingehalten
    expect(await s.watch()).toBe('triggered');
    expect(s.triggers[1]! - t1).toBeGreaterThanOrEqual(4000);
    // dritter Lauf innerhalb einer Minute: Obergrenze 2/min -> wartet bis 60 s nach dem ersten
    expect(await s.watch()).toBe('triggered');
    expect(s.triggers[2]! - t1).toBeGreaterThanOrEqual(60_000);
  });
  it('Kostenlimit: kein Auslösen ("blocked")', async () => {
    const s = setup([calm, changed, changed, changed, changed], [], {}, () => false);
    expect(await s.watch()).toBe('blocked');
    expect(s.triggers).toHaveLength(0);
  });
  it('stop() beendet die Überwachung', async () => {
    const s = setup([calm]);
    const p = s.watch();
    s.aa.stop();
    expect(await p).toBe('stopped');
  });
});
