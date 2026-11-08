import { randomUUID } from 'node:crypto';
import {
  deriveTitle,
  durationMs,
  emptyUsage,
  isTerminal,
  isTimerRunning,
  MANUAL_STATUSES,
  STATUS_LABELS,
  statusFor,
  toSummary,
  validateReopenReason,
  type Incident,
  type IncidentStatus,
  type IncidentSummary,
  type TimeEntry,
  type TimeEntryDraft,
  type TimeEntryStatus,
} from '../shared/incident';
import { buildTimeEntryDraft, redactSensitive } from '../shared/timeEntry';
import type { HistoryEntry, IncidentPatch, LlmLogEntry, RecEvent, Recommendation, ServerAccess, SessionNote, ShotRef, Step, UsageTotals } from '../shared/types';
import type { IncidentStore } from './incidentStore';
import { CsvExportSink, LocalListSink } from './sinks';

/** Was die Sitzung dem Incident-Speicher meldet. Enthält keine Screenshots. */
export interface SessionSnapshot {
  problem: string;
  phase: 'rec' | 'steps' | null;
  recommendation: Recommendation | null;
  events: RecEvent[];
  history: HistoryEntry[];
  notes: SessionNote[];
  currentStep: Step | null;
  call: boolean;
  holding: boolean;
  timerPaused: boolean;
  serverAccess: ServerAccess | null;
  commandsUsed?: Incident['commandsUsed'];
}

export interface SessionPersistence {
  create(problem: string, call: boolean): string;
  sync(id: string, snap: SessionSnapshot): void;
  pause(id: string, snap: SessionSnapshot): void;
  finish(id: string, result: 'solved' | 'unsolved'): void;
  timerInfo(id: string): { running: boolean; elapsedMs: number };
  recordLlm(id: string, entry: Omit<LlmLogEntry, 'at'>): UsageTotals;
  usageOf(id: string): UsageTotals;
  reopenCount(id: string): number;
  beginResume(id: string, reason?: string): Incident;
  shotsInfo(id: string): { enabled: boolean; count: number };
  addShot(id: string, ref: ShotRef): void;
  patchShot(id: string, shotId: string, patch: Partial<Pick<ShotRef, 'outcome'>>): void;
}

const MAX_NOTES = 50;
const MAX_EVENTS = 100;
const MAX_LOG = 200;
const MAX_MINUTES = 60 * 24 * 31;

export function closeOpenSegments(inc: Incident, atIso: string): void {
  for (const s of inc.segments) {
    if (s.end === null) s.end = Date.parse(atIso) < Date.parse(s.start) ? s.start : atIso;
  }
}

/** Stellt sicher, dass genau ein Zeitabschnitt der gewünschten Art läuft (oder keiner bei null). */
export function ensureSegment(inc: Incident, kind: 'work' | 'call' | null, nowIso: string): void {
  const open = inc.segments.find((s) => s.end === null);
  if (kind === null) return closeOpenSegments(inc, nowIso);
  if (open && (open.kind ?? 'work') === kind) return;
  closeOpenSegments(inc, nowIso);
  inc.segments.push({ start: nowIso, end: null, kind });
}

export class IncidentManager implements SessionPersistence {
  private activeId: string | null = null;
  readonly localSink: LocalListSink;

  constructor(
    private readonly store: IncidentStore,
    private readonly now: () => number = Date.now,
  ) {
    this.localSink = new LocalListSink(store);
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
  private must(id: string): Incident {
    const i = this.store.get(id);
    if (!i) throw new Error('Incident nicht gefunden.');
    return i;
  }
  private save(inc: Incident): Incident {
    inc.updatedAt = this.iso();
    this.store.put(inc);
    return inc;
  }

  get active(): string | null {
    return this.activeId;
  }

  // ---------- SessionPersistence ----------
  create(problem: string, call: boolean): string {
    const t = this.iso();
    const inc: Incident = {
      id: randomUUID(),
      title: problem.trim() ? deriveTitle(problem) : 'Telefonat',
      customer: '',
      problem: problem.trim(),
      createdAt: t,
      updatedAt: t,
      status: call ? 'call' : 'triage',
      recommendation: null,
      inSteps: false,
      events: [],
      history: [],
      currentStep: null,
      notes: [],
      supporterNotes: '',
      segments: [{ start: t, end: null, kind: call ? 'call' : 'work' }],
      manualAdjustmentMs: 0,
      loggedMs: 0,
      lastActiveAt: t,
      reopens: [],
      serverAccess: null,
      storeShots: true,
      shots: [],
      commandsUsed: [],
      usage: emptyUsage(),
      llmLog: [],
    };
    this.store.put(inc);
    this.activeId = inc.id;
    return inc.id;
  }

  private apply(inc: Incident, snap: SessionSnapshot): void {
    if (snap.problem) inc.problem = snap.problem;
    inc.recommendation = snap.recommendation;
    inc.inSteps = snap.phase === 'steps';
    inc.events = snap.events.slice(-MAX_EVENTS);
    inc.history = snap.history;
    inc.notes = snap.notes.slice(-MAX_NOTES);
    inc.currentStep = snap.currentStep;
    inc.serverAccess = snap.serverAccess;
    if (snap.commandsUsed) inc.commandsUsed = snap.commandsUsed.slice(-30);
  }

  sync(id: string, snap: SessionSnapshot): void {
    const inc = this.must(id);
    this.apply(inc, snap);
    inc.status = statusFor({ call: snap.call, holding: snap.holding, inSteps: snap.phase === 'steps', recommendation: snap.recommendation, started: true });
    const t = this.iso();
    ensureSegment(inc, snap.holding || snap.timerPaused ? null : snap.call ? 'call' : 'work', t);
    inc.lastActiveAt = t;
    this.save(inc);
  }

  pause(id: string, snap: SessionSnapshot): void {
    const inc = this.must(id);
    this.apply(inc, snap);
    const live = statusFor({ call: false, holding: snap.holding, inSteps: snap.phase === 'steps', recommendation: snap.recommendation, started: true });
    inc.status = live === 'waiting' ? 'waiting' : !snap.recommendation && snap.history.length === 0 ? 'draft' : 'paused';
    closeOpenSegments(inc, this.iso());
    if (this.activeId === id) this.activeId = null;
    this.save(inc);
  }

  finish(id: string, result: 'solved' | 'unsolved'): void {
    const inc = this.must(id);
    closeOpenSegments(inc, this.iso());
    inc.status = result;
    if (this.activeId === id) this.activeId = null;
    this.save(inc);
  }

  timerInfo(id: string): { running: boolean; elapsedMs: number } {
    const inc = this.store.get(id);
    return inc ? { running: isTimerRunning(inc), elapsedMs: durationMs(inc, this.now()) } : { running: false, elapsedMs: 0 };
  }

  recordLlm(id: string, entry: Omit<LlmLogEntry, 'at'>): UsageTotals {
    const inc = this.must(id);
    inc.usage = {
      requests: inc.usage.requests + 1,
      inputTokens: inc.usage.inputTokens + entry.inputTokens,
      outputTokens: inc.usage.outputTokens + entry.outputTokens,
      costUsd: inc.usage.costUsd + (entry.costUsd ?? 0),
    };
    inc.llmLog = [...inc.llmLog, { ...entry, at: this.iso() }].slice(-MAX_LOG);
    this.save(inc);
    return inc.usage;
  }

  usageOf(id: string): UsageTotals {
    return this.store.get(id)?.usage ?? emptyUsage();
  }

  reopenCount(id: string): number {
    return this.store.get(id)?.reopens.length ?? 0;
  }

  /** Nimmt einen Fall wieder auf. Abgeschlossene Fälle brauchen eine Begründung; nur eine aktive Sitzung gleichzeitig. */
  beginResume(id: string, reason?: string): Incident {
    if (this.activeId && this.activeId !== id) {
      throw new Error('Es läuft bereits eine aktive Sitzung. Bitte zuerst pausieren oder abschließen.');
    }
    const inc = this.must(id);
    const prev = inc.status;
    if (isTerminal(prev)) {
      const r = validateReopenReason(reason);
      inc.reopens.push({ at: this.iso(), reason: r, previousStatus: prev });
      inc.notes.push({ text: `Fall wurde wiedereröffnet (zuvor: ${STATUS_LABELS[prev]}). Begründung: ${r}`, afterSteps: inc.history.length });
    }
    inc.status = 'triage';
    ensureSegment(inc, 'work', this.iso());
    inc.lastActiveAt = this.iso();
    this.activeId = id;
    this.save(inc);
    return structuredClone(inc);
  }

  // ---------- Screenshots (nur Verweise; Bilder liegen in der ShotStore-Ablage) ----------
  shotsInfo(id: string): { enabled: boolean; count: number } {
    const inc = this.store.get(id);
    return { enabled: inc?.storeShots ?? true, count: inc?.shots.length ?? 0 };
  }

  addShot(id: string, ref: ShotRef): void {
    const inc = this.must(id);
    inc.shots = [...inc.shots, ref];
    this.store.put(inc);
  }

  patchShot(id: string, shotId: string, patch: Partial<Pick<ShotRef, 'outcome'>>): void {
    const inc = this.store.get(id);
    const s = inc?.shots.find((x) => x.id === shotId);
    if (!inc || !s) return;
    Object.assign(s, patch);
    this.store.put(inc);
  }

  shotRefs(id: string): ShotRef[] {
    return structuredClone(this.must(id).shots);
  }

  setStoreShots(id: string, on: boolean): Incident {
    const inc = this.must(id);
    inc.storeShots = on;
    return structuredClone(this.save(inc));
  }

  /** Ersetzt einen Verweis (z. B. nach dem Schwärzen) oder ändert "behalten". */
  replaceShot(id: string, ref: ShotRef): ShotRef[] {
    const inc = this.must(id);
    inc.shots = inc.shots.map((s) => (s.id === ref.id ? ref : s));
    this.store.put(inc);
    return structuredClone(inc.shots);
  }

  removeShots(id: string, shotIds?: string[]): ShotRef[] {
    const inc = this.must(id);
    const set = shotIds ? new Set(shotIds) : null;
    inc.shots = set ? inc.shots.filter((s) => !set.has(s.id)) : [];
    this.store.put(inc);
    return structuredClone(inc.shots);
  }

  /** Entfernt Verweise abgelaufener Screenshots in allen Incidents und gibt (Incident, Screenshot) zum Löschen der Dateien zurück. */
  collectExpired(isExpired: (s: ShotRef) => boolean): Array<{ incidentId: string; shotId: string }> {
    const out: Array<{ incidentId: string; shotId: string }> = [];
    for (const inc of this.store.incidents()) {
      const gone = inc.shots.filter(isExpired);
      if (!gone.length) continue;
      inc.shots = inc.shots.filter((s) => !isExpired(s));
      this.store.put(inc);
      for (const s of gone) out.push({ incidentId: inc.id, shotId: s.id });
    }
    return out;
  }

  /** Entfernt alle Verweise in allen Incidents (Dateien löscht der Aufrufer). */
  clearAllShotRefs(): number {
    let n = 0;
    for (const inc of this.store.incidents()) {
      if (!inc.shots.length) continue;
      n += inc.shots.length;
      inc.shots = [];
      this.store.put(inc);
    }
    return n;
  }

  // ---------- Liste und Verwaltung ----------
  list(): IncidentSummary[] {
    const t = this.now();
    return this.store.incidents().map((i) => toSummary(i, t));
  }

  get(id: string): Incident {
    return structuredClone(this.must(id));
  }

  update(id: string, patch: IncidentPatch): Incident {
    const inc = this.must(id);
    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (!t || t.length > 120) throw new Error('Der Titel muss 1 bis 120 Zeichen lang sein.');
      inc.title = t;
    }
    if (patch.customer !== undefined) {
      if (patch.customer.length > 120) throw new Error('Kunde/Referenz ist zu lang (max. 120 Zeichen).');
      inc.customer = patch.customer.trim();
    }
    if (patch.supporterNotes !== undefined) {
      if (patch.supporterNotes.length > 4000) throw new Error('Die Notizen sind zu lang (max. 4000 Zeichen).');
      inc.supporterNotes = patch.supporterNotes;
    }
    return structuredClone(this.save(inc));
  }

  /** Manuelle Übersteuerung; laufende Zustände ergeben sich aus dem Ablauf und sind nicht wählbar. */
  setStatus(id: string, status: IncidentStatus): Incident {
    if (!MANUAL_STATUSES.includes(status)) throw new Error('Dieser Status kann nicht manuell gesetzt werden.');
    if (id === this.activeId) throw new Error('Dieser Fall ist die aktive Sitzung. Bitte zuerst pausieren oder abschließen.');
    const inc = this.must(id);
    closeOpenSegments(inc, this.iso());
    inc.status = status;
    return structuredClone(this.save(inc));
  }

  /** Setzt die gesamte aktive Zeit (Minuten) manuell. */
  setDuration(id: string, minutes: number): Incident {
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > MAX_MINUTES) throw new Error('Ungültige Dauer.');
    const inc = this.must(id);
    const raw = inc.segments.reduce((a, s) => a + durationMs({ segments: [s], manualAdjustmentMs: 0 }, this.now()), 0);
    inc.manualAdjustmentMs = Math.round(minutes) * 60_000 - raw;
    return structuredClone(this.save(inc));
  }

  delete(id: string): void {
    if (id === this.activeId) throw new Error('Die aktive Sitzung kann nicht gelöscht werden.');
    if (!this.store.remove(id)) throw new Error('Incident nicht gefunden.');
  }

  /** Schließt einen nicht aktiven Fall ab. */
  finishInactive(id: string, result: 'solved' | 'unsolved'): Incident {
    if (id === this.activeId) throw new Error('Dieser Fall ist die aktive Sitzung. Bitte dort abschließen.');
    const inc = this.must(id);
    closeOpenSegments(inc, this.iso());
    inc.status = result;
    return structuredClone(this.save(inc));
  }

  // ---------- Herzschlag, Absturz, Beenden ----------
  heartbeat(): void {
    if (!this.activeId) return;
    const inc = this.store.get(this.activeId);
    if (!inc) return;
    inc.lastActiveAt = this.iso();
    this.store.put(inc);
  }

  /** Nach Absturz: offene Zeitabschnitte enden beim letzten Herzschlag; laufende Zustände werden "pausiert". */
  recoverAfterCrash(): number {
    let n = 0;
    for (const inc of this.store.incidents()) {
      const open = inc.segments.some((s) => s.end === null);
      const running = inc.status === 'triage' || inc.status === 'remote' || inc.status === 'call';
      if (!open && !running) continue;
      closeOpenSegments(inc, inc.lastActiveAt);
      if (running) inc.status = 'paused';
      this.store.put(inc);
      n++;
    }
    return n;
  }

  // ---------- Zeiterfassung ----------
  draftFor(id: string, result: 'solved' | 'unsolved', description: string, source: 'llm' | 'fallback'): TimeEntryDraft {
    return buildTimeEntryDraft(this.must(id), result, description, source, this.now());
  }

  async saveEntry(draft: TimeEntryDraft): Promise<TimeEntry> {
    const inc = this.must(draft.incidentId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) throw new Error('Ungültiges Datum.');
    if (!Number.isInteger(draft.durationMinutes) || draft.durationMinutes < 1 || draft.durationMinutes > 24 * 60) {
      throw new Error('Die Dauer muss zwischen 1 und 1440 Minuten liegen.');
    }
    if (draft.result !== 'solved' && draft.result !== 'unsolved') throw new Error('Ungültiges Ergebnis.');
    const entry: TimeEntry = {
      id: randomUUID(),
      date: draft.date,
      start: draft.start,
      end: draft.end,
      durationMinutes: draft.durationMinutes,
      incidentId: inc.id,
      incidentTitle: inc.title,
      customer: draft.customer.slice(0, 120),
      description: redactSensitive(draft.description).slice(0, 1000),
      result: draft.result,
      status: 'open',
      createdAt: this.iso(),
    };
    await this.localSink.submit([entry]);
    inc.loggedMs = durationMs(inc, this.now());
    this.save(inc);
    return entry;
  }

  listEntries(): TimeEntry[] {
    return this.store.timeEntries().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  setEntriesStatus(ids: string[], status: TimeEntryStatus): TimeEntry[] {
    this.store.updateEntries(ids, { status });
    return this.listEntries();
  }

  deleteEntry(id: string): TimeEntry[] {
    this.store.removeEntry(id);
    return this.listEntries();
  }

  async exportCsv(ids: string[], pickPath: () => Promise<string | null>): Promise<{ path: string; count: number } | null> {
    const set = new Set(ids);
    const entries = this.store.timeEntries().filter((e) => set.has(e.id));
    if (!entries.length) throw new Error('Keine Einträge ausgewählt.');
    const res = await new CsvExportSink(pickPath).submit(entries);
    if (!res.detail) return null;
    this.store.updateEntries(res.transferredIds, { status: 'transferred' });
    return { path: res.detail, count: res.transferredIds.length };
  }
}
