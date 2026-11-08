import type { IncidentStatus } from './incident';
import type { AppError, ErrorCode, Recommendation, SessionView, SettingsView } from './types';

/**
 * Alles, was die Oberfläche in Alltagssprache übersetzt: Status, Anweisungen, Fehler, Fortschritt, Modi, Assistent.
 * Reine Funktionen ohne DOM, damit sie getestet werden können.
 */

// ---------- Status in Alltagsworten (Farbe UND Symbol UND Text) ----------
export type Tone = 'neutral' | 'info' | 'wait' | 'good' | 'bad';

export interface StatusView {
  label: string;
  icon: string;
  tone: Tone;
  /** Ein Satz: was heißt das? */
  hint: string;
}

export const STATUS_VIEW: Record<IncidentStatus, StatusView> = {
  draft: { label: 'Noch nicht gestartet', icon: '○', tone: 'neutral', hint: 'Der Fall ist angelegt, aber noch nicht bearbeitet.' },
  call: { label: 'Im Telefonat', icon: '☎', tone: 'info', hint: 'Du sprichst gerade mit dem Kunden.' },
  triage: { label: 'Wir arbeiten dran', icon: '⚙', tone: 'info', hint: 'Die KI hat eine erste Einschätzung gemacht.' },
  waiting: { label: 'Wartet auf den Kunden', icon: '⏳', tone: 'wait', hint: 'Es braucht erst eine Antwort oder eine Rückmeldung.' },
  remote: { label: 'Wir lösen es gemeinsam', icon: '▶', tone: 'info', hint: 'Ihr arbeitet gerade zusammen am Bildschirm.' },
  paused: { label: 'Pausiert', icon: '⏸', tone: 'neutral', hint: 'Der Fall ruht. Du kannst ihn jederzeit weiterbearbeiten.' },
  solved: { label: 'Gelöst', icon: '✓', tone: 'good', hint: 'Das Problem ist behoben.' },
  unsolved: { label: 'Nicht gelöst', icon: '✕', tone: 'bad', hint: 'Das Problem konnte nicht behoben werden.' },
};

export const statusView = (s: IncidentStatus): StatusView => STATUS_VIEW[s];

/** "gerade eben", "vor 5 Minuten", "vor 2 Stunden", "vor 3 Tagen", sonst Datum. */
export function relativeTime(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const min = Math.floor((nowMs - t) / 60_000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return min === 1 ? 'vor 1 Minute' : `vor ${min} Minuten`;
  const h = Math.floor(min / 60);
  if (h < 24) return h === 1 ? 'vor 1 Stunde' : `vor ${h} Stunden`;
  const d = Math.floor(h / 24);
  if (d < 14) return d === 1 ? 'vor 1 Tag' : `vor ${d} Tagen`;
  return new Date(t).toLocaleDateString('de-DE');
}

// ---------- Die eine Anweisung ----------
export interface HeroText {
  /** Kleine Zeile über der Anweisung: Worum geht es? */
  eyebrow: string;
  /** Die eine Anweisung (aus der Empfehlung, Du-Form). */
  headline: string;
  /** Beschriftung des Haupt-Buttons. */
  doneLabel: string;
}

const EYEBROW: Record<Recommendation['action'], string> = {
  ask_customer: 'Frage an den Kunden',
  start_remote: 'Gemeinsam am Bildschirm arbeiten',
  contact_customer: 'Den Kunden kontaktieren',
  answer_directly: 'Das kannst du dem Kunden sagen',
  do_step: 'Nächster Klick',
  wait_check: 'Kurz warten und nachsehen',
  escalate: 'An Kollegen weitergeben',
  close: 'Fall abschließen',
  check_server_access: 'Zugriff auf den Server klären',
};

const DONE: Record<Recommendation['action'], string> = {
  ask_customer: 'Habe gefragt',
  start_remote: 'Fernwartung starten',
  contact_customer: 'Habe den Kunden kontaktiert',
  answer_directly: 'Habe es weitergegeben',
  do_step: 'Erledigt',
  wait_check: 'Habe nachgesehen',
  escalate: 'Habe es weitergegeben',
  close: 'Fall abschließen',
  check_server_access: 'Erledigt',
};

export function heroText(rec: Recommendation): HeroText {
  return { eyebrow: EYEBROW[rec.action], headline: rec.instruction, doneLabel: DONE[rec.action] };
}

// ---------- Fortschritt (Stepper) ----------
export const STAGES = ['Problem beschreiben', 'Klären', 'Gemeinsam lösen', 'Abschließen'] as const;

/** 0-basierter Index der aktuellen Stufe und der Satz "Wo bin ich? Was soll ich jetzt tun?". */
export function stageOf(v: SessionView | null): { index: number; where: string } {
  if (!v || !v.incidentId) return { index: 0, where: 'Beschreibe das Problem in ein bis zwei Sätzen.' };
  if (v.result) return { index: 3, where: v.result === 'solved' ? 'Geschafft. Prüfe die Arbeitszeit und sieh dir den Verlauf an.' : 'Der Fall ist beendet. Prüfe die Arbeitszeit und sieh dir den Verlauf an.' };
  if (v.call) return { index: 1, where: 'Du bist im Telefonat. Stelle die Fragen und tippe die Antworten in Stichworten ein.' };
  if (v.phase === 'steps') return { index: 2, where: 'Ihr arbeitet gemeinsam am Bildschirm. Klicke dort, wo der Pfeil hinzeigt.' };
  const a = v.recommendation?.action;
  if (a === 'start_remote') return { index: 2, where: 'Gleich geht es am Bildschirm weiter. Öffne die Fernwartung, wenn der Kunde bereit ist.' };
  if (a === 'close') return { index: 3, where: 'Fast fertig. Schließe den Fall ab, wenn das Problem behoben ist.' };
  if (a === 'ask_customer' || a === 'check_server_access') return { index: 1, where: 'Wir klären zuerst ein paar Dinge. Frage den Kunden und gib die Antwort ein.' };
  if (a === 'contact_customer') return { index: 1, where: 'Wir brauchen eine Rückmeldung vom Kunden, bevor es weitergeht.' };
  if (!v.recommendation) return { index: 1, where: 'Einen Moment, die KI macht sich ein erstes Bild.' };
  return { index: 1, where: 'Wir klären gerade, was als Nächstes sinnvoll ist.' };
}

// ---------- Fehlermeldungen ----------
export interface HumanError {
  title: string;
  /** Was ist passiert, in einem Satz. */
  text: string;
  /** Was kann ich tun? */
  next: string;
  /** Welche Aktion bietet die Oberfläche an? */
  action: 'retry' | 'settings' | 'none';
  /** Technische Details (nur unter "Fehlerdetails anzeigen"). */
  details: string;
}

const ERRORS: Record<ErrorCode, Omit<HumanError, 'details'>> = {
  auth: { title: 'Der Schlüssel passt nicht', text: 'Der KI-Anbieter hat deinen Zugangsschlüssel nicht akzeptiert.', next: 'Prüfe den Schlüssel in den Einstellungen.', action: 'settings' },
  rate_limit: { title: 'Gerade sind zu viele Anfragen unterwegs', text: 'Der KI-Anbieter bittet um eine kurze Pause.', next: 'Warte einen Moment und versuche es dann noch einmal.', action: 'retry' },
  network: { title: 'Keine Verbindung', text: 'Der KI-Anbieter ist gerade nicht erreichbar.', next: 'Prüfe deine Internetverbindung und versuche es noch einmal.', action: 'retry' },
  no_key: { title: 'Es fehlt noch ein Schlüssel', text: 'Für diesen KI-Anbieter ist noch kein Zugangsschlüssel eingetragen.', next: 'Trage ihn in den Einstellungen ein oder nutze den Testmodus.', action: 'settings' },
  invalid_response: { title: 'Die KI hat nicht verständlich geantwortet', text: 'Das kommt manchmal vor.', next: 'Versuche es noch einmal.', action: 'retry' },
  capture: { title: 'Der Bildschirm konnte nicht gelesen werden', text: 'Das gewählte Fenster oder der Bildschirm ist nicht verfügbar.', next: 'Prüfe, ob das Fenster sichtbar und nicht minimiert ist.', action: 'retry' },
  api: { title: 'Der KI-Anbieter hat ein Problem', text: 'Die Anfrage wurde nicht angenommen.', next: 'Versuche es später noch einmal oder prüfe das Modell in den Einstellungen.', action: 'retry' },
  timeout: { title: 'Die KI antwortet nicht', text: 'Es kam keine Antwort innerhalb von einer Minute.', next: 'Versuche es noch einmal oder mach selbst weiter.', action: 'retry' },
  limit: { title: 'Dein Kostenlimit ist erreicht', text: 'Neue KI-Anfragen sind pausiert, damit es nicht teurer wird.', next: 'Erlaube einmal weiter oder erhöhe das Limit.', action: 'none' },
  internal: { title: 'Das hat nicht geklappt', text: 'Es ist ein unerwarteter Fehler aufgetreten.', next: 'Versuche es noch einmal.', action: 'retry' },
};

/** Übersetzt eine technische Fehlerkategorie in einen verständlichen Text. Eigene deutsche Meldungen der App bleiben als Satz erhalten. */
export function humanizeError(e: AppError): HumanError {
  const base = ERRORS[e.code] ?? ERRORS.internal;
  const own = e.code === 'internal' && /^[A-ZÄÖÜ]/.test(e.message) && e.message.length < 160 && !/zod|exception|undefined|\bat\b.*:\d+/i.test(e.message);
  return { ...base, ...(own ? { text: e.message, title: 'Das geht so nicht' } : {}), details: `${e.code}: ${e.message}` };
}

// ---------- Modi: Einfach und Erweitert ----------
export type Section =
  | 'model-tiers'
  | 'routing'
  | 'cost-details'
  | 'cost-limits'
  | 'tokens'
  | 'activity-log'
  | 'auto-advance'
  | 'escalation'
  | 'image-quality'
  | 'price-table'
  | 'exchange-rate'
  | 'shortcuts'
  | 'retention'
  | 'window-options'
  | 'warn-threshold'
  | 'provider'
  | 'api-key'
  | 'mode-switch';

const SIMPLE: Section[] = ['provider', 'api-key', 'warn-threshold', 'mode-switch'];
const ADVANCED_ONLY: Section[] = [
  'model-tiers', 'routing', 'cost-details', 'cost-limits', 'tokens', 'activity-log', 'auto-advance', 'escalation', 'image-quality',
  'price-table', 'exchange-rate', 'shortcuts', 'retention', 'window-options',
];

export function isVisible(section: Section, advanced: boolean): boolean {
  return SIMPLE.includes(section) || (advanced && ADVANCED_ONLY.includes(section));
}

/** Sinnvolle Standardwerte: im Einfach-Modus muss niemand etwas einstellen. */
export const DEFAULTS = {
  advancedMode: false,
  onboardingDone: false,
  failedThreshold: 2,
  dropBackToBase: true,
  maxImageWidth: 1280,
  jpegQuality: 70,
  shotRetentionDays: 30,
  autoAdvance: false,
} as const;

// ---------- Willkommens-Assistent ----------
export const WIZARD_STEPS = ['provider', 'privacy', 'cost', 'test'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** Einmalig: nur beim ersten Start; nach "Fertig" oder "Überspringen" nie wieder. */
export function wizardNeeded(s: Pick<SettingsView, 'onboardingDone'>): boolean {
  return !s.onboardingDone;
}

export function nextWizardStep(cur: WizardStep): WizardStep | null {
  const i = WIZARD_STEPS.indexOf(cur);
  return WIZARD_STEPS[i + 1] ?? null;
}

export function prevWizardStep(cur: WizardStep): WizardStep | null {
  const i = WIZARD_STEPS.indexOf(cur);
  return i > 0 ? WIZARD_STEPS[i - 1]! : null;
}

/** Schritt 1 ist erst abgeschlossen, wenn Testmodus gewählt ist oder ein Schlüssel vorhanden ist. */
export function providerStepComplete(s: Pick<SettingsView, 'providerId' | 'providers'>): boolean {
  const p = s.providers.find((x) => x.id === s.providerId);
  return !!p && (!p.requiresKey || p.keySet);
}

export const PROVIDER_LABEL: Record<string, string> = { anthropic: 'Claude (Anthropic)', mock: 'Testmodus (ohne Schlüssel, nur zum Ausprobieren)' };
