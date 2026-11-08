import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDocModel, escHtml, escMd, htmlRenderer, markdownRenderer, sanitizeFileName, writeDocPackage } from '../src/main/docs';
import { CostGuard } from '../src/main/cost';
import { IncidentManager } from '../src/main/incidents';
import { IncidentStore } from '../src/main/incidentStore';
import { createDefaultRegistry, ProviderRegistry } from '../src/main/llm';
import { createMockProvider } from '../src/main/llm/mock';
import { buildSummaryText } from '../src/main/llm/prompt';
import type { Capturer } from '../src/main/captureTypes';
import { SessionService } from '../src/main/session';
import type { SafeStorageLike } from '../src/main/keystore';
import {
  blackOut,
  checkIncidentId,
  checkShotId,
  drawMarker,
  resolveInside,
  ShotCrypto,
  ShotError,
  ShotStore,
  validateRects,
  type ImageOps,
  type RawImage,
} from '../src/main/shots';
import type { Incident } from '../src/shared/incident';
import type { ShotRef } from '../src/shared/types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itt-shots-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const safe = (available = true): SafeStorageLike => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(`ENC:${s}`),
  decryptString: (b) => b.toString().replace(/^ENC:/, ''),
});

/** Fake-Bildformat: 8 Byte Breite/Höhe, danach BGRA-Pixel. Keine echte Bildverarbeitung, keine Bildschirmaufnahme. */
const fakeOps: ImageOps = {
  decode(b) {
    return { width: b.readUInt32LE(0), height: b.readUInt32LE(4), data: b.subarray(8) };
  },
  encode(raw) {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(raw.width, 0);
    h.writeUInt32LE(raw.height, 4);
    return Buffer.concat([h, raw.data]);
  },
};
const image = (w = 10, h = 10, fill = 200): Buffer => fakeOps.encode({ width: w, height: h, data: Buffer.alloc(w * h * 4, fill) }, 80);
const meta = { stepIndex: 1, text: 'Klick', target: { x: 5, y: 5 }, imageSize: { width: 10, height: 10 }, source: 'Bildschirm' };
const INC = '11111111-2222-3333-4444-555555555555';

const store = (opts: { available?: boolean; now?: () => number } = {}) => new ShotStore(dir, new ShotCrypto(dir, safe(opts.available ?? true)), undefined, opts.now);

describe('Pfadsicherheit', () => {
  it('resolveInside lehnt Ausbruch aus dem Ordner ab', () => {
    expect(resolveInside(dir, 'a', 'b')).toContain('a');
    expect(() => resolveInside(dir, '..', 'x')).toThrow(ShotError);
    expect(() => resolveInside(dir, 'a/../../x')).toThrow(ShotError);
    expect(() => resolveInside(dir, 'C:\\Windows')).toThrow(ShotError);
  });
  it('Kennungen werden streng validiert', () => {
    expect(checkIncidentId(INC)).toBe(INC);
    for (const bad of ['../x', 'a/b', 'a\\b', '', 'x'.repeat(70), '..', 'a b', null, 5]) expect(() => checkIncidentId(bad)).toThrow(ShotError);
    expect(() => checkShotId('../etc')).toThrow();
    expect(() => checkShotId('ABC')).toThrow();
    expect(checkShotId('abcdef12-3456')).toBe('abcdef12-3456');
  });
  it('ShotStore verweigert manipulierte Kennungen', () => {
    const s = store();
    expect(() => s.save('../evil', image(), meta)).toThrow(ShotError);
    expect(() => s.remove(INC, '../../x')).toThrow(ShotError);
    expect(() => s.deleteIncident('..')).toThrow(ShotError);
  });
});

describe('Verschlüsselung', () => {
  it('Roundtrip; auf der Platte steht kein Klartext; Dateischlüssel ist selbst geschützt', () => {
    const s = store();
    const plain = Buffer.from('GEHEIMES-BILD-'.repeat(20));
    const ref = s.save(INC, plain, meta);
    expect(ref.encrypted).toBe(true);
    const files = readdirSync(join(dir, 'incidents', INC, 'shots'));
    expect(files).toEqual([`${ref.id}.orig.bin`]);
    expect(readFileSync(join(dir, 'incidents', INC, 'shots', files[0]!)).includes(Buffer.from('GEHEIMES-BILD'))).toBe(false);
    expect(s.read(INC, ref, 'original').equals(plain)).toBe(true);
    const keyFile = readFileSync(join(dir, 'shots.key'), 'utf8');
    expect(Buffer.from(keyFile, 'base64').toString()).toMatch(/^ENC:/); // nur per safeStorage geschützt abgelegt
  });
  it('manipulierte oder gekürzte Dateien werden erkannt', () => {
    const s = store();
    const ref = s.save(INC, image(), meta);
    const path = join(dir, 'incidents', INC, 'shots', `${ref.id}.orig.bin`);
    const blob = readFileSync(path);
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 0xff;
    writeFileSync(path, blob);
    expect(() => s.read(INC, ref, 'original')).toThrow(/beschädigt|verändert/);
    writeFileSync(path, Buffer.from([1, 2, 3]));
    expect(() => s.read(INC, ref, 'original')).toThrow(ShotError);
  });
  it('ohne safeStorage: Klartext, aber sichtbar gekennzeichnet (encrypted=false)', () => {
    const s = store({ available: false });
    const ref = s.save(INC, image(), meta);
    expect(ref.encrypted).toBe(false);
    expect(s.encryptionAvailable).toBe(false);
    expect(s.read(INC, ref, 'original').length).toBeGreaterThan(0);
    expect(existsSync(join(dir, 'shots.key'))).toBe(false);
  });
  it('anderer Schlüssel (anderes Profil): verständlicher Fehler statt Absturz', () => {
    const ref = store().save(INC, image(), meta);
    rmSync(join(dir, 'shots.key'));
    expect(() => new ShotStore(dir, new ShotCrypto(dir, safe(true))).read(INC, ref, 'original')).toThrow(/Dateischlüssel/);
  });
});

describe('Speichern, Lesen, Fehlerfälle', () => {
  it('Verweis enthält Metadaten und Prüfsumme, aber keine Bilddaten; JSON bleibt bildfrei', () => {
    const ref = store().save(INC, image(), meta);
    expect(ref).toMatchObject({ stepIndex: 1, text: 'Klick', target: { x: 5, y: 5 }, source: 'Bildschirm', keep: true, redacted: false });
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(ref)).not.toMatch(/base64|jpeg/i);
  });
  it('Prüfsumme wird beim Lesen geprüft', () => {
    const s = store();
    const ref = s.save(INC, image(), meta);
    expect(() => s.read(INC, { ...ref, sha256: '0'.repeat(64) }, 'original')).toThrow(/Prüfsumme/);
  });
  it('Datei fehlt', () => {
    const s = store();
    const ref = s.save(INC, image(), meta);
    s.remove(INC, ref.id);
    expect(() => s.read(INC, ref, 'original')).toThrow(/fehlt/);
  });
  it('Platte voll: klare Meldung, keine halbe Datei als Ergebnis', () => {
    const s = new ShotStore(dir, new ShotCrypto(dir, safe()), {
      writeFileSync: () => {
        throw new Error('ENOSPC');
      },
      renameSync: () => undefined,
    });
    expect(() => s.save(INC, image(), meta)).toThrow(/Platte voll/);
  });
  it('leere oder zu große Bilder werden abgelehnt', () => {
    const s = store();
    expect(() => s.save(INC, Buffer.alloc(0), meta)).toThrow(ShotError);
    expect(() => s.save(INC, Buffer.alloc(9 * 1024 * 1024), meta)).toThrow(/Größe/);
  });
});

describe('Aufbewahrung und Löschen', () => {
  it('abgelaufene Screenshots (Fake-Zeit) werden erkannt und entfernt', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const clock = { t: Date.now() };
    const s = store({ now: () => clock.t });
    const old = s.save(INC, image(), meta);
    clock.t += 29 * 86_400_000;
    const fresh = s.save(INC, image(), { ...meta, stepIndex: 2 });
    clock.t += 2 * 86_400_000; // alt: 31 Tage, neu: 2 Tage
    const gone = s.expired([old, fresh], 30);
    expect(gone.map((g) => g.id)).toEqual([old.id]);
    s.remove(INC, old.id);
    expect(() => s.read(INC, old, 'original')).toThrow();
    expect(s.read(INC, fresh, 'original').length).toBeGreaterThan(0);
    vi.useRealTimers();
  });
  it('Incident-Löschen entfernt den Ordner mit allen Bildern; "Alle löschen" alle Incidents', () => {
    const s = store();
    s.save(INC, image(), meta);
    s.save('other-incident-1', image(), meta);
    s.deleteIncident(INC);
    expect(existsSync(join(dir, 'incidents', INC))).toBe(false);
    expect(existsSync(join(dir, 'incidents', 'other-incident-1'))).toBe(true);
    s.deleteAll();
    expect(existsSync(join(dir, 'incidents'))).toBe(false);
  });
  it('Manager: abgelaufene Verweise werden entfernt, übrige bleiben', () => {
    const st = new IncidentStore(dir);
    st.load();
    const m = new IncidentManager(st, () => Date.parse('2026-02-01T00:00:00Z'));
    const id = m.create('p', false);
    const mk = (sid: string, at: string): ShotRef => ({ id: sid, at, stepIndex: 1, text: 't', target: null, imageSize: { width: 1, height: 1 }, source: 's', keep: true, sha256: 'x', bytes: 1, redacted: false, encrypted: true });
    m.addShot(id, mk('aaaaaaaa-0001', '2026-01-01T00:00:00Z'));
    m.addShot(id, mk('aaaaaaaa-0002', '2026-01-30T00:00:00Z'));
    const limit = Date.parse('2026-02-01T00:00:00Z') - 30 * 86_400_000;
    expect(m.collectExpired((s) => Date.parse(s.at) < limit)).toEqual([{ incidentId: id, shotId: 'aaaaaaaa-0001' }]);
    expect(m.shotRefs(id).map((s) => s.id)).toEqual(['aaaaaaaa-0002']);
    expect(m.clearAllShotRefs()).toBe(1);
    expect(m.shotRefs(id)).toEqual([]);
  });
});

describe('Schwärzen (echte Pixel-Überschreibung)', () => {
  const raw = (): RawImage => ({ width: 10, height: 10, data: Buffer.alloc(400, 200) });
  it('blackOut überschreibt nur die Rechtecke und lässt das Original unberührt', () => {
    const src = raw();
    const out = blackOut(src, [{ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }]);
    const px = (r: RawImage, x: number, y: number) => [...r.data.subarray((y * 10 + x) * 4, (y * 10 + x) * 4 + 4)];
    expect(px(out, 3, 3)).toEqual([0, 0, 0, 255]);
    expect(px(out, 0, 0)).toEqual([200, 200, 200, 200]);
    expect(px(out, 9, 9)).toEqual([200, 200, 200, 200]);
    expect(src.data.every((b) => b === 200)).toBe(true);
  });
  it('Store: geschwärzte Kopie wird getrennt abgelegt, Original bleibt prüfsummenkonform; Export nutzt nur die Kopie', () => {
    const s = store();
    const ref = s.save(INC, image(), { ...meta, target: null });
    const red = s.redact(INC, ref, [{ x: 0, y: 0, w: 0.5, h: 0.5 }], fakeOps);
    expect(red.redacted).toBe(true);
    expect(s.read(INC, red, 'original').equals(image())).toBe(true);
    const copy = fakeOps.decode(s.read(INC, red, 'redacted'));
    expect([...copy.data.subarray(0, 4)]).toEqual([0, 0, 0, 255]);
    expect(copy.data[copy.data.length - 1]).toBe(200);
    expect(fakeOps.decode(s.exportImage(INC, red, fakeOps)).data[0]).toBe(0);
    // zweites Schwärzen addiert sich auf der Kopie
    const red2 = s.redact(INC, red, [{ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }], fakeOps);
    const c2 = fakeOps.decode(s.read(INC, red2, 'redacted'));
    expect(c2.data[0]).toBe(0);
    expect(c2.data[(9 * 10 + 9) * 4]).toBe(0);
  });
  it('Bereiche werden validiert', () => {
    expect(() => validateRects([])).toThrow();
    expect(() => validateRects([{ x: -1, y: 0, w: 0.1, h: 0.1 }])).toThrow();
    expect(() => validateRects([{ x: 0.9, y: 0, w: 0.5, h: 0.1 }])).toThrow();
    expect(() => validateRects([{ x: 0, y: 0, w: NaN, h: 0.1 }])).toThrow();
    expect(() => validateRects(Array.from({ length: 51 }, () => ({ x: 0, y: 0, w: 0.1, h: 0.1 })))).toThrow();
    expect(validateRects([{ x: 0, y: 0, w: 1, h: 1 }])).toHaveLength(1);
  });
  it('Pfeil-Markierung wird nur in eine Kopie gezeichnet', () => {
    const src: RawImage = { width: 100, height: 100, data: Buffer.alloc(100 * 100 * 4, 255) };
    const out = drawMarker(src, { x: 50, y: 50 });
    expect(out.data.equals(src.data)).toBe(false);
    expect(src.data.every((b) => b === 255)).toBe(true);
    const s = store();
    const ref = s.save(INC, image(40, 40), { ...meta, target: { x: 20, y: 20 } });
    expect(s.exportImage(INC, ref, fakeOps).equals(s.read(INC, ref, 'original'))).toBe(false);
  });
});

const incident = (over: Partial<Incident> = {}): Incident =>
  ({
    id: INC, title: 'Drucker "streikt" <b>', customer: 'ACME', problem: 'Drucker druckt nicht <script>alert(1)</script>', createdAt: 'x', updatedAt: 'x', status: 'solved',
    recommendation: null, inSteps: false, events: [],
    history: [
      { step: { text: 'Startmenü öffnen', target: null }, outcome: 'done' },
      { step: { text: 'Einstellungen öffnen', target: null }, outcome: 'failed', comment: 'interner Kommentar' },
      { step: { text: 'Treiber neu installieren', target: null }, outcome: 'done' },
    ],
    currentStep: null, notes: [{ text: 'interne Zusatzinfo', afterSteps: 0 }], supporterNotes: 'private Notiz', serverAccess: null,
    storeShots: true,
    shots: [1, 3].map((n) => ({ id: `shot0000-000${n}`, at: 'x', stepIndex: n, text: 't', target: null, imageSize: { width: 10, height: 10 }, source: 's', keep: true, sha256: 'x', bytes: 1, redacted: false, encrypted: true })),
    commandsUsed: [{ command: 'Get-Service', explanation: 'Dienste prüfen', mode: 'readonly' }],
    segments: [{ start: '2026-01-01T10:00:00Z', end: '2026-01-01T10:30:00Z' }], manualAdjustmentMs: 0, loggedMs: 0, lastActiveAt: 'x', reopens: [],
    usage: { requests: 4, inputTokens: 1000, outputTokens: 100, costUsd: 0.5 }, llmLog: [], ...over,
  }) as Incident;
const img = (ref: ShotRef) => Buffer.from(`IMG-${ref.stepIndex}`);
const NOW = Date.parse('2026-01-02T12:00:00Z');

describe('Doku: Varianten und Auswahl', () => {
  it('Ausführlich: mit Bildern, Notizen, Befehlen, Zeit und Technik', () => {
    const m = buildDocModel(incident(), { variant: 'full', steps: [1, 2, 3], summary: 'Treiber war defekt.' }, img, NOW);
    expect(m.steps.map((s) => s.image?.name ?? null)).toEqual(['step-01.jpg', null, 'step-03.jpg']);
    expect(m.commands).toHaveLength(1);
    expect(m.notes).toEqual(['interne Zusatzinfo']);
    expect(m.duration).toBe('30 min');
    expect(m.usageLine).toContain('4 Anfragen');
    const md = markdownRenderer.render(m);
    expect(md).toContain('![Schritt 1](images/step-01.jpg)');
    expect(md).toContain('Kommentar: interner Kommentar');
  });
  it('Kurz-Doku: ohne Bilder', () => {
    const m = buildDocModel(incident(), { variant: 'short', steps: [1, 2, 3], summary: 's' }, img, NOW);
    expect(m.steps.every((s) => s.image === null)).toBe(true);
    expect(markdownRenderer.render(m)).not.toContain('![');
    expect(htmlRenderer.render(m)).not.toContain('<img');
  });
  it('Kundenfassung: ohne interne Notizen, Befehle, Zeit, Modell-/Kosteninfos und Kommentare', () => {
    const m = buildDocModel(incident(), { variant: 'customer', steps: [1, 2, 3], summary: 'Gelöst.' }, img, NOW);
    const all = markdownRenderer.render(m) + htmlRenderer.render(m);
    for (const secret of ['interne Zusatzinfo', 'private Notiz', 'interner Kommentar', 'Get-Service', 'Anfragen', 'Tokens', 'Zeitaufwand', 'Status:']) expect(all).not.toContain(secret);
    expect(all).toContain('step-01.jpg');
  });
  it('Schrittauswahl: nur gewählte Schritte und deren Bilder', () => {
    const m = buildDocModel(incident(), { variant: 'full', steps: [3], summary: '' }, img, NOW);
    expect(m.steps.map((s) => s.n)).toEqual([3]);
    expect(m.steps[0]!.image?.name).toBe('step-03.jpg');
  });
  it('nicht behaltene oder fehlende Bilder: kein Absturz, Hinweis im Text', () => {
    const inc = incident();
    inc.shots[0]!.keep = false;
    const m = buildDocModel(inc, { variant: 'full', steps: [1, 3], summary: '' }, () => {
      throw new Error('Datei fehlt');
    }, NOW);
    expect(m.steps[0]!.image).toBeNull();
    expect(m.steps[1]!.imageMissing).toBe(true);
    expect(markdownRenderer.render(m)).toContain('Bild nicht verfügbar');
  });
});

describe('Export-Sicherheit', () => {
  it('HTML: Fremdtext wird escaped, CSP verbietet Skripte, Bilder nur als data-URL', () => {
    const m = buildDocModel(incident(), { variant: 'full', steps: [1], summary: '<img src=x onerror=alert(1)>' }, img, NOW);
    const html = htmlRenderer.render(m);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('src="data:image/jpeg;base64,');
    expect(escHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
  it('Markdown: HTML und Zeilenstruktur aus Fremdtext werden entschärft', () => {
    const md = markdownRenderer.render(buildDocModel(incident({ problem: '# Titel\n<script>x</script>\n- Punkt' }), { variant: 'short', steps: [], summary: '' }, img, NOW));
    expect(md).not.toContain('<script>');
    expect(md).toContain('\\# Titel');
    expect(md).toContain('&lt;script&gt;');
    expect(escMd('a|b`c')).toBe('a\\|b\\`c');
  });
  it('Dateinamen: kein Path Traversal, keine reservierten Windows-Namen, begrenzte Länge', () => {
    expect(sanitizeFileName('../../Windows/System32')).not.toMatch(/[\\/]/);
    expect(sanitizeFileName('a\\b/c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    for (const r of ['CON', 'nul', 'COM1', 'lpt9', 'aux.txt']) expect(sanitizeFileName(r)).toBe('doku');
    expect(sanitizeFileName('  ..  ')).toBe('doku');
    expect(sanitizeFileName('x'.repeat(200)).length).toBeLessThanOrEqual(80);
    expect(sanitizeFileName('Name. ')).toBe('Name');
    expect(sanitizeFileName('')).toBe('doku');
  });
  it('Paket: relative Bildpfade, nur erlaubte Dateien, Ziel nur innerhalb des gewählten Ordners', () => {
    const m = buildDocModel(incident(), { variant: 'full', steps: [1, 2, 3], summary: 's' }, img, NOW);
    const res = writeDocPackage(dir, '../../ausbruch?', m, false);
    expect(res.dir.startsWith(dir)).toBe(true);
    expect(readdirSync(res.dir).sort()).toEqual(['doku.html', 'doku.md', 'images']);
    expect(readdirSync(join(res.dir, 'images')).sort()).toEqual(['step-01.jpg', 'step-03.jpg']);
    expect(res.files).toBe(4);
    expect(readFileSync(join(res.dir, 'doku.md'), 'utf8')).toContain('](images/step-01.jpg)');
    expect(readFileSync(join(res.dir, 'doku.md'), 'utf8')).not.toMatch(/[A-Za-z]:\\/);
  });
  it('Überschreiben nur nach Bestätigung', () => {
    const m = buildDocModel(incident(), { variant: 'short', steps: [], summary: '' }, img, NOW);
    writeDocPackage(dir, 'Doku', m, false);
    expect(() => writeDocPackage(dir, 'Doku', m, false)).toThrow(expect.objectContaining({ code: 'exists' }));
    expect(writeDocPackage(dir, 'Doku', m, true).files).toBe(2);
  });
});

describe('Dokutext ohne Bild-Payload und Sitzungs-Integration', () => {
  it('Zusammenfassungs-Prompt für die Doku enthält nur Text', () => {
    const t = buildSummaryText({ problem: 'P', history: [], notes: [], result: 'solved', purpose: 'doc' });
    expect(t).toContain('Dokumentation');
    expect(t).not.toMatch(/Screenshot|base64|jpeg/i);
  });
  it('Session.summarize(doc) ruft den Anbieter ohne Bildfelder auf', async () => {
    const seen: unknown[] = [];
    const base = createMockProvider();
    const reg = new ProviderRegistry().register({
      id: 'spy', name: 's', requiresKey: false, tiers: { medium: 'm' }, knownModels: [],
      create: () => ({ ...base, summarize: (req, o) => (seen.push(req), base.summarize(req, o)) }),
    });
    const { svc } = session({ registry: reg, providerId: 'spy' });
    const text = await svc.summarize({ problem: 'p', history: [], notes: [] }, 'solved', 'doc');
    expect(text).toContain('Mock-Zusammenfassung');
    expect(JSON.stringify(seen)).not.toMatch(/screenshot|jpeg|imageSize/i);
    expect(seen[0]).toMatchObject({ purpose: 'doc' });
  });

  function session(opts: { registry?: ProviderRegistry; providerId?: string; failSave?: boolean } = {}) {
    const clock = { t: Date.UTC(2026, 10, 8, 10) };
    const st = new IncidentStore(dir);
    st.load();
    const incidents = new IncidentManager(st, () => clock.t);
    const capturer: Capturer = {
      listSources: async () => [],
      defaultSourceId: async () => 'screen:0:0',
      grabFrame: async () => ({ width: 1, height: 1, data: new Uint8Array(1) }),
      capture: async () => ({ jpegBase64: Buffer.from('FAKE-JPEG-BYTES').toString('base64'), imageSize: { width: 100, height: 100 }, kind: 'window', sourceName: 'Testfenster', geometry: { boundsDip: { x: 0, y: 0, width: 100, height: 100 }, imageSize: { width: 100, height: 100 } } }),
    };
    const shots = opts.failSave
      ? new ShotStore(dir, new ShotCrypto(dir, safe()), { writeFileSync: () => { throw new Error('ENOSPC'); }, renameSync: () => undefined })
      : store();
    const svc = new SessionService({
      registry: opts.registry ?? createDefaultRegistry(), capturer, overlay: { show: async () => undefined, hide: () => undefined, setPill: () => undefined },
      persistence: incidents, cost: new CostGuard(dir, () => ({ warnEur: null, limitEur: null, incidentLimitEur: null, period: 'month', usdEurRate: 1 }), () => clock.t),
      shots,
      getProviderId: () => opts.providerId ?? 'mock', getApiKey: () => undefined,
      getModels: () => ({ small: 'mock-small', medium: 'mock-medium', large: 'mock-large' }),
      getRouting: () => ({ triage: 'small', step: 'medium', summary: 'small', call: 'small' }),
      getFailedThreshold: () => 2, getDropBack: () => true, getCaptureOptions: () => ({ maxWidth: 1280, quality: 70 }), getReevaluate: () => false, now: () => clock.t,
    });
    return { svc, incidents, shots };
  }
  const ok = <T,>(r: { ok: boolean } & ({ value: T } | { error: unknown })): T => {
    if (!r.ok) throw new Error(JSON.stringify((r as { error: unknown }).error));
    return (r as { value: T }).value;
  };

  it('jeder Schritt mit Screenshot wird lokal gespeichert, Ergebnis wird am Bild vermerkt, JSON enthält keine Bilddaten', async () => {
    const { svc, incidents, shots } = session();
    const v0 = ok(await svc.start('Drucker'));
    expect(v0.shots).toMatchObject({ enabled: true, count: 0, encrypted: true }); // vor Fernwartung kein Bild
    const v1 = ok(await svc.react('done'));
    expect(v1.shots.count).toBe(1);
    ok(await svc.report('failed'));
    const refs = incidents.shotRefs(v0.incidentId!);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toMatchObject({ stepIndex: 1, source: 'Testfenster', outcome: 'failed' });
    expect(shots.read(v0.incidentId!, refs[0]!, 'original').toString()).toBe('FAKE-JPEG-BYTES');
    expect(readFileSync(join(dir, 'incidents.json'), 'utf8')).not.toContain(Buffer.from('FAKE-JPEG-BYTES').toString('base64'));
  });
  it('pro Incident abschaltbar: dann wird nichts gespeichert und die Anzeige sagt es', async () => {
    const { svc, incidents } = session();
    const id = ok(await svc.start('Drucker')).incidentId!;
    incidents.setStoreShots(id, false);
    const v = ok(await svc.react('done'));
    expect(v.shots).toMatchObject({ enabled: false, count: 0 });
    expect(existsSync(join(dir, 'incidents', id))).toBe(false);
  });
  it('Platte voll: Sitzung läuft weiter, Fehler wird angezeigt', async () => {
    const { svc } = session({ failSave: true });
    ok(await svc.start('Drucker'));
    const v = ok(await svc.react('done'));
    expect(v.phase).toBe('steps');
    expect(v.shots.error).toMatch(/Platte voll/);
  });
});
