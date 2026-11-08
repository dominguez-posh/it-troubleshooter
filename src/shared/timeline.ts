import type { SessionView } from './types';

export interface TimelineItem {
  kind: 'step' | 'note';
  text: string;
  outcome?: 'done' | 'failed';
  comment?: string;
}

/**
 * Chronologische Liste für das Begleit-Chatfenster. Eine Notiz mit afterSteps = k wurde eingegeben,
 * während Schritt k+1 offen war, steht also vor dem Ergebnis von Schritt k+1.
 */
export function buildTimeline(session: Pick<SessionView, 'history' | 'notes'>): TimelineItem[] {
  const out: TimelineItem[] = [];
  const notesAt = (k: number) => session.notes.filter((n) => n.afterSteps === k);
  session.history.forEach((h, i) => {
    for (const n of notesAt(i)) out.push({ kind: 'note', text: n.text });
    const item: TimelineItem = { kind: 'step', text: h.step.text, outcome: h.outcome };
    if (h.comment) item.comment = h.comment;
    out.push(item);
  });
  for (const n of session.notes.filter((x) => x.afterSteps >= session.history.length)) out.push({ kind: 'note', text: n.text });
  return out;
}
