import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { ImageSize, NormRect, Point, ShotRef, StepOutcome } from '../shared/types';
import type { SafeStorageLike } from './keystore';

export const INCIDENT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
export const SHOT_ID_RE = /^[a-z0-9-]{8,40}$/;
/** Obergrenze für ein Bild, das über IPC an den Renderer geht oder von dort verarbeitet wird. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_RECTS = 50;

export class ShotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShotError';
  }
}

/** Setzt Pfadteile zusammen und stellt sicher, dass das Ergebnis innerhalb von base bleibt (kein Path Traversal). */
export function resolveInside(base: string, ...parts: string[]): string {
  const root = resolve(base);
  const full = resolve(root, ...parts);
  if (full !== root && !full.startsWith(root + sep)) throw new ShotError('Ungültiger Pfad.');
  return full;
}

export function checkIncidentId(id: unknown): string {
  if (typeof id !== 'string' || !INCIDENT_ID_RE.test(id)) throw new ShotError('Ungültige Incident-Kennung.');
  return id;
}

export function checkShotId(id: unknown): string {
  if (typeof id !== 'string' || !SHOT_ID_RE.test(id)) throw new ShotError('Ungültige Screenshot-Kennung.');
  return id;
}

// ---------- Verschlüsselung ----------
/**
 * Dateischlüssel (zufällig, 256 Bit) liegt selbst per safeStorage geschützt in userData. Bilder werden mit AES-256-GCM verschlüsselt.
 * Ist safeStorage nicht verfügbar, wird im Klartext gespeichert und das ist in der UI sichtbar (encrypted = false).
 */
export class ShotCrypto {
  private key: Buffer | null = null;
  private readonly keyFile: string;

  constructor(
    dir: string,
    private readonly safe: SafeStorageLike,
  ) {
    this.keyFile = join(dir, 'shots.key');
  }

  get available(): boolean {
    return this.safe.isEncryptionAvailable();
  }

  private loadKey(create: boolean): Buffer | null {
    if (this.key) return this.key;
    if (existsSync(this.keyFile)) {
      try {
        const k = Buffer.from(this.safe.decryptString(Buffer.from(readFileSync(this.keyFile, 'utf8'), 'base64')), 'base64');
        if (k.length === 32) return (this.key = k);
      } catch {
        // Schlüssel nicht lesbar (z. B. anderes Windows-Profil)
      }
      if (!create) return null;
    }
    if (!create || !this.available) return null;
    const k = randomBytes(32);
    writeFileSync(this.keyFile, this.safe.encryptString(k.toString('base64')).toString('base64'), { mode: 0o600 });
    return (this.key = k);
  }

  /** Format: [1 Byte Version][12 Byte IV][16 Byte Tag][Daten]; Version 0 = Klartext. */
  encrypt(data: Buffer): { blob: Buffer; encrypted: boolean } {
    const key = this.loadKey(true);
    if (!key) return { blob: Buffer.concat([Buffer.from([0]), data]), encrypted: false };
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([c.update(data), c.final()]);
    return { blob: Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), enc]), encrypted: true };
  }

  decrypt(blob: Buffer): Buffer {
    const v = blob[0];
    if (v === 0) return blob.subarray(1);
    if (v !== 1 || blob.length < 29) throw new ShotError('Das Bildformat ist unbekannt oder beschädigt.');
    const key = this.loadKey(false);
    if (!key) throw new ShotError('Der Dateischlüssel ist nicht verfügbar (anderes Windows-Profil?). Das Bild kann nicht gelesen werden.');
    try {
      const d = createDecipheriv('aes-256-gcm', key, blob.subarray(1, 13));
      d.setAuthTag(blob.subarray(13, 29));
      return Buffer.concat([d.update(blob.subarray(29)), d.final()]);
    } catch {
      throw new ShotError('Das Bild ist beschädigt oder wurde verändert.');
    }
  }
}

// ---------- Bildoperationen ----------
export interface RawImage {
  width: number;
  height: number;
  /** BGRA, 4 Bytes pro Pixel */
  data: Buffer;
}

/** Austauschbare Bild-Ein-/Ausgabe (Electron: nativeImage; Tests: Fake). */
export interface ImageOps {
  decode(jpeg: Buffer): RawImage;
  encode(raw: RawImage, quality: number): Buffer;
}

/** Überschreibt die Pixel der Rechtecke (normiert 0..1) unwiderruflich mit Schwarz. Gibt eine Kopie zurück, das Original bleibt unverändert. */
export function blackOut(src: RawImage, rects: NormRect[]): RawImage {
  const data = Buffer.from(src.data);
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x * src.width));
    const y0 = Math.max(0, Math.floor(r.y * src.height));
    const x1 = Math.min(src.width, Math.ceil((r.x + r.w) * src.width));
    const y1 = Math.min(src.height, Math.ceil((r.y + r.h) * src.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * src.width + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 255;
      }
    }
  }
  return { width: src.width, height: src.height, data };
}

/** Zeichnet einen roten Zielring mit Kreuz in eine Kopie (für die Doku). Das Original bleibt unverändert. */
export function drawMarker(src: RawImage, p: Point, radius = Math.max(10, Math.round(src.width / 80))): RawImage {
  const data = Buffer.from(src.data);
  const set = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= src.width || y >= src.height) return;
    const i = (y * src.width + x) * 4;
    data[i] = 85; // B
    data[i + 1] = 45; // G
    data[i + 2] = 255; // R
    data[i + 3] = 255;
  };
  const thick = Math.max(2, Math.round(radius / 5));
  for (let dy = -radius - thick; dy <= radius + thick; dy++) {
    for (let dx = -radius - thick; dx <= radius + thick; dx++) {
      const d = Math.hypot(dx, dy);
      const ring = d >= radius - thick / 2 && d <= radius + thick / 2;
      const cross = (Math.abs(dx) <= thick / 2 || Math.abs(dy) <= thick / 2) && d <= radius * 1.6 && d >= radius * 0.4;
      if (ring || cross) set(Math.round(p.x) + dx, Math.round(p.y) + dy);
    }
  }
  return { width: src.width, height: src.height, data };
}

export function validateRects(rects: unknown): NormRect[] {
  if (!Array.isArray(rects) || rects.length === 0 || rects.length > MAX_RECTS) throw new ShotError('Bitte 1 bis 50 Bereiche markieren.');
  return rects.map((r) => {
    const o = r as Record<string, unknown>;
    const v = [o['x'], o['y'], o['w'], o['h']];
    if (!v.every((n) => typeof n === 'number' && Number.isFinite(n))) throw new ShotError('Ungültiger Bereich.');
    const [x, y, w, h] = v as [number, number, number, number];
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) throw new ShotError('Ungültiger Bereich.');
    return { x, y, w, h };
  });
}

// ---------- Ablage ----------
export interface SaveMeta {
  stepIndex: number;
  text: string;
  target: Point | null;
  imageSize: ImageSize;
  source: string;
}

export interface FsLike {
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
}

/**
 * Lokale Screenshot-Ablage unter <base>/incidents/<id>/shots/. Alle Pfade entstehen aus validierten Kennungen
 * (nie aus Eingaben des Renderers). Schreiben ist atomar; Fehler (z. B. Platte voll) werden als ShotError gemeldet.
 */
export class ShotStore {
  constructor(
    private readonly base: string,
    private readonly crypto: ShotCrypto,
    private readonly fs: FsLike = { writeFileSync, renameSync },
    private readonly now: () => number = Date.now,
  ) {}

  get encryptionAvailable(): boolean {
    return this.crypto.available;
  }

  private dir(incidentId: string): string {
    return resolveInside(this.base, 'incidents', checkIncidentId(incidentId), 'shots');
  }

  private file(incidentId: string, shotId: string, variant: 'orig' | 'red'): string {
    return resolveInside(this.dir(incidentId), `${checkShotId(shotId)}.${variant}.bin`);
  }

  private write(path: string, data: Buffer): boolean {
    try {
      mkdirSync(resolve(path, '..'), { recursive: true });
      const { blob, encrypted } = this.crypto.encrypt(data);
      const tmp = `${path}.tmp`;
      this.fs.writeFileSync(tmp, blob, { mode: 0o600 });
      this.fs.renameSync(tmp, path);
      return encrypted;
    } catch (e) {
      if (e instanceof ShotError) throw e;
      throw new ShotError('Der Screenshot konnte nicht gespeichert werden (Platte voll oder kein Zugriff).');
    }
  }

  /** Speichert genau das Bild, das an das Modell ging. */
  save(incidentId: string, jpeg: Buffer, meta: SaveMeta): ShotRef {
    if (jpeg.length === 0 || jpeg.length > MAX_IMAGE_BYTES) throw new ShotError('Das Bild hat eine ungültige Größe.');
    const id = randomUUID();
    const encrypted = this.write(this.file(incidentId, id, 'orig'), jpeg);
    return {
      id,
      at: new Date(this.now()).toISOString(),
      stepIndex: meta.stepIndex,
      text: meta.text.slice(0, 400),
      target: meta.target,
      imageSize: meta.imageSize,
      source: meta.source.slice(0, 120),
      keep: true,
      sha256: createHash('sha256').update(jpeg).digest('hex'),
      bytes: jpeg.length,
      redacted: false,
      encrypted,
    };
  }

  read(incidentId: string, ref: ShotRef, variant: 'original' | 'redacted'): Buffer {
    if (variant === 'redacted' && !ref.redacted) throw new ShotError('Es gibt keine geschwärzte Kopie.');
    const path = this.file(incidentId, ref.id, variant === 'redacted' ? 'red' : 'orig');
    if (!existsSync(path)) throw new ShotError('Die Bilddatei fehlt.');
    const data = this.crypto.decrypt(readFileSync(path));
    if (variant === 'original' && createHash('sha256').update(data).digest('hex') !== ref.sha256) {
      throw new ShotError('Das Bild stimmt nicht mehr mit seiner Prüfsumme überein.');
    }
    return data;
  }

  /** Schwärzt in einer KOPIE (Pixel werden überschrieben, dann neu kodiert); das Original bleibt unverändert. */
  redact(incidentId: string, ref: ShotRef, rects: NormRect[], ops: ImageOps, quality = 80): ShotRef {
    const checked = validateRects(rects);
    // Mehrfaches Schwärzen addiert sich: erneut auf der bereits geschwärzten Kopie arbeiten.
    const source = this.read(incidentId, ref, ref.redacted ? 'redacted' : 'original');
    const out = ops.encode(blackOut(ops.decode(source), checked), quality);
    this.write(this.file(incidentId, ref.id, 'red'), out);
    return { ...ref, redacted: true };
  }

  /** Bild für Vorschau und Export: bevorzugt die geschwärzte Kopie, optional mit eingebranntem Pfeil. */
  exportImage(incidentId: string, ref: ShotRef, ops: ImageOps, quality = 80): Buffer {
    const jpeg = this.read(incidentId, ref, ref.redacted ? 'redacted' : 'original');
    if (!ref.target) return jpeg;
    return ops.encode(drawMarker(ops.decode(jpeg), ref.target), quality);
  }

  remove(incidentId: string, shotId: string): void {
    for (const v of ['orig', 'red'] as const) rmSync(this.file(incidentId, shotId, v), { force: true });
  }

  deleteIncident(incidentId: string): void {
    rmSync(resolveInside(this.base, 'incidents', checkIncidentId(incidentId)), { recursive: true, force: true });
  }

  deleteAll(): void {
    rmSync(resolveInside(this.base, 'incidents'), { recursive: true, force: true });
  }

  /** IDs der Screenshots, die älter als die Aufbewahrungsfrist sind (der Aufrufer entfernt Dateien und Verweise). */
  expired(shots: ShotRef[], retentionDays: number): ShotRef[] {
    const limit = this.now() - retentionDays * 86_400_000;
    return shots.filter((s) => Date.parse(s.at) < limit);
  }
}

export type { StepOutcome };
