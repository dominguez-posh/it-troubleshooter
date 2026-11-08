import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** WCAG-2.x-Kontrast zweier Hex-Farben. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

function vars(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]!] = m[2]!;
  return out;
}

const css = read('src/ui/tokens.css');
const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const light = vars(css.slice(0, darkStart));
const dark = { ...light, ...vars(css.slice(darkStart)) };

const TEXT_PAIRS: Array<[string, string]> = [
  ['text', 'bg'], ['text', 'surface'], ['text', 'surface-2'], ['muted', 'bg'], ['muted', 'surface'], ['muted', 'surface-2'],
  ['accent', 'surface'], ['accent', 'bg'], ['accent', 'surface-2'], ['on-accent', 'accent'],
  ['good', 'good-bg'], ['bad', 'bad-bg'], ['wait', 'wait-bg'], ['info', 'info-bg'],
  ['text', 'bad-bg'], ['text', 'info-bg'], ['text', 'wait-bg'],
];

describe('Barrierefreiheit: Kontrast der Design-Tokens (WCAG AA)', () => {
  for (const [name, theme] of [['hell', light], ['dunkel', dark]] as const) {
    it(`Text-Paare haben mindestens 4,5:1 (${name})`, () => {
      for (const [fg, bg] of TEXT_PAIRS) {
        const r = ratio(theme[fg]!, theme[bg]!);
        expect(r, `${fg} auf ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`Rahmen und Fokus haben mindestens 3:1 (${name})`, () => {
      for (const [fg, bg] of [['line', 'surface'], ['line', 'bg'], ['focus', 'surface'], ['focus', 'bg'], ['accent', 'surface']] as const) {
        expect(ratio(theme[fg]!, theme[bg]!), `${fg} auf ${bg}`).toBeGreaterThanOrEqual(3);
      }
    });
  }
  it('Hell- und Dunkelmodus folgen der Systemeinstellung', () => {
    expect(css).toContain('prefers-color-scheme: dark');
    expect(css).toContain('color-scheme: light dark');
  });
});

describe('Barrierefreiheit: Schrift, Klickflächen, Fokus', () => {
  const files = ['src/ui/tokens.css', 'src/ui/base.css', 'src/renderer/styles.css', 'src/chat/chat.css'];
  it('keine Schrift unter 14 px', () => {
    for (const f of files) {
      for (const m of read(f).matchAll(/font-size:\s*(\d+)px/g)) expect(Number(m[1]), `${f}: ${m[0]}`).toBeGreaterThanOrEqual(14);
      for (const m of read(f).matchAll(/--fs-[a-z]+:\s*(\d+)px/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(14);
    }
  });
  it('Fließtext 16 px, Klickfläche mindestens 40 px, sichtbarer Fokus', () => {
    expect(css).toMatch(/--fs-body:\s*16px/);
    expect(Number(/--tap:\s*(\d+)px/.exec(css)![1])).toBeGreaterThanOrEqual(40);
    expect(read('src/ui/base.css')).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px/);
  });
  it('alle Farben im UI-CSS kommen aus den Tokens (an einer Stelle)', () => {
    for (const f of ['src/ui/base.css', 'src/chat/chat.css', 'src/renderer/styles.css']) {
      const hexes = read(f).match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      expect(hexes.filter((h) => h !== '#0003'), f).toEqual([]);
    }
  });
  it('Maximal zwei Schriftgrößen im Fließtext: 16 px und 14 px (plus Überschriften)', () => {
    expect(css).toMatch(/--fs-small:\s*14px/);
  });
});

describe('Barrierefreiheit: Struktur der Seiten', () => {
  for (const f of ['src/renderer/index.html', 'src/chat/chat.html']) {
    const html = read(f);
    it(`${f}: jeder Button hat sichtbaren Text (keine reinen Icon-Buttons)`, () => {
      for (const m of html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) expect(m[1]!.replace(/<[^>]+>/g, '').trim().length, m[0]).toBeGreaterThan(1);
    });
    it(`${f}: Sprache gesetzt, Seitentitel vorhanden, Skripte nur lokal (CSP)`, () => {
      expect(html).toContain('<html lang="de">');
      expect(html).toMatch(/<title>[^<]+<\/title>/);
      expect(html).toContain("script-src 'self'");
      expect(html).not.toMatch(/\son[a-z]+=/i);
    });
  }
  it('Dialoge sind beschriftet, Eingabefelder haben Beschriftung oder Platzhalter-Label', () => {
    const html = read('src/renderer/index.html');
    for (const m of html.matchAll(/<dialog\b[^>]*>/g)) expect(m[0]).toContain('aria-labelledby');
    for (const m of html.matchAll(/<(?:input|textarea|select)\b[^>]*\bid="([^"]+)"/g)) {
      const id = m[1]!;
      const labelled = new RegExp(`for="${id}"`).test(html) || new RegExp(`<label[^>]*>[^<]*<input[^>]*id="${id}"`).test(html) || new RegExp(`<label[^>]*>[\\s\\S]{0,160}?id="${id}"`).test(html);
      expect(labelled, `Feld ${id} braucht eine Beschriftung`).toBe(true);
    }
  });
  it('Statusanzeigen sind für Screenreader als Live-Region markiert', () => {
    const html = read('src/renderer/index.html');
    expect(html).toMatch(/id="status"[^>]*role="status"/);
    expect(read('src/chat/chat.html')).toMatch(/id="status"[^>]*role="status"/);
  });
});
