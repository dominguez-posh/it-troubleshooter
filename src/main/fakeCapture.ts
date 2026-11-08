import type { Capturer, GrayFrame } from './captureTypes';

/**
 * Fake-Quelle für Selbsttest und Tests: erzeugt synthetische Bilder, nimmt NIE den echten Bildschirm auf.
 * (Ein minimales gültiges JPEG genügt, weil der Mock-Provider das Bild nicht auswertet.)
 */
export const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

export function createFakeCapturer(opts: { width?: number; height?: number; sourceName?: string } = {}): Capturer & { frameCalls: number } {
  const width = opts.width ?? 1280;
  const height = opts.height ?? 720;
  let tick = 0;
  const self = {
    frameCalls: 0,
    async listSources() {
      return [
        { id: 'screen:0:0', name: 'Testbildschirm (simuliert)', kind: 'screen' as const, thumbnailDataUrl: '' },
        { id: 'window:1:0', name: opts.sourceName ?? 'Testfenster (simuliert)', kind: 'window' as const, thumbnailDataUrl: '' },
      ];
    },
    async defaultSourceId() {
      return 'screen:0:0';
    },
    async capture(sourceId: string) {
      const kind = sourceId.startsWith('window:') ? ('window' as const) : ('screen' as const);
      const size = { width, height };
      const r = {
        jpegBase64: TINY_JPEG_BASE64,
        imageSize: size,
        kind,
        geometry: { boundsDip: { x: 0, y: 0, width, height }, imageSize: size },
      };
      return kind === 'window' ? { ...r, sourceName: opts.sourceName ?? 'Testfenster (simuliert)' } : r;
    },
    async grabFrame(): Promise<GrayFrame> {
      self.frameCalls++;
      tick++;
      return { width: 4, height: 4, data: new Uint8Array(16).fill(tick % 2 === 0 ? 10 : 10) };
    },
  };
  return self;
}
