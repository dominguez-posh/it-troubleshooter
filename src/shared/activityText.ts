import type { ActivityState } from './types';

export type Tone = 'idle' | 'busy' | 'warn' | 'error';

export interface ActivityLabel {
  icon: string;
  text: string;
  tone: Tone;
}

const secs = (ms: number): number => Math.max(0, Math.floor(ms / 1000));

/** Anzeigetext der Aktivität (für Chat-Statusleiste, Hauptfenster und Overlay-Pill). */
export function describeActivity(a: ActivityState, nowMs: number): ActivityLabel {
  const s = secs(nowMs - a.since);
  switch (a.kind) {
    case 'idle':
      return { icon: '●', text: 'Bereit – wartet auf dich', tone: 'idle' };
    case 'capturing':
      return { icon: '◉', text: 'Screenshot wird aufgenommen', tone: 'busy' };
    case 'resizing':
      return { icon: '◉', text: 'Bild wird verkleinert', tone: 'busy' };
    case 'requesting':
      return { icon: '…', text: `Anfrage läuft an ${a.detail ?? 'das Modell'} (${s} s)`, tone: s > 45 ? 'warn' : 'busy' };
    case 'validating':
      return { icon: '…', text: 'Antwort wird geprüft', tone: 'busy' };
    case 'retrying':
      return { icon: '↻', text: `Wiederholung nach Fehler${a.attempt ? ` (Versuch ${a.attempt.n} von ${a.attempt.of})` : ''}${a.detail ? `: ${a.detail}` : ''}`, tone: 'warn' };
    case 'escalating':
      return { icon: '↑', text: `Eskalation auf größeres Modell${a.detail ? `: ${a.detail}` : ''}`, tone: 'warn' };
    case 'ratelimit': {
      const left = a.until ? Math.max(0, Math.ceil((a.until - nowMs) / 1000)) : 0;
      return { icon: '⏳', text: left > 0 ? `Rate-Limit: noch ${left} s Wartezeit` : 'Rate-Limit: du kannst es erneut versuchen', tone: 'warn' };
    }
    case 'error':
      return { icon: '!', text: `${a.detail ?? 'Fehler'}${a.hint ? ` – ${a.hint}` : ''}`, tone: 'error' };
    case 'paused':
      return { icon: '⏸', text: 'Zeitmessung pausiert', tone: 'idle' };
    case 'waiting_target':
      return { icon: '⌛', text: `wartet, bis ${a.detail ?? 'das Zielfenster'} vorne ist …`, tone: 'busy' };
    case 'please_click':
      return { icon: '➜', text: `Bitte klicken: ${a.detail ?? 'siehe Pfeil'}`, tone: 'busy' };
    case 'change_detected':
      return { icon: '✓', text: 'Klick erkannt – denkt nach …', tone: 'busy' };
    case 'no_change':
      return { icon: '⌛', text: 'wartet – keine Änderung erkannt (Manuell weiter möglich)', tone: 'warn' };
    case 'chat_writing':
      return { icon: '✎', text: 'schreibt dir im Chat', tone: 'busy' };
    case 'waiting_customer':
      return { icon: '☎', text: 'Wartet auf den Kunden', tone: 'idle' };
  }
}
