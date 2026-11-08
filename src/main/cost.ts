import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CostLevel, CostPeriod, CostView, LlmLogEntry } from '../shared/types';

/** USD pro 1 Mio. Tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Stand der Preistabelle (aus der Anthropic-Preisliste laut claude-api Skill). Vom Nutzer überschreibbar (settings.json: priceOverrides). */
export const PRICES_AS_OF = '2026-10-06';
export const DEFAULT_USD_EUR = 0.92;

export const DEFAULT_PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 1 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'mock-small': { input: 0, output: 0 },
  'mock-medium': { input: 0, output: 0 },
  'mock-large': { input: 0, output: 0 },
  'mock-1': { input: 0, output: 0 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/**
 * Kosten in USD aus den Usage-Angaben der API (Input, Output, Cache; Bildtokens stecken bereits im Input).
 * Unbekanntes Modell: konservativ mit der teuersten bekannten Stufe, markiert.
 */
export function estimateCostUsd(
  model: string,
  u: TokenUsage,
  overrides: Record<string, Price> = {},
): { usd: number; unknownModel: boolean } {
  const table = { ...DEFAULT_PRICES, ...overrides };
  let price = table[model];
  let unknown = false;
  if (!price) {
    unknown = true;
    price = Object.values(table).reduce((a, b) => (b.output + b.input > a.output + a.input ? b : a));
  }
  const cr = price.cacheRead ?? price.input * 0.1;
  const cw = price.cacheWrite ?? price.input * 1.25;
  const usd =
    (u.inputTokens * price.input + u.outputTokens * price.output + (u.cacheReadTokens ?? 0) * cr + (u.cacheCreationTokens ?? 0) * cw) / 1_000_000;
  return { usd, unknownModel: unknown };
}

/** Obergrenze einer Anfrage vorab: geschätzte Eingabe plus volle max_tokens als Ausgabe. */
export function precheckUsd(model: string, estInputTokens: number, maxOutputTokens: number, overrides: Record<string, Price> = {}): number {
  return estimateCostUsd(model, { inputTokens: estInputTokens, outputTokens: maxOutputTokens }, overrides).usd;
}

export const roundEur = (x: number): number => Math.round(x * 100) / 100;
export const formatEur = (x: number): string => `${roundEur(x).toFixed(2).replace('.', ',')} €`;

export interface CostConfig {
  warnEur: number | null;
  limitEur: number | null;
  incidentLimitEur: number | null;
  period: CostPeriod;
  usdEurRate: number;
}

/** Validiert die Kosteneinstellungen: Y >= X, nichts negativ, sinnvoller Kurs. */
export function validateCostConfig(c: CostConfig): CostConfig {
  const ok = (v: number | null) => v === null || (Number.isFinite(v) && v >= 0 && v <= 100000);
  if (!ok(c.warnEur) || !ok(c.limitEur) || !ok(c.incidentLimitEur)) throw new Error('Beträge müssen leer oder zwischen 0 und 100000 € liegen.');
  if (c.warnEur !== null && c.limitEur !== null && c.limitEur < c.warnEur) throw new Error('Das Limit muss mindestens so hoch sein wie die Warnschwelle.');
  if (!Number.isFinite(c.usdEurRate) || c.usdEurRate < 0.1 || c.usdEurRate > 5) throw new Error('Der USD-EUR-Kurs muss zwischen 0,1 und 5 liegen.');
  if (!['day', 'month', 'total'].includes(c.period)) throw new Error('Ungültiger Zeitraum.');
  return c;
}

export function periodKey(period: CostPeriod, nowMs: number): string {
  if (period === 'total') return 'total';
  const d = new Date(nowMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return period === 'month' ? `${d.getFullYear()}-${p(d.getMonth() + 1)}` : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface PeriodTotals {
  spentUsd: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  byModel: Record<string, { requests: number; usd: number }>;
}

interface LedgerData {
  schemaVersion: 1;
  periodKey: string;
  current: PeriodTotals;
  warned: { warn: boolean; ninety: boolean; limit: boolean };
  /** Höchste noch nicht bestätigte Stufe. */
  unack: CostLevel | null;
  raiseEur: number;
  once: boolean;
  unknownModel: boolean;
  history: Record<string, PeriodTotals>;
}

const emptyTotals = (): PeriodTotals => ({ spentUsd: 0, requests: 0, inputTokens: 0, outputTokens: 0, byModel: {} });
const emptyLedger = (key: string): LedgerData => ({
  schemaVersion: 1,
  periodKey: key,
  current: emptyTotals(),
  warned: { warn: false, ninety: false, limit: false },
  unack: null,
  raiseEur: 0,
  once: false,
  unknownModel: false,
  history: {},
});

const RANK: Record<CostLevel, number> = { ok: 0, warn: 1, warn90: 2, limit: 3 };

/** Kostenzähler und Limit-Logik. Speichert nur Zahlen und Modellnamen (atomar in costs.json). */
export class CostGuard {
  private data: LedgerData;
  private readonly file: string;

  constructor(
    dir: string,
    private readonly config: () => CostConfig,
    private readonly now: () => number = Date.now,
    private readonly overrides: () => Record<string, Price> = () => ({}),
  ) {
    this.file = join(dir, 'costs.json');
    this.data = this.load();
  }

  private load(): LedgerData {
    const key = periodKey(this.config().period, this.now());
    if (!existsSync(this.file)) return emptyLedger(key);
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<LedgerData>;
      if (raw.schemaVersion !== 1 || !raw.current || typeof raw.current.spentUsd !== 'number') throw new Error('format');
      return { ...emptyLedger(raw.periodKey ?? key), ...raw, current: { ...emptyTotals(), ...raw.current } } as LedgerData;
    } catch {
      try {
        renameSync(this.file, join(dir(this.file), `costs.corrupt-${this.now()}.json`));
      } catch {
        // egal
      }
      return emptyLedger(key);
    }
  }

  private save(): void {
    mkdirSync(dir(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
    renameSync(tmp, this.file);
  }

  /** Periodenwechsel: alte Summe in die Historie, Zähler und Hinweise zurücksetzen. */
  private roll(): void {
    const key = periodKey(this.config().period, this.now());
    if (key === this.data.periodKey) return;
    const hist = { ...this.data.history, [this.data.periodKey]: this.data.current };
    const keys = Object.keys(hist).sort().slice(-24);
    this.data = { ...emptyLedger(key), history: Object.fromEntries(keys.map((k) => [k, hist[k]!])) };
    this.save();
  }

  private rate(): number {
    return this.config().usdEurRate;
  }
  private limitEur(): number | null {
    const l = this.config().limitEur;
    return l === null ? null : l + this.data.raiseEur;
  }
  private spentEur(): number {
    return this.data.current.spentUsd * this.rate();
  }

  level(incidentUsd = 0): CostLevel {
    const c = this.config();
    const spent = this.spentEur();
    const lim = this.limitEur();
    if ((lim !== null && spent >= lim) || (c.incidentLimitEur !== null && incidentUsd * this.rate() >= c.incidentLimitEur)) return 'limit';
    if (lim !== null && spent >= lim * 0.9) return 'warn90';
    if (c.warnEur !== null && spent >= c.warnEur) return 'warn';
    return 'ok';
  }

  /** Verbuchen einer Anfrage; setzt Hinweise je Schwelle genau einmal pro Periode. */
  record(entry: Pick<LlmLogEntry, 'model' | 'inputTokens' | 'outputTokens' | 'costUsd' | 'costUnknown'>): void {
    this.roll();
    const c = this.data.current;
    const usd = entry.costUsd ?? 0;
    c.spentUsd += usd;
    c.requests += 1;
    c.inputTokens += entry.inputTokens;
    c.outputTokens += entry.outputTokens;
    const m = (c.byModel[entry.model] ??= { requests: 0, usd: 0 });
    m.requests += 1;
    m.usd += usd;
    if (entry.costUnknown) this.data.unknownModel = true;
    const lv = this.level();
    const w = this.data.warned;
    const flag = (k: 'warn' | 'ninety' | 'limit', level: CostLevel) => {
      if (!w[k]) {
        w[k] = true;
        if (!this.data.unack || RANK[level] > RANK[this.data.unack]) this.data.unack = level;
      }
    };
    if (RANK[lv] >= RANK.warn) flag('warn', 'warn');
    if (RANK[lv] >= RANK.warn90 && this.limitEur() !== null) flag('ninety', 'warn90');
    if (lv === 'limit') flag('limit', 'limit');
    this.save();
  }

  /** Vorabprüfung: darf eine Anfrage mit dieser geschätzten Obergrenze (USD) noch laufen? */
  check(estUsd: number, incidentUsd = 0): { allowed: boolean; reason?: string } {
    this.roll();
    const c = this.config();
    const est = estUsd * this.rate();
    const lim = this.limitEur();
    const overPeriod = lim !== null && this.spentEur() + est > lim;
    const overIncident = c.incidentLimitEur !== null && incidentUsd * this.rate() + est > c.incidentLimitEur;
    if (!overPeriod && !overIncident) return { allowed: true };
    if (this.data.once) return { allowed: true };
    return { allowed: false, reason: overIncident && !overPeriod ? 'Limit für diesen Incident erreicht' : 'Limit erreicht' };
  }

  /** Reine Abfrage ohne Nebenwirkung (z. B. für Eskalation und Auto-Weiter). */
  canAfford(estUsd: number, incidentUsd = 0): boolean {
    return this.check(estUsd, incidentUsd).allowed;
  }

  /** Nach dem Start einer Anfrage: Freigabe "Einmal fortfahren" verbrauchen. */
  consumeOnceIfNeeded(estUsd: number, incidentUsd = 0): void {
    if (!this.data.once) return;
    const c = this.config();
    const lim = this.limitEur();
    const est = estUsd * this.rate();
    const over = (lim !== null && this.spentEur() + est > lim) || (c.incidentLimitEur !== null && incidentUsd * this.rate() + est > c.incidentLimitEur);
    if (over) {
      this.data.once = false;
      this.save();
    }
  }

  view(incidentUsd: number): CostView {
    this.roll();
    const c = this.config();
    return {
      periodEur: roundEur(this.spentEur()),
      incidentEur: roundEur(incidentUsd * this.rate()),
      period: c.period,
      warnEur: c.warnEur,
      limitEur: this.limitEur(),
      level: this.level(incidentUsd),
      unacknowledged: this.data.unack !== null,
      unknownModel: this.data.unknownModel,
      onceAllowed: this.data.once,
    };
  }

  ack(): void {
    this.data.unack = null;
    this.save();
  }
  raise(eur: number): void {
    if (!Number.isFinite(eur) || eur <= 0 || eur > 100000) throw new Error('Ungültiger Betrag.');
    this.roll();
    this.data.raiseEur += eur;
    this.data.warned.limit = false;
    this.data.unack = null;
    this.save();
  }
  allowOnce(): void {
    this.data.once = true;
    this.save();
  }
  reset(): void {
    this.data = { ...emptyLedger(periodKey(this.config().period, this.now())), history: this.data.history };
    this.save();
  }
  /** Für Tests und Diagnose. */
  snapshot(): { periodKey: string; totals: PeriodTotals } {
    return { periodKey: this.data.periodKey, totals: JSON.parse(JSON.stringify(this.data.current)) as PeriodTotals };
  }
}

const dir = (f: string): string => f.slice(0, Math.max(f.lastIndexOf('/'), f.lastIndexOf('\\')));
