import { TIERS, type ModelTier, type TierModels } from '../../shared/types';

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

export function validateModelName(m: unknown): string {
  if (typeof m !== 'string' || !MODEL_RE.test(m.trim())) throw new Error('Ungültiger Modellname.');
  return m.trim();
}

/** Fehlt eine Stufe, wird die nächstgrößere genommen, danach die nächstkleinere. */
const FALLBACK_ORDER: Record<ModelTier, ModelTier[]> = {
  small: ['small', 'medium', 'large'],
  medium: ['medium', 'large', 'small'],
  large: ['large', 'medium', 'small'],
};

export function resolveModels(defaults: Partial<TierModels>, overrides: Partial<TierModels> = {}): TierModels {
  const merged: Partial<TierModels> = {};
  for (const t of TIERS) {
    const o = overrides[t]?.trim();
    const d = defaults[t];
    const v = o || d;
    if (v) merged[t] = v;
  }
  const out = {} as TierModels;
  for (const t of TIERS) {
    const m = FALLBACK_ORDER[t].map((k) => merged[k]).find((x): x is string => !!x);
    if (!m) throw new Error('Für diesen Anbieter ist keine Modellstufe konfiguriert.');
    out[t] = m;
  }
  return out;
}

/** Nächstgrößere Stufe mit anderem Modell; gibt dieselbe Stufe zurück, wenn es keine gibt (nie über die höchste hinaus). */
export function escalateTier(tier: ModelTier, models: TierModels): ModelTier {
  for (let i = TIERS.indexOf(tier) + 1; i < TIERS.length; i++) {
    const t = TIERS[i]!;
    if (models[t] !== models[tier]) return t;
  }
  return tier;
}

export const tierRank = (t: ModelTier): number => TIERS.indexOf(t);
