import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Der Teil von Electrons safeStorage, den wir brauchen (für Tests ersetzbar). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

const ID_RE = /^[a-z0-9_-]{1,40}$/;

/**
 * Speichert API-Keys verschlüsselt (OS-gebunden via safeStorage) in einer Datei im userData-Ordner.
 * Klartext landet nie auf der Platte. Nur der Main-Prozess benutzt diese Klasse.
 */
export class KeyStore {
  private readonly file: string;

  constructor(
    dir: string,
    private readonly safe: SafeStorageLike,
  ) {
    this.file = join(dir, 'keys.json');
  }

  get encryptionAvailable(): boolean {
    return this.safe.isEncryptionAvailable();
  }

  private readAll(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      const data: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(data)) if (typeof v === 'string' && ID_RE.test(k)) out[k] = v;
        return out;
      }
    } catch {
      // beschädigte Datei wie leer behandeln
    }
    return {};
  }

  private writeAll(data: Record<string, string>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private checkId(providerId: string): void {
    if (!ID_RE.test(providerId)) throw new Error('Ungültige Provider-ID');
  }

  has(providerId: string): boolean {
    this.checkId(providerId);
    return providerId in this.readAll();
  }

  set(providerId: string, key: string): void {
    this.checkId(providerId);
    const trimmed = key.trim();
    if (!trimmed) throw new Error('Der API-Key ist leer.');
    if (!this.safe.isEncryptionAvailable()) {
      throw new Error('Auf diesem System ist keine sichere Verschlüsselung verfügbar. Der Key wird nicht gespeichert.');
    }
    const all = this.readAll();
    all[providerId] = this.safe.encryptString(trimmed).toString('base64');
    this.writeAll(all);
  }

  /** Nur für den Main-Prozess (LLM-Adapter). Gibt nie etwas an den Renderer. */
  get(providerId: string): string | undefined {
    this.checkId(providerId);
    const enc = this.readAll()[providerId];
    if (!enc || !this.safe.isEncryptionAvailable()) return undefined;
    try {
      return this.safe.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return undefined;
    }
  }

  clear(providerId: string): void {
    this.checkId(providerId);
    const all = this.readAll();
    delete all[providerId];
    this.writeAll(all);
  }
}
