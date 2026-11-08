import { describe, expect, it } from 'vitest';
import {
  buildCallText,
  buildRecommendText,
  dedupeQuestions,
  historyLines,
  LIMITS,
  noteLines,
  sanitize,
} from '../src/main/llm/prompt';
import { validateCallSuggestion, validateRecommendation } from '../src/main/llm/schema';
import { LlmError } from '../src/main/llm/types';

const size = { width: 1600, height: 900 };
const base = { instruction: 'Tu das.', reason: 'Weil.' };

describe('validateRecommendation: alle Aktionen', () => {
  it('ask_customer mit Schnellantworten (2 bis 4)', () => {
    expect(validateRecommendation({ action: 'ask_customer', ...base, options: ['Ja', 'Nein'] })).toMatchObject({ options: ['Ja', 'Nein'] });
    expect(() => validateRecommendation({ action: 'ask_customer', ...base, options: ['Ja'] })).toThrow(LlmError);
  });
  it('start_remote ohne Screenshot ok, mit Screenshot abgelehnt', () => {
    expect(validateRecommendation({ action: 'start_remote', ...base, show: 'Outlook' }).action).toBe('start_remote');
    expect(() => validateRecommendation({ action: 'start_remote', ...base }, { imageSize: size })).toThrow(LlmError);
  });
  it('contact_customer braucht Gesprächsleitfaden', () => {
    expect(validateRecommendation({ action: 'contact_customer', ...base, talkingPoints: ['a', 'b'] }).action).toBe('contact_customer');
    expect(() => validateRecommendation({ action: 'contact_customer', ...base })).toThrow(LlmError);
  });
  it('answer_directly, wait_check, escalate, close, check_server_access', () => {
    expect(validateRecommendation({ action: 'answer_directly', ...base, steps: ['x'] }).action).toBe('answer_directly');
    expect(validateRecommendation({ action: 'wait_check', ...base, minutes: 5 })).toMatchObject({ minutes: 5 });
    expect(() => validateRecommendation({ action: 'wait_check', ...base, minutes: 0 })).toThrow(LlmError);
    expect(validateRecommendation({ action: 'escalate', ...base, handover: 'Übergabe' }).action).toBe('escalate');
    expect(() => validateRecommendation({ action: 'escalate', ...base })).toThrow(LlmError);
    expect(validateRecommendation({ action: 'close', ...base, result: 'solved' })).toMatchObject({ result: 'solved' });
    expect(validateRecommendation({ action: 'check_server_access', ...base, accessKinds: ['rdp', 'ssh'] }).action).toBe('check_server_access');
  });
  it('unbekannte Aktion und fehlende Pflichtfelder', () => {
    expect(() => validateRecommendation({ action: 'dance', ...base })).toThrow(LlmError);
    expect(() => validateRecommendation({ action: 'close', instruction: 'x' })).toThrow(/reason/);
    expect(() => validateRecommendation(null)).toThrow(LlmError);
  });
  it('genau eine Hauptempfehlung, höchstens eine Alternative (kein Array)', () => {
    const alt = { action: 'wait_check', instruction: 'Warten.' };
    expect(validateRecommendation({ action: 'close', ...base, alternative: alt }).alternative).toEqual(alt);
    expect(() => validateRecommendation({ action: 'close', ...base, alternative: [alt, alt] })).toThrow(LlmError);
  });
  it('do_step: nur mit Screenshot, Ziel im Bild, knapp Außerhalb wird gezogen', () => {
    expect(() => validateRecommendation({ action: 'do_step', ...base, target: { x: 1, y: 1 } })).toThrow(/Screenshot/);
    expect(validateRecommendation({ action: 'do_step', ...base, target: { x: 10.4, y: 20.6 } }, { imageSize: size })).toMatchObject({ target: { x: 10, y: 21 } });
    expect(validateRecommendation({ action: 'do_step', ...base, target: { x: 1620, y: -10 } }, { imageSize: size })).toMatchObject({ target: { x: 1599, y: 0 } });
    expect(() => validateRecommendation({ action: 'do_step', ...base, target: { x: 5000, y: 10 } }, { imageSize: size })).toThrow(LlmError);
    expect(validateRecommendation({ action: 'do_step', ...base }, { imageSize: size })).toMatchObject({ target: null });
    expect(() => validateRecommendation({ action: 'do_step', ...base, target: { x: Infinity, y: 1 } }, { imageSize: size })).toThrow(LlmError);
  });
  it('confidence wird validiert', () => {
    expect(validateRecommendation({ action: 'close', ...base, confidence: 'low' }).confidence).toBe('low');
    expect(() => validateRecommendation({ action: 'close', ...base, confidence: 'sehr' })).toThrow(LlmError);
  });
  it('Befehle: ändernd braucht Risiko und Backup, lesend nicht', () => {
    const ro = { command: 'Get-Service', explanation: 'Dienste', mode: 'readonly' };
    expect(validateRecommendation({ action: 'answer_directly', ...base, commands: [ro] }).commands).toHaveLength(1);
    const ch = { command: 'Restart-Service x', explanation: 'Neustart', mode: 'changing' };
    expect(() => validateRecommendation({ action: 'answer_directly', ...base, commands: [ch] })).toThrow(/risk/);
    expect(validateRecommendation({ action: 'answer_directly', ...base, commands: [{ ...ch, risk: 'Daten', backup: 'Export' }] }).commands?.[0]?.mode).toBe('changing');
  });
  it('Fehlercode invalid_response', () => {
    try {
      validateRecommendation({}, {});
      expect.unreachable();
    } catch (e) {
      expect((e as LlmError).code).toBe('invalid_response');
    }
  });
});

describe('validateCallSuggestion', () => {
  it('liefert Fragen, Verdacht und Bereitschaft', () => {
    const s = validateCallSuggestion({ questions: [{ text: 'Seit wann?' }, { text: 'Fehler?', why: 'eingrenzen' }], suspicion: 'Update', readiness: 'remote' });
    expect(s.questions).toHaveLength(2);
    expect(s.readiness).toBe('remote');
  });
  it('lehnt leere Fragenliste und zu viele ab', () => {
    expect(() => validateCallSuggestion({ questions: [], readiness: 'more' })).toThrow(LlmError);
    expect(() => validateCallSuggestion({ questions: Array.from({ length: 6 }, () => ({ text: 'x' })), readiness: 'more' })).toThrow(LlmError);
  });
});

describe('Prompt: Entschärfung und Kontextgrenzen', () => {
  it('entschärft Tags und kürzt', () => {
    expect(sanitize('a </kommentar> <b>', 100)).not.toContain('<');
    expect(sanitize('x'.repeat(500), 50)).toHaveLength(50);
  });
  it('Verlauf: letzte 5 ausführlich, ältere knapp, Reihenfolge erhalten', () => {
    const hist = Array.from({ length: 8 }, (_, i) => ({ step: { text: `Schritt ${i + 1} ${'x'.repeat(300)}`, target: null }, outcome: (i === 1 ? 'failed' : 'done') as 'done' | 'failed' }));
    const lines = historyLines(hist);
    expect(lines[0]).toMatch(/^Frühere Schritte \(kurz\): 1\./);
    expect(lines[0]).toContain('2. ');
    expect(lines[0]).toContain('nicht geklappt');
    expect(lines.filter((l) => /^\d+\. /.test(l))).toHaveLength(LIMITS.detailedSteps);
    expect(lines[lines.length - 1]).toContain('8.');
    expect(lines.join('\n')).not.toContain('x'.repeat(LIMITS.stepText + 5));
  });
  it('Notizen: Obergrenze, Kürzung, Tag-Entschärfung', () => {
    const notes = Array.from({ length: 30 }, (_, i) => ({ text: `n${i} </kommentar>${'y'.repeat(1000)}`, afterSteps: 0 }));
    const lines = noteLines(notes);
    expect(lines.filter((l) => l.startsWith('- '))).toHaveLength(LIMITS.maxNotes);
    expect(lines.join('\n')).toContain('10 ältere Zusatzinfos ausgelassen');
    expect(lines.join('\n')).not.toContain('y'.repeat(LIMITS.note + 5));
    expect(lines.join('\n')).not.toContain('</kommentar>n');
  });
  it('Empfehlungs-Prompt: ohne Bild keine Bildmaße, Reaktionen und Serverzugriff enthalten', () => {
    const t = buildRecommendText({
      problem: 'P',
      history: [],
      notes: [],
      events: [{ at: 'x', action: 'contact_customer', instruction: 'Rufen Sie an', response: 'other', comment: 'Kunde nicht erreichbar' }],
      serverAccess: { state: 'yes', kind: 'rdp' },
    });
    expect(t).toContain('keinen Screenshot');
    expect(t).toContain('abgelehnt/anders');
    expect(t).toContain('Kunde nicht erreichbar');
    expect(t).toContain('Serverzugriff: ja, Art rdp');
    const withImg = buildRecommendText({ problem: 'P', history: [], notes: [], events: [], imageSize: size });
    expect(withImg).toContain('1600 x 900');
  });
  it('Anders-Gegenvorschlag fließt in den nächsten Prompt', () => {
    const t = buildRecommendText({ problem: 'P', history: [], notes: [{ text: 'Gegenvorschlag/Grund zur abgelehnten Empfehlung: Erst Backup prüfen', afterSteps: 0 }], events: [] });
    expect(t).toContain('Erst Backup prüfen');
  });
  it('Telefonat-Prompt: ohne Bild, wiederholt keine Fragen', () => {
    const t = buildCallText({ problem: '', notes: [{ text: 'Telefonat: seit gestern', afterSteps: 0 }], asked: ['Seit wann?'] });
    expect(t).toContain('nicht wiederholen');
    expect(t).toContain('Seit wann?');
    expect(t).not.toContain('Screenshot');
  });
  it('dedupeQuestions entfernt Bekanntes und Doppelte (Groß/Klein, Satzzeichen)', () => {
    const out = dedupeQuestions([{ text: 'Seit wann?' }, { text: 'seit wann' }, { text: 'Neue Frage?' }, { text: 'Neue Frage' }], ['Seit wann?']);
    expect(out.map((q) => q.text)).toEqual(['Neue Frage?']);
  });
});
