import type { HistoryEntry, LlmLogEntry, RecEvent, Recommendation, ServerAccess, SessionNote, ShotRef, Step, UsageTotals } from './types';

/** Aktuelle Version des Speicherformats (siehe IncidentStore und migrate). */
export const SCHEMA_VERSION = 1;

export type IncidentStatus = 'draft' | 'call' | 'triage' | 'waiting' | 'remote' | 'paused' | 'solved' | 'unsolved';

export const STATUS_LABELS: Record<IncidentStatus, string> = {
  draft: 'Entwurf',
  call: 'Telefonat',
  triage: 'Triage',
  waiting: 'Rückfrage offen',
  remote: 'Fernwartung läuft',
  paused: 'Pausiert',
  solved: 'Gelöst',
  unsolved: 'Nicht gelöst',
};
export const ALL_STATUSES = Object.keys(STATUS_LABELS) as IncidentStatus[];

/** Wiedereröffnung eines abgeschlossenen Falls mit Begründung. */
export interface ReopenEntry {
  at: string;
  reason: string;
  previousStatus: IncidentStatus;
}

export const MAX_REOPEN_REASON = 500;

export interface TimeSegment {
  start: string;
  end: string | null;
  /** Zeitabschnitt "Telefonat" oder normale Arbeit (Standard). */
  kind?: 'work' | 'call';
}

/** Ein Fall. Enthält bewusst keine Screenshots und keine API-Keys. */
export interface Incident {
  id: string;
  title: string;
  customer: string;
  problem: string;
  createdAt: string;
  updatedAt: string;
  status: IncidentStatus;
  /** Aktuelle Hauptempfehlung oder null. */
  recommendation: Recommendation | null;
  /** Pfeil-Schritt-Modus (Fernwartung) war aktiv. */
  inSteps: boolean;
  /** Reaktionen auf Empfehlungen (nur Text, begrenzt). */
  events: RecEvent[];
  history: HistoryEntry[];
  /** Offener Schritt (Text und Ziel in Bildpixeln) – wird beim Wiederaufnehmen nicht mehr angezeigt, da neu aufgenommen wird. */
  currentStep: Step | null;
  /** Zusatzinfos aus dem Chatfenster sowie Antworten auf Rückfragen. */
  notes: SessionNote[];
  /** Freie Notizen des Supporters. */
  supporterNotes: string;
  segments: TimeSegment[];
  manualAdjustmentMs: number;
  /** Bereits per Zeiterfassungs-Eintrag erfasste Zeit. */
  loggedMs: number;
  /** Letzter Herzschlag einer laufenden Sitzung (für die Wiederherstellung nach Absturz). */
  lastActiveAt: string;
  reopens: ReopenEntry[];
  /** Antwort auf "Zugriff auf den Server?" – keine Zugangsdaten. */
  serverAccess: ServerAccess | null;
  /** Screenshots dieses Incidents speichern (Standard an). */
  storeShots: boolean;
  /** Verweise auf lokal gespeicherte Screenshots (Bilder liegen nie in der JSON). */
  shots: ShotRef[];
  /** Vom Supporter als gemacht bestätigte Befehle (für die Doku). */
  commandsUsed: Array<{ command: string; explanation: string; mode: 'readonly' | 'changing' }>;
  /** Nur Zahlen und Modellnamen, keine Inhalte. */
  usage: UsageTotals;
  llmLog: LlmLogEntry[];
}

export type TimeEntryStatus = 'open' | 'transferred';

export interface TimeEntry {
  id: string;
  /** Lokales Datum YYYY-MM-DD */
  date: string;
  start: string;
  end: string;
  durationMinutes: number;
  incidentId: string;
  incidentTitle: string;
  customer: string;
  description: string;
  result: 'solved' | 'unsolved';
  status: TimeEntryStatus;
  createdAt: string;
}

export type TimeEntryDraft = Omit<TimeEntry, 'id' | 'status' | 'createdAt'> & {
  summarySource: 'llm' | 'fallback';
};

export interface IncidentSummary {
  id: string;
  title: string;
  customer: string;
  status: IncidentStatus;
  detail: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  timerRunning: boolean;
  reopenCount: number;
  usage: UsageTotals;
  searchText: string;
}

/**
 * Zustand des Troubleshootings automatisch aus dem Ablauf ableiten (Statusmaschine).
 * Telefonat und Warten auf den Kunden haben Vorrang vor der Phase.
 */
export function statusFor(s: { call: boolean; holding: boolean; inSteps: boolean; recommendation: Recommendation | null; started: boolean }): IncidentStatus {
  if (s.call) return 'call';
  if (s.holding) return 'waiting';
  if (s.inSteps) return 'remote';
  const r = s.recommendation;
  if (!r) return s.started ? 'triage' : 'draft';
  return r.action === 'ask_customer' || r.action === 'contact_customer' ? 'waiting' : 'triage';
}

export const isTerminal = (s: IncidentStatus): boolean => s === 'solved' || s === 'unsolved';
/** Status, die nur bei laufender Sitzung vorkommen dürfen. */
export const isRunningStatus = (s: IncidentStatus): boolean => s === 'triage' || s === 'remote' || s === 'call';

/** Status, die der Supporter manuell setzen darf (laufende Zustände ergeben sich aus dem Ablauf). */
export const MANUAL_STATUSES: IncidentStatus[] = ['draft', 'waiting', 'paused', 'solved', 'unsolved'];

export function deriveTitle(problem: string): string {
  const first = problem.trim().split(/\r?\n/)[0] ?? '';
  const t = first.replace(/\s+/g, ' ').trim();
  if (!t) return 'Ohne Titel';
  return t.length > 70 ? `${t.slice(0, 67)}...` : t;
}

export function segmentMs(s: TimeSegment, nowMs: number): number {
  const a = Date.parse(s.start);
  const b = s.end ? Date.parse(s.end) : nowMs;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, b - a);
}

export function durationMs(inc: Pick<Incident, 'segments' | 'manualAdjustmentMs'>, nowMs: number): number {
  const sum = inc.segments.reduce((acc, s) => acc + segmentMs(s, nowMs), 0);
  return Math.max(0, sum + inc.manualAdjustmentMs);
}

export const isTimerRunning = (inc: Pick<Incident, 'segments'>): boolean => inc.segments.some((s) => s.end === null);

function clip(s: string, n = 110): string {
  return s.length > n ? `${s.slice(0, n - 3)}...` : s;
}

/** Kurze Zusatzinfo für die Liste, z. B. "Schritt 4, letzter Schritt: ...". */
export function statusDetail(inc: Incident): string {
  const stepInfo = (): string => {
    const last = inc.currentStep ?? inc.history[inc.history.length - 1]?.step;
    if (!last) return '';
    const n = inc.history.length + (inc.currentStep ? 1 : 0);
    return `Schritt ${n}, letzter Schritt: ${clip(last.text)}`;
  };
  if (isTerminal(inc.status)) return `${inc.history.length} Schritte`;
  if (inc.status === 'draft') return 'Noch nicht eingeschätzt';
  if (inc.status === 'call') return 'Im Gespräch mit dem Kunden';
  if (inc.status === 'remote' || (inc.inSteps && inc.history.length > 0)) return stepInfo();
  const r = inc.recommendation;
  if (r) return clip(r.action === 'ask_customer' ? `Rückfrage: ${r.instruction}` : `Empfehlung: ${r.instruction}`);
  return inc.status === 'triage' ? 'Einschätzung läuft' : '';
}

export function toSummary(inc: Incident, nowMs: number): IncidentSummary {
  const search = [inc.title, inc.customer, inc.problem, inc.supporterNotes, ...inc.notes.map((n) => n.text)].join('\n').toLowerCase();
  return {
    id: inc.id,
    title: inc.title,
    customer: inc.customer,
    status: inc.status,
    detail: statusDetail(inc),
    createdAt: inc.createdAt,
    updatedAt: inc.updatedAt,
    durationMs: durationMs(inc, nowMs),
    timerRunning: isTimerRunning(inc),
    reopenCount: inc.reopens.length,
    usage: inc.usage,
    searchText: search.slice(0, 6000),
  };
}

export type IncidentSort = 'updated' | 'created' | 'title' | 'duration' | 'status';

export function queryIncidents(
  list: IncidentSummary[],
  opts: { query?: string; status?: IncidentStatus | 'all' | 'open'; sort?: IncidentSort },
): IncidentSummary[] {
  const q = (opts.query ?? '').trim().toLowerCase();
  const out = list.filter((i) => {
    if (opts.status === 'open' && isTerminal(i.status)) return false;
    if (opts.status && opts.status !== 'all' && opts.status !== 'open' && i.status !== opts.status) return false;
    return !q || i.searchText.includes(q);
  });
  const key = opts.sort ?? 'updated';
  const order = (s: IncidentStatus) => ALL_STATUSES.indexOf(s);
  out.sort((a, b) => {
    switch (key) {
      case 'title':
        return a.title.localeCompare(b.title, 'de');
      case 'created':
        return b.createdAt.localeCompare(a.createdAt);
      case 'duration':
        return b.durationMs - a.durationMs;
      case 'status':
        return order(a.status) - order(b.status) || b.updatedAt.localeCompare(a.updatedAt);
      default:
        return b.updatedAt.localeCompare(a.updatedAt);
    }
  });
  return out;
}

export function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}


export const emptyUsage = (): UsageTotals => ({ requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });

/**
 * Darf ein Fall in diesen Zustand wiederaufgenommen werden? Abgeschlossene Fälle brauchen eine Begründung,
 * alle anderen (Entwurf, Rückfrage offen, pausiert) nicht.
 */
export function resumeRequiresReason(status: IncidentStatus): boolean {
  return isTerminal(status);
}

export function validateReopenReason(reason: unknown): string {
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('Bitte eine Begründung für die Wiederaufnahme angeben.');
  const r = reason.trim();
  if (r.length > MAX_REOPEN_REASON) throw new Error(`Die Begründung ist zu lang (max. ${MAX_REOPEN_REASON} Zeichen).`);
  return r;
}
