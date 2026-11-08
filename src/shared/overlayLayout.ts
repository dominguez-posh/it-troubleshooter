import type { ImageSize, Point } from './types';
import { clamp } from './coords';

export interface OverlayLayout {
  tip: Point;
  /** Pfeilende (Schaft beginnt hier) */
  tail: Point;
  /** Textlabel */
  label: { x: number; y: number; width: number; height: number };
}

export const ARROW_LEN = 110;
export const LABEL_W = 320;
export const LABEL_H = 80;
const MARGIN = 12;

/**
 * Legt Pfeil und Label so, dass beides im sichtbaren Bereich bleibt.
 * Der Pfeil kommt von links oben auf das Ziel zu; am rechten bzw. unteren Rand wird gespiegelt.
 */
export function layoutOverlay(tip: Point, viewport: ImageSize): OverlayLayout {
  const t = { x: clamp(tip.x, 0, viewport.width), y: clamp(tip.y, 0, viewport.height) };
  const reach = ARROW_LEN * 0.7;
  const needLeft = reach + LABEL_W + MARGIN;
  const needTop = reach + LABEL_H + MARGIN;
  const dx = t.x >= needLeft ? -1 : 1;
  const dy = t.y >= needTop ? -1 : 1;
  const tail = { x: t.x + dx * reach, y: t.y + dy * reach };
  const lx = dx < 0 ? tail.x - LABEL_W : tail.x;
  const ly = dy < 0 ? tail.y - LABEL_H : tail.y;
  return {
    tip: t,
    tail,
    label: {
      x: clamp(lx, MARGIN, Math.max(MARGIN, viewport.width - LABEL_W - MARGIN)),
      y: clamp(ly, MARGIN, Math.max(MARGIN, viewport.height - LABEL_H - MARGIN)),
      width: LABEL_W,
      height: LABEL_H,
    },
  };
}
