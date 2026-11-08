import { clamp, type Rect } from './coords';

export const CHAT_DEFAULT_SIZE = { width: 340, height: 210 };
export const CHAT_MIN_SIZE = { width: 260, height: 160 };
const MARGIN = 16;
const TITLE_STRIP = 32;

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const bt = Math.min(a.y + a.height, b.y + b.height);
  return r > x && bt > y ? { x, y, width: r - x, height: bt - y } : null;
}

export function isRect(v: unknown): v is Rect {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k] as number));
}

/** Standardposition: unten rechts im Arbeitsbereich des Hauptmonitors. */
export function defaultChatBounds(primaryWorkArea: Rect): Rect {
  const width = Math.min(CHAT_DEFAULT_SIZE.width, primaryWorkArea.width);
  const height = Math.min(CHAT_DEFAULT_SIZE.height, primaryWorkArea.height);
  return {
    x: primaryWorkArea.x + primaryWorkArea.width - width - MARGIN,
    y: primaryWorkArea.y + primaryWorkArea.height - height - MARGIN,
    width,
    height,
  };
}

/**
 * Prüft gemerkte oder neu berechnete Fensterposition: Größe wird auf Mindest-/Maximalgröße begrenzt;
 * ist die Titelleiste auf keinem Monitor mehr ausreichend sichtbar (z. B. Monitor abgesteckt),
 * wird auf die Standardposition zurückgesetzt.
 */
export function validateChatBounds(saved: unknown, workAreas: Rect[], primaryWorkArea: Rect): Rect {
  if (!isRect(saved) || workAreas.length === 0) return defaultChatBounds(primaryWorkArea);
  const width = Math.round(clamp(saved.width, CHAT_MIN_SIZE.width, Math.max(CHAT_MIN_SIZE.width, primaryWorkArea.width)));
  const height = Math.round(clamp(saved.height, CHAT_MIN_SIZE.height, Math.max(CHAT_MIN_SIZE.height, primaryWorkArea.height)));
  const x = Math.round(saved.x);
  const y = Math.round(saved.y);
  const strip: Rect = { x, y, width, height: TITLE_STRIP };
  const visible = workAreas.some((wa) => {
    const i = intersect(strip, wa);
    return i !== null && i.width >= Math.min(120, width) && i.height >= 24;
  });
  if (!visible) return { ...defaultChatBounds(primaryWorkArea), width, height: Math.min(height, primaryWorkArea.height) };
  return { x, y, width, height };
}
