import type { CaptureGeometry } from '../shared/coords';
import type { CaptureSourceInfo, ImageSize } from '../shared/types';

export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureError';
  }
}

export interface CaptureOptions {
  maxWidth: number;
  /** JPEG-Qualität 1-100 */
  quality: number;
  /** Fortschritt für die sichtbare Aktivität. */
  onPhase?: (p: 'capturing' | 'resizing') => void;
}

export interface CaptureResult {
  jpegBase64: string;
  imageSize: ImageSize;
  geometry: CaptureGeometry;
  kind: 'screen' | 'window';
  /** Fenstertitel bei Fenster-Aufnahme (für Auto-Weiter). */
  sourceName?: string;
}

/** Kleines Graustufenbild nur für den Änderungsvergleich (nie gespeichert). */
export interface GrayFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Capturer {
  listSources(): Promise<CaptureSourceInfo[]>;
  capture(sourceId: string, opts: CaptureOptions): Promise<CaptureResult>;
  grabFrame(sourceId: string): Promise<GrayFrame>;
  /** Standardquelle (erster Bildschirm), falls keine gewählt wurde. */
  defaultSourceId(): Promise<string | null>;
}
