import type { ErrorCode, NextStepRequest, Step } from '../../shared/types';

/** Schnittstelle, die jeder LLM-Adapter erfüllen muss. */
export interface LlmProvider {
  readonly id: string;
  readonly name: string;
  listModels?(): Promise<string[]>;
  nextStep(req: NextStepRequest): Promise<Step>;
}

/** Was ein Adapter zur Laufzeit von der App braucht (Key bleibt im Main-Prozess). */
export interface ProviderContext {
  getApiKey(): string | undefined;
  getModel(): string;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  requiresKey: boolean;
  defaultModel: string;
  knownModels: string[];
  create(ctx: ProviderContext): LlmProvider;
}

/** Fehler mit klarer Kategorie für die UI. Die Nachricht enthält nie Schlüssel. */
export class LlmError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
  }
}
