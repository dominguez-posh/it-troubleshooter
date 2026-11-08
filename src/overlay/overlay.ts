import { layoutOverlay } from '../shared/overlayLayout';
import type { OverlayPayload } from '../shared/types';

declare global {
  interface Window {
    overlayApi: { onShow(cb: (p: OverlayPayload) => void): void };
  }
}

// Alle Stile per CSSOM/Attributen, damit die CSP kein 'unsafe-inline' braucht.
document.documentElement.style.background = 'transparent';
document.body.style.cssText = 'margin:0;overflow:hidden;background:transparent;';

const SVG_NS = 'http://www.w3.org/2000/svg';
const COLOR = '#ff2d55';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function pillEl(text: string): HTMLDivElement {
  const d = document.createElement('div');
  d.textContent = text;
  d.style.cssText =
    'position:fixed;right:16px;bottom:16px;max-width:360px;padding:6px 12px;border-radius:999px;background:rgba(20,24,33,0.82);color:#fff;font:500 13px "Segoe UI",system-ui,sans-serif;border:1px solid rgba(255,255,255,.25);';
  return d;
}

function render(p: OverlayPayload): void {
  document.body.replaceChildren();
  if (p.pill) document.body.append(pillEl(p.pill));
  if (!p.tip && !p.text) return;
  const { viewport } = p;
  const root = svg('svg', { width: viewport.width, height: viewport.height, viewBox: `0 0 ${viewport.width} ${viewport.height}` });
  root.style.cssText = 'position:fixed;left:0;top:0;';
  document.body.append(root);

  const label = document.createElement('div');
  label.textContent = p.text;
  const base =
    'position:fixed;box-sizing:border-box;padding:10px 14px;background:rgba(20,24,33,0.94);color:#fff;' +
    'font:600 16px/1.3 "Segoe UI",system-ui,sans-serif;border-radius:10px;border:2px solid ' +
    COLOR +
    ';overflow:hidden;box-shadow:0 4px 18px rgba(0,0,0,.45);';

  if (!p.tip) {
    label.style.cssText = `${base}left:50%;top:24px;transform:translateX(-50%);max-width:420px;`;
    document.body.append(label);
    return;
  }

  const l = layoutOverlay(p.tip, viewport);
  // Schaft
  root.append(svg('line', { x1: l.tail.x, y1: l.tail.y, x2: l.tip.x, y2: l.tip.y, stroke: COLOR, 'stroke-width': 7, 'stroke-linecap': 'round' }));
  // Spitze
  const ang = Math.atan2(l.tip.y - l.tail.y, l.tip.x - l.tail.x);
  const head = 26;
  const a1 = ang + Math.PI * 0.85;
  const a2 = ang - Math.PI * 0.85;
  const pts = [
    [l.tip.x, l.tip.y],
    [l.tip.x + head * Math.cos(a1), l.tip.y + head * Math.sin(a1)],
    [l.tip.x + head * Math.cos(a2), l.tip.y + head * Math.sin(a2)],
  ]
    .map((q) => q.join(','))
    .join(' ');
  root.append(svg('polygon', { points: pts, fill: COLOR, stroke: COLOR, 'stroke-width': 3, 'stroke-linejoin': 'round' }));
  // Zielring
  root.append(svg('circle', { cx: l.tip.x, cy: l.tip.y, r: 14, fill: 'none', stroke: COLOR, 'stroke-width': 3 }));

  label.style.cssText = `${base}left:${l.label.x}px;top:${l.label.y}px;width:${l.label.width}px;max-height:${l.label.height}px;`;
  document.body.append(label);
}

window.overlayApi.onShow(render);
