import { describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider, mapAnthropicError, type AnthropicLike } from '../src/main/llm/anthropic';
import { createDefaultRegistry, ProviderRegistry, type ProviderDefinition } from '../src/main/llm';
import { createMockProvider } from '../src/main/llm/mock';
import { chooseTier, DEFAULT_ROUTING, routeCall, type RouteContext } from '../src/main/llm/router';
import { escalateTier, resolveModels, validateModelName } from '../src/main/llm/tiers';
import { LlmError } from '../src/main/llm/types';

const req = { problem: 'p', history: [], notes: [], events: [], screenshotJpegBase64: 'AAAA', imageSize: { width: 1000, height: 500 } };
const rec = { action: 'do_step', instruction: 'Klick', reason: 'weil', target: { x: 5, y: 6 } };
const toolUse = (input: unknown) => ({ stop_reason: 'tool_use', model: 'claude-sonnet-5-5', usage: { input_tokens: 100, output_tokens: 20 }, content: [{ type: 'tool_use', id: 't', name: 'recommend', input }] });

function client(...responses: unknown[]): { c: AnthropicLike; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn();
  for (const r of responses) {
    if (r && typeof r === 'object' && 'status' in r && !('content' in r)) create.mockRejectedValueOnce(r);
    else create.mockResolvedValueOnce(r);
  }
  return { c: { messages: { create }, models: { list: async () => [] } } as unknown as AnthropicLike, create };
}
const ctx = { getApiKey: () => 'k', getModel: (t: string) => `m-${t}` };

describe('Anthropic-Adapter', () => {
  it('sendet genau ein Bild, nutzt Stufenmodell, liefert validierte Empfehlung mit Usage', async () => {
    const { c, create } = client(toolUse(rec));
    const p = createAnthropicProvider(ctx, () => c);
    const r = await p.recommend(req, { tier: 'medium' });
    expect(r.value).toMatchObject({ action: 'do_step', target: { x: 5, y: 6 } });
    expect(r.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    const params = create.mock.calls[0]![0];
    expect(params.model).toBe('m-medium');
    expect(params.tool_choice).toEqual({ type: 'auto' });
    const imgs = params.messages[0].content.filter((b: { type: string }) => b.type === 'image');
    expect(imgs).toHaveLength(1);
  });
  it('Triage ohne Bild: kein Bildblock im Request', async () => {
    const { c, create } = client(toolUse({ action: 'ask_customer', instruction: 'Fragen', reason: 'r' }));
    const p = createAnthropicProvider(ctx, () => c);
    await p.recommend({ problem: 'p', history: [], notes: [], events: [] }, { tier: 'small' });
    const content = create.mock.calls[0]![0].messages[0].content as Array<{ type: string }>;
    expect(content.some((b) => b.type === 'image')).toBe(false);
    expect(create.mock.calls[0]![0].model).toBe('m-small');
  });
  it('kein Key: no_key ohne API-Aufruf', async () => {
    const { c, create } = client();
    const p = createAnthropicProvider({ ...ctx, getApiKey: () => undefined }, () => c);
    await expect(p.recommend(req, { tier: 'small' })).rejects.toMatchObject({ code: 'no_key' });
    expect(create).not.toHaveBeenCalled();
  });
  it('ungültige Antwort -> ein Retry mit Ereignis, danach Fehler', async () => {
    const events: string[] = [];
    const { c, create } = client({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hm' }], usage: {} }, toolUse(rec));
    const p = createAnthropicProvider(ctx, () => c);
    const r = await p.recommend(req, { tier: 'medium', onEvent: (e) => events.push(e.type) });
    expect(r.value.action).toBe('do_step');
    expect(create).toHaveBeenCalledTimes(2);
    expect(events).toContain('retry');
    const bad = toolUse({ nope: true });
    const { c: c2 } = client(bad, bad);
    await expect(createAnthropicProvider(ctx, () => c2).recommend(req, { tier: 'medium' })).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('API-Fehler werden kategorisiert, ohne Key in der Meldung, ohne Retry', async () => {
    const { c, create } = client({ status: 401 });
    const err = await createAnthropicProvider({ ...ctx, getApiKey: () => 'sk-secret' }, () => c).recommend(req, { tier: 'small' }).catch((e: unknown) => e);
    expect((err as LlmError).code).toBe('auth');
    expect((err as LlmError).message).not.toContain('sk-secret');
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('Telefonat: nutzt Streaming-Teilergebnisse, falls vorhanden', async () => {
    const seen: string[][] = [];
    const final = { stop_reason: 'tool_use', model: 'm', usage: {}, content: [{ type: 'tool_use', id: 't', name: 'call_questions', input: { questions: [{ text: 'Seit wann?' }], readiness: 'more' } }] };
    const stream = vi.fn(() => ({
      on: (_e: string, cb: (d: string, s: unknown) => void) => cb('', { questions: [{ text: 'Seit wann?' }] }),
      finalMessage: async () => final,
    }));
    const c = { messages: { create: vi.fn(), stream }, models: { list: async () => [] } } as unknown as AnthropicLike;
    const r = await createAnthropicProvider(ctx, () => c).callQuestions({ problem: '', notes: [], asked: [] }, { tier: 'small' }, (q) => seen.push(q));
    expect(seen[0]).toEqual(['Seit wann?']);
    expect(r.value.questions[0]!.text).toBe('Seit wann?');
  });
});

describe('mapAnthropicError', () => {
  it.each([[401, 'auth'], [403, 'auth'], [429, 'rate_limit'], [500, 'api'], [529, 'api'], [400, 'api']])('Status %s -> %s', (status, code) => {
    expect(mapAnthropicError({ status }).code).toBe(code);
  });
  it('Rate-Limit mit Retry-After', () => {
    const e = mapAnthropicError({ status: 429, headers: { get: () => '42' } });
    expect(e.retryAfterSec).toBe(42);
    expect(mapAnthropicError({ status: 429 }).retryAfterSec).toBe(30);
  });
  it('Netzwerk und unbekannt', () => {
    expect(mapAnthropicError(new Error('fetch failed ECONNREFUSED')).code).toBe('network');
    expect(mapAnthropicError('boom').code).toBe('api');
  });
});

const fake = (id: string): ProviderDefinition => ({ id, name: id, requiresKey: false, tiers: { medium: 'm' }, knownModels: ['m'], create: () => createMockProvider() });

describe('ProviderRegistry', () => {
  it('registriert, findet, lehnt doppelte/ungültige IDs ab', () => {
    const r = new ProviderRegistry().register(fake('openai')).register(fake('gemini'));
    expect(r.list().map((d) => d.id)).toEqual(['openai', 'gemini']);
    expect(() => r.register(fake('openai'))).toThrow();
    expect(() => r.register(fake('Bad Id'))).toThrow();
    expect(() => r.get('x')).toThrow();
  });
  it('Standard-Registry: Anthropic (haiku/sonnet/opus) und Mock', () => {
    const r = createDefaultRegistry();
    expect(r.get('anthropic').tiers).toEqual({ small: 'claude-haiku-5-5', medium: 'claude-sonnet-5-5', large: 'claude-opus-5-5' });
    expect(r.get('anthropic').requiresKey).toBe(true);
    expect(r.get('mock').requiresKey).toBe(false);
  });
});

describe('Mock-Provider deckt alle Aktionen deterministisch ab', () => {
  const p = createMockProvider();
  const mk = (problem: string, extra: object = {}) => ({ problem, history: [], notes: [], events: [], ...extra });
  const act = async (problem: string, extra: object = {}) => (await p.recommend(mk(problem, extra), { tier: 'small' })).value.action;
  it('Triage-Stichworte', async () => {
    expect(await act('Passwort vergessen')).toBe('answer_directly');
    expect(await act('bitte Rückruf')).toBe('contact_customer');
    expect(await act('muss eskalieren')).toBe('escalate');
    expect(await act('bitte warten')).toBe('wait_check');
    expect(await act('alles langsam')).toBe('ask_customer');
    expect(await act('Drucker')).toBe('start_remote');
    expect(await act('Drucker', { prefer: 'question' })).toBe('ask_customer');
    expect(await act('Server hängt')).toBe('check_server_access');
    expect(await act('Server hängt', { serverAccess: { state: 'no' } })).toBe('contact_customer');
    expect(await act('Server hängt', { serverAccess: { state: 'yes' } })).toBe('answer_directly');
  });
  it('Schritt-Modus: do_step, close am Ende, answer_directly bei "neustart", low confidence nur unterhalb "large"', async () => {
    const image = { screenshotJpegBase64: 'A', imageSize: { width: 100, height: 100 } };
    const first = (await p.recommend(mk('x', image), { tier: 'medium' })).value;
    expect(first.action).toBe('do_step');
    const hist = (n: number) => Array.from({ length: n }, () => ({ step: { text: 's', target: null }, outcome: 'done' as const }));
    expect((await p.recommend(mk('x', { ...image, history: hist(3) }), { tier: 'medium' })).value.action).toBe('close');
    expect((await p.recommend(mk('neustart', { ...image, history: hist(2) }), { tier: 'medium' })).value.action).toBe('answer_directly');
    const u = (tier: 'medium' | 'large') => p.recommend(mk('unsicher', image), { tier }).then((r) => (r.value.action === 'do_step' ? r.value.confidence : null));
    expect(await u('medium')).toBe('low');
    expect(await u('large')).toBe('high');
  });
  it('Telefonat-Fragen deterministisch, ohne Wiederholung', async () => {
    const a = (await p.callQuestions({ problem: '', notes: [], asked: [] }, { tier: 'small' })).value;
    const b = (await p.callQuestions({ problem: '', notes: [], asked: a.questions.map((q) => q.text) }, { tier: 'small' })).value;
    expect(b.questions.every((q) => !a.questions.some((x) => x.text === q.text))).toBe(true);
  });
});

describe('Modellstufen: Zuordnung und Auflösung', () => {
  it('fehlende Stufe fällt auf die nächstgrößere zurück', () => {
    expect(resolveModels({ medium: 'M', large: 'L' })).toEqual({ small: 'M', medium: 'M', large: 'L' });
    expect(resolveModels({ small: 'S', medium: 'M' })).toEqual({ small: 'S', medium: 'M', large: 'M' });
    expect(resolveModels({ medium: 'M' }, { small: 'X' })).toEqual({ small: 'X', medium: 'M', large: 'M' });
    expect(() => resolveModels({})).toThrow();
  });
  it('Modellnamen werden validiert', () => {
    expect(validateModelName(' claude-haiku-5-5 ')).toBe('claude-haiku-5-5');
    expect(() => validateModelName('a b')).toThrow();
    expect(() => validateModelName('$(rm -rf)')).toThrow();
    expect(() => validateModelName('')).toThrow();
  });
  it('Eskalation nie über die höchste Stufe, überspringt gleiche Modelle', () => {
    const m = { small: 'S', medium: 'M', large: 'L' };
    expect(escalateTier('small', m)).toBe('medium');
    expect(escalateTier('large', m)).toBe('large');
    expect(escalateTier('small', { small: 'S', medium: 'S', large: 'L' })).toBe('large');
    expect(escalateTier('medium', { small: 'S', medium: 'M', large: 'M' })).toBe('medium');
  });
});

const rctx = (over: Partial<RouteContext> = {}): RouteContext => ({
  routing: DEFAULT_ROUTING,
  models: { small: 'S', medium: 'M', large: 'L' },
  failedStreak: 0,
  failedThreshold: 2,
  reopenCount: 0,
  historyLen: 0,
  ...over,
});
const ok = <T>(value: T) => ({ value, usage: { inputTokens: 10, outputTokens: 5 }, model: 'x', imageBytes: 0 });

describe('Routing und Eskalation', () => {
  it('Routing-Tabelle je Aufgabe', () => {
    expect(chooseTier('triage', rctx())).toMatchObject({ tier: 'small', reason: 'Triage', escalated: false });
    expect(chooseTier('step', rctx())).toMatchObject({ tier: 'medium' });
    expect(chooseTier('summary', rctx())).toMatchObject({ tier: 'small' });
    expect(chooseTier('call', rctx())).toMatchObject({ tier: 'small' });
  });
  it('Schwelle: erst ab 2x nicht geklappt eskalieren, mit Begründung', () => {
    expect(chooseTier('step', rctx({ failedStreak: 1 })).tier).toBe('medium');
    expect(chooseTier('step', rctx({ failedStreak: 2 }))).toMatchObject({ tier: 'large', escalated: true, reason: 'Schritt-Anweisung (2x nicht geklappt)' });
    expect(chooseTier('step', rctx({ failedStreak: 3, failedThreshold: 3 })).tier).toBe('large');
    expect(chooseTier('summary', rctx({ failedStreak: 5 })).tier).toBe('small');
  });
  it('wiedergeöffnet mit langem Verlauf eskaliert', () => {
    expect(chooseTier('step', rctx({ reopenCount: 1, historyLen: 6 })).tier).toBe('large');
    expect(chooseTier('step', rctx({ reopenCount: 1, historyLen: 3 })).tier).toBe('medium');
  });
  it('Rückfall auf Basisstufe; Sticky nur wenn eingeschaltet', () => {
    expect(chooseTier('step', rctx({ failedStreak: 0, sticky: null })).tier).toBe('medium');
    expect(chooseTier('step', rctx({ failedStreak: 0, sticky: 'large' })).tier).toBe('large');
  });
  it('Eskalation bei confidence low: genau eine, Usage beider Aufrufe summiert', async () => {
    const calls: string[] = [];
    const r = await routeCall('step', rctx(), async (tier) => {
      calls.push(tier);
      return ok({ confidence: tier === 'medium' ? 'low' : 'high' });
    }, (v) => v.confidence === 'low');
    expect(calls).toEqual(['medium', 'large']);
    expect(r.entry).toMatchObject({ tier: 'large', escalated: true, inputTokens: 20, outputTokens: 10 });
    expect(r.entry.reason).toContain('unsicher');
  });
  it('höchste Stufe: keine weitere Eskalation', async () => {
    const calls: string[] = [];
    await routeCall('step', rctx({ routing: { ...DEFAULT_ROUTING, step: 'large' } }), async (t) => (calls.push(t), ok({ c: 'low' })), () => true);
    expect(calls).toEqual(['large']);
  });
  it('bereits regelbasiert eskaliert: kein zweites Mal', async () => {
    const calls: string[] = [];
    await routeCall('step', rctx({ failedStreak: 2, routing: { ...DEFAULT_ROUTING, step: 'small' } }), async (t) => (calls.push(t), ok({ c: 'low' })), () => true);
    expect(calls).toEqual(['medium']);
  });
  it('ungültige Antwort der kleinen Stufe -> einmal höher; zweiter Fehler wird geworfen', async () => {
    const calls: string[] = [];
    const bad = new LlmError('invalid_response', 'x');
    const r = await routeCall('triage', rctx(), async (t) => {
      calls.push(t);
      if (t === 'small') throw bad;
      return ok('fine');
    });
    expect(calls).toEqual(['small', 'medium']);
    expect(r.entry.reason).toContain('ungültige Antwort');
    await expect(routeCall('triage', rctx(), async () => { throw bad; })).rejects.toBe(bad);
  });
  it('Netz-/Key-Fehler lösen keine Eskalation aus', async () => {
    const calls: string[] = [];
    await expect(routeCall('triage', rctx(), async (t) => { calls.push(t); throw new LlmError('network', 'n'); })).rejects.toMatchObject({ code: 'network' });
    expect(calls).toEqual(['small']);
  });
  it('Kostenlimit verhindert Eskalation (canAfford)', async () => {
    expect(chooseTier('step', rctx({ failedStreak: 2, canAfford: (t) => t !== 'large' })).tier).toBe('medium');
    const calls: string[] = [];
    await routeCall('step', rctx({ canAfford: (t) => t !== 'large' }), async (t) => (calls.push(t), ok({ c: 'low' })), () => true);
    expect(calls).toEqual(['medium']);
  });
});
