import Anthropic from '@anthropic-ai/sdk';
import type { NextStepRequest, Step } from '../../shared/types';
import { buildUserText, SYSTEM_PROMPT } from './prompt';
import { STEP_TOOL_INPUT_SCHEMA, STEP_TOOL_NAME, validateStep } from './schema';
import { LlmError, type LlmProvider, type ProviderContext, type ProviderDefinition } from './types';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5-5';
export const ANTHROPIC_KNOWN_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'];

/** Minimale Sicht auf den SDK-Client, damit Tests ihn ersetzen können. */
export interface AnthropicLike {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
  models: { list(): PromiseLike<AsyncIterable<{ id: string }>> | AsyncIterable<{ id: string }> };
}

export type AnthropicClientFactory = (apiKey: string) => AnthropicLike;

const defaultFactory: AnthropicClientFactory = (apiKey) =>
  new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 }) as unknown as AnthropicLike;

/** Wandelt SDK-Fehler in kategorisierte LlmError um. Keine Schlüssel in Meldungen. */
export function mapAnthropicError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : undefined;
  if (status === 401 || status === 403) {
    return new LlmError('auth', 'Der API-Key wurde abgelehnt. Bitte in den Einstellungen prüfen.');
  }
  if (status === 429) {
    return new LlmError('rate_limit', 'Rate-Limit erreicht. Bitte einen Moment warten und erneut versuchen.');
  }
  if (status === 529 || (status !== undefined && status >= 500)) {
    return new LlmError('api', 'Der Anthropic-Dienst ist gerade überlastet oder nicht erreichbar. Bitte später erneut versuchen.');
  }
  if (status === 400 || status === 404) {
    return new LlmError('api', 'Anfrage abgelehnt (Modell oder Anfrage ungültig). Bitte das Modell in den Einstellungen prüfen.');
  }
  if (err instanceof Anthropic.APIConnectionError || (status === undefined && /ECONN|ENOTFOUND|network|fetch failed|timed? ?out/i.test(String((err as Error)?.message)))) {
    return new LlmError('network', 'Keine Verbindung zum Anthropic-Dienst. Bitte die Netzwerkverbindung prüfen.');
  }
  return new LlmError('api', 'Unerwarteter Fehler bei der Anfrage an Anthropic.');
}

export function createAnthropicProvider(ctx: ProviderContext, factory: AnthropicClientFactory = defaultFactory): LlmProvider {
  const client = (): AnthropicLike => {
    const key = ctx.getApiKey();
    if (!key) throw new LlmError('no_key', 'Für Anthropic ist noch kein API-Key hinterlegt (Einstellungen).');
    return factory(key);
  };

  const callOnce = async (req: NextStepRequest, nudge: boolean): Promise<Step> => {
    const c = client();
    let text = buildUserText(req.problem, req.history, req.imageSize);
    if (nudge) text += `\n\nRufe jetzt das Werkzeug "${STEP_TOOL_NAME}" auf.`;
    let msg: Anthropic.Message;
    try {
      msg = await c.messages.create({
        model: ctx.getModel(),
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools: [
          {
            name: STEP_TOOL_NAME,
            description: 'Liefert den einen nächsten Schritt für den Supporter, optional mit Pfeilziel im Screenshot.',
            input_schema: STEP_TOOL_INPUT_SCHEMA as unknown as Anthropic.Tool.InputSchema,
          },
        ],
        // Bei Sonnet 5.5 ist erzwungenes tool_choice nicht erlaubt; Steuerung über den Prompt.
        tool_choice: { type: 'auto' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: req.screenshotJpegBase64 } },
              { type: 'text', text },
            ],
          },
        ],
      });
    } catch (e) {
      throw mapAnthropicError(e);
    }
    if (msg.stop_reason === 'refusal') {
      throw new LlmError('invalid_response', 'Das Modell hat die Anfrage abgelehnt.');
    }
    const block = msg.content.find((b) => b.type === 'tool_use' && b.name === STEP_TOOL_NAME);
    if (!block || block.type !== 'tool_use') {
      throw new LlmError('invalid_response', 'Das Modell hat keinen Schritt geliefert.');
    }
    return validateStep(block.input, req.imageSize);
  };

  return {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    async listModels(): Promise<string[]> {
      try {
        const ids: string[] = [];
        for await (const m of await client().models.list()) ids.push(m.id);
        return ids.length ? ids : ANTHROPIC_KNOWN_MODELS;
      } catch (e) {
        throw mapAnthropicError(e);
      }
    },
    async nextStep(req: NextStepRequest): Promise<Step> {
      try {
        return await callOnce(req, false);
      } catch (e) {
        // Ein Wiederholungsversuch nur bei unbrauchbarer Modellantwort, nicht bei Netz-/Key-Fehlern.
        if (e instanceof LlmError && e.code === 'invalid_response') return callOnce(req, true);
        throw e;
      }
    },
  };
}

export const anthropicDefinition: ProviderDefinition = {
  id: 'anthropic',
  name: 'Anthropic (Claude)',
  requiresKey: true,
  defaultModel: ANTHROPIC_DEFAULT_MODEL,
  knownModels: ANTHROPIC_KNOWN_MODELS,
  create: (ctx) => createAnthropicProvider(ctx),
};
