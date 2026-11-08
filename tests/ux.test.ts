import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KeyStore } from '../src/main/keystore';
import { createDefaultRegistry } from '../src/main/llm';
import { SettingsStore } from '../src/main/settings';
import { ALL_STATUSES } from '../src/shared/incident';
import type { ErrorCode, Recommendation, SessionView } from '../src/shared/types';
import {
  DEFAULTS,
  heroText,
  humanizeError,
  isVisible,
  nextWizardStep,
  prevWizardStep,
  providerStepComplete,
  relativeTime,
  stageOf,
  STAGES,
  STATUS_VIEW,
  WIZARD_STEPS,
  wizardNeeded,
  type Section,
} from '../src/shared/ux';

/** Wörter, die in der Oberfläche für Neulinge nicht vorkommen sollen (außerhalb von "Erweitert"). */
const JARGON = /incident|triage|eskalier|provider|token|routing|modellstufe|zod|schema|\bapi\b/i;

describe('Status in Alltagsworten: Farbe UND Symbol UND Text', () => {
  it('jeder Status hat Text, Symbol, Farbton und einen erklärenden Satz', () => {
    for (const s of ALL_STATUSES) {
      const v = STATUS_VIEW[s];
      expect(v.label.length).toBeGreaterThan(2);
      expect(v.icon.length).toBeGreaterThan(0);
      expect(['neutral', 'info', 'wait', 'good', 'bad']).toContain(v.tone);
      expect(v.hint.endsWith('.')).toBe(true);
    }
  });
  it('Zuordnung der Kernbegriffe', () => {
    expect(STATUS_VIEW.waiting.label).toBe('Wartet auf den Kunden');
    expect(STATUS_VIEW.triage.label).toBe('Wir arbeiten dran');
    expect(STATUS_VIEW.solved.label).toBe('Gelöst');
    expect(STATUS_VIEW.solved.tone).toBe('good');
    expect(STATUS_VIEW.unsolved.tone).toBe('bad');
  });
  it('Bezeichnungen sind eindeutig, damit der Status nie nur an der Farbe hängt', () => {
    const labels = ALL_STATUSES.map((s) => STATUS_VIEW[s].label);
    expect(new Set(labels).size).toBe(labels.length);
    const icons = ALL_STATUSES.map((s) => STATUS_VIEW[s].icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
  it('keine Fachbegriffe in Status-Texten', () => {
    for (const s of ALL_STATUSES) expect(`${STATUS_VIEW[s].label} ${STATUS_VIEW[s].hint}`).not.toMatch(JARGON);
  });
});

describe('Zeitangaben', () => {
  const now = Date.parse('2026-06-15T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it('"zuletzt vor 5 Minuten" und Nachbarn', () => {
    expect(relativeTime(ago(10_000), now)).toBe('gerade eben');
    expect(relativeTime(ago(60_000), now)).toBe('vor 1 Minute');
    expect(relativeTime(ago(5 * 60_000), now)).toBe('vor 5 Minuten');
    expect(relativeTime(ago(60 * 60_000), now)).toBe('vor 1 Stunde');
    expect(relativeTime(ago(3 * 3600_000), now)).toBe('vor 3 Stunden');
    expect(relativeTime(ago(24 * 3600_000), now)).toBe('vor 1 Tag');
    expect(relativeTime(ago(3 * 86_400_000), now)).toBe('vor 3 Tagen');
    expect(relativeTime(ago(30 * 86_400_000), now)).toMatch(/\d{2}\.\d{2}\.\d{4}|\d{1,2}\.\d{1,2}\.\d{4}/);
    expect(relativeTime('kaputt', now)).toBe('');
  });
});

describe('Die eine Anweisung ("Jetzt tun")', () => {
  const base = { instruction: 'Mach das.', reason: 'weil' };
  const recs: Recommendation[] = [
    { action: 'ask_customer', ...base },
    { action: 'start_remote', ...base },
    { action: 'contact_customer', ...base, talkingPoints: ['a'] },
    { action: 'answer_directly', ...base },
    { action: 'do_step', ...base, target: null },
    { action: 'wait_check', ...base },
    { action: 'escalate', ...base, handover: 'x' },
    { action: 'close', ...base },
    { action: 'check_server_access', ...base },
  ];
  it('jede Aktion hat eine verständliche Überschrift-Zeile und Button-Beschriftung mit Verb', () => {
    for (const r of recs) {
      const t = heroText(r);
      expect(t.headline).toBe('Mach das.');
      expect(t.eyebrow.length).toBeGreaterThan(3);
      expect(t.doneLabel.length).toBeGreaterThan(3);
      expect(`${t.eyebrow} ${t.doneLabel}`).not.toMatch(JARGON);
    }
  });
  it('"Eskalieren" heißt "An Kollegen weitergeben"', () => {
    expect(heroText(recs[6]!).eyebrow).toBe('An Kollegen weitergeben');
  });
});

const view = (over: Partial<SessionView> = {}): SessionView =>
  ({ incidentId: 'i', problem: 'p', history: [], notes: [], phase: 'rec', recommendation: null, recPostponed: false, holding: false, current: null, result: null, call: null, ...over }) as SessionView;
const rec = (action: Recommendation['action']): Recommendation => ({ action, instruction: 'x', reason: 'y', talkingPoints: ['a'], handover: 'h', target: null }) as Recommendation;

describe('Fortschritt in vier einfachen Schritten', () => {
  it('Schritte in einfachen Worten', () => {
    expect([...STAGES]).toEqual(['Problem beschreiben', 'Klären', 'Gemeinsam lösen', 'Abschließen']);
  });
  it('Stufe und Satz "Wo bin ich?" je Lage', () => {
    expect(stageOf(null).index).toBe(0);
    expect(stageOf(view({ incidentId: null })).index).toBe(0);
    expect(stageOf(view({ recommendation: rec('ask_customer') })).index).toBe(1);
    expect(stageOf(view({ recommendation: rec('check_server_access') })).index).toBe(1);
    expect(stageOf(view({ recommendation: rec('start_remote') })).index).toBe(2);
    expect(stageOf(view({ phase: 'steps' })).index).toBe(2);
    expect(stageOf(view({ recommendation: rec('close') })).index).toBe(3);
    expect(stageOf(view({ result: 'solved' })).index).toBe(3);
    expect(stageOf(view({ call: { questions: [], suspicion: null, readiness: 'more', answered: 0, loading: false } })).index).toBe(1);
  });
  it('jeder Satz sagt, was zu tun ist, und enthält keine Fachbegriffe', () => {
    const all = [null, view({ recommendation: rec('ask_customer') }), view({ recommendation: rec('start_remote') }), view({ phase: 'steps' }), view({ recommendation: rec('close') }), view({ result: 'unsolved' }), view()];
    for (const v of all) {
      const w = stageOf(v).where;
      expect(w.length).toBeGreaterThan(15);
      expect(w.endsWith('.')).toBe(true);
      expect(w).not.toMatch(JARGON);
    }
  });
});

describe('Fehlermeldungen: von Technik zu Verständlich', () => {
  const codes: ErrorCode[] = ['auth', 'rate_limit', 'network', 'no_key', 'invalid_response', 'capture', 'api', 'timeout', 'limit', 'internal'];
  it('jede Fehlerkategorie hat Titel, Text und nächste Handlung ohne Fachwort', () => {
    for (const c of codes) {
      const h = humanizeError({ code: c, message: 'technische Meldung' });
      expect(h.title.length).toBeGreaterThan(5);
      expect(h.text.length).toBeGreaterThan(10);
      expect(h.next.length).toBeGreaterThan(10);
      expect(`${h.title} ${h.text} ${h.next}`).not.toMatch(JARGON);
      expect(['retry', 'settings', 'none']).toContain(h.action);
    }
  });
  it('"Ungültige Antwort (zod)" wird zu einem freundlichen Satz mit nächster Handlung', () => {
    const h = humanizeError({ code: 'invalid_response', message: 'Antwort des Modells ist ungültig (action: Invalid input; zod).' });
    expect(h.title).toBe('Die KI hat nicht verständlich geantwortet');
    expect(h.next).toBe('Versuche es noch einmal.');
    expect(h.action).toBe('retry');
    expect(`${h.title} ${h.text} ${h.next}`).not.toMatch(/zod|ungültig|invalid/i);
    expect(h.details).toContain('zod'); // nur unter "Fehlerdetails anzeigen"
  });
  it('Schlüssel-Probleme führen in die Einstellungen', () => {
    expect(humanizeError({ code: 'auth', message: '' }).action).toBe('settings');
    expect(humanizeError({ code: 'no_key', message: '' }).action).toBe('settings');
  });
  it('eigene deutsche Hinweise der App bleiben erhalten, technische Texte nicht', () => {
    const own = humanizeError({ code: 'internal', message: 'Bitte zuerst das Problem beschreiben.' });
    expect(own.text).toBe('Bitte zuerst das Problem beschreiben.');
    const tech = humanizeError({ code: 'internal', message: 'TypeError: undefined is not a function at x.js:12:3' });
    expect(tech.text).toBe('Es ist ein unerwarteter Fehler aufgetreten.');
    expect(tech.details).toContain('TypeError');
  });
  it('enthält nie den Schlüssel oder Roh-Meldung im sichtbaren Text', () => {
    const h = humanizeError({ code: 'api', message: 'sk-ant-GEHEIM 500' });
    expect(`${h.title} ${h.text} ${h.next}`).not.toContain('GEHEIM');
  });
});

describe('Modus Einfach und Erweitert', () => {
  const advancedOnly: Section[] = ['model-tiers', 'routing', 'cost-details', 'cost-limits', 'tokens', 'activity-log', 'auto-advance', 'escalation', 'image-quality', 'price-table', 'exchange-rate', 'shortcuts', 'retention', 'window-options'];
  it('Einfach zeigt nur das Nötige', () => {
    for (const s of advancedOnly) expect(isVisible(s, false)).toBe(false);
    for (const s of ['provider', 'api-key', 'warn-threshold', 'mode-switch'] as Section[]) expect(isVisible(s, false)).toBe(true);
  });
  it('Erweitert zeigt zusätzlich Modelle, Kosten-Details, Token, Protokoll, Auto-Weiter, Schwellen, Bildqualität, Preistabelle, Kurs', () => {
    for (const s of advancedOnly) expect(isVisible(s, true)).toBe(true);
    expect(isVisible('provider', true)).toBe(true);
  });
  it('sinnvolle Standardwerte: Einfach-Modus, Assistent offen, nichts muss eingestellt werden', () => {
    expect(DEFAULTS).toMatchObject({ advancedMode: false, onboardingDone: false, failedThreshold: 2, dropBackToBase: true, maxImageWidth: 1280, jpegQuality: 70, shotRetentionDays: 30, autoAdvance: false });
  });
});

describe('Willkommens-Assistent', () => {
  it('Reihenfolge: Anbieter, Datenschutz, Kosten, Testlauf; vor und zurück', () => {
    expect([...WIZARD_STEPS]).toEqual(['provider', 'privacy', 'cost', 'test']);
    expect(nextWizardStep('provider')).toBe('privacy');
    expect(nextWizardStep('test')).toBeNull();
    expect(prevWizardStep('provider')).toBeNull();
    expect(prevWizardStep('cost')).toBe('privacy');
  });
  it('Anbieter-Schritt ist mit Testmodus oder mit Schlüssel abgeschlossen', () => {
    const providers = [
      { id: 'anthropic', requiresKey: true, keySet: false },
      { id: 'mock', requiresKey: false, keySet: true },
    ] as never;
    expect(providerStepComplete({ providerId: 'mock', providers })).toBe(true);
    expect(providerStepComplete({ providerId: 'anthropic', providers })).toBe(false);
    expect(providerStepComplete({ providerId: 'anthropic', providers: [{ id: 'anthropic', requiresKey: true, keySet: true }] as never })).toBe(true);
    expect(providerStepComplete({ providerId: 'unbekannt', providers })).toBe(false);
  });
  it('wird nur gezeigt, solange er nicht abgeschlossen oder übersprungen wurde', () => {
    expect(wizardNeeded({ onboardingDone: false })).toBe(true);
    expect(wizardNeeded({ onboardingDone: true })).toBe(false);
  });
});

describe('Einstellungen: Modus und Assistent bleiben gespeichert (einmalig)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'itt-ux-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const make = () => {
    const keys = new KeyStore(dir, { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() });
    return new SettingsStore(dir, createDefaultRegistry(), keys);
  };
  it('Standard: Einfach-Modus und Assistent noch offen', () => {
    const v = make().view();
    expect(v.advancedMode).toBe(false);
    expect(v.onboardingDone).toBe(false);
    expect(v.failedThreshold).toBe(DEFAULTS.failedThreshold);
    expect(v.maxImageWidth).toBe(DEFAULTS.maxImageWidth);
    expect(v.jpegQuality).toBe(DEFAULTS.jpegQuality);
    expect(v.shotRetentionDays).toBe(DEFAULTS.shotRetentionDays);
    expect(v.autoAdvance).toBe(false);
    expect(v.dropBackToBase).toBe(true);
  });
  it('Moduswechsel und "Assistent erledigt" überstehen einen Neustart', () => {
    const s = make();
    s.update({ advancedMode: true, onboardingDone: true });
    const again = make().view();
    expect(again.advancedMode).toBe(true);
    expect(wizardNeeded(again)).toBe(false);
    s.update({ advancedMode: false });
    expect(make().view().advancedMode).toBe(false);
    expect(make().view().onboardingDone).toBe(true);
  });
  it('Wechsel in den Erweitert-Modus ändert keine Standardwerte', () => {
    const s = make();
    const before = s.view();
    s.update({ advancedMode: true });
    const after = s.view();
    expect({ ...after, advancedMode: false }).toEqual(before);
  });
});
