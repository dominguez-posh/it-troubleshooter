import Anthropic from '@anthropic-ai/sdk';
import type { ModelTier } from '../../shared/types';
import {
  buildCallText,
  buildRecommendText,
  buildSummaryText,
  CALL_SYSTEM_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
} from './prompt';
import {
  CALL_TOOL_INPUT_SCHEMA,
  CALL_TOOL_NAME,
  REC_TOOL_INPUT_SCHEMA,
  REC_TOOL_NAME,
  SUMMARY_TOOL_INPUT_SCHEMA,
  SUMMARY_TOOL_NAME,
  validateCallSuggestion,
  validateRecommendation,
  validateSummary,
} from './schema';
import { LlmError, type CallOptions, type LlmProvider, type LlmResult, type ProviderContext, type ProviderDefinition } from './types';

export const ANTHROPIC_TIERS = { small: 'claude-haiku-5-5', medium: 'claude-sonnet-5-5', large: 'claude-opus-5-5' };
export const ANTHROPIC_KNOWN_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-opus-5'];

/** Minimale Sicht auf den SDK-Client, damit Tests ihn ersetzen können. */
export interface AnthropicLike {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
    stream?(params: Anthropic.MessageCreateParamsNonStreaming): {
      on(event: 'inputJson', cb: (delta: string, snapshot: unknown) => void): unknown;
      finalMessage(): Promise<Anthropic.Message>;
    };
  };
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
    const h = (err as { headers?: { get?: (k: string) => string | null } }).headers;
    const ra = Number(h?.get?.('retry-after'));
    return new LlmError('rate_limit', 'Rate-Limit erreicht. Bitte einen Moment warten und erneut versuchen.', Number.isFinite(ra) && ra > 0 ? Math.min(ra, 300) : 30);
  }
  if (status === 529 || (status !== undefined && status >= 500)) {
    return new LlmError('api', 'Der Anthropic-Dienst ist gerade überlastet oder nicht erreichbar. Bitte später erneut versuchen.');
  }
  if (status === 400 || status === 404) {
    return new LlmError('api', 'Anfrage abgelehnt (Modell oder Anfrage ungültig). Bitte die Modelle in den Einstellungen prüfen.');
  }
  if (
    err instanceof Anthropic.APIConnectionError ||
    (status === undefined && /ECONN|ENOTFOUND|network|fetch failed|timed? ?out/i.test(String((err as Error)?.message)))
  ) {
    return new LlmError('network', 'Keine Verbindung zum Anthropic-Dienst. Bitte die Netzwerkverbindung prüfen.');
  }
  return new LlmError('api', 'Unerwarteter Fehler bei der Anfrage an Anthropic.');
}

const EFFORT: Record<ModelTier, 'low' | 'medium' | 'high'> = { small: 'low', medium: 'medium', large: 'high' };

interface ToolCall<T> {
  tier: ModelTier;
  system: string;
  text: string;
  image?: { base64: string };
  toolName: string;
  toolDescription: string;
  schema: unknown;
  validate(input: unknown): T;
  onPartial?: (snapshot: unknown) => void;
  onEvent?: CallOptions['onEvent'];
}

export function createAnthropicProvider(ctx: ProviderContext, factory: AnthropicClientFactory = defaultFactory): LlmProvider {
  const client = (): AnthropicLike => {
    const key = ctx.getApiKey();
    if (!key) throw new LlmError('no_key', 'Für Anthropic ist noch kein API-Key hinterlegt (Einstellungen).');
    return factory(key);
  };

  const once = async <T>(c: ToolCall<T>, nudge: boolean): Promise<LlmResult<T>> => {
    const api = client();
    const model = ctx.getModel(c.tier);
    const content: Anthropic.ContentBlockParam[] = [];
    if (c.image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: c.image.base64 } });
    content.push({ type: 'text', text: nudge ? `${c.text}\n\nRufe jetzt das Werkzeug "${c.toolName}" auf.` : c.text });
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: 2048,
      system: c.system,
      output_config: { effort: EFFORT[c.tier] },
      tools: [{ name: c.toolName, description: c.toolDescription, input_schema: c.schema as Anthropic.Tool.InputSchema }],
      // Erzwungenes tool_choice ist bei den aktuellen Modellen nicht erlaubt; Steuerung über den Prompt.
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content }],
    };
    let msg: Anthropic.Message;
    try {
      if (c.onPartial && api.messages.stream) {
        const s = api.messages.stream(params);
        s.on('inputJson', (_d, snap) => c.onPartial?.(snap));
        msg = await s.finalMessage();
      } else {
        msg = await api.messages.create(params);
      }
    } catch (e) {
      throw mapAnthropicError(e);
    }
    const usage = {
      inputTokens: msg.usage?.input_tokens ?? 0,
      outputTokens: msg.usage?.output_tokens ?? 0,
      cacheReadTokens: msg.usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: msg.usage?.cache_creation_input_tokens ?? 0,
    };
    const imageBytes = c.image ? Math.floor((c.image.base64.length * 3) / 4) : 0;
    if (msg.stop_reason === 'refusal') throw new LlmError('invalid_response', 'Das Modell hat die Anfrage abgelehnt.');
    const block = msg.content.find((b) => b.type === 'tool_use' && b.name === c.toolName);
    if (!block || block.type !== 'tool_use') throw new LlmError('invalid_response', 'Das Modell hat keine strukturierte Antwort geliefert.');
    c.onEvent?.({ type: 'validating' });
    return { value: c.validate(block.input), usage, model: msg.model || model, imageBytes };
  };

  /** Ein Wiederholungsversuch nur bei unbrauchbarer Modellantwort, nicht bei Netz-/Key-Fehlern. */
  const run = async <T>(c: ToolCall<T>): Promise<LlmResult<T>> => {
    try {
      return await once(c, false);
    } catch (e) {
      if (e instanceof LlmError && e.code === 'invalid_response') {
        c.onEvent?.({ type: 'retry', attempt: 2, of: 2, reason: 'ungültige Antwort' });
        return once(c, true);
      }
      throw e;
    }
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
    recommend(req, opts) {
      const call: ToolCall<ReturnType<typeof validateRecommendation>> = {
        tier: opts.tier,
        onEvent: opts.onEvent,
        system: SYSTEM_PROMPT,
        text: buildRecommendText(req),
        toolName: REC_TOOL_NAME,
        toolDescription: 'Liefert die eine Hauptempfehlung (Next Best Action) für den Supporter.',
        schema: REC_TOOL_INPUT_SCHEMA,
        validate: (i) => validateRecommendation(i, req.imageSize ? { imageSize: req.imageSize } : {}),
      };
      if (req.screenshotJpegBase64) call.image = { base64: req.screenshotJpegBase64 };
      return run(call);
    },
    callQuestions(req, opts, onPartial) {
      const call: ToolCall<ReturnType<typeof validateCallSuggestion>> = {
        tier: opts.tier,
        onEvent: opts.onEvent,
        system: CALL_SYSTEM_PROMPT,
        text: buildCallText(req),
        toolName: CALL_TOOL_NAME,
        toolDescription: 'Liefert die nächsten Fragen für das Telefonat mit dem Kunden.',
        schema: CALL_TOOL_INPUT_SCHEMA,
        validate: validateCallSuggestion,
      };
      if (onPartial) {
        call.onPartial = (snap) => {
          const qs = (snap as { questions?: unknown } | null)?.questions;
          if (!Array.isArray(qs)) return;
          const texts = qs.map((q) => (q as { text?: unknown } | null)?.text).filter((t): t is string => typeof t === 'string' && t.length > 3);
          if (texts.length) onPartial(texts);
        };
      }
      return run(call);
    },
    summarize(req, opts) {
      return run({
        tier: opts.tier,
        onEvent: opts.onEvent,
        system: SUMMARY_SYSTEM_PROMPT,
        text: buildSummaryText(req),
        toolName: SUMMARY_TOOL_NAME,
        toolDescription: 'Liefert die kurze Zusammenfassung für die Zeiterfassung.',
        schema: SUMMARY_TOOL_INPUT_SCHEMA,
        validate: validateSummary,
      });
    },
  };
}

export const anthropicDefinition: ProviderDefinition = {
  id: 'anthropic',
  name: 'Anthropic (Claude)',
  requiresKey: true,
  tiers: ANTHROPIC_TIERS,
  knownModels: ANTHROPIC_KNOWN_MODELS,
  create: (ctx) => createAnthropicProvider(ctx),
};
