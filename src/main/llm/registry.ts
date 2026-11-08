import type { ProviderDefinition } from './types';

/** Registry der verfügbaren Provider-Adapter. Neue Provider werden nur hier registriert. */
export class ProviderRegistry {
  private readonly defs = new Map<string, ProviderDefinition>();

  register(def: ProviderDefinition): this {
    if (!/^[a-z0-9_-]+$/.test(def.id)) throw new Error(`Ungültige Provider-ID: ${def.id}`);
    if (this.defs.has(def.id)) throw new Error(`Provider bereits registriert: ${def.id}`);
    this.defs.set(def.id, def);
    return this;
  }

  has(id: string): boolean {
    return this.defs.has(id);
  }

  get(id: string): ProviderDefinition {
    const d = this.defs.get(id);
    if (!d) throw new Error(`Unbekannter Provider: ${id}`);
    return d;
  }

  list(): ProviderDefinition[] {
    return [...this.defs.values()];
  }
}
