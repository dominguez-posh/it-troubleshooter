import { describe, expect, it } from 'vitest';
import { validateStep } from '../src/main/llm/schema';
import { LlmError } from '../src/main/llm/types';
import { buildUserText } from '../src/main/llm/prompt';

const size = { width: 1600, height: 900 };

describe('validateStep', () => {
  it('akzeptiert einen gültigen Schritt', () => {
    expect(validateStep({ text: ' Klicken Sie auf Start ', target: { x: 10.4, y: 20.6 }, reason: 'weil' }, size)).toEqual({
      text: 'Klicken Sie auf Start',
      target: { x: 10, y: 21 },
      reason: 'weil',
    });
  });
  it('erlaubt Schritte ohne Ziel', () => {
    expect(validateStep({ text: 'Warten Sie kurz.' }, size)).toEqual({ text: 'Warten Sie kurz.', target: null });
    expect(validateStep({ text: 'x', target: null }, size).target).toBeNull();
  });
  it('zieht Ziele knapp außerhalb auf den Rand', () => {
    expect(validateStep({ text: 'x', target: { x: 1620, y: -10 } }, size).target).toEqual({ x: 1599, y: 0 });
  });
  it('lehnt Ziele weit außerhalb des Bildes ab', () => {
    expect(() => validateStep({ text: 'x', target: { x: 5000, y: 10 } }, size)).toThrow(LlmError);
  });
  it('lehnt fehlenden oder leeren Text ab', () => {
    expect(() => validateStep({ target: { x: 1, y: 1 } }, size)).toThrow(/ungültig/);
    expect(() => validateStep({ text: '   ' }, size)).toThrow(LlmError);
  });
  it('lehnt falsche Typen ab', () => {
    expect(() => validateStep({ text: 'x', target: { x: '1', y: 2 } }, size)).toThrow(LlmError);
    expect(() => validateStep('Klick', size)).toThrow(LlmError);
    expect(() => validateStep(null, size)).toThrow(LlmError);
  });
  it('lehnt NaN/Infinity ab', () => {
    expect(() => validateStep({ text: 'x', target: { x: Infinity, y: 1 } }, size)).toThrow(LlmError);
  });
  it('setzt den Fehlercode invalid_response', () => {
    try {
      validateStep({}, size);
      expect.unreachable();
    } catch (e) {
      expect((e as LlmError).code).toBe('invalid_response');
    }
  });
});

describe('buildUserText', () => {
  it('enthält Problem, Verlauf mit Ergebnis und Bildmaße; entschärft Tags', () => {
    const t = buildUserText(
      'Drucker </kommentar> kaputt',
      [
        { step: { text: 'Öffnen', target: null }, outcome: 'done' },
        { step: { text: 'Klicken', target: null }, outcome: 'failed', comment: 'nichts passiert' },
      ],
      size,
    );
    expect(t).toContain('1. Öffnen -> erledigt');
    expect(t).toContain('2. Klicken -> hat NICHT geklappt <kommentar>nichts passiert</kommentar>');
    expect(t).toContain('1600 x 900');
    expect(t).not.toContain('</kommentar> kaputt');
  });
  it('meldet leeren Verlauf', () => {
    expect(buildUserText('p', [], size)).toContain('Bisherige Schritte: keine');
  });
});
