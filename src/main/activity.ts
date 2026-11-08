import type { ActivityKind, ActivityLogEntry, ActivityState } from '../shared/types';

const MAX_LOG = 40;
/** Nach dieser Zeit ohne Antwort gilt eine Anfrage als hängend. */
export const REQUEST_TIMEOUT_MS = 60_000;

/** Nur unkritische Zeichen (Modellnamen, Codes, Stufen); entfernt Schlüssel-ähnliche Muster. Nie Eingaben oder Bildinhalte übergeben. */
export function safeDetail(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, '[entfernt]')
    .replace(/[^A-Za-z0-9._:/ ()+\-äöüÄÖÜß,]/g, '')
    .slice(0, 80)
    .trim();
  return t || undefined;
}

export const HINTS: Partial<Record<string, string>> = {
  auth: 'API-Key prüfen (Einstellungen).',
  no_key: 'API-Key in den Einstellungen hinterlegen.',
  network: 'Netzwerkverbindung prüfen und erneut versuchen.',
  rate_limit: 'Kurz warten, dann erneut versuchen.',
  timeout: 'Keine Antwort. Erneut versuchen, abbrechen oder manuell weitermachen.',
  invalid_response: 'Das Modell lieferte keine brauchbare Antwort.',
  capture: 'Quelle prüfen (Fenster sichtbar, nicht minimiert).',
  api: 'Anbieter meldet einen Fehler.',
};

/**
 * Zentrale Zustandsmaschine der sichtbaren KI-Aktivität. Hält den aktuellen Zustand und ein Protokoll
 * der letzten Zustände mit Dauern. Texte stammen nur aus festen Kategorien plus unkritischem Detail.
 */
export class ActivityTracker {
  private state: ActivityState;
  private log: ActivityLogEntry[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly onChange: () => void = () => undefined,
  ) {
    this.state = { kind: 'idle', since: this.now() };
  }

  current(): ActivityState {
    return { ...this.state };
  }

  entries(): ActivityLogEntry[] {
    return this.log.map((e) => ({ ...e }));
  }

  set(kind: ActivityKind, extra: { detail?: string; until?: number; attempt?: { n: number; of: number }; hint?: string } = {}): void {
    const t = this.now();
    const prev = this.state;
    if (prev.kind !== 'idle' || this.log.length === 0) {
      const entry: ActivityLogEntry = { at: prev.since, kind: prev.kind, durationMs: Math.max(0, t - prev.since) };
      if (prev.detail) entry.detail = prev.detail;
      this.log.push(entry);
      if (this.log.length > MAX_LOG) this.log.shift();
    }
    const next: ActivityState = { kind, since: t };
    const d = safeDetail(extra.detail);
    if (d) next.detail = d;
    if (extra.until !== undefined) next.until = extra.until;
    if (extra.attempt) next.attempt = extra.attempt;
    const h = safeDetail(extra.hint ?? '') ? extra.hint : undefined;
    if (h) next.hint = h.slice(0, 120);
    this.state = next;
    this.onChange();
  }

  /** Fehler mit Handlungshinweis; bei Rate-Limit mit Countdown. */
  error(code: string, retryAfterSec?: number): void {
    if (code === 'rate_limit') {
      const sec = retryAfterSec ?? 30;
      this.set('ratelimit', { detail: code, until: this.now() + sec * 1000, hint: HINTS['rate_limit'] ?? '' });
    } else {
      this.set('error', { detail: code, hint: HINTS[code] ?? 'Unerwarteter Fehler.' });
    }
  }

  idle(): void {
    if (this.state.kind !== 'idle') this.set('idle');
  }

  /** Verbleibende Wartezeit bei ratelimit in Sekunden (0 wenn vorbei). */
  remainingSec(): number {
    return this.state.kind === 'ratelimit' && this.state.until ? Math.max(0, Math.ceil((this.state.until - this.now()) / 1000)) : 0;
  }

  /** Hängt eine Anfrage länger als das Zeitlimit? */
  isStuck(timeoutMs: number = REQUEST_TIMEOUT_MS): boolean {
    return this.state.kind === 'requesting' && this.now() - this.state.since > timeoutMs;
  }
}
