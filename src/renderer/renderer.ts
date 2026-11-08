import { describeActivity } from '../shared/activityText';
import { formatEurShort } from '../shared/format';
import {
  ALL_STATUSES,
  formatDuration,
  MANUAL_STATUSES,
  queryIncidents,
  resumeRequiresReason,
  type Incident,
  type IncidentSort,
  type IncidentStatus,
  type IncidentSummary,
  type TimeEntry,
  type TimeEntryDraft,
} from '../shared/incident';
import { buildTimeline } from '../shared/timeline';
import type { AppError, CaptureSourceInfo, DocVariant, ModelTier, NormRect, RendererApi, Result, SessionView, SettingsView, ShotRef } from '../shared/types';
import {
  humanizeError,
  nextWizardStep,
  PROVIDER_LABEL,
  prevWizardStep,
  providerStepComplete,
  relativeTime,
  stageOf,
  STAGES,
  statusView,
  wizardNeeded,
  WIZARD_STEPS,
  type WizardStep,
} from '../shared/ux';
import { renderHero, type CardHandlers } from '../ui/hero';

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
let override: 'time' | null = null;

const advanced = (): boolean => settings?.advancedMode === true;

function setStatus(el: HTMLElement, kind: 'loading' | 'error' | 'info' | null, text = ''): void {
  el.hidden = kind === null;
  el.className = `notice${kind === 'error' ? ' error' : kind === 'loading' ? ' loading' : kind === 'info' ? ' info' : ''}`;
  el.textContent = text;
}
const status = (kind: 'loading' | 'error' | 'info' | null, text = ''): void => setStatus($('status'), kind, text);

/** Fehler in Alltagssprache mit nächster Handlung; technische Details nur auf Wunsch. */
function showError(e: AppError): void {
  const h = humanizeError(e);
  const box = $('status');
  box.hidden = false;
  box.className = 'notice error';
  box.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = h.title;
  const p = document.createElement('p');
  p.textContent = `${h.text} ${h.next}`;
  box.append(title, p);
  const row = document.createElement('div');
  row.className = 'row nomargin';
  if (h.action === 'settings') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small primary';
    b.textContent = 'Einstellungen öffnen';
    b.addEventListener('click', openSettings);
    row.append(b);
  }
  const d = document.createElement('details');
  d.className = 'more';
  const s = document.createElement('summary');
  s.textContent = 'Fehlerdetails anzeigen';
  const dp = document.createElement('p');
  dp.className = 'hint';
  dp.textContent = h.details;
  d.append(s, dp);
  box.append(row, d);
}

/** Ergebnis anwenden: Fehler anzeigen, sonst Sicht aktualisieren. */
function apply(r: Result<SessionView>): void {
  if (!r.ok) return showError(r.error);
  status(null);
  setView(r.value);
}

let lastSig = '';

function setView(v: SessionView): void {
  const sig = `${v.incidentId}|${v.result}|${v.phase}|${v.recommendation?.action}|${v.holding}|${v.call ? 'call' : ''}`;
  if (sig !== lastSig) {
    lastSig = sig;
    void loadIncidents();
  }
  view = v;
  viewAt = Date.now();
  renderSession();
  void maybeOpenTimeDialog();
}

function openSettings(): void {
  setStatus($('settings-status'), null);
  renderSettings();
  $<HTMLDialogElement>('settings-dialog').showModal();
}

// ---------- Handler für die "Jetzt tun"-Karte ----------
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
  startCall: () => void startCall(),
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
  openSettings,
};

async function startCall(): Promise<void> {
  override = null;
  apply(await api.startCall());
  void api.openChat();
}

// ---------- Ansichten ----------
function applyMode(): void {
  document.body.dataset['mode'] = advanced() ? 'advanced' : 'simple';
}

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

function showView(name: 'home' | 'case' | 'time'): void {
  $('view-home').hidden = name !== 'home';
  $('view-case').hidden = name !== 'case';
  $('view-time').hidden = name !== 'time';
}

function renderStepper(index: number): void {
  const ol = $('stepper');
  ol.replaceChildren();
  STAGES.forEach((label, i) => {
    const item = document.createElement('li');
    item.className = i < index ? 'done' : i === index ? 'current' : '';
    if (i === index) item.setAttribute('aria-current', 'step');
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = i < index ? '✓' : String(i + 1);
    item.append(n, label);
    ol.append(item);
  });
}

function renderSession(): void {
  applyMode();
  const v = view;
  const active = !!v?.incidentId;
  if (override === 'time') showView('time');
  else showView(active ? 'case' : 'home');
  renderCases();
  if (!v) return;
  if (active) {
    const st = stageOf(v);
    renderStepper(st.index);
    $('where').textContent = st.where;
    $('case-title').textContent = v.problem ? v.problem.split(/\r?\n/)[0]!.slice(0, 90) : 'Telefonat';
    renderHero($('card'), v, handlers, { compact: false, advanced: advanced() });
    if (v.result) {
      const row = document.createElement('div');
      row.className = 'row';
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn primary';
      b.textContent = 'Neuen Fall starten';
      b.addEventListener('click', () => void leaveFinished());
      row.append(b);
      $('card').append(row);
    }
    const running = !v.result;
    for (const id of ['note-form', 'btn-pause', 'btn-solved']) $(id).hidden = !running;
    $('btn-remote').hidden = v.phase === 'steps' || !!v.call || !running;
    $('btn-ask').hidden = !!v.call || !running;
    $('btn-show').hidden = !v.current;
    $('btn-show').textContent = v.current?.overlayShown ? 'Pfeil ausblenden' : 'Pfeil wieder zeigen';
    $('btn-timer').textContent = v.timer.running ? 'Zeit anhalten' : 'Zeit fortsetzen';
    $('btn-abort').hidden = !running;
    $('sources-box').hidden = !(v.phase === 'steps' || v.recommendation?.action === 'start_remote');
    const open = $<HTMLDetailsElement>('sources-box');
    if (v.recommendation?.action === 'start_remote') open.open = true;
  }
  const h = $('history-list');
  h.replaceChildren();
  const tl = buildTimeline(v);
  for (const it of tl) {
    if (it.kind === 'step') h.append(li(`${it.text} – ${it.outcome === 'done' ? 'erledigt' : 'hat nicht geklappt'}${it.comment ? ` (${it.comment})` : ''}`, it.outcome === 'failed' ? 'fail' : ''));
  }
  if (!h.children.length) h.append(li('Noch nichts passiert.'));
  const n = $('notes-list');
  n.replaceChildren();
  for (const x of v.notes) n.append(li(x.text));
  if (!n.children.length) n.append(li('Keine Notizen.'));
  const r = v.lastRequest;
  $('req-line').textContent = r
    ? `Letzte Anfrage: ${r.tier} (${r.model}) · ${r.reason} · ${r.inputTokens + r.outputTokens} Tokens${r.imageBytes ? ` · Bild ${Math.round(r.imageBytes / 1024)} KB` : ' · ohne Bild'} · Summe Fall: ${v.usage.inputTokens + v.usage.outputTokens} Tokens, ca. ${formatEurShort(v.cost.incidentEur)} (Schätzung)`
    : '';
  const sh = v.shots;
  $('shots-line').textContent = v.incidentId
    ? sh.enabled
      ? `Bildschirmfotos werden auf diesem Computer gespeichert (${sh.count}, ${sh.encrypted ? 'verschlüsselt' : 'NICHT verschlüsselt'}). Du kannst das pro Fall abschalten.${sh.error ? ` Fehler beim Speichern: ${sh.error}` : ''}`
      : 'Bildschirmfotos werden für diesen Fall nicht gespeichert.'
    : '';
  renderActivity();
  renderCost();
}

async function leaveFinished(): Promise<void> {
  await api.resetSession();
  shownResultFor = null;
  override = null;
  $<HTMLTextAreaElement>('problem').value = '';
  status(null);
  setView(await api.getSession());
  void loadIncidents();
}

function renderActivity(): void {
  if (!view) return;
  const a = describeActivity(view.activity, Date.now());
  const quiet = view.activity.kind === 'idle' || view.activity.kind === 'please_click' || view.activity.kind === 'error' || view.activity.kind === 'ratelimit';
  if (!quiet) setStatus($('status'), 'loading', `${a.icon} ${a.text}`);
  else if ($('status').classList.contains('loading')) status(null);
  const log = $('activity-list');
  log.replaceChildren();
  for (const e of [...view.activityLog].reverse()) {
    log.append(li(`${new Date(e.at).toLocaleTimeString('de-DE')} · ${describeActivity({ kind: e.kind, since: e.at, ...(e.detail ? { detail: e.detail } : {}) }, e.at).text} · ${Math.round(e.durationMs / 1000)} s`));
  }
}

function renderCost(): void {
  if (!view) return;
  const c = view.cost;
  $('cost-head').textContent = `${formatEurShort(c.periodEur)}${c.limitEur !== null ? ` von ${formatEurShort(c.limitEur)}` : ''} (Schätzung)`;
  const banner = $('cost-banner');
  const show = c.level === 'limit' || (c.level !== 'ok' && c.unacknowledged);
  banner.hidden = !show;
  if (show) {
    $('cost-banner-text').textContent =
      c.level === 'limit'
        ? 'Das Kostenlimit ist erreicht. Die KI macht erst weiter, wenn du es erlaubst. (Das ist eine Schätzung.)'
        : `Hinweis: Bisher ca. ${formatEurShort(c.periodEur)}${c.limitEur !== null ? ` von ${formatEurShort(c.limitEur)}` : ''} ausgegeben (Schätzung).`;
    $('cost-raise').hidden = c.limitEur === null;
    $('cost-once').hidden = c.level !== 'limit';
  }
}

function tickTimer(): void {
  if (!view?.incidentId) return;
  const ms = view.timer.elapsedMs + (view.timer.running ? Date.now() - viewAt : 0);
  $('timer').textContent = `Arbeitszeit: ${formatDuration(ms)}${view.timer.running ? '' : ' (angehalten)'}`;
  if (view.activity.kind !== 'idle') renderActivity();
}

// ---------- Fälle (Karten in der Seitenleiste) ----------
async function loadIncidents(): Promise<void> {
  const r = await api.listIncidents();
  if (!r.ok) return showError(r.error);
  incidents = r.value;
  renderCases();
}

function renderCases(): void {
  const list = queryIncidents(incidents, {
    query: inp('inc-search').value,
    status: $<HTMLSelectElement>('inc-status').value as IncidentStatus | 'all' | 'open',
    sort: $<HTMLSelectElement>('inc-sort').value as IncidentSort,
  });
  const box = $('case-list');
  box.replaceChildren();
  $('cases-empty').hidden = incidents.length > 0;
  const now = Date.now();
  for (const i of list) {
    const sv = statusView(i.status);
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'listitem');
    b.className = `case${view?.incidentId === i.id ? ' active' : ''}`;
    b.title = sv.hint;
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = i.title;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const pill = document.createElement('span');
    pill.className = `pill ${sv.tone}`;
    pill.textContent = `${sv.icon} ${sv.label}`;
    const when = document.createElement('span');
    when.textContent = `zuletzt ${relativeTime(i.updatedAt, now)}`;
    meta.append(pill, when);
    b.append(title, meta);
    const extra = i.reopenCount ? `wieder geöffnet (${i.reopenCount}×)` : '';
    if (extra) {
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = extra;
      b.append(sub);
    }
    b.addEventListener('click', () => {
      if (view?.incidentId === i.id && !view.result) {
        override = null;
        renderSession();
      } else void openIncidentDialog(i.id);
    });
    box.append(b);
  }
}

// ---------- Arbeitszeit ----------
async function maybeOpenTimeDialog(): Promise<void> {
  const v = view;
  if (!v?.result || !v.incidentId || shownResultFor === v.incidentId + v.result) return;
  shownResultFor = v.incidentId + v.result;
  await openTimeDialog(v.incidentId, v.result);
}

async function openTimeDialog(incidentId: string, result: 'solved' | 'unsolved'): Promise<void> {
  const dlg = $<HTMLDialogElement>('time-dialog');
  setStatus($('td-status'), 'loading', 'Die Zusammenfassung wird vorbereitet …');
  dlg.showModal();
  const r = await api.prepareTimeEntry(incidentId, result);
  if (!r.ok) return setStatus($('td-status'), 'error', humanizeError(r.error).text);
  draft = r.value;
  setStatus($('td-status'), null);
  $('te-source').textContent = `${draft.incidentTitle} · ${result === 'solved' ? 'gelöst' : 'nicht gelöst'} · Die Zusammenfassung ist ${draft.summarySource === 'llm' ? 'von der KI vorgeschlagen' : 'ein einfacher Vorschlag'}. Bitte prüfe sie.`;
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
  const body = $('te-list');
  body.replaceChildren();
  $('te-empty').hidden = entries.length > 0;
  for (const e of entries) {
    const card = document.createElement('div');
    card.className = 'case';
    card.setAttribute('role', 'listitem');
    const label = document.createElement('label');
    label.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset['id'] = e.id;
    const t = document.createElement('span');
    t.className = 'title';
    t.textContent = `${e.date} · ${e.durationMinutes} Min. · ${e.incidentTitle}`;
    label.append(cb, t);
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${e.customer ? `${e.customer} · ` : ''}${e.status === 'open' ? '○ Noch offen' : '✓ Übertragen'}`;
    const desc = document.createElement('span');
    desc.className = 'sub';
    desc.textContent = e.description;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn link';
    del.textContent = 'Eintrag löschen';
    del.addEventListener('click', async () => {
      if (window.confirm('Diesen Eintrag löschen?')) {
        await api.deleteTimeEntry(e.id);
        void loadEntries();
      }
    });
    card.append(label, meta, desc, del);
    body.append(card);
  }
}

const selectedEntryIds = (): string[] => [...document.querySelectorAll<HTMLInputElement>('#te-list input[type=checkbox]:checked')].map((c) => c.dataset['id']!);

// ---------- Fall öffnen ----------
async function openIncidentDialog(id: string): Promise<void> {
  const r = await api.getIncident(id);
  if (!r.ok) return showError(r.error);
  const inc = r.value;
  openIncident = inc;
  setStatus($('id-status'), null);
  const sv = statusView(inc.status);
  inp('id-title').value = inc.title;
  inp('id-customer').value = inc.customer;
  const raw = inc.segments.reduce((a, s) => a + Math.max(0, Date.parse(s.end ?? new Date().toISOString()) - Date.parse(s.start)), 0);
  inp('id-minutes').value = String(Math.round(Math.max(0, raw + inc.manualAdjustmentMs) / 60_000));
  $<HTMLTextAreaElement>('id-notes').value = inc.supporterNotes;
  $('id-meta').textContent = `${sv.icon} ${sv.label} · angelegt ${new Date(inc.createdAt).toLocaleDateString('de-DE')} · zuletzt ${relativeTime(inc.updatedAt, Date.now())}`;
  $('id-problem').textContent = inc.problem || '(Telefonat ohne Problembeschreibung)';
  const fill = (elId: string, items: string[], empty: string) => {
    const ul = $(elId);
    ul.replaceChildren();
    for (const t of items) ul.append(li(t));
    if (!items.length) ul.append(li(empty));
  };
  fill('id-history', inc.history.map((h) => `${h.step.text} – ${h.outcome === 'done' ? 'erledigt' : 'hat nicht geklappt'}${h.comment ? ` (${h.comment})` : ''}`), 'Noch keine Schritte.');
  fill('id-infos', inc.notes.map((n) => n.text), 'Keine Infos.');
  fill('id-segments', inc.segments.map((s) => `${s.kind === 'call' ? 'Telefonat' : 'Arbeit'}: ${new Date(s.start).toLocaleString('de-DE')} – ${s.end ? new Date(s.end).toLocaleTimeString('de-DE') : 'läuft'}`), 'Noch keine Arbeitszeit.');
  fill('id-reopens', inc.reopens.map((x) => `${new Date(x.at).toLocaleString('de-DE')}: ${x.reason}`), 'Der Fall wurde noch nie wieder geöffnet.');
  const sel = $<HTMLSelectElement>('id-setstatus');
  sel.replaceChildren();
  const first = document.createElement('option');
  first.value = '';
  first.textContent = 'Nicht ändern';
  sel.append(first);
  for (const st of ALL_STATUSES.filter((s) => MANUAL_STATUSES.includes(s))) {
    const o = document.createElement('option');
    o.value = st;
    o.textContent = statusView(st).label;
    sel.append(o);
  }
  $('id-resume').textContent = inc.status === 'solved' || inc.status === 'unsolved' ? 'Wieder öffnen' : 'Weiterbearbeiten';
  inp('id-store').checked = inc.storeShots;
  await renderShots(inc.id, inc.shots);
  $<HTMLDialogElement>('inc-dialog').showModal();
}

// ---------- Bildschirmfotos, Schwärzen, Doku ----------
async function thumb(incidentId: string, shotId: string, variant: 'original' | 'redacted' | 'export'): Promise<string | null> {
  const r = await api.getShot(incidentId, shotId, variant);
  return r.ok ? r.value : null;
}

async function renderShots(incidentId: string, shots: ShotRef[]): Promise<void> {
  const box = $('id-shots');
  box.replaceChildren();
  $('id-shots-info').textContent = shots.length
    ? `${shots.length} Bildschirmfoto(s) lokal gespeichert${shots.some((s) => !s.encrypted) ? ' – ACHTUNG: unverschlüsselt (Windows-Verschlüsselung nicht verfügbar)' : ' (verschlüsselt)'}. Sie können Passwörter oder Kundendaten zeigen.`
    : 'Keine Bildschirmfotos gespeichert.';
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
      if (!window.confirm('Diesen Bildschirmfoto endgültig löschen?')) return;
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
    if (!openIncident || !window.confirm('Alle Bildschirmfotos dieses Fälle endgültig löschen?')) return;
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
    if (r.ok) override = null;
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
  applyMode();
  const cur = s.providers.find((p) => p.id === s.providerId);
  fillSelect('provider-select', s.providerId, s.providers.map((p) => [p.id, PROVIDER_LABEL[p.id] ?? p.name]));
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
  $('key-state').textContent = cur?.keySet ? 'Ein Schlüssel ist gespeichert.' : 'Es ist noch kein Schlüssel gespeichert.';
  $('enc-warning').hidden = s.encryptionAvailable;
  inp('chk-advanced').checked = s.advancedMode;
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
    setStatus(st, 'error', `${humanizeError(r.error).title}. ${r.error.message}`);
    return false;
  }
  setStatus(st, null);
  settings = r.value;
  renderSettings();
  if (view) renderSession();
  return true;
}

const num = (id: string): number | null => (inp(id).value.trim() === '' ? null : Number(inp(id).value));

function wireSettings(): void {
  const dlg = $<HTMLDialogElement>('settings-dialog');
  $('btn-settings').addEventListener('click', openSettings);
  $('settings-form').addEventListener('submit', () => dlg.close());
  const upd = async (patch: Parameters<RendererApi['updateSettings']>[0]) => applySettings(await api.updateSettings(patch));
  $('provider-select').addEventListener('change', (e) => void upd({ providerId: (e.target as HTMLSelectElement).value }));
  inp('chk-advanced').addEventListener('change', () => void upd({ advancedMode: inp('chk-advanced').checked }));
  inp('cost-warn').addEventListener('change', () => void upd({ costWarnEur: num('cost-warn') }));
  for (const t of ['small', 'medium', 'large'] as ModelTier[]) inp(`tier-${t}`).addEventListener('change', () => void upd({ tierModels: { [t]: inp(`tier-${t}`).value } }));
  for (const k of ['triage', 'step', 'summary', 'call'] as const) {
    $(`route-${k}`).addEventListener('change', (e) => void upd({ routing: { [k]: (e.target as HTMLSelectElement).value as ModelTier } }));
  }
  inp('threshold').addEventListener('change', () => void upd({ failedThreshold: Number(inp('threshold').value) }));
  inp('dropback').addEventListener('change', () => void upd({ dropBackToBase: inp('dropback').checked }));
  inp('img-width').addEventListener('change', () => void upd({ maxImageWidth: Number(inp('img-width').value) }));
  inp('img-quality').addEventListener('change', () => void upd({ jpegQuality: Number(inp('img-quality').value) }));
  const costPatch = () => upd({ costWarnEur: num('cost-warn'), costLimitEur: num('cost-limit'), costIncidentLimitEur: num('cost-inc'), costPeriod: $<HTMLSelectElement>('cost-period').value as 'day' | 'month' | 'total', usdEurRate: Number(inp('cost-rate').value) });
  for (const id of ['cost-limit', 'cost-inc', 'cost-period', 'cost-rate']) $(id).addEventListener('change', () => void costPatch());
  $('cost-reset').addEventListener('click', async () => {
    if (window.confirm('Den Kostenzähler dieses Zeitraums auf null setzen?')) apply(await api.costAction({ type: 'reset' }));
  });
  inp('chk-exclude').addEventListener('change', () => void upd({ excludeMainWindow: inp('chk-exclude').checked }));
  inp('chk-chat-shortcut').addEventListener('change', () => void upd({ chatShortcut: inp('chk-chat-shortcut').checked }));
  inp('chk-call-shortcut').addEventListener('change', () => void upd({ callShortcut: inp('chk-call-shortcut').checked }));
  inp('chk-pill').addEventListener('change', () => void upd({ activityPill: inp('chk-pill').checked }));
  inp('chk-auto').addEventListener('change', () => void upd({ autoAdvance: inp('chk-auto').checked }));
  inp('shot-days').addEventListener('change', () => void upd({ shotRetentionDays: Number(inp('shot-days').value) }));
  $('shots-delete-all').addEventListener('click', async () => {
    if (!window.confirm('ALLE gespeicherten Bildschirmfotos aller Fälle endgültig löschen?')) return;
    const r = await api.deleteAllShots();
    setStatus($('settings-status'), r.ok ? 'info' : 'error', r.ok ? `${r.value} Bildschirmfotos gelöscht.` : humanizeError(r.error).text);
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
    setStatus($('settings-status'), 'loading', 'Die Modelle werden geladen …');
    const r = await api.listModels(settings.providerId);
    if (!r.ok) return setStatus($('settings-status'), 'error', humanizeError(r.error).text);
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

// ---------- Willkommens-Assistent (einmalig, überspringbar) ----------
let wizStep: WizardStep = 'provider';
let wizDone = false;

function renderWizard(): void {
  const idx = WIZARD_STEPS.indexOf(wizStep);
  $('wiz-count').textContent = `Schritt ${idx + 1} von ${WIZARD_STEPS.length}`;
  for (const el of document.querySelectorAll<HTMLElement>('#wizard [data-step]')) el.hidden = el.dataset['step'] !== wizStep;
  $('wiz-back').hidden = prevWizardStep(wizStep) === null;
  const testMode = inp('wiz-mock').checked;
  $('wiz-next').textContent = wizStep === 'privacy' ? 'Verstanden' : wizStep === 'test' ? (testMode ? 'Testlauf starten' : 'Fertig') : 'Weiter';
  $('wiz-key-box').hidden = !inp('wiz-claude').checked;
  const t = document.querySelector<HTMLElement>('#wizard [data-step="test"] p');
  if (t) t.textContent = testMode ? 'In etwa 30 Sekunden siehst du, wie es funktioniert – mit erfundenen Daten im Testmodus. Es entstehen keine Kosten.' : 'Du kannst jetzt mit deinem eigenen Fall beginnen. Der Testmodus bleibt in den Einstellungen jederzeit wählbar.';
}

async function finishWizard(runDemo: boolean): Promise<void> {
  if (wizDone) return;
  wizDone = true;
  await api.updateSettings({ onboardingDone: true });
  if (settings) settings = { ...settings, onboardingDone: true };
  $<HTMLDialogElement>('wizard').close();
  if (runDemo) {
    const r = await api.updateSettings({ providerId: 'mock' });
    if (r.ok) {
      settings = r.value;
      renderSettings();
    }
    status('loading', 'Der Testlauf startet …');
    apply(await api.startSession('Testlauf: Der Drucker druckt nicht.'));
  }
}

async function wizardNext(): Promise<void> {
  const st = $('wiz-status');
  setStatus(st, null);
  if (wizStep === 'provider') {
    if (inp('wiz-claude').checked) {
      const key = inp('wiz-key').value.trim();
      if (key) {
        const k = await api.setApiKey('anthropic', key);
        inp('wiz-key').value = '';
        if (!k.ok) return setStatus(st, 'error', `${humanizeError(k.error).title}. ${k.error.message}`);
        settings = k.value;
      }
      const r = await api.updateSettings({ providerId: 'anthropic' });
      if (r.ok) settings = r.value;
      if (!settings || !providerStepComplete(settings)) return setStatus(st, 'error', 'Bitte trage den Zugangsschlüssel ein oder wähle den Testmodus.');
    } else {
      const r = await api.updateSettings({ providerId: 'mock' });
      if (r.ok) settings = r.value;
    }
  } else if (wizStep === 'cost') {
    const raw = inp('wiz-warn').value.trim();
    const r = await api.updateSettings({ costWarnEur: raw === '' ? null : Number(raw) });
    if (!r.ok) return setStatus(st, 'error', r.error.message);
    settings = r.value;
  } else if (wizStep === 'test') {
    return void finishWizard(inp('wiz-mock').checked);
  }
  const n = nextWizardStep(wizStep);
  if (n) wizStep = n;
  renderWizard();
  renderSettings();
}

function wireWizard(): void {
  const dlg = $<HTMLDialogElement>('wizard');
  for (const id of ['wiz-mock', 'wiz-claude']) inp(id).addEventListener('change', renderWizard);
  $('wiz-next').addEventListener('click', () => void wizardNext());
  $('wiz-back').addEventListener('click', () => {
    const p = prevWizardStep(wizStep);
    if (p) wizStep = p;
    renderWizard();
  });
  $('wiz-skip').addEventListener('click', () => void finishWizard(false));
  dlg.addEventListener('close', () => void finishWizard(false)); // Escape zählt als Überspringen: nie wieder nerven
}

function maybeShowWizard(): void {
  if (!settings || !wizardNeeded(settings)) return;
  inp('wiz-mock').checked = true;
  wizStep = 'provider';
  wizDone = false;
  renderWizard();
  $<HTMLDialogElement>('wizard').showModal();
}

// ---------- Bedienung ----------
function wireMain(): void {
  $('nav-time').addEventListener('click', () => {
    override = 'time';
    renderSession();
    void loadEntries();
  });
  $('btn-chat').addEventListener('click', () => void api.openChat());
  $('btn-start-call').addEventListener('click', () => void startCall());
  $('btn-open-cases').addEventListener('click', () => {
    override = null;
    $<HTMLSelectElement>('inc-status').value = 'open';
    renderCases();
    (document.querySelector<HTMLElement>('#case-list .case') ?? inp('inc-search')).focus();
  });
  $('btn-new-case').addEventListener('click', async () => {
    override = null;
    if (view?.incidentId && !view.result) {
      if (!window.confirm('Der aktuelle Fall wird pausiert. Du kannst ihn später weiterbearbeiten. Neuen Fall beginnen?')) return;
      apply(await api.pauseSession());
      void loadIncidents();
    } else if (view?.result) await leaveFinished();
    renderSession();
    $('problem').focus();
  });
  $('btn-refresh-sources').addEventListener('click', () => void loadSources());
  $('btn-start').addEventListener('click', async () => {
    const problem = $<HTMLTextAreaElement>('problem').value;
    if (!problem.trim()) {
      status('error', 'Bitte beschreibe zuerst kurz das Problem.');
      $('problem').focus();
      return;
    }
    override = null;
    status('loading', 'Die KI macht sich ein erstes Bild …');
    apply(await api.startSession(problem));
    void loadIncidents();
  });
  $('problem').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('btn-start').click();
  });
  $('btn-remote').addEventListener('click', () => {
    if (!window.confirm('Ab jetzt wird bei jedem Schritt ein Bildschirmfoto an den KI-Anbieter gesendet und auf diesem Computer gespeichert. Fortfahren?')) return;
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
    if (window.confirm('Den Fall als „nicht gelöst“ beenden?')) void api.finishSession('unsolved').then(apply);
  });
  $('note-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = inp('note').value.trim();
    if (!t) return;
    inp('note').value = '';
    apply(view?.call ? await api.callInput(t) : await api.addNote(t));
  });
  $('cost-ack').addEventListener('click', () => void api.costAction({ type: 'ack' }).then(apply));
  $('cost-once').addEventListener('click', () => void api.costAction({ type: 'once' }).then(apply));
  $('cost-raise').addEventListener('click', () => void api.costAction({ type: 'raise', eur: 5 }).then(apply));

  // Fälle
  for (const id of ['inc-search', 'inc-status', 'inc-sort']) $(id).addEventListener('input', renderCases);
  $('id-save').addEventListener('click', async () => {
    if (!openIncident) return;
    const id = openIncident.id;
    const r = await api.updateIncident(id, { title: inp('id-title').value, customer: inp('id-customer').value, supporterNotes: $<HTMLTextAreaElement>('id-notes').value });
    if (!r.ok) return setStatus($('id-status'), 'error', r.error.message);
    const d = await api.setIncidentDuration(id, Number(inp('id-minutes').value));
    if (!d.ok) return setStatus($('id-status'), 'error', d.error.message);
    const sv = $<HTMLSelectElement>('id-setstatus').value;
    if (sv) {
      const s = await api.setIncidentStatus(id, sv as IncidentStatus);
      if (!s.ok) return setStatus($('id-status'), 'error', s.error.message);
    }
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
  $('id-delete').addEventListener('click', async () => {
    if (!openIncident) return;
    if (!window.confirm(`Den Fall „${openIncident.title}“ endgültig löschen? Das kann nicht rückgängig gemacht werden.`)) return;
    const r = await api.deleteIncident(openIncident.id);
    if (!r.ok) return setStatus($('id-status'), 'error', r.error.message);
    $<HTMLDialogElement>('inc-dialog').close();
    void loadIncidents();
  });
  $('ro-ok').addEventListener('click', async () => {
    if (!openIncident) return;
    const reason = $<HTMLTextAreaElement>('ro-reason').value;
    if (!reason.trim()) return setStatus($('ro-status'), 'error', 'Bitte sag kurz, warum du den Fall wieder öffnest.');
    status('loading', 'Der Fall wird wieder geöffnet …');
    const r = await api.resumeIncident(openIncident.id, reason);
    if (!r.ok) return setStatus($('ro-status'), 'error', humanizeError(r.error).text);
    $<HTMLDialogElement>('reopen-dialog').close();
    $<HTMLDialogElement>('inc-dialog').close();
    shownResultFor = null;
    override = null;
    apply(r);
    void loadIncidents();
  });

  // Arbeitszeit
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
    if (!ids.length) return status('error', 'Bitte wähle zuerst Einträge aus.');
    const r = await api.exportTimeEntriesCsv(ids);
    if (!r.ok) return showError(r.error);
    if (r.value) status('info', `${r.value.count} Einträge gespeichert.`);
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
  wireWizard();
  api.onSessionChanged((v) => setView(v));
  settings = await api.getSettings();
  renderSettings();
  setView(await api.getSession());
  setInterval(tickTimer, 1000);
  await Promise.all([loadSources(), loadIncidents()]);
  maybeShowWizard();
  const cur = settings.providers.find((p) => p.id === settings!.providerId);
  if (!wizardNeeded(settings) && cur?.requiresKey && !cur.keySet) {
    status('info', 'Willkommen! Trage in den Einstellungen deinen Zugangsschlüssel ein oder wähle den Testmodus.');
  }
}

void init();
