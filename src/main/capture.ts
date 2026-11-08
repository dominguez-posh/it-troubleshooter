import { execFile } from 'node:child_process';
import { desktopCapturer, screen, type Display, type NativeImage } from 'electron';
import { fitWidth, type Rect } from '../shared/coords';
import { CaptureError, type Capturer } from './captureTypes';
import type { CaptureSourceInfo, ImageSize } from '../shared/types';

export const MAX_IMAGE_WIDTH = 1600;
const JPEG_QUALITY = 80;
export const OWN_WINDOW_TITLE = 'IT-Troubleshooter';

const SOURCE_ID_RE = /^(screen|window):\d+:\d+$/;

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
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 15_000, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(new CaptureError('Die Position des Fensters konnte nicht ermittelt werden.'));
        const m = /(-?\d+),(-?\d+),(-?\d+),(-?\d+)/.exec(stdout);
        if (!m) return reject(new CaptureError('Die Position des Fensters konnte nicht gelesen werden.'));
        const [l, t, r, b] = m.slice(1).map(Number) as [number, number, number, number];
        if (r - l <= 0 || b - t <= 0) return reject(new CaptureError('Das Fenster ist minimiert oder hat keine Größe.'));
        resolve({ x: l, y: t, width: r - l, height: b - t });
      },
    );
  });
}

function toJpeg(img: NativeImage): { base64: string; size: ImageSize } {
  const raw = img.getSize();
  const size = fitWidth(raw, MAX_IMAGE_WIDTH);
  const scaled = size.width === raw.width ? img : img.resize({ width: size.width, height: size.height, quality: 'best' });
  const actual = scaled.getSize();
  return { base64: scaled.toJPEG(JPEG_QUALITY).toString('base64'), size: actual };
}

export const electronCapturer: Capturer = {
  async listSources() {
    const thumbnailSize = { width: 320, height: 200 };
    const [screens, windows] = await Promise.all([
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize }),
      desktopCapturer.getSources({ types: ['window'], thumbnailSize }),
    ]);
    const mk = (kind: 'screen' | 'window') => (s: Electron.DesktopCapturerSource): CaptureSourceInfo => ({
      id: s.id,
      name: s.name,
      kind,
      thumbnailDataUrl: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
    });
    return [
      ...screens.map(mk('screen')),
      ...windows.filter((w) => w.name.trim() && w.name !== OWN_WINDOW_TITLE).map(mk('window')),
    ];
  },

  async capture(sourceId) {
    if (!SOURCE_ID_RE.test(sourceId)) throw new CaptureError('Ungültige Aufnahmequelle.');
    const kind = sourceId.startsWith('screen:') ? 'screen' : 'window';
    const displays = screen.getAllDisplays();
    const maxPhys = displays.map(physicalSize).reduce((a, b) => ({
      width: Math.max(a.width, b.width),
      height: Math.max(a.height, b.height),
    }));
    // Fenster können größer als jeder Bildschirm sein; großzügig anfragen, Electron skaliert nie hoch.
    const thumbnailSize = kind === 'screen' ? maxPhys : { width: Math.max(maxPhys.width, 3840), height: Math.max(maxPhys.height, 2160) };
    let sources: Electron.DesktopCapturerSource[];
    try {
      sources = await desktopCapturer.getSources({ types: [kind], thumbnailSize });
    } catch {
      throw new CaptureError('Die Bildschirmaufnahme ist fehlgeschlagen (Berechtigung?).');
    }
    const src = sources.find((s) => s.id === sourceId);
    if (!src) throw new CaptureError('Die gewählte Quelle ist nicht mehr verfügbar. Bitte die Liste aktualisieren.');
    if (src.thumbnail.isEmpty()) {
      throw new CaptureError('Das Fenster liefert kein Bild (minimiert oder geschützt). Bitte in den Vordergrund holen.');
    }
    const { base64, size } = toJpeg(src.thumbnail);

    if (kind === 'screen') {
      const display = displays.find((d) => String(d.id) === src.display_id) ?? screen.getPrimaryDisplay();
      return { jpegBase64: base64, imageSize: size, kind, geometry: { boundsDip: display.bounds, imageSize: size } };
    }
    const hwnd = Number(sourceId.split(':')[1]);
    const phys = await getWindowRectPhysical(hwnd);
    const boundsDip = screen.screenToDipRect(null, phys);
    return { jpegBase64: base64, imageSize: size, kind, geometry: { boundsDip, imageSize: size } };
  },
};
