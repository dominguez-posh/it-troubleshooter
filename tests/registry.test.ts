import { describe, expect, it } from 'vitest';
import { createDefaultRegistry, ProviderRegistry, type ProviderDefinition } from '../src/main/llm';
import { createMockProvider } from '../src/main/llm/mock';

const fake = (id: string): ProviderDefinition => ({
  id,
  name: id,
  requiresKey: false,
  defaultModel: 'm',
  knownModels: ['m'],
  create: () => createMockProvider(),
});

describe('ProviderRegistry', () => {
  it('registriert und findet Provider', () => {
    const r = new ProviderRegistry().register(fake('openai')).register(fake('gemini'));
    expect(r.has('openai')).toBe(true);
    expect(r.get('gemini').id).toBe('gemini');
    expect(r.list().map((d) => d.id)).toEqual(['openai', 'gemini']);
  });
  it('lehnt doppelte und ungültige IDs ab', () => {
    const r = new ProviderRegistry().register(fake('a'));
    expect(() => r.register(fake('a'))).toThrow();
    expect(() => r.register(fake('Bad Id'))).toThrow();
  });
  it('wirft bei unbekanntem Provider', () => {
    expect(() => new ProviderRegistry().get('x')).toThrow();
  });
  it('Standard-Registry enthält Anthropic (Standardmodell claude-sonnet-5-5) und Mock', () => {
    const r = createDefaultRegistry();
    expect(r.get('anthropic').defaultModel).toBe('claude-sonnet-5-5');
    expect(r.get('anthropic').requiresKey).toBe(true);
    expect(r.get('mock').requiresKey).toBe(false);
  });
});

describe('Mock-Provider', () => {
  it('liefert deterministische Schritte relativ zur Bildgröße und endet ohne Ziel', async () => {
    const p = createMockProvider();
    const imageSize = { width: 1000, height: 500 };
    const base = { problem: 'p', screenshotJpegBase64: '', imageSize };
    const s1 = await p.nextStep({ ...base, history: [] });
    expect(s1.target!.x).toBeLessThan(1000);
    const hist = [1, 2, 3].map(() => ({ step: s1, outcome: 'done' as const }));
    const last = await p.nextStep({ ...base, history: hist });
    expect(last.target).toBeNull();
  });
});
