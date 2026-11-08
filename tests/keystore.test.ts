import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KeyStore, type SafeStorageLike } from '../src/main/keystore';

/** Fake-Verschlüsselung: macht den Klartext in der Datei erkennbar unlesbar (Umkehrung + Präfix). */
function fakeSafe(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from('ENC:' + [...s].reverse().join('')),
    decryptString: (b) => {
      const t = b.toString();
      if (!t.startsWith('ENC:')) throw new Error('bad');
      return [...t.slice(4)].reverse().join('');
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itt-keys-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('KeyStore', () => {
  it('speichert und liest Keys; Datei enthält keinen Klartext', () => {
    const ks = new KeyStore(dir, fakeSafe());
    ks.set('anthropic', 'sk-ant-geheim-123');
    expect(ks.has('anthropic')).toBe(true);
    expect(ks.get('anthropic')).toBe('sk-ant-geheim-123');
    const raw = readFileSync(join(dir, 'keys.json'), 'utf8');
    expect(raw).not.toContain('sk-ant-geheim-123');
    expect(raw).not.toContain('321-meheg');
  });
  it('trimmt den Key und lehnt leere ab', () => {
    const ks = new KeyStore(dir, fakeSafe());
    ks.set('anthropic', '  abc  ');
    expect(ks.get('anthropic')).toBe('abc');
    expect(() => ks.set('anthropic', '   ')).toThrow();
  });
  it('speichert nichts, wenn keine Verschlüsselung verfügbar ist', () => {
    const ks = new KeyStore(dir, fakeSafe(false));
    expect(() => ks.set('anthropic', 'abc')).toThrow(/Verschlüsselung/);
    expect(ks.has('anthropic')).toBe(false);
    expect(() => readFileSync(join(dir, 'keys.json'))).toThrow();
  });
  it('löscht Keys und trennt Provider', () => {
    const ks = new KeyStore(dir, fakeSafe());
    ks.set('anthropic', 'a');
    ks.set('openai', 'b');
    ks.clear('anthropic');
    expect(ks.has('anthropic')).toBe(false);
    expect(ks.get('openai')).toBe('b');
  });
  it('gibt undefined zurück, wenn Entschlüsselung fehlschlägt', () => {
    const ks = new KeyStore(dir, fakeSafe());
    ks.set('anthropic', 'a');
    const other = new KeyStore(dir, { ...fakeSafe(), decryptString: () => { throw new Error('x'); } });
    expect(other.get('anthropic')).toBeUndefined();
  });
  it('lehnt unsichere Provider-IDs ab', () => {
    const ks = new KeyStore(dir, fakeSafe());
    expect(() => ks.set('../evil', 'a')).toThrow();
    expect(() => ks.has('A B')).toThrow();
  });
});
