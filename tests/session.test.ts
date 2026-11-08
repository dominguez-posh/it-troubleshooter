import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureError, type Capturer } from '../src/main/captureTypes';
import { CostGuard, type CostConfig } from '../src/main/cost';
import { IncidentManager } from '../src/main/incidents';
import { IncidentStore } from '../src/main/incidentStore';
import { createDefaultRegistry, ProviderRegistry, type ProviderDefinition } from '../src/main/llm';
import { createMockProvider } from '../src/main/llm/mock';
import type { LlmProvider } from '../src/main/llm/types';
import type { OverlayController } from '../src/main/overlay';
import { SessionService, STARTER_QUESTIONS, type SessionDeps } from '../src/main/session';
import type { Point } from '../src/shared/types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itt-ses-'));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function setup(opts: { cost?: Partial<CostConfig>; registry?: ProviderRegistry; providerId?: string; key?: string; timeoutMs?: number; capture?: Capturer['capture'] } = {}) {
  const clock = { t: Date.UTC(2026, 10, 8, 10) };
  const shows: Array<{ tip: Point | null; text: string }> = [];
  const overlay: OverlayController = { show: vi.fn(async (tip, text) => void shows.push({ tip, text })), hide: vi.fn(), setPill: vi.fn() };
  let captures = 0;
  const capturer: Capturer = {
    listSources: async () => [],
    defaultSourceId: async () => 'screen:0:0',
    grabFrame: async () => ({ width: 1, height: 1, data: new Uint8Array(1) }),
    capture:
      opts.capture ??
      (async () => {
        captures++;
        return {
          jpegBase64: 'AAAA',
          imageSize: { width: 1600, height: 900 },
          kind: 'screen' as const,
          // 150 % DPI: 2560x1440 DIP auf Monitor mit Versatz 1920
          geometry: { boundsDip: { x: 1920, y: 0, width: 2560, height: 1440 }, imageSize: { width: 1600, height: 900 } },
        };
      }),
  };
  const store = new IncidentStore(dir);
  store.load();
  const incidents = new IncidentManager(store, () => clock.t);
  const costCfg: CostConfig = { warnEur: null, limitEur: null, incidentLimitEur: null, period: 'month', usdEurRate: 1, ...opts.cost };
  const cost = new CostGuard(dir, () => costCfg, () => clock.t);
  const deps: SessionDeps = {
    registry: opts.registry ?? createDefaultRegistry(),
    capturer,
    overlay,
    persistence: incidents,
    cost,
    getProviderId: () => opts.providerId ?? 'mock',
    getApiKey: () => opts.key,
    getModels: (id) => (id === 'mock' ? { small: 'mock-small', medium: 'mock-medium', large: 'mock-large' } : { small: 'claude-haiku-5-5', medium: 'claude-sonnet-5-5', large: 'claude-opus-5-5' }),
    getRouting: () => ({ triage: 'small', step: 'medium', summary: 'small', call: 'small' }),
    getFailedThreshold: () => 2,
    getDropBack: () => true,
    getCaptureOptions: () => ({ maxWidth: 1280, quality: 70 }),
    getReevaluate: () => false,
    now: () => clock.t,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  };
  const svc = new SessionService(deps);
  return { svc, incidents, overlay, shows, cost, clock, captures: () => captures, advance: (min: number) => (clock.t += min * 60_000) };
}

const ok = <T,>(r: { ok: boolean } & ({ value: T } | { error: unknown })): T => {
  if (!r.ok) throw new Error('erwartet ok: ' + JSON.stringify((r as { error: unknown }).error));
  return (r as { value: T }).value;
};

describe('Triage ohne Screenshot', () => {
  it('Einschätzung läuft ohne Aufnahme; erst "Fernwartung starten" nimmt auf und zeigt den Pfeil in Desktop-DIP', async () => {
    const { svc, shows, captures, incidents } = setup();
    const v1 = ok(await svc.start('Drucker druckt nicht'));
    expect(v1.recommendation?.action).toBe('start_remote');
    expect(v1.phase).toBe('rec');
    expect(captures()).toBe(0); // KEIN Screenshot vor Fernwartung
    expect(shows).toHaveLength(0);
    expect(incidents.get(v1.incidentId!).status).toBe('triage');

    const v2 = ok(await svc.react('done'));
    expect(captures()).toBe(1);
    expect(v2.phase).toBe('steps');
    expect(v2.current?.index).toBe(1);
    const t = v2.current!.step.target!;
    expect(shows[0]!.tip!.x).toBeCloseTo(1920 + t.x * (2560 / 1600));
    expect(shows[0]!.tip!.y).toBeCloseTo(t.y * (1440 / 900));
    expect(incidents.get(v1.incidentId!).status).toBe('remote');
  });
  it('Verzweigung nach Ausgang: Antwort, Rückfrage, Kontakt, Eskalation, Warten', async () => {
    for (const [problem, action] of [['Passwort vergessen', 'answer_directly'], ['bitte Rückruf', 'contact_customer'], ['muss eskalieren', 'escalate'], ['bitte warten', 'wait_check'], ['alles langsam', 'ask_customer']] as const) {
      const s = setup();
      expect(ok(await s.svc.start(problem)).recommendation?.action).toBe(action);
      expect(s.captures()).toBe(0);
    }
  });
  it('Antwort auf Rückfrage löst neue Einschätzung aus (erneute Triage), weiterhin ohne Bild', async () => {
    const { svc, captures } = setup();
    expect(ok(await svc.start('alles langsam')).recommendation?.action).toBe('ask_customer');
    const v = ok(await svc.note('Antwort: nur Outlook'));
    expect(v.recommendation?.action).toBe('start_remote');
    expect(v.notes.map((n) => n.text)).toContain('Antwort: nur Outlook');
    expect(captures()).toBe(0);
  });
  it('"Doch erst nachfragen" übersteuert Fernwartung', async () => {
    const { svc } = setup();
    ok(await svc.start('Drucker'));
    expect(ok(await svc.askFirst()).recommendation?.action).toBe('ask_customer');
  });
  it('Problemtext fehlt oder ist zu lang', async () => {
    const { svc } = setup();
    expect((await svc.start('  ')).ok).toBe(false);
    expect((await svc.start('x'.repeat(4001))).ok).toBe(false);
  });
  it('fehlender Key: Fehler no_key ohne Aufnahme, Fall bleibt als Entwurf erhalten', async () => {
    const { svc, captures, incidents } = setup({ providerId: 'anthropic' });
    const r = await svc.start('Problem');
    expect(r).toMatchObject({ ok: false, error: { code: 'no_key' } });
    expect(captures()).toBe(0);
    expect(incidents.list()).toHaveLength(1);
    expect(incidents.list()[0]!.status).toBe('draft');
    expect(svc.isActive).toBe(false);
  });
});

describe('Reaktionen auf Empfehlungen (Gemacht, Anders, Später)', () => {
  it('Später stellt zurück, ohne neue Anfrage; Verlauf-Ereignis wird gespeichert', async () => {
    const { svc, incidents } = setup();
    const v0 = ok(await svc.start('Passwort vergessen'));
    const v = ok(await svc.react('later'));
    expect(v.recPostponed).toBe(true);
    expect(v.recommendation?.action).toBe('answer_directly');
    expect(incidents.get(v0.incidentId!).events[0]).toMatchObject({ response: 'later', action: 'answer_directly' });
  });
  it('Anders: Gegenvorschlag wird Zusatzinfo und fließt in die nächste Empfehlung; Ereignis gespeichert', async () => {
    const { svc, incidents } = setup();
    const v0 = ok(await svc.start('Passwort vergessen'));
    const v = ok(await svc.react('other', 'Kunde hat kein Portal-Konto'));
    expect(v.recommendation?.action).toBe('ask_customer'); // Mock: abgelehnt -> nachfragen
    expect(v.notes.some((n) => n.text.includes('Kunde hat kein Portal-Konto'))).toBe(true);
    expect(incidents.get(v0.incidentId!).events[0]).toMatchObject({ response: 'other', comment: 'Kunde hat kein Portal-Konto' });
  });
  it('contact_customer "Gemacht": Status "wartet auf Kunde", Zeitmessung pausiert; Eingabe setzt fort', async () => {
    const { svc, incidents, advance } = setup();
    const v0 = ok(await svc.start('bitte Rückruf'));
    advance(5);
    const v = ok(await svc.react('done'));
    expect(v.holding).toBe(true);
    expect(v.timer.running).toBe(false);
    expect(incidents.get(v0.incidentId!).status).toBe('waiting');
    advance(60);
    expect(incidents.timerInfo(v0.incidentId!).elapsedMs).toBe(5 * 60_000);
    const w = ok(await svc.note('Kunde hat zurückgerufen'));
    expect(w.holding).toBe(false);
    expect(w.timer.running).toBe(true);
  });
  it('close "Gemacht" schließt den Fall (Abschluss -> Zeiterfassung)', async () => {
    const { svc, incidents } = setup();
    const v0 = ok(await svc.start('Passwort vergessen'));
    const v1 = ok(await svc.react('done')); // Antwort weitergegeben -> Mock empfiehlt close
    expect(v1.recommendation?.action).toBe('close');
    const v2 = ok(await svc.react('done'));
    expect(v2.result).toBe('solved');
    expect(incidents.get(v0.incidentId!).status).toBe('solved');
  });
  it('ändernde Befehle: "Gemacht" erst nach Bestätigung "ich habe es verstanden"', async () => {
    const { svc } = setup();
    ok(await svc.start('Server hängt'));
    expect(ok(await svc.setServerAccess({ state: 'yes', kind: 'rdp', note: 'SRV01' })).recommendation?.commands?.some((c) => c.mode === 'changing')).toBe(true);
    const denied = await svc.react('done');
    expect(denied).toMatchObject({ ok: false, error: { message: expect.stringContaining('bestätigen') } });
    expect((await svc.react('done', undefined, true)).ok).toBe(true);
  });
  it('Serverzugriff: Antwort wird im Incident gemerkt (ohne Zugangsdaten), "nein" führt zu Alternative', async () => {
    const { svc, incidents } = setup();
    const v0 = ok(await svc.start('Server hängt'));
    expect(v0.recommendation?.action).toBe('check_server_access');
    expect((await svc.react('done')).ok).toBe(false); // verlangt Ja/Nein/Unklar
    const v1 = ok(await svc.setServerAccess({ state: 'no' }));
    expect(v1.serverAccess).toEqual({ state: 'no' });
    expect(v1.recommendation?.action).toBe('contact_customer');
    expect(incidents.get(v0.incidentId!).serverAccess).toEqual({ state: 'no' });
    expect(JSON.stringify(incidents.get(v0.incidentId!))).not.toMatch(/passwor/i);
  });
});

describe('Schritt-Modus, Eskalation, Abschluss', () => {
  it('Schritte bis close; "nicht geklappt" 2x in Folge eskaliert auf die große Stufe mit Begründung', async () => {
    const { svc } = setup();
    ok(await svc.start('Drucker'));
    ok(await svc.react('done'));
    const a = ok(await svc.report('failed', 'nichts passiert'));
    expect(a.history[0]).toMatchObject({ outcome: 'failed', comment: 'nichts passiert' });
    expect(a.lastRequest?.tier).toBe('medium');
    const b = ok(await svc.report('failed'));
    expect(b.lastRequest).toMatchObject({ tier: 'large', escalated: true });
    expect(b.lastRequest?.reason).toContain('2x nicht geklappt');
    const c = ok(await svc.report('done')); // wieder Basisstufe
    expect(c.lastRequest?.tier).toBe('medium');
  });
  it('unsichere Antwort (confidence low) eskaliert genau einmal', async () => {
    const { svc } = setup();
    ok(await svc.start('unsicher beim Klick'));
    const v = ok(await svc.react('done'));
    expect(v.lastRequest).toMatchObject({ tier: 'large', escalated: true });
    expect(v.lastRequest?.reason).toContain('unsicher');
    expect(v.current?.step.confidence).toBe('high');
  });
  it('Rückschwenk mitten in der Session: Modell antwortet ohne weitere Klicks', async () => {
    const { svc } = setup();
    ok(await svc.start('neustart nötig'));
    ok(await svc.react('done'));
    ok(await svc.report('done'));
    const v = ok(await svc.report('done'));
    expect(v.phase).toBe('rec');
    expect(v.recommendation?.action).toBe('answer_directly');
    expect(v.current).toBeNull();
  });
  it('Fehler im Folgeschritt lässt den Zustand unverändert, Wiederholung klappt', async () => {
    let fail = false;
    let n = 0;
    const s = setup({
      capture: async () => {
        n++;
        if (fail) throw new CaptureError('weg');
        return { jpegBase64: 'A', imageSize: { width: 100, height: 100 }, kind: 'screen', geometry: { boundsDip: { x: 0, y: 0, width: 100, height: 100 }, imageSize: { width: 100, height: 100 } } };
      },
    });
    ok(await s.svc.start('Drucker'));
    ok(await s.svc.react('done'));
    fail = true;
    expect(await s.svc.report('done')).toMatchObject({ ok: false, error: { code: 'capture' } });
    expect(s.svc.view().history).toHaveLength(0);
    expect(s.svc.view().current?.index).toBe(1);
    fail = false;
    expect((await s.svc.report('done')).ok).toBe(true);
    expect(n).toBeGreaterThan(2);
  });
  it('Pause stoppt die Zeit und beendet die Sitzung; Wiederaufnehmen ohne Begründung bei "pausiert", ohne Screenshot', async () => {
    const { svc, incidents, captures, advance } = setup();
    const v0 = ok(await svc.start('Drucker'));
    advance(5);
    ok(await svc.pause());
    expect(svc.isActive).toBe(false);
    expect(incidents.get(v0.incidentId!).status).toBe('paused');
    advance(60);
    expect(incidents.timerInfo(v0.incidentId!).elapsedMs).toBe(5 * 60_000);
    const c0 = captures();
    const v = ok(await svc.resume(v0.incidentId!));
    expect(v.problem).toBe('Drucker');
    expect(v.recommendation?.action).toBe('start_remote');
    expect(captures()).toBe(c0); // Aufnahme erst, wenn wieder Fernwartung nötig ist
  });
  it('Wiederaufnahme eines abgeschlossenen Falls: Begründung Pflicht, Verlauf bleibt, Status danach Triage; zweite Zeiterfassung nur für neue Arbeit', async () => {
    const { svc, incidents, advance } = setup();
    const id = ok(await svc.start('Passwort vergessen')).incidentId!;
    advance(10);
    ok(await svc.finish('solved'));
    const first = await incidents.saveEntry(incidents.draftFor(id, 'solved', 'x', 'llm'));
    expect(first.durationMinutes).toBe(10);
    expect((await svc.resume(id)).ok).toBe(false);
    expect((await svc.resume(id, '   ')).ok).toBe(false);
    const v = ok(await svc.resume(id, 'Problem ist nach Neustart wieder da'));
    expect(v.reopenCount).toBe(1);
    expect(v.notes.some((n) => n.text.includes('Problem ist nach Neustart wieder da'))).toBe(true);
    expect(incidents.get(id).status).toBe('triage');
    advance(4);
    ok(await svc.finish('solved'));
    const second = await incidents.saveEntry(incidents.draftFor(id, 'solved', 'y', 'llm'));
    expect(second.durationMinutes).toBe(4);
    expect(incidents.listEntries().map((e) => e.durationMinutes).sort((a, b) => a - b)).toEqual([4, 10]);
    expect(incidents.listEntries()[0]!.incidentId).toBe(id);
  });
  it('nur eine aktive Sitzung gleichzeitig', async () => {
    const { svc, incidents } = setup();
    ok(await svc.start('A'));
    expect(await svc.start('B')).toMatchObject({ ok: false });
    expect(incidents.list()).toHaveLength(1);
  });
});

describe('Telefonat-Modus', () => {
  it('neuer Incident: Status "Telefonat", lokale Einstiegsfragen ohne API-Aufruf, Zeitabschnitt "call"', async () => {
    const { svc, incidents } = setup({ providerId: 'anthropic' }); // ohne Key: würde bei API-Aufruf scheitern
    const v = ok(await svc.startCall());
    expect(v.call?.questions.map((q) => q.text)).toEqual(STARTER_QUESTIONS);
    const inc = incidents.get(v.incidentId!);
    expect(inc.status).toBe('call');
    expect(inc.segments[0]).toMatchObject({ kind: 'call', end: null });
    expect(inc.title).toBe('Telefonat');
  });
  it('hängt sich an den aktiven Incident, Zeitabschnitt wechselt auf "call" und danach zurück', async () => {
    const { svc, incidents } = setup();
    const id = ok(await svc.start('Drucker')).incidentId!;
    const v = ok(await svc.startCall());
    expect(v.incidentId).toBe(id);
    expect(incidents.get(id).status).toBe('call');
    ok(await svc.endCall(false));
    expect(incidents.get(id).segments.map((s) => s.kind)).toEqual(['work', 'call', 'work']);
    expect(incidents.get(id).status).toBe('triage');
  });
  it('Stichworte -> nächste Fragen (kleine Stufe), nichts Beantwortetes wiederholen, Notiz im Incident', async () => {
    const { svc, incidents } = setup();
    ok(await svc.startCall());
    const v = ok(await svc.callInput('seit gestern', STARTER_QUESTIONS[1]));
    const texts = v.call!.questions.map((q) => q.text);
    expect(texts.length).toBeGreaterThanOrEqual(1);
    expect(texts.length).toBeLessThanOrEqual(3);
    for (const q of texts) expect(STARTER_QUESTIONS).not.toContain(q);
    expect(v.lastRequest).toMatchObject({ task: 'call', tier: 'small' });
    expect(v.lastRequest?.imageBytes).toBe(0);
    expect(incidents.get(v.incidentId!).notes[0]!.text).toContain('seit gestern');
    const w = ok(await svc.callInput('Outlook'));
    for (const q of w.call!.questions.map((x) => x.text)) expect(texts).not.toContain(q);
  });
  it('genug Infos: Bereitschaft remote und Übergang in die Triage', async () => {
    const { svc, captures } = setup();
    ok(await svc.startCall());
    ok(await svc.callInput('a'));
    let v = ok(await svc.callInput('b'));
    expect(v.call?.suspicion).toBeTruthy();
    v = ok(await svc.callInput('c'));
    expect(v.call?.readiness).toBe('remote');
    const t = ok(await svc.endCall(true));
    expect(t.call).toBeNull();
    expect(t.recommendation?.action).toBe('start_remote');
    expect(captures()).toBe(0);
  });
  it('Längenlimits für Eingaben', async () => {
    const { svc } = setup();
    ok(await svc.startCall());
    const v = ok(await svc.callInput('x'.repeat(5000)));
    expect(v.notes[0]!.text.length).toBeLessThanOrEqual(1100);
  });
});

describe('Kostenlimit, Zeitlimit, Abbruch', () => {
  it('Limit erreicht: keine neuen Anfragen, bis angehoben oder einmal freigegeben', async () => {
    const reg = new ProviderRegistry().register({
      id: 'paid',
      name: 'Bezahlt',
      requiresKey: false,
      tiers: { small: 'claude-haiku-5-5', medium: 'claude-sonnet-5-5', large: 'claude-opus-5-5' },
      knownModels: [],
      create: () => createMockProvider({ getApiKey: () => 'x', getModel: () => 'claude-sonnet-5-5' }),
    } satisfies ProviderDefinition);
    const s = setup({ registry: reg, providerId: 'paid', cost: { limitEur: 0.0005, warnEur: 0.0001 } });
    const r = await s.svc.start('Drucker');
    expect(r).toMatchObject({ ok: false, error: { code: 'limit' } });
    s.cost.allowOnce();
    expect((await s.svc.start('Drucker')).ok).toBe(true);
    // Freigabe verbraucht -> nächste Anfrage wird wieder vorab geprüft
    expect(await s.svc.react('later')).toMatchObject({ ok: true });
    const blocked = await s.svc.askFirst();
    expect(blocked).toMatchObject({ ok: false, error: { code: 'limit' } });
    s.cost.raise(100);
    expect((await s.svc.askFirst()).ok).toBe(true);
  });
  it('keine Eskalation, wenn die größere Stufe das Limit sprengen würde', async () => {
    const reg = new ProviderRegistry().register({
      id: 'paid',
      name: 'x',
      requiresKey: false,
      tiers: { small: 'claude-haiku-5-5', medium: 'claude-sonnet-5-5', large: 'claude-opus-5-5' },
      knownModels: [],
      create: (ctx) => createMockProvider(ctx),
    } satisfies ProviderDefinition);
    // Medium (Sonnet) ~0,02 USD Obergrenze, Large (Opus) ~0,04: Limit dazwischen
    const s = setup({ registry: reg, providerId: 'paid', cost: { limitEur: 0.03 } });
    ok(await s.svc.start('unsicher beim Klick'));
    const v = ok(await s.svc.react('done'));
    expect(v.lastRequest?.tier).toBe('medium');
    expect(v.lastRequest?.escalated).toBe(false);
  });
  it('Zeitlimit: Anfrage hängt -> Fehler timeout, Zustand "error"; Abbrechen und Erneut versuchen', async () => {
    vi.useFakeTimers();
    let hang = true;
    const base = createMockProvider();
    const provider: LlmProvider = { ...base, recommend: (req, o) => (hang ? new Promise(() => undefined) : base.recommend(req, o)) };
    const reg = new ProviderRegistry().register({ id: 'slow', name: 's', requiresKey: false, tiers: { medium: 'm' }, knownModels: [], create: () => provider });
    const s = setup({ registry: reg, providerId: 'slow', timeoutMs: 5000 });
    const p = s.svc.start('Drucker');
    await vi.advanceTimersByTimeAsync(6000);
    expect(await p).toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(s.svc.view().activity.kind).toBe('error');
    hang = false;
    const retry = await s.svc.retryLast();
    expect(retry.ok).toBe(true);
    expect(s.svc.view().activity.kind).toBe('idle');
  });
  it('Abbrechen/Manuell weiter: Anfrage wird verworfen, späte Antwort ändert nichts', async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const base = createMockProvider();
    const provider: LlmProvider = { ...base, recommend: (req, o) => new Promise((res) => (release = () => res(base.recommend(req, o)))) };
    const reg = new ProviderRegistry().register({ id: 'slow', name: 's', requiresKey: false, tiers: { medium: 'm' }, knownModels: [], create: () => provider });
    const s = setup({ registry: reg, providerId: 'slow', timeoutMs: 60_000 });
    const p = s.svc.start('Drucker');
    await vi.advanceTimersByTimeAsync(10);
    const a = await s.svc.abortRequest(true);
    expect(a.ok && a.value.notes.some((n) => n.text.includes('manuell'))).toBe(true);
    release();
    await p;
    expect(s.svc.view().recommendation).toBeNull();
    expect(s.svc.view().activity.kind).toBe('idle');
  });
  it('Usage/Kosten pro Incident nur als Zahlen, Gesamtsumme im Verlauf', async () => {
    const { svc, incidents } = setup();
    const v = ok(await svc.start('Passwort vergessen'));
    ok(await svc.react('done'));
    const inc = incidents.get(v.incidentId!);
    expect(inc.usage.requests).toBe(2);
    expect(inc.llmLog.map((l) => l.task)).toEqual(['triage', 'triage']);
    expect(inc.usage.inputTokens).toBe(inc.llmLog.reduce((a, l) => a + l.inputTokens, 0));
  });
  it('Aktivität: Anfrage-Status mit Modell/Stufe im Protokoll, danach wieder bereit', async () => {
    const { svc } = setup();
    ok(await svc.start('Drucker'));
    const kinds = svc.view().activityLog.map((e) => e.kind);
    expect(kinds).toContain('requesting');
    expect(svc.view().activityLog.find((e) => e.kind === 'requesting')?.detail).toBe('mock-small (small)');
    expect(svc.view().activity.kind).toBe('idle');
  });
});
