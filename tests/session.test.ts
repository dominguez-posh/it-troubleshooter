import { describe, expect, it, vi } from 'vitest';
import { CaptureError, type Capturer } from '../src/main/captureTypes';
import { createDefaultRegistry } from '../src/main/llm';
import type { OverlayController } from '../src/main/overlay';
import { SessionService } from '../src/main/session';
import type { Point } from '../src/shared/types';

function setup(opts: { providerId?: string; key?: string; capture?: Capturer['capture'] } = {}) {
  const shows: Array<{ tip: Point | null; text: string }> = [];
  const overlay: OverlayController = {
    show: vi.fn(async (tip, text) => void shows.push({ tip, text })),
    hide: vi.fn(),
  };
  const capturer: Capturer = {
    listSources: async () => [],
    capture:
      opts.capture ??
      (async () => ({
        jpegBase64: 'AAAA',
        imageSize: { width: 1600, height: 900 },
        kind: 'screen' as const,
        // 150 % DPI: 2560x1440 DIP auf einem Monitor mit Versatz 1920
        geometry: { boundsDip: { x: 1920, y: 0, width: 2560, height: 1440 }, imageSize: { width: 1600, height: 900 } },
      })),
  };
  const svc = new SessionService({
    registry: createDefaultRegistry(),
    capturer,
    overlay,
    getProviderId: () => opts.providerId ?? 'mock',
    getModel: () => 'm',
    getApiKey: () => opts.key,
  });
  return { svc, overlay, shows };
}

describe('SessionService (Mock-Ablauf Ende-zu-Ende)', () => {
  it('führt Schritt für Schritt bis zur Lösung und rechnet Koordinaten in Desktop-DIP um', async () => {
    const { svc, shows } = setup();
    const r1 = await svc.start('Drucker druckt nicht', 'screen:0:0');
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.value.current?.index).toBe(1);
    const t = r1.value.current!.step.target!;
    // Mock zeigt auf Bildpunkt t -> Overlay bekommt Desktop-DIP = 1920 + t.x * 2560/1600
    expect(shows[0]!.tip!.x).toBeCloseTo(1920 + t.x * (2560 / 1600));
    expect(shows[0]!.tip!.y).toBeCloseTo(t.y * (1440 / 900));

    const r2 = await svc.report('done');
    expect(r2.ok && r2.value.current?.index).toBe(2);
    const r3 = await svc.report('failed', '  geht nicht  ');
    expect(r3.ok && r3.value.history[1]).toMatchObject({ outcome: 'failed', comment: 'geht nicht' });
    const r4 = await svc.report('done');
    expect(r4.ok && r4.value.current?.step.target).toBeNull();

    const solved = await svc.markSolved();
    expect(solved.ok && solved.value.solved).toBe(true);
    expect(solved.ok && solved.value.history).toHaveLength(4);
    expect(solved.ok && solved.value.current).toBeNull();
  });

  it('gibt den bisherigen Verlauf an den Provider weiter', async () => {
    const { svc } = setup();
    await svc.start('p', 'screen:0:0');
    const r = await svc.report('done');
    expect(r.ok && r.value.history).toHaveLength(1);
  });

  it('verlangt Problem und meldet fehlenden Key (ohne Capture)', async () => {
    const capture = vi.fn();
    const { svc } = setup({ providerId: 'anthropic', capture });
    expect(await svc.start('   ', 'screen:0:0')).toMatchObject({ ok: false });
    const r = await svc.start('Problem', 'screen:0:0');
    expect(r).toMatchObject({ ok: false, error: { code: 'no_key' } });
    expect(capture).not.toHaveBeenCalled();
  });

  it('meldet Aufnahmefehler und behält bei Fehlern im Folgeschritt den Zustand', async () => {
    let fail = false;
    const { svc } = setup({
      capture: async () => {
        if (fail) throw new CaptureError('weg');
        return {
          jpegBase64: 'A',
          imageSize: { width: 100, height: 100 },
          kind: 'screen' as const,
          geometry: { boundsDip: { x: 0, y: 0, width: 100, height: 100 }, imageSize: { width: 100, height: 100 } },
        };
      },
    });
    await svc.start('p', 'screen:0:0');
    fail = true;
    const r = await svc.report('done');
    expect(r).toMatchObject({ ok: false, error: { code: 'capture' } });
    expect(svc.view().history).toHaveLength(0);
    expect(svc.view().current?.index).toBe(1);
    fail = false;
    expect((await svc.report('done')).ok).toBe(true);
  });

  it('reset blendet das Overlay aus und leert den Zustand', async () => {
    const { svc, overlay } = setup();
    await svc.start('p', 'screen:0:0');
    await svc.reset();
    expect(overlay.hide).toHaveBeenCalled();
    expect(svc.view()).toMatchObject({ problem: '', current: null, history: [] });
  });
});
