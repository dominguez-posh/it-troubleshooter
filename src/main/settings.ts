import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { TIERS, type ModelTier, type Routing, type SettingsPatch, type SettingsView, type TierModels } from '../shared/types';
import type { Rect } from '../shared/coords';
import type { KeyStore } from './keystore';
import type { ProviderRegistry } from './llm';
import { DEFAULT_FAILED_THRESHOLD, DEFAULT_ROUTING } from './llm/router';
import { resolveModels, validateModelName } from './llm/tiers';
import { DEFAULT_USD_EUR, validateCostConfig, type CostConfig, type Price } from './cost';

const tier = z.enum(['small', 'medium', 'large']);
/** Ältere Versionen speicherten ein einzelnes Modell je Anbieter (= mittlere Stufe). */
const modelsSchema = z.record(
  z.string(),
  z.preprocess((v) => (typeof v === 'string' ? { medium: v } : v), z.object({ small: z.string().optional(), medium: z.string().optional(), large: z.string().optional() })),
);

const fileSchema = z.object({
  providerId: z.string().default('anthropic'),
  models: modelsSchema.default({}),
  routing: z.object({ triage: tier.optional(), step: tier.optional(), summary: tier.optional(), call: tier.optional() }).default({}),
  failedThreshold: z.number().int().min(1).max(5).default(DEFAULT_FAILED_THRESHOLD),
  dropBackToBase: z.boolean().default(true),
  maxImageWidth: z.number().int().min(800).max(1920).default(1280),
  jpegQuality: z.number().int().min(40).max(90).default(70),
  excludeMainWindow: z.boolean().default(true),
  chatReevaluate: z.boolean().default(false),
  chatShortcut: z.boolean().default(true),
  callShortcut: z.boolean().default(true),
  activityPill: z.boolean().default(true),
  autoAdvance: z.boolean().default(false),
  shotRetentionDays: z.number().int().min(1).max(3650).default(30),
  costWarnEur: z.number().min(0).nullable().default(null),
  costLimitEur: z.number().min(0).nullable().default(null),
  costIncidentLimitEur: z.number().min(0).nullable().default(null),
  costPeriod: z.enum(['day', 'month', 'total']).default('month'),
  usdEurRate: z.number().min(0.1).max(5).default(DEFAULT_USD_EUR),
  /** Optional von Hand in settings.json gepflegt: USD pro 1 Mio. Tokens je Modell. */
  priceOverrides: z.record(z.string(), z.object({ input: z.number().min(0), output: z.number().min(0), cacheRead: z.number().min(0).optional(), cacheWrite: z.number().min(0).optional() })).default({}),
  chatBounds: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .nullable()
    .default(null),
});
type SettingsFile = z.infer<typeof fileSchema>;

export const CHAT_SHORTCUT = 'Control+Alt+Space';
export const CALL_SHORTCUT = 'Control+Alt+T';

/** Nicht-geheime Einstellungen. Keys liegen im KeyStore. */
export class SettingsStore {
  private data: SettingsFile;
  private readonly file: string;

  constructor(
    private readonly dir: string,
    private readonly registry: ProviderRegistry,
    private readonly keys: KeyStore,
  ) {
    this.file = join(dir, 'settings.json');
    this.data = this.load();
    if (!registry.has(this.data.providerId)) this.data.providerId = 'anthropic';
  }

  private load(): SettingsFile {
    try {
      if (existsSync(this.file)) return fileSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      // defaults
    }
    return fileSchema.parse({});
  }

  private save(): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  get providerId(): string {
    return this.data.providerId;
  }
  get excludeMainWindow(): boolean {
    return this.data.excludeMainWindow;
  }
  get chatReevaluate(): boolean {
    return this.data.chatReevaluate;
  }
  get chatShortcut(): boolean {
    return this.data.chatShortcut;
  }
  get callShortcut(): boolean {
    return this.data.callShortcut;
  }
  get activityPill(): boolean {
    return this.data.activityPill;
  }
  get autoAdvance(): boolean {
    return this.data.autoAdvance;
  }
  costConfig(): CostConfig {
    const d = this.data;
    return { warnEur: d.costWarnEur, limitEur: d.costLimitEur, incidentLimitEur: d.costIncidentLimitEur, period: d.costPeriod, usdEurRate: d.usdEurRate };
  }
  priceOverrides(): Record<string, Price> {
    return this.data.priceOverrides;
  }
  get shotRetentionDays(): number {
    return this.data.shotRetentionDays;
  }
  get failedThreshold(): number {
    return this.data.failedThreshold;
  }
  get dropBackToBase(): boolean {
    return this.data.dropBackToBase;
  }
  get chatBounds(): Rect | null {
    return this.data.chatBounds;
  }
  setChatBounds(r: Rect): void {
    this.data.chatBounds = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    this.save();
  }
  captureOptions(): { maxWidth: number; quality: number } {
    return { maxWidth: this.data.maxImageWidth, quality: this.data.jpegQuality };
  }
  routing(): Routing {
    return { ...DEFAULT_ROUTING, ...this.data.routing };
  }

  /** Wirksame Modelle je Stufe (Standard des Anbieters, überschrieben durch Nutzer; fehlende Stufen fallen zurück). */
  tierModels(providerId: string): TierModels {
    return resolveModels(this.registry.get(providerId).tiers, this.data.models[providerId] ?? {});
  }

  update(patch: SettingsPatch): void {
    if (patch.providerId !== undefined) {
      if (!this.registry.has(patch.providerId)) throw new Error('Unbekannter Provider');
      this.data.providerId = patch.providerId;
    }
    if (patch.tierModels) {
      const cur: Partial<Record<ModelTier, string>> = { ...(this.data.models[this.data.providerId] ?? {}) };
      for (const t of TIERS) {
        const v = patch.tierModels[t];
        if (v === undefined) continue;
        if (v.trim() === '') delete cur[t];
        else cur[t] = validateModelName(v);
      }
      this.data.models[this.data.providerId] = cur;
    }
    if (patch.routing) {
      for (const [k, v] of Object.entries(patch.routing)) {
        if (!(k in DEFAULT_ROUTING) || !TIERS.includes(v as ModelTier)) throw new Error('Ungültige Zuordnung');
        (this.data.routing as Record<string, ModelTier>)[k] = v as ModelTier;
      }
    }
    const num = (v: number, min: number, max: number, name: string): number => {
      if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name}: Wert zwischen ${min} und ${max} erwartet`);
      return v;
    };
    if (patch.failedThreshold !== undefined) this.data.failedThreshold = num(patch.failedThreshold, 1, 5, 'Schwelle');
    if (patch.maxImageWidth !== undefined) this.data.maxImageWidth = num(patch.maxImageWidth, 800, 1920, 'Bildbreite');
    if (patch.jpegQuality !== undefined) this.data.jpegQuality = num(patch.jpegQuality, 40, 90, 'JPEG-Qualität');
    if (patch.dropBackToBase !== undefined) this.data.dropBackToBase = patch.dropBackToBase;
    if (patch.excludeMainWindow !== undefined) this.data.excludeMainWindow = patch.excludeMainWindow;
    if (patch.chatReevaluate !== undefined) this.data.chatReevaluate = patch.chatReevaluate;
    if (patch.chatShortcut !== undefined) this.data.chatShortcut = patch.chatShortcut;
    if (patch.callShortcut !== undefined) this.data.callShortcut = patch.callShortcut;
    if (patch.activityPill !== undefined) this.data.activityPill = patch.activityPill;
    if (patch.autoAdvance !== undefined) this.data.autoAdvance = patch.autoAdvance;
    if (patch.shotRetentionDays !== undefined) this.data.shotRetentionDays = num(patch.shotRetentionDays, 1, 3650, 'Aufbewahrungsfrist');
    const costKeys = ['costWarnEur', 'costLimitEur', 'costIncidentLimitEur', 'costPeriod', 'usdEurRate'] as const;
    if (costKeys.some((k) => patch[k] !== undefined)) {
      const next = { ...this.costConfig() };
      if (patch.costWarnEur !== undefined) next.warnEur = patch.costWarnEur;
      if (patch.costLimitEur !== undefined) next.limitEur = patch.costLimitEur;
      if (patch.costIncidentLimitEur !== undefined) next.incidentLimitEur = patch.costIncidentLimitEur;
      if (patch.costPeriod !== undefined) next.period = patch.costPeriod;
      if (patch.usdEurRate !== undefined) next.usdEurRate = patch.usdEurRate;
      validateCostConfig(next);
      this.data.costWarnEur = next.warnEur;
      this.data.costLimitEur = next.limitEur;
      this.data.costIncidentLimitEur = next.incidentLimitEur;
      this.data.costPeriod = next.period;
      this.data.usdEurRate = next.usdEurRate;
    }
    this.save();
  }

  /** Sicht für den Renderer: nur "Key gesetzt ja/nein", nie der Key. */
  view(): SettingsView {
    return {
      providerId: this.data.providerId,
      tierModels: this.tierModels(this.data.providerId),
      routing: this.routing(),
      failedThreshold: this.data.failedThreshold,
      dropBackToBase: this.data.dropBackToBase,
      maxImageWidth: this.data.maxImageWidth,
      jpegQuality: this.data.jpegQuality,
      excludeMainWindow: this.data.excludeMainWindow,
      chatReevaluate: this.data.chatReevaluate,
      chatShortcut: this.data.chatShortcut,
      chatShortcutLabel: 'Strg+Alt+Leertaste',
      callShortcut: this.data.callShortcut,
      callShortcutLabel: 'Strg+Alt+T',
      activityPill: this.data.activityPill,
      autoAdvance: this.data.autoAdvance,
      shotRetentionDays: this.data.shotRetentionDays,
      costWarnEur: this.data.costWarnEur,
      costLimitEur: this.data.costLimitEur,
      costIncidentLimitEur: this.data.costIncidentLimitEur,
      costPeriod: this.data.costPeriod,
      usdEurRate: this.data.usdEurRate,
      encryptionAvailable: this.keys.encryptionAvailable,
      providers: this.registry.list().map((d) => ({
        id: d.id,
        name: d.name,
        requiresKey: d.requiresKey,
        keySet: d.requiresKey ? this.keys.has(d.id) : true,
        defaultTiers: resolveModels(d.tiers),
        knownModels: d.knownModels,
      })),
    };
  }
}
