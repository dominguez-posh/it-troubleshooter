import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { SettingsPatch, SettingsView } from '../shared/types';
import type { KeyStore } from './keystore';
import type { ProviderRegistry } from './llm';

const fileSchema = z.object({
  providerId: z.string().default('anthropic'),
  models: z.record(z.string(), z.string()).default({}),
  excludeMainWindow: z.boolean().default(true),
});
type SettingsFile = z.infer<typeof fileSchema>;

/** Nicht-geheime Einstellungen (Provider, Modell, Aufnahme-Optionen). Keys liegen im KeyStore. */
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

  modelFor(providerId: string): string {
    return this.data.models[providerId] || this.registry.get(providerId).defaultModel;
  }

  update(patch: SettingsPatch): void {
    if (patch.providerId !== undefined) {
      if (!this.registry.has(patch.providerId)) throw new Error('Unbekannter Provider');
      this.data.providerId = patch.providerId;
    }
    if (patch.model !== undefined) {
      const m = patch.model.trim();
      if (m.length > 100 || /\s/.test(m)) throw new Error('Ungültiger Modellname');
      if (m) this.data.models[this.data.providerId] = m;
      else delete this.data.models[this.data.providerId];
    }
    if (patch.excludeMainWindow !== undefined) this.data.excludeMainWindow = patch.excludeMainWindow;
    this.save();
  }

  /** Sicht für den Renderer: nur "Key gesetzt ja/nein", nie der Key. */
  view(): SettingsView {
    return {
      providerId: this.data.providerId,
      model: this.modelFor(this.data.providerId),
      excludeMainWindow: this.data.excludeMainWindow,
      encryptionAvailable: this.keys.encryptionAvailable,
      providers: this.registry.list().map((d) => ({
        id: d.id,
        name: d.name,
        requiresKey: d.requiresKey,
        keySet: d.requiresKey ? this.keys.has(d.id) : true,
        defaultModel: d.defaultModel,
        knownModels: d.knownModels,
      })),
    };
  }
}
