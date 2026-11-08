import { durationMs, type Incident, type TimeEntryDraft } from './incident';

function localDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Entfernt offensichtlich sensible Werte aus Zusammenfassungen (Passwörter, Tokens, API-Keys).
 * Heuristik als zweite Verteidigungslinie; der Supporter prüft den Text im Dialog zusätzlich.
 */
export function redactSensitive(text: string): string {
  return text
    .replace(/\b(passwort|kennwort|password|passwd|pwd|pin|token|secret|api[-_ ]?key|schlüssel)\b(\s*(?:ist|lautet|war|:|=)\s*)\S+/gi, '$1$2[entfernt]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]{10,})/g, '[entfernt]');
}

/** Zusammenfassung ohne LLM (z. B. offline oder ohne Key). */
export function fallbackSummary(inc: Pick<Incident, 'problem' | 'history'>, result: 'solved' | 'unsolved'): string {
  const failed = inc.history.filter((h) => h.outcome === 'failed').length;
  const first = inc.problem.trim().split(/\r?\n/)[0] ?? '';
  const parts = [`Problem: ${first.length > 160 ? `${first.slice(0, 157)}...` : first}.`];
  parts.push(`${inc.history.length} Schritte durchgeführt${failed ? `, davon ${failed} ohne Erfolg` : ''}.`);
  parts.push(result === 'solved' ? 'Ergebnis: gelöst.' : 'Ergebnis: nicht gelöst bzw. abgebrochen.');
  return redactSensitive(parts.join(' '));
}

/**
 * Baut den Entwurf für den Zeiterfassungs-Eintrag aus dem noch nicht erfassten Teil der aktiven Zeit.
 * Das Ende ist das Ende des letzten Zeitabschnitts, der Beginn ergibt sich aus der Dauer.
 */
export function buildTimeEntryDraft(
  inc: Incident,
  result: 'solved' | 'unsolved',
  description: string,
  summarySource: 'llm' | 'fallback',
  nowMs: number,
): TimeEntryDraft {
  const unlogged = Math.max(0, durationMs(inc, nowMs) - inc.loggedMs);
  const minutes = Math.max(1, Math.round(unlogged / 60_000));
  const ends = inc.segments.map((s) => (s.end ? Date.parse(s.end) : nowMs)).filter(Number.isFinite);
  const endMs = ends.length ? Math.max(...ends) : nowMs;
  const startMs = endMs - minutes * 60_000;
  return {
    date: localDate(startMs),
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    durationMinutes: minutes,
    incidentId: inc.id,
    incidentTitle: inc.title,
    customer: inc.customer,
    description: redactSensitive(description).trim().slice(0, 1000),
    result,
    summarySource,
  };
}
