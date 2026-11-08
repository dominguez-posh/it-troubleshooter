import type { AppError, CaptureSourceInfo, RendererApi, Result, SessionView, SettingsView } from '../shared/types';

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

let settings: SettingsView | null = null;
let sources: CaptureSourceInfo[] = [];
let selectedSource = '';
let session: SessionView | null = null;
let busy = false;

const ERROR_TITLES: Record<AppError['code'], string> = {
  auth: 'Ungültiger API-Key',
  rate_limit: 'Rate-Limit',
  network: 'Netzwerkfehler',
  no_key: 'API-Key fehlt',
  invalid_response: 'Ungültige Antwort',
  capture: 'Aufnahme fehlgeschlagen',
  api: 'Fehler beim Anbieter',
  internal: 'Fehler',
};

function showStatus(el: HTMLElement, kind: 'loading' | 'error' | 'info' | null, text = ''): void {
  el.hidden = kind === null;
  el.className = `status${kind === 'error' ? ' error' : kind === 'loading' ? ' loading' : ''}`;
  el.textContent = text;
}
const status = (kind: 'loading' | 'error' | 'info' | null, text = ''): void => showStatus($('status'), kind, text);
const showError = (err: AppError): void => status('error', `${ERROR_TITLES[err.code]}: ${err.message}`);

function setBusy(b: boolean, text = ''): void {
  busy = b;
  if (b) status('loading', text);
  for (const id of ['btn-start', 'btn-done', 'btn-failed', 'btn-solved', 'btn-show', 'btn-reset']) {
    $<HTMLButtonElement>(id).disabled = b;
  }
}

async function run<T>(text: string, p: Promise<Result<T>>): Promise<T | null> {
  setBusy(true, text);
  try {
    const r = await p;
    if (!r.ok) {
      setBusy(false);
      showError(r.error);
      return null;
    }
    setBusy(false);
    status(null);
    return r.value;
  } catch {
    setBusy(false);
    status('error', 'Fehler: Die Anfrage konnte nicht ausgeführt werden.');
    return null;
  }
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
    b.dataset['id'] = s.id;
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
    name.title = s.name;
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
  if (!r.ok) {
    showError(r.error);
    return;
  }
  sources = r.value;
  if (!sources.some((s) => s.id === selectedSource)) selectedSource = sources[0]?.id ?? '';
  renderSources();
}

function renderHistory(): void {
  const list = $('history-list');
  list.replaceChildren();
  const h = session?.history ?? [];
  $('history-panel').hidden = h.length === 0;
  h.forEach((e) => {
    const li = document.createElement('li');
    li.append(`${e.step.text} `);
    const res = document.createElement('span');
    res.className = e.outcome === 'done' ? 'res-done' : 'res-failed';
    res.textContent = e.outcome === 'done' ? '- erledigt' : '- hat nicht geklappt';
    li.append(res);
    if (e.comment) {
      const c = document.createElement('div');
      c.className = 'muted';
      c.textContent = `Kommentar: ${e.comment}`;
      li.append(c);
    }
    list.append(li);
  });
}

function renderSession(): void {
  const active = session !== null && session.problem !== '';
  $('setup-panel').hidden = active;
  $('session-panel').hidden = !(active && session?.current);
  $('solved-panel').hidden = !(active && session?.solved);
  if (active && session?.current) {
    const cur = session.current;
    $('step-heading').textContent = `Schritt ${cur.index}`;
    $('problem-echo').textContent = `Problem: ${session.problem}`;
    $('step-text').textContent = cur.step.text;
    $('step-reason').textContent = cur.step.reason ?? '';
    $('step-reason').hidden = !cur.step.reason;
    $('step-notarget').hidden = cur.step.target !== null;
    $<HTMLButtonElement>('btn-show').textContent = cur.overlayShown ? 'Pfeil ausblenden' : 'Pfeil anzeigen';
    $<HTMLButtonElement>('btn-show').hidden = cur.step.target === null && !cur.overlayShown;
  }
  renderHistory();
}

function renderSettings(): void {
  if (!settings) return;
  const cur = settings.providers.find((p) => p.id === settings!.providerId);
  $('provider-badge').textContent = `${cur?.name ?? settings.providerId} · ${settings.model}`;
  const sel = $<HTMLSelectElement>('provider-select');
  sel.replaceChildren();
  for (const p of settings.providers) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name;
    o.selected = p.id === settings.providerId;
    sel.append(o);
  }
  $<HTMLInputElement>('model-input').value = settings.model;
  const dl = $('model-list');
  dl.replaceChildren();
  for (const m of cur?.knownModels ?? []) {
    const o = document.createElement('option');
    o.value = m;
    dl.append(o);
  }
  $('key-block').hidden = !cur?.requiresKey;
  $('key-state').textContent = cur?.keySet ? 'Key gesetzt: ja' : 'Key gesetzt: nein';
  $('enc-warning').hidden = settings.encryptionAvailable;
  $<HTMLInputElement>('chk-exclude').checked = settings.excludeMainWindow;
}

function applySettings(r: Result<SettingsView>): boolean {
  const s = $('settings-status');
  if (!r.ok) {
    showStatus(s, 'error', r.error.message);
    return false;
  }
  showStatus(s, null);
  settings = r.value;
  renderSettings();
  return true;
}

function wireSettings(): void {
  const dlg = $<HTMLDialogElement>('settings-dialog');
  $('btn-settings').addEventListener('click', () => {
    showStatus($('settings-status'), null);
    renderSettings();
    dlg.showModal();
  });
  $('settings-form').addEventListener('submit', () => dlg.close());
  $('provider-select').addEventListener('change', async (e) => {
    applySettings(await api.updateSettings({ providerId: (e.target as HTMLSelectElement).value }));
  });
  $('model-input').addEventListener('change', async (e) => {
    applySettings(await api.updateSettings({ model: (e.target as HTMLInputElement).value }));
  });
  $('chk-exclude').addEventListener('change', async (e) => {
    applySettings(await api.updateSettings({ excludeMainWindow: (e.target as HTMLInputElement).checked }));
  });
  $('btn-save-key').addEventListener('click', async () => {
    if (!settings) return;
    const input = $<HTMLInputElement>('key-input');
    const r = await api.setApiKey(settings.providerId, input.value);
    input.value = '';
    applySettings(r);
  });
  $('btn-clear-key').addEventListener('click', async () => {
    if (settings) applySettings(await api.clearApiKey(settings.providerId));
  });
  $('btn-load-models').addEventListener('click', async () => {
    if (!settings) return;
    const s = $('settings-status');
    showStatus(s, 'loading', 'Modelle werden geladen ...');
    const r = await api.listModels(settings.providerId);
    if (!r.ok) {
      showStatus(s, 'error', r.error.message);
      return;
    }
    showStatus(s, null);
    const dl = $('model-list');
    dl.replaceChildren();
    for (const m of r.value) {
      const o = document.createElement('option');
      o.value = m;
      dl.append(o);
    }
  });
}

function wireSession(): void {
  $('btn-refresh-sources').addEventListener('click', () => void loadSources());
  $('btn-start').addEventListener('click', async () => {
    if (busy) return;
    const problem = $<HTMLTextAreaElement>('problem').value;
    if (!problem.trim()) return status('error', 'Bitte zuerst das Problem beschreiben.');
    if (!selectedSource) return status('error', 'Bitte eine Quelle auswählen.');
    const v = await run('Screenshot wird aufgenommen und analysiert ...', api.startSession(problem, selectedSource));
    if (v) {
      session = v;
      renderSession();
    }
  });
  const report = async (outcome: 'done' | 'failed'): Promise<void> => {
    if (busy) return;
    const c = $<HTMLInputElement>('comment');
    const v = await run('Neuer Screenshot, nächster Schritt wird ermittelt ...', api.reportStep(outcome, c.value));
    if (v) {
      c.value = '';
      session = v;
      renderSession();
    }
  };
  $('btn-done').addEventListener('click', () => void report('done'));
  $('btn-failed').addEventListener('click', () => void report('failed'));
  $('btn-show').addEventListener('click', async () => {
    const v = await run('', api.toggleOverlay());
    if (v) {
      session = v;
      renderSession();
    }
  });
  $('btn-solved').addEventListener('click', async () => {
    const v = await run('', api.markSolved());
    if (v) {
      session = v;
      renderSession();
    }
  });
  const reset = async (): Promise<void> => {
    await api.resetSession();
    session = null;
    status(null);
    $<HTMLTextAreaElement>('problem').value = '';
    renderSession();
    void loadSources();
  };
  $('btn-reset').addEventListener('click', () => void reset());
  $('btn-new').addEventListener('click', () => void reset());
}

async function init(): Promise<void> {
  wireSettings();
  wireSession();
  settings = await api.getSettings();
  renderSettings();
  renderSession();
  await loadSources();
  const cur = settings.providers.find((p) => p.id === settings!.providerId);
  if (cur?.requiresKey && !cur.keySet) {
    status('info', 'Willkommen. Bitte zuerst in den Einstellungen einen API-Key hinterlegen (oder den Mock-Anbieter zum Ausprobieren wählen).');
  }
}

void init();
