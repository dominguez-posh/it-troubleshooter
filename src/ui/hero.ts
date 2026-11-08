import { heroText, humanizeError } from '../shared/ux';
import type { ErrorCode, Recommendation, ServerAccess, SessionView, StepOutcome } from '../shared/types';

/** Aktionen, die die "Jetzt tun"-Karte auslösen kann (vom Fenster an die Preload-API gebunden). */
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
  openSettings?(): void;
}

export interface HeroOptions {
  /** Kleines Mini-Fenster: weniger Text, keine Zusatzbereiche. */
  compact: boolean;
  /** Erweiterter Modus: zeigt auch Modell, Tokens und Vertrauen unter "Mehr Details". */
  advanced: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function btn(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', `btn ${cls}`.trim(), label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

const link = (label: string, onClick: () => void): HTMLButtonElement => btn(label, onClick, 'link');

function details(summary: string, ...body: Node[]): HTMLDetailsElement {
  const d = el('details', 'more');
  d.append(el('summary', '', summary), ...body);
  return d;
}

function commandsBlock(rec: Recommendation, h: CardHandlers): { node: HTMLElement; ack: HTMLInputElement | null } | null {
  const cmds = rec.commands ?? [];
  if (!cmds.length) return null;
  const box = el('div', 'commands');
  box.append(el('p', 'hint keep', 'Diese Befehle führst du selbst aus. Das Tool führt nie etwas aus. Gib keine Passwörter ein.'));
  let ack: HTMLInputElement | null = null;
  for (const c of cmds) {
    const mode = c.mode === 'readonly' ? '✓ Nur ansehen' : '⚠ Ändert etwas';
    const head = el('p', `cmd-head ${c.mode}`, `${mode}: ${c.explanation}`);
    box.append(head, el('code', '', c.command), btn('Befehl kopieren', () => h.copy(c.command), 'small'));
    if (c.mode === 'changing') box.append(el('p', 'warn', `Achtung: ${c.risk ?? ''}${c.backup ? ` Sicherung / Rückweg: ${c.backup}` : ''}`));
  }
  if (cmds.some((c) => c.mode === 'changing')) {
    const label = el('label', 'check');
    ack = el('input');
    ack.type = 'checkbox';
    label.append(ack, ' Ich habe die Warnung verstanden');
    box.append(label);
  }
  return { node: box, ack };
}

/** Fehler-Hinweis in Alltagssprache mit klarer nächster Handlung. */
function errorBox(root: HTMLElement, v: SessionView, h: CardHandlers): void {
  const code = (v.activity.kind === 'ratelimit' ? 'rate_limit' : (v.activity.detail ?? 'internal')) as ErrorCode;
  const e = humanizeError({ code, message: v.activity.hint ?? '' });
  const box = el('div', 'alert');
  box.setAttribute('role', 'alert');
  box.append(el('p', 'alert-title', `! ${e.title}`), el('p', '', `${e.text} ${e.next}`));
  const row = el('div', 'row');
  if (e.action === 'settings' && h.openSettings) row.append(btn('Einstellungen öffnen', h.openSettings, 'primary'));
  else row.append(btn('Noch einmal versuchen', h.retry, 'primary'));
  row.append(btn('Selbst weitermachen', () => h.abort(true)), link('Abbrechen', () => h.abort(false)));
  box.append(row, details('Fehlerdetails anzeigen', el('p', 'hint', e.details)));
  root.append(box);
}

function callHero(root: HTMLElement, v: SessionView, h: CardHandlers, o: HeroOptions): void {
  const c = v.call!;
  root.append(el('p', 'eyebrow', 'Im Telefonat'), el('h2', 'headline', c.loading ? 'Einen Moment, ich suche die nächsten Fragen …' : 'Stelle dem Kunden diese Fragen:'));
  for (const q of c.questions) {
    const b = btn(q.text, () => h.focusInput(`${q.text} → `), `question${q.asked ? ' done' : ''}`);
    b.title = 'Klicke, dann tippe die Antwort in Stichworten ein.';
    root.append(b);
  }
  if (c.readiness !== 'more') {
    root.append(el('p', 'hint good', c.readiness === 'remote' ? 'Jetzt weißt du genug. Am Bildschirm ansehen ist der nächste Schritt.' : 'Jetzt weißt du genug. Das lässt sich ohne Fernwartung lösen.'));
  }
  const row = el('div', 'row');
  row.append(btn('Weiter mit der Einschätzung', () => h.endCall(true), c.readiness !== 'more' ? 'primary' : ''));
  root.append(row, link('Telefonat beenden', () => h.endCall(false)));
  if (c.suspicion && !o.compact) root.append(details('Mehr Details', el('p', '', c.suspicion)));
}

/** Zeichnet die "Jetzt tun"-Karte: eine Anweisung, höchstens zwei Buttons, alles andere unter "Mehr Details". */
export function renderHero(root: HTMLElement, v: SessionView, h: CardHandlers, o: HeroOptions): void {
  root.replaceChildren();
  root.classList.toggle('compact', o.compact);
  const act = v.activity;
  if (act.kind === 'error' || act.kind === 'ratelimit') errorBox(root, v, h);

  if (v.result) {
    root.append(el('p', 'eyebrow', v.result === 'solved' ? 'Gelöst' : 'Beendet'), el('h2', 'headline', v.result === 'solved' ? 'Geschafft!' : 'Der Fall ist beendet.'));
    return;
  }
  if (v.call) return callHero(root, v, h, o);
  if (!v.incidentId) {
    root.append(el('p', 'eyebrow', 'Kein Fall offen'), el('h2', 'headline', 'Beschreibe ein Problem, dann geht es los.'), btn('Telefonat mit Kunden', h.startCall));
    return;
  }

  const more: Node[] = [];
  const rec = v.recommendation;

  // ---- Schritt mit Pfeil ----
  if (v.phase === 'steps' && v.current) {
    root.append(el('p', 'eyebrow', 'Nächster Klick'), el('h2', 'headline', v.current.step.text));
    root.append(el('p', 'hint', 'Der Pfeil auf deinem Bildschirm zeigt dir die Stelle.'));
    const cmd = rec ? commandsBlock(rec, h) : null;
    if (cmd) root.append(cmd.node);
    const row = el('div', 'row');
    row.append(btn('Erledigt', () => h.report('done'), 'primary'), btn('Hat nicht geklappt', () => h.report('failed', h.takeInput())));
    root.append(row);
    if (v.current.step.reason) more.push(el('p', '', `Warum: ${v.current.step.reason}`));
    if (o.advanced && v.lastRequest) more.push(el('p', 'hint', `Modell: ${v.lastRequest.model} (${v.lastRequest.tier}) · ${v.lastRequest.inputTokens + v.lastRequest.outputTokens} Tokens`));
    if (more.length && !o.compact) root.append(details('Mehr Details', ...more));
    return;
  }

  if (!rec) {
    root.append(el('p', 'eyebrow', 'Einen Moment'), el('h2', 'headline', v.holding ? 'Wir warten auf den Kunden.' : 'Die KI macht sich ein erstes Bild …'));
    return;
  }

  const t = heroText(rec);
  root.append(el('p', 'eyebrow', v.recPostponed ? `${t.eyebrow} (zurückgestellt)` : t.eyebrow), el('h2', 'headline', t.headline));
  if (rec.risk) root.append(el('p', 'warn', `Achtung: ${rec.risk}`));
  if (rec.action === 'start_remote') root.append(el('p', 'hint', 'Standard ist der ganze Bildschirm. Ein einzelnes Fenster kannst du unter „Was soll angesehen werden?“ wählen.'));
  if (rec.action === 'start_remote' && rec.show) root.append(el('p', 'hint', `Der Kunde soll zeigen: ${rec.show}`));
  if (rec.action === 'contact_customer') {
    const ul = el('ul', 'hint');
    for (const p of rec.talkingPoints) ul.append(el('li', '', p));
    root.append(ul);
  }
  if (rec.action === 'answer_directly' && rec.steps) {
    const ol = el('ol', 'hint');
    for (const p of rec.steps) ol.append(el('li', '', p));
    root.append(ol);
  }
  if (rec.action === 'escalate') root.append(el('p', 'hint', `Das gibst du weiter${rec.to ? ` an ${rec.to}` : ''}: ${rec.handover}`));
  if (rec.action === 'wait_check' && rec.minutes) root.append(el('p', 'hint', `Das dauert etwa ${rec.minutes} Minuten.`));
  const cmd = commandsBlock(rec, h);
  if (cmd) root.append(cmd.node);

  if (rec.action === 'check_server_access') {
    const row = el('div', 'row');
    const send = (state: ServerAccess['state']) => h.serverAccess({ state });
    row.append(btn('Ja', () => send('yes'), 'primary'), btn('Nein', () => send('no')), btn('Weiß nicht', () => send('unclear')));
    root.append(row, el('p', 'hint keep', 'Gib hier keine Passwörter ein. Es geht nur darum, ob es einen Zugang gibt.'));
  } else if (rec.action === 'ask_customer') {
    // Hauptaktion: Antwort des Kunden eingeben (Schnellantworten, falls vorhanden).
    if (rec.options) {
      const row = el('div', 'row');
      for (const opt of rec.options) row.append(btn(opt, () => h.note(`Antwort des Kunden: ${opt}`)));
      root.append(row);
    }
    root.append(el('p', 'hint keep', 'Tippe die Antwort des Kunden unten ein und drücke Enter.'));
  } else {
    const row = el('div', 'row');
    const done = btn(t.doneLabel, () => h.react('done', undefined, cmd?.ack?.checked === true), 'primary');
    if (cmd?.ack) {
      done.disabled = true;
      const ack = cmd.ack;
      ack.addEventListener('change', () => (done.disabled = !ack.checked));
    }
    row.append(done);
    if (rec.action !== 'start_remote' && rec.action !== 'close') row.append(btn('Hat nicht geklappt', () => h.react('other', h.takeInput() ?? 'Hat nicht geklappt')));
    root.append(row);
  }
  if (rec.action !== 'check_server_access') root.append(link('Anderer Vorschlag', () => h.react('other', h.takeInput())));

  more.push(el('p', '', `Warum: ${rec.reason}`));
  if (rec.alternative) more.push(el('p', 'hint', `Alternative: ${rec.alternative.instruction}`));
  if (!v.recPostponed) more.push(link('Später erinnern', () => h.react('later')));
  if (o.advanced) {
    if (rec.confidence) more.push(el('p', 'hint', `Sicherheit der KI: ${{ low: 'niedrig', medium: 'mittel', high: 'hoch' }[rec.confidence]}`));
    if (v.lastRequest) more.push(el('p', 'hint', `Modell: ${v.lastRequest.model} (${v.lastRequest.tier}) · ${v.lastRequest.reason} · ${v.lastRequest.inputTokens + v.lastRequest.outputTokens} Tokens`));
  }
  if (!o.compact) root.append(details('Mehr Details', ...more));
}
