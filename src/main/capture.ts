import { execFile } from 'node:child_process';
import { desktopCapturer, screen, type Display, type NativeImage } from 'electron';
import { fitWidth, type Rect } from '../shared/coords';
import type { CaptureSourceInfo, ImageSize } from '../shared/types';
import { CaptureError, type CaptureOptions, type CaptureResult, type Capturer, type GrayFrame } from './captureTypes';

export const OWN_WINDOW_TITLE = 'IT-Troubleshooter';
const SOURCE_ID_RE = /^(screen|window):\d+:\d+$/;
const FRAME_SIZE = { width: 96, height: 54 };

function physicalSize(d: Display): ImageSize {
  return { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
}

/** Position eines fremden Fensters in physischen Desktop-Pixeln (Win32 GetWindowRect, DPI-aware). */
function getWindowRectPhysical(hwnd: number): Promise<Rect> {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new CaptureError('Fenster-Aufnahme wird nur unter Windows unterstützt.'));
    if (!Number.isSafeInteger(hwnd) || hwnd <= 0) return reject(new CaptureError('Ungültiges Fenster.'));
    const script = [
      "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W{[StructLayout(LayoutKind.Sequential)]public struct R{public int L;public int T;public int Rt;public int B;}[DllImport(\"user32.dll\")]public static extern bool GetWindowRect(IntPtr h,out R r);[DllImport(\"user32.dll\")]public static extern bool SetProcessDPIAware();}'",
      '[void][W]::SetProcessDPIAware()',
      '$r=New-Object W+R',
      `if(-not [W]::GetWindowRect([IntPtr]${hwnd},[ref]$r)){exit 2}`,
      'Write-Output ("{0},{1},{2},{3}" -f $r.L,$r.T,$r.Rt,$r.B)',
    ].join(';');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
      if (err) return reject(new CaptureError('Die Position des Fensters konnte nicht ermittelt werden.'));
      const m = /(-?\d+),(-?\d+),(-?\d+),(-?\d+)/.exec(stdout);
      if (!m) return reject(new CaptureError('Die Position des Fensters konnte nicht gelesen werden.'));
      const [l, t, r, b] = m.slice(1).map(Number) as [number, number, number, number];
      if (r - l <= 0 || b - t <= 0) return reject(new CaptureError('Das Fenster ist minimiert oder hat keine Größe.'));
      resolve({ x: l, y: t, width: r - l, height: b - t });
    });
  });
}

function toJpeg(img: NativeImage, o: CaptureOptions): { base64: string; size: ImageSize } {
  o.onPhase?.('resizing');
  const raw = img.getSize();
  const size = fitWidth(raw, o.maxWidth);
  const scaled = size.width === raw.width ? img : img.resize({ width: size.width, height: size.height, quality: 'best' });
  return { base64: scaled.toJPEG(o.quality).toString('base64'), size: scaled.getSize() };
}

function toGray(img: NativeImage): GrayFrame {
  const small = img.resize({ width: FRAME_SIZE.width, height: FRAME_SIZE.height, quality: 'good' });
  const { width, height } = small.getSize();
  const bmp = small.toBitmap();
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    // BGRA
    data[i] = Math.round(0.114 * (bmp[i * 4] ?? 0) + 0.587 * (bmp[i * 4 + 1] ?? 0) + 0.299 * (bmp[i * 4 + 2] ?? 0));
  }
  return { width, height, data };
}

async function sourcesOf(kind: 'screen' | 'window', size: ImageSize): Promise<Electron.DesktopCapturerSource[]> {
  try {
    return await desktopCapturer.getSources({ types: [kind], thumbnailSize: size });
  } catch {
    throw new CaptureError('Die Bildschirmaufnahme ist fehlgeschlagen (Berechtigung?).');
  }
}

/** Echte Aufnahme per desktopCapturer. In Tests und im Selbsttest wird stattdessen eine Fake-Quelle verwendet. */
export const electronCapturer: Capturer = {
  async listSources() {
    const thumbnailSize = { width: 320, height: 200 };
    const [screens, windows] = await Promise.all([sourcesOf('screen', thumbnailSize), sourcesOf('window', thumbnailSize)]);
    const mk = (kind: 'screen' | 'window') => (s: Electron.DesktopCapturerSource): CaptureSourceInfo => ({
      id: s.id,
      name: s.name,
      kind,
      thumbnailDataUrl: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
    });
    return [...screens.map(mk('screen')), ...windows.filter((w) => w.name.trim() && w.name !== OWN_WINDOW_TITLE).map(mk('window'))];
  },

  async defaultSourceId() {
    const s = await sourcesOf('screen', { width: 1, height: 1 });
    return s[0]?.id ?? null;
  },

  async capture(sourceId, opts): Promise<CaptureResult> {
    if (!SOURCE_ID_RE.test(sourceId)) throw new CaptureError('Ungültige Aufnahmequelle.');
    opts.onPhase?.('capturing');
    const kind = sourceId.startsWith('screen:') ? 'screen' : 'window';
    const displays = screen.getAllDisplays();
    const maxPhys = displays.map(physicalSize).reduce((a, b) => ({ width: Math.max(a.width, b.width), height: Math.max(a.height, b.height) }));
    const thumbnailSize = kind === 'screen' ? maxPhys : { width: Math.max(maxPhys.width, 3840), height: Math.max(maxPhys.height, 2160) };
    const src = (await sourcesOf(kind, thumbnailSize)).find((s) => s.id === sourceId);
    if (!src) throw new CaptureError('Die gewählte Quelle ist nicht mehr verfügbar. Bitte die Liste aktualisieren.');
    if (src.thumbnail.isEmpty()) throw new CaptureError('Das Fenster liefert kein Bild (minimiert oder geschützt). Bitte in den Vordergrund holen.');
    const { base64, size } = toJpeg(src.thumbnail, opts);
    if (kind === 'screen') {
      const display = displays.find((d) => String(d.id) === src.display_id) ?? screen.getPrimaryDisplay();
      return { jpegBase64: base64, imageSize: size, kind, geometry: { boundsDip: display.bounds, imageSize: size } };
    }
    const phys = await getWindowRectPhysical(Number(sourceId.split(':')[1]));
    return { jpegBase64: base64, imageSize: size, kind, sourceName: src.name, geometry: { boundsDip: screen.screenToDipRect(null, phys), imageSize: size } };
  },

  async grabFrame(sourceId) {
    if (!SOURCE_ID_RE.test(sourceId)) throw new CaptureError('Ungültige Aufnahmequelle.');
    const kind = sourceId.startsWith('screen:') ? 'screen' : 'window';
    const src = (await sourcesOf(kind, { width: 320, height: 200 })).find((s) => s.id === sourceId);
    if (!src || src.thumbnail.isEmpty()) throw new CaptureError('Die Quelle liefert kein Bild.');
    return toGray(src.thumbnail);
  },
};
