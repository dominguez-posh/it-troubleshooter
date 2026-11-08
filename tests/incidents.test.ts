import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IncidentManager, type SessionSnapshot } from '../src/main/incidents';
import { IncidentStore, migrate } from '../src/main/incidentStore';
import { csvCell, entriesToCsv, CsvExportSink, neutralize } from '../src/main/sinks';
import {
  deriveTitle,
  durationMs,
  formatDuration,
  queryIncidents,
  resumeRequiresReason,
  statusDetail,
  statusFor,
  toSummary,
  validateReopenReason,
  type Incident,
  type TimeEntry,
} from '../src/shared/incident';
import { buildTimeEntryDraft, fallbackSummary, redactSensitive } from '../src/shared/timeEntry';
import { buildTimeline } from '../src/shared/timeline';
import { CHAT_MIN_SIZE, defaultChatBounds, validateChatBounds } from '../src/shared/windowBounds';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itt-inc-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const snap = (over: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  problem: 'Drucker druckt nicht',
  phase: 'rec',
  recommendation: { action: 'start_remote', instruction: 'Öffnen', reason: 'r' },
  events: [],
  history: [],
  notes: [],
  currentStep: null,
  call: false,
  holding: false,
  timerPaused: false,
  serverAccess: null,
  ...over,
});

function manager(startMs = Date.UTC(2026, 10, 8, 10, 0, 0)) {
  const clock = { t: startMs };
  const store = new IncidentStore(dir);
  store.load();
  const m = new IncidentManager(store, () => clock.t);
  return { m, store, clock, advance: (min: number) => (clock.t += min * 60_000) };
}

describe('Statusmaschine', () => {
  it('leitet den Status automatisch aus dem Ablauf ab', () => {
    const base = { call: false, holding: false, inSteps: false, recommendation: null, started: true };
    expect(statusFor({ ...base, started: false })).toBe('draft');
    expect(statusFor(base)).toBe('triage');
    expect(statusFor({ ...base, call: true })).toBe('call');
    expect(statusFor({ ...base, holding: true })).toBe('waiting');
    expect(statusFor({ ...base, inSteps: true })).toBe('remote');
    expect(statusFor({ ...base, recommendation: { action: 'ask_customer', instruction: 'x', reason: 'y' } })).toBe('waiting');
    expect(statusFor({ ...base, recommendation: { action: 'contact_customer', instruction: 'x', reason: 'y', talkingPoints: ['a'] } })).toBe('waiting');
    expect(statusFor({ ...base, recommendation: { action: 'start_remote', instruction: 'x', reason: 'y' } })).toBe('triage');
  });
  it('Wiederaufnahme: abgeschlossene Fälle brauchen eine Begründung, andere nicht', () => {
    expect(resumeRequiresReason('solved')).toBe(true);
    expect(resumeRequiresReason('unsolved')).toBe(true);
    expect(resumeRequiresReason('paused')).toBe(false);
    expect(resumeRequiresReason('waiting')).toBe(false);
    expect(() => validateReopenReason('   ')).toThrow(/Begründung/);
    expect(() => validateReopenReason(undefined)).toThrow();
    expect(() => validateReopenReason('x'.repeat(501))).toThrow(/zu lang/);
    expect(validateReopenReason('  Fehler wieder da ')).toBe('Fehler wieder da');
  });
});

describe('IncidentManager: Zeitmessung und Status', () => {
  it('create startet den Zeitabschnitt, sync ändert Status und pausiert bei Warten auf Kunden', () => {
    const { m, advance } = manager();
    const id = m.create('Drucker druckt nicht', false);
    expect(m.get(id).status).toBe('triage');
    advance(10);
    m.sync(id, snap());
    expect(m.timerInfo(id)).toMatchObject({ running: true, elapsedMs: 10 * 60_000 });
    m.sync(id, snap({ holding: true }));
    expect(m.get(id).status).toBe('waiting');
    expect(m.timerInfo(id).running).toBe(false);
    advance(30);
    expect(m.timerInfo(id).elapsedMs).toBe(10 * 60_000);
    m.sync(id, snap({ holding: false }));
    advance(5);
    expect(m.timerInfo(id).elapsedMs).toBe(15 * 60_000);
  });
  it('Telefonat ist ein eigener Zeitabschnitt "call", Wechsel zu Arbeit öffnet einen neuen', () => {
    const { m, advance } = manager();
    const id = m.create('', true);
    expect(m.get(id).title).toBe('Telefonat');
    expect(m.get(id).status).toBe('call');
    advance(4);
    m.sync(id, snap({ call: true, recommendation: null, phase: null }));
    m.sync(id, snap({ call: false }));
    const segs = m.get(id).segments;
    expect(segs.map((s) => s.kind)).toEqual(['call', 'work']);
    expect(segs[0]!.end).not.toBeNull();
    expect(segs[1]!.end).toBeNull();
  });
  it('manuelle Zeitpause (timerPaused) und Fortsetzen', () => {
    const { m, advance } = manager();
    const id = m.create('p', false);
    advance(2);
    m.sync(id, snap({ timerPaused: true }));
    advance(10);
    m.sync(id, snap({ timerPaused: false }));
    advance(3);
    expect(m.timerInfo(id).elapsedMs).toBe(5 * 60_000);
  });
  it('pause: Entwurf ohne Inhalt, "waiting" bei offener Rückfrage, sonst "paused"; Zeit stoppt', () => {
    const { m, advance } = manager();
    const a = m.create('p', false);
    m.pause(a, snap({ recommendation: null, phase: null }));
    expect(m.get(a).status).toBe('draft');
    const b = m.create('q', false);
    advance(5);
    m.pause(b, snap({ recommendation: { action: 'ask_customer', instruction: 'x', reason: 'y' } }));
    expect(m.get(b).status).toBe('waiting');
    const c = m.create('r', false);
    m.pause(c, snap());
    expect(m.get(c).status).toBe('paused');
    expect(m.timerInfo(c).running).toBe(false);
  });
  it('nur eine aktive Sitzung gleichzeitig', () => {
    const { m } = manager();
    const a = m.create('a', false);
    const b = (() => {
      m.pause(a, snap());
      return m.create('b', false);
    })();
    expect(() => m.beginResume(a)).toThrow(/aktive Sitzung/);
    m.pause(b, snap());
    expect(m.beginResume(a).id).toBe(a);
  });
  it('Wiedereröffnung: Begründung Pflicht, wird als Verlaufseintrag und Zusatzinfo gespeichert; Zähler wächst', () => {
    const { m } = manager();
    const id = m.create('p', false);
    m.finish(id, 'solved');
    expect(() => m.beginResume(id)).toThrow(/Begründung/);
    expect(() => m.beginResume(id, '  ')).toThrow();
    const inc = m.beginResume(id, 'Fehler tritt wieder auf');
    expect(inc.reopens).toHaveLength(1);
    expect(inc.reopens[0]).toMatchObject({ reason: 'Fehler tritt wieder auf', previousStatus: 'solved' });
    expect(inc.notes.some((n) => n.text.includes('Fehler tritt wieder auf') && n.text.includes('Gelöst'))).toBe(true);
    expect(inc.status).toBe('triage');
    expect(m.reopenCount(id)).toBe(1);
    m.finish(id, 'unsolved');
    m.beginResume(id, 'nochmal');
    expect(m.reopenCount(id)).toBe(2);
    expect(m.list()[0]!.reopenCount).toBe(2);
  });
  it('manuelle Übersteuerung nur für erlaubte Status, nicht für die aktive Sitzung', () => {
    const { m } = manager();
    const id = m.create('p', false);
    expect(() => m.setStatus(id, 'paused')).toThrow(/aktive Sitzung/);
    m.pause(id, snap());
    expect(m.setStatus(id, 'solved').status).toBe('solved');
    expect(() => m.setStatus(id, 'remote')).toThrow();
  });
  it('Dauer manuell korrigieren, Titel/Kunde editieren, Löschen', () => {
    const { m, advance } = manager();
    const id = m.create('Titel', false);
    advance(10);
    m.pause(id, snap());
    expect(m.setDuration(id, 25).manualAdjustmentMs).toBe(15 * 60_000);
    expect(durationMs(m.get(id), 0)).toBe(25 * 60_000);
    expect(() => m.setDuration(id, -1)).toThrow();
    expect(m.update(id, { title: ' Neu ', customer: 'ACME' })).toMatchObject({ title: 'Neu', customer: 'ACME' });
    expect(() => m.update(id, { title: '' })).toThrow();
    m.delete(id);
    expect(() => m.get(id)).toThrow();
  });
  it('Absturz: offene Abschnitte enden beim letzten Herzschlag, laufende Fälle kommen als "pausiert" zurück', () => {
    const { m, store, clock, advance } = manager();
    const id = m.create('p', false);
    advance(5);
    m.heartbeat();
    advance(120); // App war weg, Zeit darf nicht zählen
    const store2 = new IncidentStore(dir);
    store2.load();
    const m2 = new IncidentManager(store2, () => clock.t);
    expect(m2.recoverAfterCrash()).toBe(1);
    const inc = m2.get(id);
    expect(inc.status).toBe('paused');
    expect(durationMs(inc, clock.t)).toBe(5 * 60_000);
    expect(store.incidents()).toHaveLength(1);
  });
  it('Nutzungszähler und Log enthalten nur Zahlen und Modellnamen', () => {
    const { m } = manager();
    const id = m.create('p', false);
    m.recordLlm(id, { task: 'triage', tier: 'small', model: 'm', reason: 'Triage', escalated: false, inputTokens: 100, outputTokens: 10, imageBytes: 0, costUsd: 0.01 });
    m.recordLlm(id, { task: 'step', tier: 'medium', model: 'm2', reason: 'Schritt', escalated: false, inputTokens: 200, outputTokens: 20, imageBytes: 5000, costUsd: 0.02 });
    expect(m.usageOf(id)).toEqual({ requests: 2, inputTokens: 300, outputTokens: 30, costUsd: 0.03 });
    expect(JSON.stringify(m.get(id).llmLog)).not.toMatch(/Drucker|screenshot/i);
  });
});

describe('Zeiterfassung', () => {
  it('Entwurf: Dauer aus aktiver Zeit, nur nicht erfasster Teil, Mindestens 1 Min., Ende = letzter Abschnitt', async () => {
    const { m, advance } = manager();
    const id = m.create('p', false);
    advance(42);
    m.finish(id, 'solved');
    const d = m.draftFor(id, 'solved', 'Zusammenfassung', 'llm');
    expect(d.durationMinutes).toBe(42);
    expect(Date.parse(d.end) - Date.parse(d.start)).toBe(42 * 60_000);
    expect(d).toMatchObject({ incidentId: id, result: 'solved', summarySource: 'llm' });
    expect(d.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const e = await m.saveEntry(d);
    expect(e.status).toBe('open');
    expect(m.listEntries()).toHaveLength(1);
    // zweiter Abschluss nach Wiedereröffnung erzeugt einen eigenen Eintrag nur für die neue Arbeit
    m.beginResume(id, 'wieder da');
    advance(7);
    m.finish(id, 'solved');
    const d2 = m.draftFor(id, 'solved', 'neu', 'fallback');
    expect(d2.durationMinutes).toBe(7);
    await m.saveEntry(d2);
    const list = m.listEntries();
    expect(list).toHaveLength(2);
    expect(list.every((x) => x.incidentId === id)).toBe(true);
    expect(list.map((x) => x.durationMinutes).sort((a, b) => a - b)).toEqual([7, 42]);
  });
  it('Validierung beim Speichern', async () => {
    const { m, advance } = manager();
    const id = m.create('p', false);
    advance(3);
    m.finish(id, 'solved');
    const d = m.draftFor(id, 'solved', 'x', 'llm');
    await expect(m.saveEntry({ ...d, date: '08.11.2026' })).rejects.toThrow(/Datum/);
    await expect(m.saveEntry({ ...d, durationMinutes: 0 })).rejects.toThrow(/Dauer/);
    await expect(m.saveEntry({ ...d, durationMinutes: 1.5 })).rejects.toThrow();
  });
  it('Beschreibung wird um Passwörter und Tokens bereinigt', () => {
    expect(redactSensitive('Passwort: geheim123 und Token=abc sowie sk-ant-abcdefgh12345')).not.toMatch(/geheim123|abc |sk-ant/);
    expect(redactSensitive('Kennwort ist hunter2')).toContain('[entfernt]');
    const inc = { problem: 'P', history: [{ step: { text: 's', target: null }, outcome: 'failed' as const }] };
    expect(fallbackSummary(inc, 'unsolved')).toContain('1 ohne Erfolg');
  });
  it('buildTimeEntryDraft rundet und begrenzt', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const inc = { id: 'i', title: 'T', customer: 'K', problem: '', segments: [{ start: new Date(now - 30_000).toISOString(), end: new Date(now).toISOString() }], manualAdjustmentMs: 0, loggedMs: 0 } as unknown as Incident;
    expect(buildTimeEntryDraft(inc, 'solved', 'x'.repeat(2000), 'llm', now).durationMinutes).toBe(1);
    expect(buildTimeEntryDraft(inc, 'solved', 'x'.repeat(2000), 'llm', now).description).toHaveLength(1000);
  });
});

describe('CSV-Export', () => {
  const entry = (over: Partial<TimeEntry> = {}): TimeEntry => ({
    id: '1', date: '2026-11-08', start: '2026-11-08T09:05:00', end: '2026-11-08T09:35:00', durationMinutes: 30, incidentId: 'i', incidentTitle: 'Titel',
    customer: 'ACME', description: 'Text', result: 'solved', status: 'open', createdAt: 'x', ...over,
  });
  it('Spalten: Datum, Start, Ende, Dauer in Minuten, Incident, Kunde, Beschreibung', () => {
    const lines = entriesToCsv([entry()]).trim().split('\r\n');
    expect(lines[0]).toBe('Datum,Start,Ende,Dauer in Minuten,Incident,Kunde,Beschreibung');
    expect(lines[1]).toBe('2026-11-08,09:05,09:35,30,Titel,ACME,Text');
  });
  it('Escaping von Komma, Anführungszeichen und Zeilenumbruch', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('sagt "hi"')).toBe('"sagt ""hi"""');
    expect(csvCell('zwei\nZeilen')).toBe('"zwei\nZeilen"');
    expect(csvCell(30)).toBe('30');
  });
  it('CSV-Injection: führende =, +, -, @ werden neutralisiert (Zahlen nicht)', () => {
    for (const c of ['=SUM(A1)', '+1', '-2', '@cmd', '\tx']) expect(neutralize(c).startsWith("'")).toBe(true);
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(entriesToCsv([entry({ description: '=1+1', customer: '@x' })])).toContain("'=1+1");
    expect(neutralize('normal')).toBe('normal');
  });
  it('Export-Sink schreibt Datei mit BOM und markiert als übertragen; Abbruch ändert nichts', async () => {
    const written: Record<string, string> = {};
    const sink = new CsvExportSink(async () => 'x.csv', (p, d) => void (written[p] = d));
    const res = await sink.submit([entry()]);
    expect(res.transferredIds).toEqual(['1']);
    expect(written['x.csv']!.charCodeAt(0)).toBe(0xfeff);
    expect((await new CsvExportSink(async () => null).submit([entry()])).transferredIds).toEqual([]);
  });
  it('Manager: Export markiert Einträge als übertragen, Status lässt sich zurücksetzen', async () => {
    const { m, advance } = manager();
    const id = m.create('p', false);
    advance(3);
    m.finish(id, 'solved');
    const e = await m.saveEntry(m.draftFor(id, 'solved', 'x', 'llm'));
    expect(await m.exportCsv([e.id], async () => join(dir, 'out.csv'))).toMatchObject({ count: 1 });
    expect(readFileSync(join(dir, 'out.csv'), 'utf8')).toContain('Datum,Start');
    expect(m.listEntries()[0]!.status).toBe('transferred');
    expect(m.setEntriesStatus([e.id], 'open')[0]!.status).toBe('open');
    await expect(m.exportCsv([], async () => null)).rejects.toThrow();
  });
});

describe('IncidentStore: Speicher, Migration, atomares Schreiben, defekte Datei', () => {
  const legacy = [{ id: 'a', title: 'Alt', problem: 'p', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', status: 'solved', history: [{ step: { text: 's' }, outcome: 'done' }] }];
  it('migriert Version 0 (Array ohne Schema-Version) auf 1 und ergänzt Standardwerte', () => {
    const r = migrate(legacy);
    expect(r.from).toBe(0);
    expect(r.data.schemaVersion).toBe(1);
    expect(r.data.incidents[0]).toMatchObject({ id: 'a', customer: '', reopens: [], segments: [], loggedMs: 0, serverAccess: null });
    expect(r.data.incidents[0]!.history[0]!.step.target).toBeNull();
  });
  it('lädt eine Version-0-Datei, speichert sie migriert und behält die Daten', () => {
    writeFileSync(join(dir, 'incidents.json'), JSON.stringify(legacy));
    const s = new IncidentStore(dir);
    expect(s.load().migratedFrom).toBe(0);
    expect(s.incidents()).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'incidents.json'), 'utf8')).schemaVersion).toBe(1);
  });
  it('verwirft einzelne ungültige Einträge, behält die übrigen', () => {
    const r = migrate({ schemaVersion: 1, incidents: [legacy[0], { nope: true }], timeEntries: [] });
    expect(r.data.incidents).toHaveLength(1);
    expect(r.dropped).toBe(1);
  });
  it('beschädigte Datei wird beiseitegelegt, nicht überschrieben; Start mit leerem Bestand', () => {
    writeFileSync(join(dir, 'incidents.json'), '{kaputt');
    const s = new IncidentStore(dir);
    const rep = s.load();
    expect(rep.corruptBackup).toBeDefined();
    expect(s.incidents()).toHaveLength(0);
    expect(readdirSync(dir).some((f) => f.startsWith('incidents.corrupt-'))).toBe(true);
  });
  it('zu neue Schema-Version wird nicht überschrieben', () => {
    writeFileSync(join(dir, 'incidents.json'), JSON.stringify({ schemaVersion: 99, incidents: [] }));
    const s = new IncidentStore(dir);
    expect(s.load().corruptBackup).toBeDefined();
  });
  it('atomar: Fehler beim Schreiben lässt die vorhandene Datei unverändert und hinterlässt keine kaputte Hauptdatei', () => {
    const good = new IncidentStore(dir);
    good.load();
    good.put(migrate(legacy).data.incidents[0]!);
    const before = readFileSync(join(dir, 'incidents.json'), 'utf8');
    const failing = new IncidentStore(dir, {
      writeFileSync: () => {
        throw new Error('Platte voll');
      },
      renameSync: () => undefined,
    });
    failing.load();
    expect(() => failing.put(migrate(legacy).data.incidents[0]!)).toThrow(/Platte voll/);
    expect(readFileSync(join(dir, 'incidents.json'), 'utf8')).toBe(before);
  });
  it('enthält weder Bilder noch Schlüssel-Felder', () => {
    const { m } = manager();
    m.create('Problem', false);
    const raw = readFileSync(join(dir, 'incidents.json'), 'utf8');
    expect(raw).not.toMatch(/jpeg|base64|apiKey|api_key|sk-ant/i);
  });
});

describe('Liste: Suche, Filter, Sortierung, Statusinfo', () => {
  const mk = (id: string, title: string, status: Incident['status'], updated: string, extra: Partial<Incident> = {}): Incident =>
    ({ id, title, customer: '', problem: `${title} Text`, createdAt: updated, updatedAt: updated, status, recommendation: null, inSteps: false, events: [], history: [], currentStep: null, notes: [], supporterNotes: '', segments: [], manualAdjustmentMs: 0, loggedMs: 0, lastActiveAt: updated, reopens: [], serverAccess: null, usage: { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, llmLog: [], ...extra }) as Incident;
  const list = [
    mk('1', 'Drucker', 'solved', '2026-01-03T00:00:00Z', { segments: [{ start: '2026-01-03T00:00:00Z', end: '2026-01-03T01:00:00Z' }] }),
    mk('2', 'Outlook', 'remote', '2026-01-05T00:00:00Z'),
    mk('3', 'VPN', 'waiting', '2026-01-04T00:00:00Z', { notes: [{ text: 'Zertifikat abgelaufen', afterSteps: 0 }] }),
  ].map((i) => toSummary(i, Date.parse('2026-02-01')));
  it('Suche in Titel und Zusatzinfos', () => {
    expect(queryIncidents(list, { query: 'zertifikat' }).map((i) => i.id)).toEqual(['3']);
    expect(queryIncidents(list, { query: 'OUTLOOK' }).map((i) => i.id)).toEqual(['2']);
  });
  it('Filter nach Status und "offen"', () => {
    expect(queryIncidents(list, { status: 'solved' }).map((i) => i.id)).toEqual(['1']);
    expect(queryIncidents(list, { status: 'open' }).map((i) => i.id).sort()).toEqual(['2', '3']);
  });
  it('Sortierung', () => {
    expect(queryIncidents(list, { sort: 'updated' }).map((i) => i.id)).toEqual(['2', '3', '1']);
    expect(queryIncidents(list, { sort: 'title' }).map((i) => i.id)).toEqual(['1', '2', '3']);
    expect(queryIncidents(list, { sort: 'duration' })[0]!.id).toBe('1');
  });
  it('Zusatzinfo "Schritt 4, letzter Schritt: ..." und Hilfsfunktionen', () => {
    const steps = Array.from({ length: 3 }, (_, i) => ({ step: { text: `Klick ${i}`, target: null }, outcome: 'done' as const }));
    const inc = mk('x', 'T', 'remote', '2026-01-01T00:00:00Z', { history: steps, currentStep: { text: 'Öffnen', target: null }, inSteps: true });
    expect(statusDetail(inc)).toBe('Schritt 4, letzter Schritt: Öffnen');
    expect(deriveTitle('  Erste Zeile\nzweite')).toBe('Erste Zeile');
    expect(deriveTitle('')).toBe('Ohne Titel');
    expect(formatDuration(90 * 60_000)).toBe('1 h 30 min');
  });
});

describe('Fensterposition und Verlauf', () => {
  const wa = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: 0, width: 1280, height: 1000 }];
  it('gültige Position bleibt, Größe wird auf Minimum begrenzt', () => {
    expect(validateChatBounds({ x: 100, y: 100, width: 400, height: 300 }, wa, wa[0]!)).toEqual({ x: 100, y: 100, width: 400, height: 300 });
    expect(validateChatBounds({ x: 100, y: 100, width: 10, height: 10 }, wa, wa[0]!)).toMatchObject({ width: CHAT_MIN_SIZE.width, height: CHAT_MIN_SIZE.height });
  });
  it('Position auf abgestecktem Monitor fällt auf die Standardposition zurück', () => {
    const r = validateChatBounds({ x: 5000, y: 100, width: 340, height: 210 }, wa, wa[0]!);
    expect(r).toEqual(defaultChatBounds(wa[0]!));
  });
  it('Fenster zweiter Monitor ist gültig; ungültige Daten -> Standard', () => {
    expect(validateChatBounds({ x: 2000, y: 50, width: 340, height: 210 }, wa, wa[0]!).x).toBe(2000);
    expect(validateChatBounds({ x: NaN }, wa, wa[0]!)).toEqual(defaultChatBounds(wa[0]!));
    expect(validateChatBounds(null, wa, wa[0]!)).toEqual(defaultChatBounds(wa[0]!));
  });
  it('Standardgröße ist kompakt', () => {
    const d = defaultChatBounds(wa[0]!);
    expect(d.width).toBeLessThanOrEqual(360);
    expect(d.height).toBeLessThanOrEqual(260);
  });
  it('Verlauf und Zusatzinfo werden chronologisch zusammengeführt', () => {
    const t = buildTimeline({
      history: [{ step: { text: 'A', target: null }, outcome: 'done' }, { step: { text: 'B', target: null }, outcome: 'failed', comment: 'k' }],
      notes: [{ text: 'vorher', afterSteps: 0 }, { text: 'zwischen', afterSteps: 1 }, { text: 'jetzt', afterSteps: 2 }],
    });
    expect(t.map((x) => x.text)).toEqual(['vorher', 'A', 'zwischen', 'B', 'jetzt']);
    expect(t[3]).toMatchObject({ outcome: 'failed', comment: 'k' });
  });
});
