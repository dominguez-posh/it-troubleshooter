import type { CaptureGeometry } from '../shared/coords';
import type { CaptureSourceInfo, ImageSize } from '../shared/types';

export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureError';
  }
}

export interface CaptureResult {
  jpegBase64: string;
  imageSize: ImageSize;
  geometry: CaptureGeometry;
  kind: 'screen' | 'window';
}

export interface Capturer {
  listSources(): Promise<CaptureSourceInfo[]>;
  capture(sourceId: string): Promise<CaptureResult>;
}
