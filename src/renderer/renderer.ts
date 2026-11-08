import { describeActivity } from '../shared/activityText';
import { formatEurShort } from '../shared/format';
import {
  ALL_STATUSES,
  formatDuration,
  MANUAL_STATUSES,
  queryIncidents,
  resumeRequiresReason,
  STATUS_LABELS,
  type Incident,
  type IncidentSort,
  type IncidentStatus,
  type IncidentSummary,
  type TimeEntry,
  type TimeEntryDraft,
} from '../shared/incident';
import { buildTimeline } from '../shared/timeline';
import type { AppError, CaptureSourceInfo, DocVariant, ModelTier, NormRect, RendererApi, Result, SessionView, SettingsView, ShotRef } from '../shared/types';
import { renderCard, type CardHandlers } from '../ui/card';

declare global {
  interface Window {
    itt: RendererApi;
  }
}

const api = window.itt;
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element fehlt: ${id}`);
  return el as T;
};
const inp = (id: string) => $<HTMLInputElement>(id);

let settings: SettingsView | null = null;
let sources: CaptureSourceInfo[] = [];
let selectedSource = '';
let view: SessionView | null = null;
let viewAt = Date.now();
let incidents: IncidentSummary[] = [];
let entries: TimeEntry[] = [];
let openIncident: Incident | null = null;
let draft: TimeEntryDraft | null = null;
let shownResultFor: string | null = null;

const ERROR_TITLES: Record<AppError['code'], string> = {
  auth: 'Ungültiger API-Key',
  rate_limit: 'Rate-Limit',
  network: 'Netzwerkfehler',
  no_key: 'API-Key fehlt',
  invalid_response: 'Ungültige Antwort',
  capture: 'Aufnahme fehlgeschlagen',
  api: 'Fehler beim Anbieter',
  timeout: 'Zeitüberschreitung',
  limit: 'Limit erreicht',
  internal: 'Fehler',
};

function setStatus(el: HTMLElement, kind: 'loading' | 'error' | 'info' | null, text = ''): void {
  el.hidden = kind === null;
  el.className = `status${kind === 'error' ? ' error' : kind === 'loading' ? ' loading' : ''}`;
  el.textContent = text;
}
const status = (kind: 'loading' | 'error' | 'info' | null, text = ''): void => setStatus($('status'), kind, text);
const showError = (e: AppError): void => status('error', `${ERROR_TITLES[e.code]}: ${e.message}`);

/** Ergebnis anwenden: Fehler anzeigen, sonst Sicht aktualisieren. */
function apply(r: Result<SessionView>): void {
  if (!r.ok) return showError(r.error);
  status(null);
  setView(r.value);
}

function setView(v: SessionView): void {
  view = v;
  viewAt = Date.now();
  renderSession();
  maybeOpenTimeDialog();
}

// ---------- Handler für die gemeinsame Karte ----------
const handlers: CardHandlers = {
  react: (resp, c, ack) => {
    if (resp === 'done' && view?.recommendation?.action === 'start_remote') return void api.startRemote(selectedSource || undefined).then(apply);
    void api.reactRecommendation(resp, c, ack).then(apply);
  },
  serverAccess: (a) => void api.setServerAccess(a).then(apply),
  note: (t) => void api.addNote(t).then(apply),
  copy: (t) => api.copyText(t),
  report: (o, c) => void api.reportStep(o, c).then(apply),
  startRemote: () => void api.startRemote(selectedSource || undefined).then(apply),
  callInput: (t, q) => void api.callInput(t, q).then(apply),
  endCall: (to) => void api.endCall(to).then(apply),
  startCall: () => void api.startCall().then(apply),
  retry: () => void api.retryLast().then(apply),
  abort: (m) => void api.abortRequest(m).then(apply),
  focusInput: (pre) => {
    if (pre && !inp('note').value) inp('note').value = pre;
    inp('note').focus();
  },
  takeInput: () => {
    const v = inp('note').value.trim();
    inp('note').value = '';
    return v || undefined;
  },
};

// ---------- Sitzung ----------
function renderSources(): void {
  const box = $('sources');
  box.replaceChildren();
  $('sources-empty').hidden = sources.length > 0;
  for (const s of sources) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'source';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(s.id === selectedSource));
    if (s.thumbnailDataUrl) {
      const img = document.createElement('img');
      img.src = s.thumbnailDataUrl;
      img.alt = '';
      b.append(img);
    } else {
      const d = document.createElement('div');
      d.className = 'noimg';
      d.textContent = 'keine Vorschau';
      b.append(d);
    }
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = s.name;
    const kind = document.createElement('div');
    kind.className = 'kind';
    kind.textContent = s.kind === 'screen' ? 'Ganzer Bildschirm' : 'Einzelnes Fenster';
    b.append(name, kind);
    b.addEventListener('click', () => {
      selectedSource = s.id;
      renderSources();
    });
    box.append(b);
  }
}

async function loadSources(): Promise<void> {
  const r = await api.listSources();
  if (!r.ok) return showError(r.error);
  sources = r.value;
  if (!sources.some((s) => s.id === selectedSource)) selectedSource = sources[0]?.id ?? '';
  renderSources();
}

function li(text: string, cls = ''): HTMLLIElement {
  const e = document.createElement('li');
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function renderSession(): void {
  const v = view;
  const active = !!v?.incidentId;
  $('setup-panel').hidden = active;
  $('session-panel').hidden = !(active && !v?.result);
  $('solved-panel').hidden = !(active && !!v?.result);
  if (!v) return;
  if (active && !v.result) {
    $('session-title').textContent = v.call ? 'Telefonat' : v.phase === 'steps' ? `Fernwartung · Schritt ${v.current?.index ?? ''}` : 'Einschätzung';
    $('problem-echo').textContent = v.problem ? `Problem: ${v.problem}` : 'Telefonat ohne Problemschilderung';
    renderCard($('card'), v, handlers);
    $('btn-remote').hidden = v.phase === 'steps' || !!v.call;
    $('btn-ask').hidden = !!v.call;
    $('btn-show').hidden = !v.current;
    $('btn-show').textContent = v.current?.overlayShown ? 'Pfeil ausblenden' : 'Pfeil anzeigen';
    $('btn-timer').textContent = v.timer.running ? 'Zeit pausieren' : 'Zeit fortsetzen';
    $('sources-box').hidden = !!v.call;
  }
  if (active && v.result) $('solved-title').textContent = v.result === 'solved' ? 'Problem gelöst' : 'Abgebrochen (nicht gelöst)';
  const h = $('history-list');
  h.replaceChildren();
  const tl = buildTimeline(v);
  $('history-panel').hidden = tl.length === 0;
  for (const it of tl) {
    if (it.kind === 'step') h.append(li(`${it.text} – ${it.outcome === 'done' ? 'erledigt' : 'hat nicht geklappt'}${it.comment ? ` (${it.comment})` : ''}`, it.outcome === 'failed' ? 'fail' : ''));
  }
  const n = $('notes-list');
  n.replaceChildren();
  for (const x of v.notes) n.append(li(x.text));
  const r = v.lastRequest;
  $('req-line').textContent = r
    ? `Letzte Anfrage: ${r.tier} (${r.model}) · ${r.reason} · ${r.inputTokens + r.outputTokens} Tokens${r.imageBytes ? ` · Bild ${Math.round(r.imageBytes / 1024)} KB` : ' · ohne Bild'} · Summe Incident: ${v.usage.inputTokens + v.usage.outputTokens} Tokens, ca. ${formatEurShort(v.cost.incidentEur)} (Schätzung)`
    : '';
  renderActivity();
  renderCost();
  const sh = v.shots;
  $('shots-line').textContent = v.incidentId
    ? sh.enabled
      ? `● Screenshots werden lokal gespeichert (${sh.count}) – ${sh.encrypted ? 'verschlüsselt' : 'ACHTUNG: unverschlüsselt'}. Pro Incident abschaltbar im Incident-Dialog.${sh.error ? ` Fehler: ${sh.error}` : ''}`
      : 'Screenshots werden für diesen Incident NICHT gespeichert.'
    : '';
}

function renderActivity(): void {
  if (!view) return;
  const a = describeActivity(view.activity, Date.now());
  const quiet = view.activity.kind === 'idle' || view.activity.kind === 'please_click';
  if (view.activity.kind === 'error') setStatus($('status'), 'error', `${a.icon} ${a.text}`);
  else if (!quiet) setStatus($('status'), 'loading', `${a.icon} ${a.text}`);
  else if (view.activity.kind === 'please_click') setStatus($('status'), 'info', `${a.icon} ${a.text}`);
  else if (!$('status').classList.contains('error')) status(null);
  const log = $('activity-list');
  log.replaceChildren();
  for (const e of [...view.activityLog].reverse()) {
    log.append(li(`${new Date(e.at).toLocaleTimeString('de-DE')} · ${describeActivity({ kind: e.kind, since: e.at, ...(e.detail ? { detail: e.detail } : {}) }, e.at).text} · ${Math.round(e.durationMs / 1000)} s`));
  }
}

function renderCost(): void {
  if (!view) return;
  const c = view.cost;
  $('cost-head').textContent = `${formatEurShort(c.periodEur)}${c.limitEur !== null ? ` / ${formatEurShort(c.limitEur)}` : ''} (${{ day: 'Tag', month: 'Monat', total: 'gesamt' }[c.period]}, Schätzung)`;
  const banner = $('cost-banner');
  const show = c.level === 'limit' || (c.level !== 'ok' && c.unacknowledged);
  banner.hidden = !show;
  if (show) {
    $('cost-banner-text').textContent =
      c.level === 'limit'
        ? 'Limit erreicht – pausiert. Neue Anfragen sind gesperrt (Schätzung, maßgeblich ist die Abrechnung beim Anbieter).'
        : `Warnung: ${formatEurShort(c.periodEur)}${c.limitEur !== null ? ` von ${formatEurShort(c.limitEur)}` : ''} (Schätzung)`;
    $('cost-raise').hidden = c.limitEur === null;
    $('cost-once').hidden = c.level !== 'limit';
  }
}

function tickTimer(): void {
  if (!view?.incidentId) return;
  const ms = view.timer.elapsedMs + (view.timer.running ? Date.now() - viewAt : 0);
  $('timer').textContent = formatDuration(ms);
  if (view.activity.kind !== 'idle') renderActivity();
}

// ---------- Zeiterfassung ----------
async function maybeOpenTimeDialog(): Promise<void> {
  const v = view;
  if (!v?.result || !v.incidentId || shownResultFor === v.incidentId + v.result) return;
  shownResultFor = v.incidentId + v.result;
  await openTimeDialog(v.incidentId, v.result);
}

async function openTimeDialog(incidentId: string, result: 'solved' | 'unsolved'): Promise<void> {
  const dlg = $<HTMLDialogElement>('time-dialog');
  setStatus($('td-status'), 'loading', 'Zusammenfassung wird erstellt (nur Text, kleine Modellstufe) …');
  dlg.showModal();
  const r = await api.prepareTimeEntry(incidentId, result);
  if (!r.ok) return setStatus($('td-status'), 'error', r.error.message);
  draft = r.value;
  setStatus($('td-status'), null);
  $('te-source').textContent = `${draft.incidentTitle} · ${result === 'solved' ? 'gelöst' : 'nicht gelöst/abgebrochen'} · Zusammenfassung: ${draft.summarySource === 'llm' ? 'vom Modell erzeugt' : 'lokal erzeugt'}`;
  inp('td-date').value = draft.date;
  inp('td-min').value = String(draft.durationMinutes);
  inp('td-customer').value = draft.customer;
  $<HTMLTextAreaElement>('td-desc').value = draft.description;
  $('td-info').textContent = `${new Date(draft.start).toLocaleString('de-DE')} bis ${new Date(draft.end).toLocaleTimeString('de-DE')}`;
}

async function loadEntries(): Promise<void> {
  const r = await api.listTimeEntries();
  if (!r.ok) return showError(r.error);
  entries = r.value;
  const body = $('te-body');
  body.replaceChildren();
  $('te-empty').hidden = entries.length > 0;
  for (const e of entries) {
    const tr = document.createElement('tr');
    const c = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset['id'] = e.id;
    c.append(cb);
    tr.append(c);
    for (const t of [e.date, `${e.durationMinutes} min`, e.incidentTitle, e.customer, e.description, e.status === 'open' ? 'offen' : 'übertragen']) {
      const td = document.createElement('td');
      td.textContent = t;
      tr.append(td);
    }
    const del = document.createElement('td');
    const b = document.createElement('button');
    b.className = 'btn small ghost';
    b.type = 'button';
    b.textContent = 'Löschen';
    b.addEventListener('click', async () => {
      if (window.confirm('Eintrag löschen?')) {
        await api.deleteTimeEntry(e.id);
        void loadEntries();
      }
    });
    del.append(b);
    tr.append(del);
    body.append(tr);
  }
}

const selectedEntryIds = (): string[] => [...document.querySelectorAll<HTMLInputElement>('#te-body input[type=checkbox]:checked')].map((c) => c.dataset['id']!);

// ---------- Incidents ----------
async function loadIncidents(): Promise<void> {
  const r = await api.listIncidents();
  if (!r.ok) return showError(r.error);
  incidents = r.value;
  renderIncidents();
}

function renderIncidents(): void {
  const list = queryIncidents(incidents, {
    query: inp('inc-search').value,
    status: $<HTMLSelectElement>('inc-status').value as IncidentStatus | 'all' | 'open',
    sort: $<HTMLSelectElement>('inc-sort').value as IncidentSort,
  });
  const body = $('inc-body');
  body.replaceChildren();
  $('inc-empty').hidden = list.length > 0;
  for (const i of list) {
    const tr = document.createElement('tr');
    const t = document.createElement('td');
    const title = document.createElement('div');
    title.textContent = i.title;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `${i.customer ? `${i.customer} · ` : ''}${i.detail}${i.reopenCount ? ` · wiedergeöffnet (${i.reopenCount}×)` : ''}`;
    t.append(title, sub);
    const s = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = `pill ${i.status}`;
    pill.textContent = STATUS_LABELS[i.status];
    s.append(pill);
    const cells = [new Date(i.updatedAt).toLocaleString('de-DE'), formatDuration(i.durationMs) + (i.timerRunning ? ' ●' : ''), `ca. ${formatEurShort(i.usage.costUsd * (settings?.usdEurRate ?? 0.92))}`];
    tr.append(t, s);
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.append(td);
    }
    const a = document.createElement('td');
    const open = document.createElement('button');
    open.className = 'btn small';
    open.type = 'button';
    open.textContent = 'Öffnen';
    open.addEventListener('click', () => void openIncidentDialog(i.id));
    a.append(open);
    tr.append(a);
    body.append(tr);
  }
}

async function openIncidentDialog(id: string): Promise<void> {
  const r = await api.getIncident(id);
  if (!r.ok) return showError(r.error);
  const inc = r.value;
  openIncident = inc;
  setStatus($('id-status'), null);
  inp('id-title').value = inc.title;
  inp('id-customer').value = inc.customer;
  const raw = inc.segments.reduce((a, s) => a + Math.max(0, Date.parse(s.end ?? new Date().toISOString()) - Date.parse(s.start)), 0);
  inp('id-minutes').value = String(Math.round(Math.max(0, raw + inc.manualAdjustmentMs) / 60_000));
  $<HTMLTextAreaElement>('id-notes').value = inc.supporterNotes;
  $('id-meta').textContent = `${STATUS_LABELS[inc.status]} · erstellt ${new Date(inc.createdAt).toLocaleString('de-DE')} · ${inc.usage.requests} Anfragen, ${inc.usage.inputTokens + inc.usage.outputTokens} Tokens, ca. ${formatEurShort(inc.usage.costUsd * (settings?.usdEurRate ?? 0.92))} (Schätzung)`;
  $('id-problem').textContent = inc.problem || '(Telefonat ohne Problemschilderung)';
  const fill = (elId: string, items: string[]) => {
    const ul = $(elId);
    ul.replaceChildren();
    for (const t of items) ul.append(li(t));
  };
  fill('id-history', inc.history.map((h) => `${h.step.text} – ${h.outcome === 'done' ? 'erledigt' : 'hat nicht geklappt'}${h.comment ? ` (${h.comment})` : ''}`));
  fill('id-infos', inc.notes.map((n) => n.text));
  fill('id-segments', inc.segments.map((s) => `${s.kind === 'call' ? 'Telefonat' : 'Arbeit'}: ${new Date(s.start).toLocaleString('de-DE')} – ${s.end ? new Date(s.end).toLocaleTimeString('de-DE') : 'läuft'}`));
  fill('id-reopens', inc.reopens.map((r2) => `${new Date(r2.at).toLocaleString('de-DE')} (zuvor ${STATUS_LABELS[r2.previousStatus]}): ${r2.reason}`));
  const sel = $<HTMLSelectElement>('id-setstatus');
  sel.replaceChildren();
  const first = document.createElement('option');
  first.value = '';
  first.textContent = 'Status manuell setzen …';
  sel.append(first);
  for (const st of ALL_STATUSES.filter((s) => MANUAL_STATUSES.includes(s))) {
    const o = document.createElement('option');
    o.value = st;
    o.textContent = STATUS_LABELS[st];
    sel.append(o);
  }
  inp('id-store').checked = inc.storeShots;
  await renderShots(inc.id, inc.shots);
  $<HTMLDialogElement>('inc-dialog').showModal();
}

// ---------- Screenshots, Schwärzen, Doku ----------
async function thumb(incidentId: string, shotId: string, variant: 'original' | 'redacted' | 'export'): Promise<string | null> {
  const r = await api.getShot(incidentId, shotId, variant);
  return r.ok ? r.value : null;
}

async function renderShots(incidentId: string, shots: ShotRef[]): Promise<void> {
  const box = $('id-shots');
  box.replaceChildren();
  $('id-shots-info').textContent = shots.length
    ? `${shots.length} Screenshot(s) lokal gespeichert${shots.some((s) => !s.encrypted) ? ' – ACHTUNG: unverschlüsselt (Windows-Verschlüsselung nicht verfügbar)' : ' (verschlüsselt)'}. Sie können Passwörter oder Kundendaten zeigen.`
    : 'Keine Screenshots gespeichert.';
  for (const s of shots) {
    const card = document.createElement('div');
    card.className = 'shot';
    const img = document.createElement('img');
    img.alt = `Schritt ${s.stepIndex}`;
    const src = await thumb(incidentId, s.id, s.redacted ? 'redacted' : 'original');
    if (src) img.src = src;
    const cap = document.createElement('div');
    cap.textContent = `Schritt ${s.stepIndex}: ${s.text}${s.redacted ? ' (geschwärzt)' : ''}`;
    const row = document.createElement('div');
    row.className = 'row';
    const keep = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = s.keep;
    cb.addEventListener('change', async () => void api.setShotKeep(incidentId, s.id, cb.checked));
    keep.append(cb, ' behalten');
    const red = document.createElement('button');
    red.type = 'button';
    red.className = 'btn small';
    red.textContent = 'Schwärzen …';
    red.addEventListener('click', () => void openRedact(incidentId, s));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn small';
    del.textContent = 'Verwerfen';
    del.addEventListener('click', async () => {
      if (!window.confirm('Diesen Screenshot endgültig löschen?')) return;
      const r = await api.discardShot(incidentId, s.id);
      if (r.ok) await renderShots(incidentId, r.value);
    });
    row.append(keep, red, del);
    card.append(img, cap, row);
    box.append(card);
  }
}

let redactCtx: { incidentId: string; shot: ShotRef; img: HTMLImageElement; rects: NormRect[] } | null = null;

async function openRedact(incidentId: string, shot: ShotRef): Promise<void> {
  const src = await thumb(incidentId, shot.id, shot.redacted ? 'redacted' : 'original');
  if (!src) return setStatus($('id-status'), 'error', 'Das Bild konnte nicht geladen werden.');
  const img = new Image();
  img.onload = () => {
    redactCtx = { incidentId, shot, img, rects: [] };
    const c = $<HTMLCanvasElement>('red-canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    drawRedact();
    setStatus($('red-status'), null);
    $<HTMLDialogElement>('red-dialog').showModal();
  };
  img.src = src;
}

function drawRedact(live?: NormRect): void {
  if (!redactCtx) return;
  const c = $<HTMLCanvasElement>('red-canvas');
  const g = c.getContext('2d')!;
  g.drawImage(redactCtx.img, 0, 0);
  g.fillStyle = 'rgba(0,0,0,0.85)';
  for (const r of [...redactCtx.rects, ...(live ? [live] : [])]) g.fillRect(r.x * c.width, r.y * c.height, r.w * c.width, r.h * c.height);
}

function wireRedact(): void {
  const c = $<HTMLCanvasElement>('red-canvas');
  let start: { x: number; y: number } | null = null;
  const pos = (e: MouseEvent) => {
    const b = c.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), y: Math.min(1, Math.max(0, (e.clientY - b.top) / b.height)) };
  };
  const rect = (a: { x: number; y: number }, b: { x: number; y: number }): NormRect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
  c.addEventListener('mousedown', (e) => (start = pos(e)));
  c.addEventListener('mousemove', (e) => start && drawRedact(rect(start, pos(e))));
  window.addEventListener('mouseup', (e) => {
    if (!start || !redactCtx) return;
    const r = rect(start, pos(e));
    start = null;
    if (r.w > 0.005 && r.h > 0.005) redactCtx.rects.push(r);
    drawRedact();
  });
  $('red-undo').addEventListener('click', () => {
    redactCtx?.rects.pop();
    drawRedact();
  });
  $('red-apply').addEventListener('click', async () => {
    if (!redactCtx || redactCtx.rects.length === 0) return setStatus($('red-status'), 'error', 'Bitte mindestens einen Bereich markieren.');
    const { incidentId, shot, rects } = redactCtx;
    const r = await api.redactShot(incidentId, shot.id, rects);
    if (!r.ok) return setStatus($('red-status'), 'error', r.error.message);
    $<HTMLDialogElement>('red-dialog').close();
    await renderShots(incidentId, r.value);
  });
}

async function loadDocPreview(): Promise<void> {
  if (!openIncident) return;
  const id = openIncident.id;
  const variant = $<HTMLSelectElement>('doc-variant').value as DocVariant;
  setStatus($('doc-status'), 'loading', 'Text wird vorbereitet (nur Textverlauf, kleine Modellstufe, keine Bilder) …');
  const r = await api.prepareDoc(id, variant);
  if (!r.ok) return setStatus($('doc-status'), 'error', r.error.message);
  setStatus($('doc-status'), null);
  const d = r.value;
  if (!$<HTMLTextAreaElement>('doc-summary').value.trim() || !openDocEdited) $<HTMLTextAreaElement>('doc-summary').value = d.summary;
  const steps = $('doc-steps');
  steps.replaceChildren();
  for (const s of d.steps) {
    const l = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset['n'] = String(s.index);
    cb.addEventListener('change', () => void refreshDocImages());
    l.append(cb, ` ${s.index}. ${s.text}${s.shotId ? ' 🖼' : ''}`);
    steps.append(l);
  }
  await refreshDocImages();
}
let openDocEdited = false;

async function refreshDocImages(): Promise<void> {
  if (!openIncident) return;
  const id = openIncident.id;
  const variant = $<HTMLSelectElement>('doc-variant').value;
  const box = $('doc-preview');
  box.replaceChildren();
  if (variant === 'short') return;
  const chosen = new Set([...document.querySelectorAll<HTMLInputElement>('#doc-steps input:checked')].map((c) => Number(c.dataset['n'])));
  const shots = await api.listShots(id);
  if (!shots.ok) return;
  for (const s of shots.value.filter((x) => x.keep && chosen.has(x.stepIndex))) {
    const src = await thumb(id, s.id, 'export'); // Vorschau = genau das, was exportiert wird
    if (!src) continue;
    const card = document.createElement('div');
    card.className = 'shot';
    const img = document.createElement('img');
    img.src = src;
    img.alt = `Schritt ${s.stepIndex}`;
    const cap = document.createElement('div');
    cap.textContent = `Schritt ${s.stepIndex}${s.redacted ? ' (geschwärzt)' : ' (NICHT geschwärzt)'}`;
    card.append(img, cap);
    box.append(card);
  }
}

function wireDocs(): void {
  wireRedact();
  $('id-store').addEventListener('change', async () => {
    if (!openIncident) return;
    await api.setStoreShots(openIncident.id, inp('id-store').checked);
  });
  $('id-shots-del').addEventListener('click', async () => {
    if (!openIncident || !window.confirm('Alle Screenshots dieses Incidents endgültig löschen?')) return;
    const r = await api.deleteIncidentShots(openIncident.id);
    if (r.ok) await renderShots(openIncident.id, r.value);
  });
  $('id-doc').addEventListener('click', async () => {
    openDocEdited = false;
    $<HTMLTextAreaElement>('doc-summary').value = '';
    $<HTMLDialogElement>('doc-dialog').showModal();
    await loadDocPreview();
  });
  $('doc-summary').addEventListener('input', () => (openDocEdited = true));
  $('doc-variant').addEventListener('change', () => void refreshDocImages());
  $('doc-export').addEventListener('click', async () => {
    if (!openIncident) return;
    const steps = [...document.querySelectorAll<HTMLInputElement>('#doc-steps input:checked')].map((c) => Number(c.dataset['n']));
    const r = await api.exportDoc(openIncident.id, { variant: $<HTMLSelectElement>('doc-variant').value as DocVariant, steps, summary: $<HTMLTextAreaElement>('doc-summary').value });
    if (!r.ok) return setStatus($('doc-status'), 'error', r.error.message);
    setStatus($('doc-status'), 'info', r.value ? `Exportiert: ${r.value.files} Dateien in ${r.value.dir}` : 'Export abgebrochen.');
  });
}

async function resumeFlow(inc: Incident): Promise<void> {
  if (!resumeRequiresReason(inc.status)) {
    $<HTMLDialogElement>('inc-dialog').close();
    const r = await api.resumeIncident(inc.id);
    apply(r);
    if (r.ok) switchTab('session');
    return;
  }
  inp('ro-reason').value = '';
  setStatus($('ro-status'), null);
  $<HTMLDialogElement>('reopen-dialog').showModal();
}

// ---------- Einstellungen ----------
function fillSelect(id: string, value: string, opts: Array<[string, string]>): void {
  const s = $<HTMLSelectElement>(id);
  s.replaceChildren();
  for (const [v, l] of opts) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = l;
    o.selected = v === value;
    s.append(o);
  }
}

function renderSettings(): void {
  if (!settings) return;
  const s = settings;
  const cur = s.providers.find((p) => p.id === s.providerId);
  $('provider-badge').textContent = `${cur?.name ?? s.providerId} · ${s.tierModels.small} / ${s.tierModels.medium} / ${s.tierModels.large}`;
  fillSelect('provider-select', s.providerId, s.providers.map((p) => [p.id, p.name]));
  for (const t of ['small', 'medium', 'large'] as ModelTier[]) inp(`tier-${t}`).value = s.tierModels[t];
  const dl = $('model-list');
  dl.replaceChildren();
  for (const m of cur?.knownModels ?? []) {
    const o = document.createElement('option');
    o.value = m;
    dl.append(o);
  }
  const tiers: Array<[string, string]> = [['small', 'klein'], ['medium', 'mittel'], ['large', 'groß']];
  for (const k of ['triage', 'step', 'summary', 'call'] as const) fillSelect(`route-${k}`, s.routing[k], tiers);
  inp('threshold').value = String(s.failedThreshold);
  inp('dropback').checked = s.dropBackToBase;
  inp('img-width').value = String(s.maxImageWidth);
  inp('img-quality').value = String(s.jpegQuality);
  inp('cost-warn').value = s.costWarnEur === null ? '' : String(s.costWarnEur);
  inp('cost-limit').value = s.costLimitEur === null ? '' : String(s.costLimitEur);
  inp('cost-inc').value = s.costIncidentLimitEur === null ? '' : String(s.costIncidentLimitEur);
  $<HTMLSelectElement>('cost-period').value = s.costPeriod;
  inp('cost-rate').value = String(s.usdEurRate);
  $('key-block').hidden = !cur?.requiresKey;
  $('key-state').textContent = cur?.keySet ? 'Key gesetzt: ja' : 'Key gesetzt: nein';
  $('enc-warning').hidden = s.encryptionAvailable;
  inp('chk-exclude').checked = s.excludeMainWindow;
  inp('chk-chat-shortcut').checked = s.chatShortcut;
  inp('chk-call-shortcut').checked = s.callShortcut;
  inp('chk-pill').checked = s.activityPill;
  inp('chk-auto').checked = s.autoAdvance;
  inp('shot-days').value = String(s.shotRetentionDays);
}

function applySettings(r: Result<SettingsView>): boolean {
  const st = $('settings-status');
  if (!r.ok) {
    setStatus(st, 'error', r.error.message);
    return false;
  }
  setStatus(st, null);
  settings = r.value;
  renderSettings();
  return true;
}

const num = (id: string): number | null => (inp(id).value.trim() === '' ? null : Number(inp(id).value));

function wireSettings(): void {
  const dlg = $<HTMLDialogElement>('settings-dialog');
  $('btn-settings').addEventListener('click', () => {
    setStatus($('settings-status'), null);
    renderSettings();
    dlg.showModal();
  });
  $('settings-form').addEventListener('submit', () => dlg.close());
  const upd = async (patch: Parameters<RendererApi['updateSettings']>[0]) => applySettings(await api.updateSettings(patch));
  $('provider-select').addEventListener('change', (e) => void upd({ providerId: (e.target as HTMLSelectElement).value }));
  for (const t of ['small', 'medium', 'large'] as ModelTier[]) inp(`tier-${t}`).addEventListener('change', () => void upd({ tierModels: { [t]: inp(`tier-${t}`).value } }));
  for (const k of ['triage', 'step', 'summary', 'call'] as const) {
    $(`route-${k}`).addEventListener('change', (e) => void upd({ routing: { [k]: (e.target as HTMLSelectElement).value as ModelTier } }));
  }
  inp('threshold').addEventListener('change', () => void upd({ failedThreshold: Number(inp('threshold').value) }));
  inp('dropback').addEventListener('change', () => void upd({ dropBackToBase: inp('dropback').checked }));
  inp('img-width').addEventListener('change', () => void upd({ maxImageWidth: Number(inp('img-width').value) }));
  inp('img-quality').addEventListener('change', () => void upd({ jpegQuality: Number(inp('img-quality').value) }));
  const costPatch = () => upd({ costWarnEur: num('cost-warn'), costLimitEur: num('cost-limit'), costIncidentLimitEur: num('cost-inc'), costPeriod: $<HTMLSelectElement>('cost-period').value as 'day' | 'month' | 'total', usdEurRate: Number(inp('cost-rate').value) });
  for (const id of ['cost-warn', 'cost-limit', 'cost-inc', 'cost-period', 'cost-rate']) $(id).addEventListener('change', () => void costPatch());
  $('cost-reset').addEventListener('click', async () => {
    if (window.confirm('Kostenzähler dieser Periode zurücksetzen?')) apply(await api.costAction({ type: 'reset' }));
  });
  inp('chk-exclude').addEventListener('change', () => void upd({ excludeMainWindow: inp('chk-exclude').checked }));
  inp('chk-chat-shortcut').addEventListener('change', () => void upd({ chatShortcut: inp('chk-chat-shortcut').checked }));
  inp('chk-call-shortcut').addEventListener('change', () => void upd({ callShortcut: inp('chk-call-shortcut').checked }));
  inp('chk-pill').addEventListener('change', () => void upd({ activityPill: inp('chk-pill').checked }));
  inp('chk-auto').addEventListener('change', () => void upd({ autoAdvance: inp('chk-auto').checked }));
  inp('shot-days').addEventListener('change', () => void upd({ shotRetentionDays: Number(inp('shot-days').value) }));
  $('shots-delete-all').addEventListener('click', async () => {
    if (!window.confirm('ALLE gespeicherten Screenshots aller Incidents endgültig löschen?')) return;
    const r = await api.deleteAllShots();
    setStatus($('settings-status'), r.ok ? 'info' : 'error', r.ok ? `${r.value} Screenshots gelöscht.` : r.error.message);
  });
  $('btn-save-key').addEventListener('click', async () => {
    if (!settings) return;
    const r = await api.setApiKey(settings.providerId, inp('key-input').value);
    inp('key-input').value = '';
    applySettings(r);
  });
  $('btn-clear-key').addEventListener('click', async () => {
    if (settings) applySettings(await api.clearApiKey(settings.providerId));
  });
  $('btn-load-models').addEventListener('click', async () => {
    if (!settings) return;
    setStatus($('settings-status'), 'loading', 'Modelle werden geladen …');
    const r = await api.listModels(settings.providerId);
    if (!r.ok) return setStatus($('settings-status'), 'error', r.error.message);
    setStatus($('settings-status'), null);
    const dl = $('model-list');
    dl.replaceChildren();
    for (const m of r.value) {
      const o = document.createElement('option');
      o.value = m;
      dl.append(o);
    }
  });
}

function switchTab(tab: 'session' | 'incidents' | 'time'): void {
  for (const t of ['session', 'incidents', 'time'] as const) {
    $(`tab-${t}`).classList.toggle('active', t === tab);
    $(`view-${t}`).hidden = t !== tab;
  }
  if (tab === 'incidents') void loadIncidents();
  if (tab === 'time') void loadEntries();
}

function wireMain(): void {
  for (const t of ['session', 'incidents', 'time'] as const) $(`tab-${t}`).addEventListener('click', () => switchTab(t));
  $('btn-chat').addEventListener('click', () => void api.openChat());
  $('btn-call').addEventListener('click', async () => {
    apply(await api.startCall());
    void api.openChat();
  });
  $('btn-start-call').addEventListener('click', async () => {
    apply(await api.startCall());
    void api.openChat();
  });
  $('btn-refresh-sources').addEventListener('click', () => void loadSources());
  $('btn-start').addEventListener('click', async () => {
    const problem = $<HTMLTextAreaElement>('problem').value;
    if (!problem.trim()) return status('error', 'Bitte zuerst das Problem beschreiben.');
    status('loading', 'Einschätzung wird erstellt (ohne Screenshot) …');
    apply(await api.startSession(problem));
  });
  $('btn-remote').addEventListener('click', () => {
    if (!window.confirm('Ab jetzt wird bei jedem Schritt ein Screenshot der gewählten Quelle an den Anbieter gesendet. Fortfahren?')) return;
    void api.startRemote(selectedSource || undefined).then(apply);
  });
  $('btn-ask').addEventListener('click', () => void api.askFirst().then(apply));
  $('btn-show').addEventListener('click', () => void api.toggleOverlay().then(apply));
  $('btn-timer').addEventListener('click', () => void api.setTimerRunning(!view?.timer.running).then(apply));
  $('btn-pause').addEventListener('click', async () => {
    apply(await api.pauseSession());
    void loadIncidents();
  });
  $('btn-solved').addEventListener('click', () => void api.finishSession('solved').then(apply));
  $('btn-abort').addEventListener('click', () => {
    if (window.confirm('Sitzung als nicht gelöst abbrechen?')) void api.finishSession('unsolved').then(apply);
  });
  $('btn-note').addEventListener('click', async () => {
    const t = inp('note').value.trim();
    if (!t) return;
    inp('note').value = '';
    apply(view?.call ? await api.callInput(t) : await api.addNote(t));
  });
  inp('note').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-note').click();
  });
  const reset = async () => {
    await api.resetSession();
    shownResultFor = null;
    $<HTMLTextAreaElement>('problem').value = '';
    status(null);
    view = await api.getSession();
    renderSession();
  };
  $('btn-new').addEventListener('click', () => void reset());
  $('cost-ack').addEventListener('click', () => void api.costAction({ type: 'ack' }).then(apply));
  $('cost-once').addEventListener('click', () => void api.costAction({ type: 'once' }).then(apply));
  $('cost-raise').addEventListener('click', () => {
    const eur = Number(window.prompt === undefined ? '' : '');
    void eur;
    const v = inp('cost-limit').value;
    // Anheben um 5 € (einfacher Standard); feinere Werte in den Einstellungen.
    void v;
    void api.costAction({ type: 'raise', eur: 5 }).then(apply);
  });

  // Incidents
  for (const id of ['inc-search', 'inc-status', 'inc-sort']) $(id).addEventListener('input', renderIncidents);
  $('id-save').addEventListener('click', async () => {
    if (!openIncident) return;
    const id = openIncident.id;
    const r = await api.updateIncident(id, { title: inp('id-title').value, customer: inp('id-customer').value, supporterNotes: $<HTMLTextAreaElement>('id-notes').value });
    if (!r.ok) return setStatus($('id-status'), 'error', r.error.message);
    const m = Number(inp('id-minutes').value);
    const d = await api.setIncidentDuration(id, m);
    if (!d.ok) return setStatus($('id-status'), 'error', d.error.message);
    openIncident = d.value;
    setStatus($('id-status'), 'info', 'Gespeichert.');
    void loadIncidents();
  });
  $('id-resume').addEventListener('click', () => openIncident && void resumeFlow(openIncident));
  const finishInactive = async (res: 'solved' | 'unsolved') => {
    if (!openIncident) return;
    const id = openIncident.id;
    const r = await api.finishIncident(id, res);
    if (!r.ok) return setStatus($('id-status'), 'error', r.error.message);
    $<HTMLDialogElement>('inc-dialog').close();
    void loadIncidents();
    await openTimeDialog(id, res);
  };
  $('id-solve').addEventListener('click', () => void finishInactive('solved'));
  $('id-unsolve').addEventListener('click', () => void finishInactive('unsolved'));
  $('id-setstatus').addEventListener('change', async (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (!v || !openIncident) return;
    const r = await api.setIncidentStatus(openIncident.id, v as IncidentStatus);
    if (!r.ok) return setStatus($('id-status'), 'error', r.error.message);
    $<HTMLDialogElement>('inc-dialog').close();
    void loadIncidents();
  });
  $('id-delete').addEventListener('click', async () => {
    if (!openIncident) return;
    if (!window.confirm(`Incident "${openIncident.title}" endgültig löschen?`)) return;
    const r = await api.deleteIncident(openIncident.id);
    if (!r.ok) return setStatus($('id-status'), 'error', r.error.message);
    $<HTMLDialogElement>('inc-dialog').close();
    void loadIncidents();
  });
  $('ro-ok').addEventListener('click', async () => {
    if (!openIncident) return;
    const reason = $<HTMLTextAreaElement>('ro-reason').value;
    if (!reason.trim()) return setStatus($('ro-status'), 'error', 'Bitte eine Begründung angeben.');
    status('loading', 'Fall wird wieder aufgenommen (ohne Screenshot) …');
    const r = await api.resumeIncident(openIncident.id, reason);
    if (!r.ok) return setStatus($('ro-status'), 'error', r.error.message);
    $<HTMLDialogElement>('reopen-dialog').close();
    $<HTMLDialogElement>('inc-dialog').close();
    shownResultFor = null;
    apply(r);
    switchTab('session');
  });

  // Zeiterfassung
  $('td-save').addEventListener('click', async () => {
    if (!draft) return;
    const d: TimeEntryDraft = { ...draft, date: inp('td-date').value.trim(), durationMinutes: Number(inp('td-min').value), customer: inp('td-customer').value, description: $<HTMLTextAreaElement>('td-desc').value };
    const r = await api.saveTimeEntry(d);
    if (!r.ok) return setStatus($('td-status'), 'error', r.error.message);
    $<HTMLDialogElement>('time-dialog').close();
    void loadEntries();
  });
  $('te-export').addEventListener('click', async () => {
    const ids = selectedEntryIds();
    if (!ids.length) return status('error', 'Bitte Einträge auswählen.');
    const r = await api.exportTimeEntriesCsv(ids);
    if (!r.ok) return showError(r.error);
    if (r.value) status('info', `${r.value.count} Einträge exportiert.`);
    void loadEntries();
  });
  const mark = (s: 'open' | 'transferred') => async () => {
    const ids = selectedEntryIds();
    if (ids.length) {
      await api.setTimeEntriesStatus(ids, s);
      void loadEntries();
    }
  };
  $('te-transferred').addEventListener('click', () => void mark('transferred')());
  $('te-open').addEventListener('click', () => void mark('open')());
}

async function init(): Promise<void> {
  wireSettings();
  wireMain();
  wireDocs();
  api.onSessionChanged((v) => setView(v));
  settings = await api.getSettings();
  renderSettings();
  setView(await api.getSession());
  setInterval(tickTimer, 1000);
  await loadSources();
  const cur = settings.providers.find((p) => p.id === settings!.providerId);
  if (cur?.requiresKey && !cur.keySet) {
    status('info', 'Willkommen. Bitte in den Einstellungen einen API-Key hinterlegen (oder den Mock-Anbieter zum Ausprobieren wählen).');
  }
}

void init();
