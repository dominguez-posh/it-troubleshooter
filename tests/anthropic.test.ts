import { describe, expect, it, vi } from 'vitest';
import { createAnthropicProvider, mapAnthropicError, type AnthropicLike } from '../src/main/llm/anthropic';
import { LlmError } from '../src/main/llm/types';

const req = { problem: 'p', history: [], screenshotJpegBase64: 'AAAA', imageSize: { width: 1000, height: 500 } };

function clientReturning(...responses: unknown[]): { client: AnthropicLike; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn();
  for (const r of responses) {
    if (r instanceof Error || (r && typeof r === 'object' && 'status' in r && !('content' in r))) create.mockRejectedValueOnce(r);
    else create.mockResolvedValueOnce(r);
  }
  const client = { messages: { create }, models: { list: async () => [] } } as unknown as AnthropicLike;
  return { client, create };
}

const toolUse = (input: unknown) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'next_step', input }] });

describe('Anthropic-Adapter', () => {
  it('sendet Bild + Text, nutzt das konfigurierte Modell und liefert den validierten Schritt', async () => {
    const { client, create } = clientReturning(toolUse({ text: 'Klick', target: { x: 5, y: 6 } }));
    const p = createAnthropicProvider({ getApiKey: () => 'k', getModel: () => 'claude-sonnet-5-5' }, () => client);
    const step = await p.nextStep(req);
    expect(step).toEqual({ text: 'Klick', target: { x: 5, y: 6 } });
    const params = create.mock.calls[0]![0];
    expect(params.model).toBe('claude-sonnet-5-5');
    expect(params.tool_choice).toEqual({ type: 'auto' });
    expect(params.messages[0].content[0].type).toBe('image');
    expect(params.messages[0].content[0].source.media_type).toBe('image/jpeg');
    expect(params.tools[0].name).toBe('next_step');
  });
  it('wirft no_key ohne Key und ruft die API nicht auf', async () => {
    const { client, create } = clientReturning();
    const p = createAnthropicProvider({ getApiKey: () => undefined, getModel: () => 'm' }, () => client);
    await expect(p.nextStep(req)).rejects.toMatchObject({ code: 'no_key' });
    expect(create).not.toHaveBeenCalled();
  });
  it('wiederholt einmal bei ungültiger Modellantwort', async () => {
    const { client, create } = clientReturning({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'hm' }] }, toolUse({ text: 'ok' }));
    const p = createAnthropicProvider({ getApiKey: () => 'k', getModel: () => 'm' }, () => client);
    expect((await p.nextStep(req)).text).toBe('ok');
    expect(create).toHaveBeenCalledTimes(2);
  });
  it('gibt nach zwei ungültigen Antworten auf', async () => {
    const bad = toolUse({ nope: true });
    const { client } = clientReturning(bad, bad);
    const p = createAnthropicProvider({ getApiKey: () => 'k', getModel: () => 'm' }, () => client);
    await expect(p.nextStep(req)).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('mappt API-Fehler auf Kategorien und wiederholt dabei nicht', async () => {
    const { client, create } = clientReturning({ status: 401 });
    const p = createAnthropicProvider({ getApiKey: () => 'sk-secret', getModel: () => 'm' }, () => client);
    const err = await p.nextStep(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).code).toBe('auth');
    expect((err as LlmError).message).not.toContain('sk-secret');
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('mapAnthropicError', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [500, 'api'],
    [529, 'api'],
    [400, 'api'],
  ])('Status %s -> %s', (status, code) => {
    expect(mapAnthropicError({ status }).code).toBe(code);
  });
  it('erkennt Netzwerkfehler', () => {
    expect(mapAnthropicError(new Error('fetch failed ECONNREFUSED')).code).toBe('network');
  });
  it('unbekannt -> api', () => {
    expect(mapAnthropicError('boom').code).toBe('api');
  });
});
