import type { ErrorCode, HistoryEntry, ImageSize, ModelTier, RecEvent, Recommendation, ServerAccess, SessionNote, TierModels } from '../../shared/types';
import type { CallSuggestion } from './schema';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** Ergebnis eines Aufrufs inklusive Verbrauch (aus den Usage-Angaben der API) und tatsächlich genutztem Modell. */
export interface LlmResult<T> {
  value: T;
  usage: LlmUsage;
  model: string;
  /** Bytes des mitgesendeten Bildes, 0 ohne Bild. */
  imageBytes: number;
}

/** Fortschritt eines Aufrufs für die sichtbare KI-Aktivität (enthält keine Inhalte). */
export type CallEvent = { type: 'validating' } | { type: 'retry'; attempt: number; of: number; reason: string };

export interface CallOptions {
  tier: ModelTier;
  onEvent?: (e: CallEvent) => void;
}

/** Anfrage für eine Hauptempfehlung. Ohne Screenshot = Triage/Einschätzung, mit Screenshot = Schritt-Modus. */
export interface RecommendRequest {
  problem: string;
  history: HistoryEntry[];
  notes: SessionNote[];
  /** Bisherige Reaktionen des Supporters auf Empfehlungen (Gemacht, Anders, Später). */
  events: RecEvent[];
  serverAccess?: ServerAccess | null;
  screenshotJpegBase64?: string;
  imageSize?: ImageSize;
  /** Supporter will zuerst nachfragen: bevorzugt ask_customer. */
  prefer?: 'question';
  /** Fall wurde pausiert/wiederaufgenommen; der Bildschirmzustand ist unbekannt. */
  resumed?: boolean;
}

export interface CallRequest {
  problem: string;
  notes: SessionNote[];
  /** Bereits vorgeschlagene Fragen (nicht wiederholen). */
  asked: string[];
}

export interface SummaryRequest {
  problem: string;
  history: HistoryEntry[];
  notes: SessionNote[];
  result: 'solved' | 'unsolved';
}

/** Schnittstelle, die jeder LLM-Adapter erfüllen muss. */
export interface LlmProvider {
  readonly id: string;
  readonly name: string;
  listModels?(): Promise<string[]>;
  /** Genau eine Hauptempfehlung (Next Best Action); mit Screenshot typischerweise do_step. */
  recommend(req: RecommendRequest, opts: CallOptions): Promise<LlmResult<Recommendation>>;
  /** Telefonat-Modus: nächste Fragen, ohne Bild; onPartial liefert bereits eintreffende Fragen (Streaming). */
  callQuestions(req: CallRequest, opts: CallOptions, onPartial?: (questions: string[]) => void): Promise<LlmResult<CallSuggestion>>;
  /** Kurze Zusammenfassung für die Zeiterfassung. */
  summarize(req: SummaryRequest, opts: CallOptions): Promise<LlmResult<string>>;
}

/** Was ein Adapter zur Laufzeit von der App braucht (Key bleibt im Main-Prozess). */
export interface ProviderContext {
  getApiKey(): string | undefined;
  getModel(tier: ModelTier): string;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  requiresKey: boolean;
  /** Standardzuordnung der Stufen; fehlende Stufen fallen auf die nächstgrößere zurück. */
  tiers: Partial<TierModels>;
  knownModels: string[];
  create(ctx: ProviderContext): LlmProvider;
}

/** Fehler mit klarer Kategorie für die UI. Die Nachricht enthält nie Schlüssel. */
export class LlmError extends Error {
  readonly code: ErrorCode;
  /** Bei rate_limit: empfohlene Wartezeit. */
  retryAfterSec?: number;
  constructor(code: ErrorCode, message: string, retryAfterSec?: number) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    if (retryAfterSec !== undefined) this.retryAfterSec = retryAfterSec;
  }
}
