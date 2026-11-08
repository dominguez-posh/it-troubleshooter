import type { ActivityKind } from '../shared/types';
import type { GrayFrame } from './captureTypes';

export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiffOptions {
  /** Helligkeitsunterschied (0-255), ab dem ein Pixel als geändert gilt. */
  pixelThreshold?: number;
  /** Anteil geänderter Pixel (0-1), ab dem das Bild als geändert gilt. */
  minChangedFraction?: number;
  /** Bereiche (Bildkoordinaten), die ignoriert werden, z. B. eigene Chat-/Overlay-Fenster. */
  ignore?: FrameRect[];
}

/** Vergleicht zwei Graustufenbilder nur im Speicher. */
export function diffFrames(a: GrayFrame, b: GrayFrame, opts: DiffOptions = {}): { changedFraction: number; changed: boolean } {
  const thr = opts.pixelThreshold ?? 24;
  const minFrac = opts.minChangedFraction ?? 0.01;
  if (a.width !== b.width || a.height !== b.height) return { changedFraction: 1, changed: true };
  const ign = opts.ignore ?? [];
  let considered = 0;
  let changed = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (ign.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) continue;
      considered++;
      const i = y * a.width + x;
      if (Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)) >= thr) changed++;
    }
  }
  const frac = considered === 0 ? 0 : changed / considered;
  return { changedFraction: frac, changed: frac >= minFrac };
}

export interface ForegroundInfo {
  processName: string;
  title: string;
}

/** Austauschbare Erkennung des Vordergrundfensters (Windows: GetForegroundWindow). */
export interface ForegroundProbe {
  get(): Promise<ForegroundInfo | null>;
}

export interface AutoConfig {
  pollMs: number;
  /** So lange muss der Bildschirm ruhig sein, bevor der nächste Schritt ausgelöst wird. */
  settleMs: number;
  minIntervalMs: number;
  maxPerMinute: number;
  /** Ohne erkannte Änderung nach dieser Zeit: "keine Änderung erkannt". */
  timeoutMs: number;
  foregroundTimeoutMs: number;
}

export const DEFAULT_AUTO: AutoConfig = {
  pollMs: 1000,
  settleMs: 1500,
  minIntervalMs: 4000,
  maxPerMinute: 6,
  timeoutMs: 90_000,
  foregroundTimeoutMs: 45_000,
};

export interface AutoDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  grab(sourceId: string): Promise<GrayFrame>;
  foreground: ForegroundProbe;
  /** Kostenlimit: darf eine weitere Anfrage laufen? */
  allow(): boolean;
  ignoreRects?(frame: GrayFrame): FrameRect[];
  config?: Partial<AutoConfig>;
}

export interface WatchOptions {
  sourceId: string;
  /** Fenstertitel des Zielfensters oder null (Bildschirm-Modus: keine Vordergrundprüfung). */
  targetWindow: string | null;
  stepText: string;
  onTrigger(): void;
  onStatus(kind: ActivityKind, detail?: string): void;
}

export type WatchEnd = 'triggered' | 'timeout' | 'foreground-timeout' | 'blocked' | 'stopped' | 'error';

/**
 * Auto-Weiter (optional): wartet, bis das Zielfenster vorne ist, erkennt dann eine Bildschirmänderung (Klick),
 * wartet bis der Bildschirm ruhig ist und löst genau einen nächsten Schritt aus. Mit Mindestabstand und
 * Obergrenze pro Minute. Bilder bleiben im Speicher.
 */
export class AutoAdvance {
  private token = 0;
  private triggers: number[] = [];
  private readonly cfg: AutoConfig;

  constructor(private readonly d: AutoDeps) {
    this.cfg = { ...DEFAULT_AUTO, ...d.config };
  }

  stop(): void {
    this.token++;
  }

  watch(o: WatchOptions): Promise<WatchEnd> {
    const my = ++this.token;
    return this.run(my, o).catch(() => 'error' as const);
  }

  private alive(t: number): boolean {
    return t === this.token;
  }

  private async run(t: number, o: WatchOptions): Promise<WatchEnd> {
    const c = this.cfg;
    const d = this.d;
    if (o.targetWindow) {
      const want = o.targetWindow.toLowerCase();
      const end = d.now() + c.foregroundTimeoutMs;
      let announced = false;
      for (;;) {
        if (!this.alive(t)) return 'stopped';
        const fg = await d.foreground.get();
        if (fg && (fg.title.toLowerCase().includes(want) || want.includes(fg.title.toLowerCase()) && fg.title.length > 3)) break;
        if (!announced) {
          o.onStatus('waiting_target', o.targetWindow);
          announced = true;
        }
        if (d.now() >= end) {
          o.onStatus('no_change');
          return 'foreground-timeout';
        }
        await d.sleep(c.pollMs);
      }
    }
    o.onStatus('please_click', o.stepText);
    const base = await d.grab(o.sourceId);
    const deadline = d.now() + c.timeoutMs;
    const diffOpts = (f: GrayFrame): DiffOptions => ({ ignore: d.ignoreRects?.(f) ?? [] });
    for (;;) {
      if (!this.alive(t)) return 'stopped';
      if (d.now() >= deadline) {
        o.onStatus('no_change');
        return 'timeout';
      }
      await d.sleep(c.pollMs);
      if (!this.alive(t)) return 'stopped';
      const cur = await d.grab(o.sourceId);
      if (!diffFrames(base, cur, diffOpts(cur)).changed) continue;
      o.onStatus('change_detected');
      // Entprellen: warten, bis der Bildschirm ruhig ist.
      let prev = cur;
      let calmSince = d.now();
      const settleDeadline = d.now() + 10_000;
      while (d.now() - calmSince < c.settleMs && d.now() < settleDeadline) {
        await d.sleep(Math.min(c.pollMs, c.settleMs));
        if (!this.alive(t)) return 'stopped';
        const next = await d.grab(o.sourceId);
        if (diffFrames(prev, next, diffOpts(next)).changed) calmSince = d.now();
        prev = next;
      }
      // Mindestabstand und Obergrenze pro Minute (Tokenkontrolle).
      for (;;) {
        const now = d.now();
        this.triggers = this.triggers.filter((x) => now - x < 60_000);
        const last = this.triggers[this.triggers.length - 1];
        const gap = last === undefined ? 0 : Math.max(0, c.minIntervalMs - (now - last));
        const perMinute = this.triggers.length >= c.maxPerMinute ? 60_000 - (now - this.triggers[0]!) : 0;
        const wait = Math.max(gap, perMinute);
        if (wait <= 0) break;
        if (now + wait > deadline + 60_000) {
          o.onStatus('no_change');
          return 'timeout';
        }
        await d.sleep(Math.min(wait, 1000));
        if (!this.alive(t)) return 'stopped';
      }
      if (!d.allow()) return 'blocked';
      this.triggers.push(d.now());
      o.onTrigger();
      return 'triggered';
    }
  }
}
