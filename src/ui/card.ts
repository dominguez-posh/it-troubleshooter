import type { Recommendation, ServerAccess, SessionView, StepOutcome } from '../shared/types';

/** Aktionen, die die Karte auslösen kann (vom jeweiligen Fenster an die Preload-API gebunden). */
export interface CardHandlers {
  react(response: 'done' | 'other' | 'later', comment?: string, ack?: boolean): void;
  serverAccess(a: ServerAccess): void;
  note(text: string): void;
  copy(text: string): void;
  report(outcome: StepOutcome, comment?: string): void;
  startRemote(): void;
  callInput(text: string, question?: string): void;
  endCall(toTriage: boolean): void;
  startCall(): void;
  retry(): void;
  abort(manual: boolean): void;
  focusInput(prefill?: string): void;
  /** Text aus dem Eingabefeld als Kommentar entnehmen (und leeren). */
  takeInput(): string | undefined;
}

export const ACTION_LABEL: Record<Recommendation['action'], string> = {
  ask_customer: 'Kunden fragen',
  start_remote: 'Fernwartung starten',
  contact_customer: 'Kunden kontaktieren',
  answer_directly: 'Ohne Fernwartung lösen',
  do_step: 'Nächster Schritt',
  wait_check: 'Warten und prüfen',
  escalate: 'Eskalieren',
  close: 'Fall abschließen',
  check_server_access: 'Serverzugriff klären',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function btn(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function commandsBlock(rec: Recommendation, h: CardHandlers): { node: HTMLElement; needsAck: boolean; ack: HTMLInputElement | null } {
  const box = el('div');
  let ack: HTMLInputElement | null = null;
  const cmds = rec.commands ?? [];
  for (const c of cmds) {
    const head = el('div', 'sub');
    head.append(el('span', `tag ${c.mode === 'readonly' ? 'ro' : 'ch'}`, c.mode === 'readonly' ? 'Nur lesen' : 'ÄNDERND'), c.explanation);
    const code = el('code', '', c.command);
    box.append(head, code, btn('Kopieren', () => h.copy(c.command)));
    if (c.mode === 'changing') {
      box.append(el('div', 'risk', `Warnung: ${c.risk ?? ''}${c.backup ? ` Backup/Rückfall: ${c.backup}` : ''}`));
    }
  }
  const needsAck = cmds.some((c) => c.mode === 'changing');
  if (needsAck) {
    const label = el('label');
    ack = el('input');
    ack.type = 'checkbox';
    label.append(ack, ' Ich habe es verstanden');
    box.append(label);
  }
  if (cmds.length) box.append(el('div', 'sub', 'Das Tool führt nie selbst Befehle aus – nur du. Keine Passwörter eingeben.'));
  return { node: box, needsAck, ack };
}

function recCard(root: HTMLElement, v: SessionView, rec: Recommendation, h: CardHandlers): void {
  root.append(el('h3', '', `Jetzt tun · ${ACTION_LABEL[rec.action]}${v.recPostponed ? ' (zurückgestellt)' : ''}`));
  root.append(el('p', 'main', rec.instruction));
  root.append(el('p', 'sub', rec.reason));
  if (rec.risk) root.append(el('p', 'risk', `Risiko: ${rec.risk}`));
  if (rec.action === 'start_remote' && rec.show) root.append(el('p', 'sub', `Kunde soll zeigen: ${rec.show}`));
  if (rec.action === 'contact_customer') {
    const ul = el('ul', 'sub');
    for (const t of rec.talkingPoints) ul.append(el('li', '', t));
    root.append(ul);
  }
  if (rec.action === 'answer_directly' && rec.steps) {
    const ol = el('ol', 'sub');
    for (const t of rec.steps) ol.append(el('li', '', t));
    root.append(ol);
  }
  if (rec.action === 'escalate') root.append(el('p', 'sub', `Übergabe${rec.to ? ` an ${rec.to}` : ''}: ${rec.handover}`));
  if (rec.action === 'wait_check' && rec.minutes) root.append(el('p', 'sub', `Warten: ca. ${rec.minutes} min`));
  if (rec.alternative) root.append(el('p', 'sub', `Alternative: ${rec.alternative.instruction}`));
  const cmd = commandsBlock(rec, h);
  root.append(cmd.node);

  if (rec.action === 'check_server_access') {
    root.append(el('p', 'sub', 'Bitte keine Passwörter oder Zugangsdaten eingeben – nur ob und wie Zugriff besteht.'));
    const kind = el('select');
    for (const [val, label] of [['', 'Art (optional)'], ['rdp', 'RDP'], ['ssh', 'SSH'], ['web', 'Webkonsole'], ['other', 'Sonstiges']] as const) {
      const o = el('option', '', label);
      o.value = val;
      kind.append(o);
    }
    const note = el('input');
    note.type = 'text';
    note.maxLength = 100;
    note.placeholder = 'Servername/Rolle (optional)';
    const send = (state: ServerAccess['state']) => {
      const a: ServerAccess = { state };
      if (kind.value) a.kind = kind.value as NonNullable<ServerAccess['kind']>;
      if (note.value.trim()) a.note = note.value.trim();
      h.serverAccess(a);
    };
    const row = el('div', 'row');
    row.append(btn('Ja', () => send('yes'), 'primary'), btn('Nein', () => send('no')), btn('Unklar', () => send('unclear')), kind, note);
    root.append(row);
    return;
  }

  const row = el('div', 'row');
  if (rec.action === 'ask_customer' && rec.options) {
    for (const o of rec.options) row.append(btn(o, () => h.note(`Antwort des Kunden: ${o}`)));
  }
  const done = btn(rec.action === 'start_remote' ? 'Fernwartung starten' : rec.action === 'ask_customer' ? 'Gefragt' : 'Gemacht', () => {
    if (rec.action === 'ask_customer') h.focusInput('Antwort: ');
    h.react('done', undefined, cmd.ack?.checked === true);
  }, 'primary');
  if (cmd.needsAck && cmd.ack) {
    done.disabled = true;
    cmd.ack.addEventListener('change', () => (done.disabled = !cmd.ack!.checked));
  }
  row.append(
    done,
    btn('Anders (Text im Eingabefeld = Grund)', () => {
      h.react('other', h.takeInput());
    }),
    btn('Später', () => h.react('later')),
  );
  root.append(row);
}

function callCard(root: HTMLElement, v: SessionView, h: CardHandlers): void {
  const c = v.call!;
  root.append(el('h3', '', `Telefonat${c.loading ? ' · denkt nach …' : ''}`));
  if (c.suspicion) root.append(el('p', 'sub', c.suspicion));
  for (const q of c.questions) {
    const b = btn(q.text, () => h.focusInput(`${q.text} → `), `q${q.asked ? ' asked' : ''}`);
    b.title = q.why ?? 'Klicken, dann Antwort-Stichworte eintippen';
    root.append(b);
  }
  if (c.readiness !== 'more') {
    root.append(el('p', 'main', c.readiness === 'remote' ? 'Genug Infos: Fernwartung nötig.' : 'Genug Infos: Lösung ohne Fernwartung möglich.'));
  }
  const row = el('div', 'row');
  row.append(btn('Einschätzung starten', () => h.endCall(true), c.readiness !== 'more' ? 'primary' : ''), btn('Telefonat beenden', () => h.endCall(false)));
  root.append(row);
}

/** Zeichnet die zentrale Karte ("Jetzt tun", Schritt, Telefonat, Fehler) in den Container. */
export function renderCard(root: HTMLElement, v: SessionView, h: CardHandlers): void {
  root.replaceChildren();
  const act = v.activity;
  if (act.kind === 'error' || act.kind === 'ratelimit') {
    const row = el('div', 'row');
    row.append(btn('Erneut versuchen', h.retry, 'primary'), btn('Abbrechen', () => h.abort(false)), btn('Manuell weiter', () => h.abort(true)));
    if (act.detail === 'timeout' || act.kind === 'ratelimit' || act.detail === 'limit') root.append(row);
  }
  if (v.result) {
    root.append(el('h3', '', v.result === 'solved' ? 'Gelöst' : 'Abgebrochen'), el('p', 'main', 'Die Sitzung ist abgeschlossen.'));
    return;
  }
  if (v.call) return callCard(root, v, h);
  if (!v.incidentId) {
    root.append(el('p', 'sub', 'Keine aktive Sitzung.'), btn('☎ Jetzt Telefonat mit Kunden', h.startCall, 'primary'));
    return;
  }
  if (v.phase === 'steps' && v.current) {
    root.append(el('h3', '', `Schritt ${v.current.index} · ${v.lastRequest ? `${v.lastRequest.tier}` : 'Pfeil'}`));
    root.append(el('p', 'main', v.current.step.text));
    if (v.current.step.reason) root.append(el('p', 'sub', v.current.step.reason));
    const cmd = v.recommendation ? commandsBlock(v.recommendation, h) : null;
    if (cmd) root.append(cmd.node);
    const row = el('div', 'row');
    row.append(btn('Erledigt / Weiter', () => h.report('done'), 'primary'), btn('Hat nicht geklappt', () => {
      h.report('failed', h.takeInput());
    }));
    root.append(row);
    return;
  }
  if (v.recommendation) return recCard(root, v, v.recommendation, h);
  root.append(el('p', 'sub', v.holding ? 'Wartet auf den Kunden.' : 'Einschätzung wird erstellt …'));
}
