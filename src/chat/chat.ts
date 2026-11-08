import { describeActivity } from '../shared/activityText';
import { buildTimeline } from '../shared/timeline';
import type { ChatApi, Result, SessionView } from '../shared/types';
import { renderHero, type CardHandlers } from '../ui/hero';

declare global {
  interface Window {
    chatApi: ChatApi;
  }
}

const api = window.chatApi;
const $ = <T extends HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Element fehlt: ${id}`);
  return e as T;
};

let view: SessionView | null = null;
let expanded = false;
const input = $<HTMLTextAreaElement>('input');

function apply(r: Result<SessionView>): void {
  if (r.ok) {
    view = r.value;
    render();
  } else {
    $('status').textContent = r.error.message;
  }
}

const handlers: CardHandlers = {
  react: (resp, c, ack) => void api.reactRecommendation(resp, c, ack).then(apply),
  serverAccess: (a) => void api.setServerAccess(a).then(apply),
  note: (t) => void api.addNote(t).then(apply),
  copy: (t) => api.copyText(t),
  report: (o, c) => void api.report(o, c).then(apply),
  startRemote: () => void api.reactRecommendation('done').then(apply),
  callInput: (t, q) => void api.callInput(t, q).then(apply),
  endCall: (to) => void api.endCall(to).then(apply),
  startCall: () => void api.startCall().then(apply),
  retry: () => void api.retryLast().then(apply),
  abort: (m) => void api.abortRequest(m).then(apply),
  focusInput: (pre) => {
    if (pre && !input.value) input.value = pre;
    input.focus();
  },
  takeInput: () => {
    const v = input.value.trim();
    input.value = '';
    return v || undefined;
  },
};

function renderHistory(): void {
  const h = $('hist-list');
  h.replaceChildren();
  if (!view) return;
  const ol = document.createElement('ol');
  for (const it of buildTimeline(view).slice(-8)) {
    const li = document.createElement('li');
    li.className = it.kind === 'note' ? 'note' : it.outcome === 'failed' ? 'fail' : '';
    li.textContent = it.kind === 'note' ? `Info: ${it.text}` : `${it.text} (${it.outcome === 'done' ? 'erledigt' : 'hat nicht geklappt'})`;
    ol.append(li);
  }
  if (!ol.children.length) {
    const li = document.createElement('li');
    li.textContent = 'Noch nichts passiert.';
    ol.append(li);
  }
  h.append(ol);
}

function render(): void {
  if (!view) return;
  const a = describeActivity(view.activity, Date.now());
  const c = view.cost;
  const costText = c.level === 'limit' ? 'Kostenlimit erreicht – Pause' : c.level !== 'ok' ? 'Hinweis: Kosten prüfen' : '';
  const plain = view.activity.kind === 'please_click' ? 'Du bist dran: bitte klicken' : a.text;
  $('status').textContent = costText && a.tone === 'idle' ? costText : view.incidentId ? plain : 'Kein Fall offen';
  renderHero($('card'), view, handlers, { compact: true, advanced: false });
  if (expanded) renderHistory();
  input.disabled = !view.incidentId || view.result !== null;
  $('b-call').hidden = !!view.call;
}

async function send(): Promise<void> {
  const t = input.value.trim();
  if (!t || !view) return;
  input.value = '';
  if (expanded) toggleHistory(false);
  if (view.call) {
    const m = /^(.*?) → (.*)$/s.exec(t);
    apply(await api.callInput(m ? m[2]! : t, m ? m[1]! : undefined));
  } else {
    apply(await api.addNote(t));
  }
}

function toggleHistory(on: boolean): void {
  expanded = on;
  $('hist').hidden = !on;
  $('b-hist').setAttribute('aria-expanded', String(on));
  $('b-hist').textContent = on ? 'Weniger' : 'Mehr';
  if (on) renderHistory();
  void api.setHistoryExpanded(on);
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  void send();
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void send();
  }
});
$('b-call').addEventListener('click', () => void api.startCall().then(apply));
$('b-hist').addEventListener('click', () => toggleHistory(!expanded));
$('b-close').addEventListener('click', () => void api.close());
$<HTMLInputElement>('reeval').addEventListener('change', (e) => void api.setReevaluate((e.target as HTMLInputElement).checked));
// Tastatursteuerung: Alt+Pfeile verschieben, Alt+Umschalt+Pfeile ändern die Größe.
window.addEventListener('keydown', (e) => {
  if (!e.altKey) return;
  const d: Record<string, [-1 | 0 | 1, -1 | 0 | 1]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const v = d[e.key];
  if (!v) return;
  e.preventDefault();
  void api.moveWindow({ mode: e.shiftKey ? 'resize' : 'move', dx: v[0], dy: v[1] });
});
// Der Verlauf klappt zu, sobald das Fenster den Fokus verliert (zurück auf Minimalgröße).
window.addEventListener('blur', () => {
  if (expanded) toggleHistory(false);
});
api.onSessionChanged((v) => {
  view = v;
  render();
});
api.onFocusInput(() => input.focus());
setInterval(() => {
  if (view && view.activity.kind !== 'idle') render();
}, 1000);

void api.getState().then((st) => {
  view = st.session;
  $<HTMLInputElement>('reeval').checked = st.reevaluate;
  render();
});
