import type { ImageSize, Point } from './types';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Beschreibt, wo im Desktop (in DIP, also Electron-Koordinaten) der aufgenommene
 * Bereich lag. Bei Bildschirmen ist das display.bounds, bei Fenstern die Fensterposition
 * zum Zeitpunkt der Aufnahme.
 */
export interface CaptureGeometry {
  /** Aufgenommener Bereich in DIP auf dem virtuellen Desktop. */
  boundsDip: Rect;
  /** Größe des gesendeten (skalierten) Bildes in Pixeln. */
  imageSize: ImageSize;
}

/** Skaliert so, dass die Breite höchstens maxWidth beträgt (nie hochskalieren), Seitenverhältnis bleibt. */
export function fitWidth(size: ImageSize, maxWidth: number): ImageSize {
  if (size.width <= 0 || size.height <= 0) throw new Error('Ungültige Bildgröße');
  if (size.width <= maxWidth) return { width: Math.round(size.width), height: Math.round(size.height) };
  const f = maxWidth / size.width;
  return { width: maxWidth, height: Math.max(1, Math.round(size.height * f)) };
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Bildpunkt (Pixel des gesendeten JPEG) -> Desktop-Punkt in DIP. */
export function imagePointToDesktopDip(p: Point, g: CaptureGeometry): Point {
  const sx = g.boundsDip.width / g.imageSize.width;
  const sy = g.boundsDip.height / g.imageSize.height;
  return { x: g.boundsDip.x + p.x * sx, y: g.boundsDip.y + p.y * sy };
}

/** Desktop-Punkt in DIP -> Punkt relativ zu einem Fenster/Display (DIP). */
export function desktopDipToLocal(p: Point, origin: Point): Point {
  return { x: p.x - origin.x, y: p.y - origin.y };
}

export function rectContains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
}
