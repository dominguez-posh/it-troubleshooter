import { describe, expect, it } from 'vitest';
import { desktopDipToLocal, fitWidth, imagePointToDesktopDip, rectContains } from '../src/shared/coords';
import { layoutOverlay } from '../src/shared/overlayLayout';

describe('fitWidth', () => {
  it('skaliert große Bilder auf max. Breite und behält das Seitenverhältnis', () => {
    expect(fitWidth({ width: 3840, height: 2160 }, 1600)).toEqual({ width: 1600, height: 900 });
  });
  it('skaliert nie hoch', () => {
    expect(fitWidth({ width: 800, height: 600 }, 1600)).toEqual({ width: 800, height: 600 });
  });
  it('lehnt ungültige Größen ab', () => {
    expect(() => fitWidth({ width: 0, height: 10 }, 1600)).toThrow();
  });
});

describe('imagePointToDesktopDip', () => {
  it('Vollbild bei 100 % DPI: Bildpixel entsprechen DIP', () => {
    const g = { boundsDip: { x: 0, y: 0, width: 1600, height: 900 }, imageSize: { width: 1600, height: 900 } };
    expect(imagePointToDesktopDip({ x: 100, y: 50 }, g)).toEqual({ x: 100, y: 50 });
  });
  it('DPI 150 %: 3840x2160 physisch = 2560x1440 DIP, Bild 1600x900', () => {
    const g = { boundsDip: { x: 0, y: 0, width: 2560, height: 1440 }, imageSize: { width: 1600, height: 900 } };
    expect(imagePointToDesktopDip({ x: 800, y: 450 }, g)).toEqual({ x: 1280, y: 720 });
    expect(imagePointToDesktopDip({ x: 1600, y: 900 }, g)).toEqual({ x: 2560, y: 1440 });
  });
  it('Zweiter Monitor rechts mit Versatz', () => {
    const g = { boundsDip: { x: 1920, y: 0, width: 1920, height: 1080 }, imageSize: { width: 1600, height: 900 } };
    const p = imagePointToDesktopDip({ x: 0, y: 0 }, g);
    expect(p).toEqual({ x: 1920, y: 0 });
    expect(rectContains({ x: 1920, y: 0, width: 1920, height: 1080 }, p)).toBe(true);
  });
  it('Monitor links mit negativen Koordinaten', () => {
    const g = { boundsDip: { x: -1280, y: -200, width: 1280, height: 1024 }, imageSize: { width: 1280, height: 1024 } };
    expect(imagePointToDesktopDip({ x: 10, y: 20 }, g)).toEqual({ x: -1270, y: -180 });
  });
  it('Fenster-Modus: Pfeil relativ zur Fensterposition bei Aufnahme', () => {
    // Fenster bei (300, 120) DIP, 1000x500 DIP groß, Bild auf 500x250 skaliert
    const g = { boundsDip: { x: 300, y: 120, width: 1000, height: 500 }, imageSize: { width: 500, height: 250 } };
    expect(imagePointToDesktopDip({ x: 250, y: 125 }, g)).toEqual({ x: 800, y: 370 });
  });
});

describe('desktopDipToLocal', () => {
  it('rechnet in Overlay-Koordinaten um', () => {
    expect(desktopDipToLocal({ x: 2000, y: 100 }, { x: 1920, y: 0 })).toEqual({ x: 80, y: 100 });
  });
});

describe('layoutOverlay', () => {
  const vp = { width: 1920, height: 1080 };
  it('hält Label im sichtbaren Bereich (Ecke oben links)', () => {
    const l = layoutOverlay({ x: 5, y: 5 }, vp);
    expect(l.label.x).toBeGreaterThanOrEqual(0);
    expect(l.label.y).toBeGreaterThanOrEqual(0);
  });
  it('hält Label im sichtbaren Bereich (Ecke unten rechts)', () => {
    const l = layoutOverlay({ x: 1915, y: 1075 }, vp);
    expect(l.label.x + l.label.width).toBeLessThanOrEqual(vp.width);
    expect(l.label.y + l.label.height).toBeLessThanOrEqual(vp.height);
  });
  it('Pfeil kommt in der Mitte von links oben', () => {
    const l = layoutOverlay({ x: 960, y: 540 }, vp);
    expect(l.tail.x).toBeLessThan(960);
    expect(l.tail.y).toBeLessThan(540);
  });
});
