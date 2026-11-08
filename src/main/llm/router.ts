import type { LlmLogEntry, ModelTier, Routing, TaskKind, TierModels } from '../../shared/types';
import { escalateTier, tierRank } from './tiers';
import { LlmError, type LlmResult } from './types';

export const DEFAULT_ROUTING: Routing = { triage: 'small', step: 'medium', summary: 'small', call: 'small' };
export const DEFAULT_FAILED_THRESHOLD = 2;
/** Ab dieser Verlaufslänge gilt ein wiedergeöffneter Fall als komplex. */
export const COMPLEX_HISTORY_MIN = 6;

const TASK_LABEL: Record<TaskKind, string> = { triage: 'Triage', step: 'Schritt-Anweisung', summary: 'Zusammenfassung', call: 'Telefonat' };

export interface RouteContext {
  routing: Routing;
  models: TierModels;
  /** "Hat nicht geklappt" in Folge */
  failedStreak: number;
  failedThreshold: number;
  reopenCount: number;
  historyLen: number;
  /** Nur gesetzt, wenn "zur Basisstufe zurückkehren" ausgeschaltet ist. */
  sticky?: ModelTier | null;
  /** Kostenlimit: darf auf diese Stufe eskaliert werden? Standard: ja. */
  canAfford?: (tier: ModelTier) => boolean;
}

export interface Choice {
  tier: ModelTier;
  /** Begründung als Text, z. B. "Schritt-Anweisung (2x nicht geklappt)" */
  reason: string;
  escalated: boolean;
}

/** Wählt die Startstufe einer Aufgabe: Basisstufe, ggf. regelbasiert eskaliert. */
export function chooseTier(task: TaskKind, ctx: RouteContext): Choice {
  let base = ctx.routing[task];
  if (ctx.sticky && tierRank(ctx.sticky) > tierRank(base)) base = ctx.sticky;
  let why = '';
  if (task === 'triage' || task === 'step') {
    if (ctx.failedStreak >= Math.max(1, ctx.failedThreshold)) why = `${ctx.failedStreak}x nicht geklappt`;
    else if (ctx.reopenCount > 0 && ctx.historyLen >= COMPLEX_HISTORY_MIN) why = 'wiedergeöffnet, langer Verlauf';
  }
  if (why) {
    const up = escalateTier(base, ctx.models);
    if (up !== base && (ctx.canAfford?.(up) ?? true)) return { tier: up, reason: `${TASK_LABEL[task]} (${why})`, escalated: true };
  }
  return { tier: base, reason: TASK_LABEL[task], escalated: false };
}

export interface RouteHooks {
  /** Vor jedem Modellaufruf (Stufe und Begründung). */
  onCall?(tier: ModelTier, reason: string): void;
  /** Bevor auf die nächste Stufe gewechselt wird. */
  onEscalate?(reason: string): void;
}

export interface Routed<T> {
  value: T;
  entry: Omit<LlmLogEntry, 'at'>;
}

/**
 * Führt einen Aufruf auf der gewählten Stufe aus. Höchstens eine Eskalation pro Anfrage: bei ungültiger Antwort
 * (nach dem Retry des Adapters) oder unsicherer Antwort (confidence low) wird einmal auf die nächste Stufe gewechselt.
 * Eine bereits regelbasierte Eskalation zählt als diese eine Eskalation.
 */
export async function routeCall<T>(
  task: TaskKind,
  ctx: RouteContext,
  call: (tier: ModelTier) => Promise<LlmResult<T>>,
  isUncertain: (v: T) => boolean = () => false,
  hooks: RouteHooks = {},
): Promise<Routed<T>> {
  const choice = chooseTier(task, ctx);
  const usedUp = { in: 0, out: 0, cr: 0, cc: 0 };
  const finish = (r: LlmResult<T>, tier: ModelTier, reason: string, escalated: boolean): Routed<T> => {
    usedUp.in += r.usage.inputTokens;
    usedUp.out += r.usage.outputTokens;
    usedUp.cr += r.usage.cacheReadTokens ?? 0;
    usedUp.cc += r.usage.cacheCreationTokens ?? 0;
    return {
      value: r.value,
      entry: { task, tier, model: r.model, reason, escalated, inputTokens: usedUp.in, outputTokens: usedUp.out, imageBytes: r.imageBytes, cacheReadTokens: usedUp.cr, cacheCreationTokens: usedUp.cc },
    };
  };
  const canEscalate = !choice.escalated;
  const rawNext = escalateTier(choice.tier, ctx.models);
  const next = rawNext !== choice.tier && !(ctx.canAfford?.(rawNext) ?? true) ? choice.tier : rawNext;
  let first: LlmResult<T>;
  try {
    hooks.onCall?.(choice.tier, choice.reason);
    first = await call(choice.tier);
  } catch (e) {
    if (canEscalate && next !== choice.tier && e instanceof LlmError && e.code === 'invalid_response') {
      hooks.onEscalate?.('ungültige Antwort');
      hooks.onCall?.(next, 'Eskalation');
      const second = await call(next);
      return finish(second, next, `${TASK_LABEL[task]} (Eskalation: ungültige Antwort)`, true);
    }
    throw e;
  }
  if (canEscalate && next !== choice.tier && isUncertain(first.value)) {
    usedUp.in += first.usage.inputTokens;
    usedUp.out += first.usage.outputTokens;
    usedUp.cr += first.usage.cacheReadTokens ?? 0;
    usedUp.cc += first.usage.cacheCreationTokens ?? 0;
    try {
      hooks.onEscalate?.('Modell unsicher');
      hooks.onCall?.(next, 'Eskalation');
      const second = await call(next);
      return finish(second, next, `${TASK_LABEL[task]} (Eskalation: Modell unsicher)`, true);
    } catch {
      // Eskalation gescheitert: die unsichere, aber gültige erste Antwort behalten.
      usedUp.in -= first.usage.inputTokens;
      usedUp.out -= first.usage.outputTokens;
      usedUp.cr -= first.usage.cacheReadTokens ?? 0;
      usedUp.cc -= first.usage.cacheCreationTokens ?? 0;
    }
  }
  return finish(first, choice.tier, choice.reason, choice.escalated);
}
