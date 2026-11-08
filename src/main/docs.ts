import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { durationMs, formatDuration, STATUS_LABELS, type Incident } from '../shared/incident';
import type { DocRequest, DocVariant, ShotRef } from '../shared/types';
import { resolveInside, ShotError } from './shots';

export interface DocStep {
  n: number;
  text: string;
  outcome: 'done' | 'failed' | null;
  comment?: string;
  /** Dateiname im Paket (images/step-01.jpg) oder null. */
  image: { name: string; data: Buffer } | null;
  imageMissing: boolean;
}

/** Format-unabhängiges Dokumentmodell. Weitere Renderer (DOCX, PDF) können später daran anknüpfen. */
export interface DocModel {
  variant: DocVariant;
  title: string;
  date: string;
  customer: string;
  status: string;
  problem: string;
  summary: string;
  steps: DocStep[];
  commands: Array<{ command: string; explanation: string; mode: 'readonly' | 'changing' }>;
  notes: string[];
  supporterNotes: string;
  duration: string | null;
  usageLine: string | null;
}

export interface DocRenderer {
  readonly id: string;
  readonly fileName: string;
  render(model: DocModel): string;
}

const localDate = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * Baut das Dokumentmodell. Varianten: short = ohne Bilder; full = mit Bildern, internen Notizen, Zeit und Modellinfo;
 * customer = Kundenfassung ohne interne Notizen, Befehle, Zeit, Modell- und Kosteninfos.
 */
export function buildDocModel(
  inc: Incident,
  req: DocRequest,
  getImage: (ref: ShotRef) => Buffer | null,
  nowMs: number,
): DocModel {
  const internal = req.variant !== 'customer';
  const wantImages = req.variant !== 'short';
  const chosen = new Set(req.steps);
  const steps: DocStep[] = [];
  inc.history.forEach((h, i) => {
    const n = i + 1;
    if (!chosen.has(n)) return;
    const step: DocStep = { n, text: h.step.text, outcome: h.outcome, image: null, imageMissing: false };
    if (h.comment && internal) step.comment = h.comment;
    const ref = inc.shots.find((s) => s.stepIndex === n && s.keep);
    if (wantImages && ref) {
      let data: Buffer | null;
      try {
        data = getImage(ref);
      } catch {
        data = null;
      }
      if (data) step.image = { name: `step-${String(n).padStart(2, '0')}.jpg`, data };
      else step.imageMissing = true;
    }
    steps.push(step);
  });
  const model: DocModel = {
    variant: req.variant,
    title: inc.title,
    date: localDate(nowMs),
    customer: inc.customer,
    status: STATUS_LABELS[inc.status],
    problem: inc.problem,
    summary: req.summary.trim().slice(0, 4000),
    steps,
    commands: internal ? inc.commandsUsed : [],
    notes: internal ? inc.notes.map((n) => n.text) : [],
    supporterNotes: internal ? inc.supporterNotes : '',
    duration: internal ? formatDuration(durationMs(inc, nowMs)) : null,
    usageLine: req.variant === 'full' ? `${inc.usage.requests} Anfragen, ${inc.usage.inputTokens + inc.usage.outputTokens} Tokens (Schätzung der Kosten siehe Anwendung)` : null,
  };
  return model;
}

// ---------- Escaping ----------
export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Markdown: HTML-Zeichen entschärfen und Zeilenanfänge/Sonderzeichen maskieren, damit Fremdtext keine Struktur oder Skripte einschleust. */
export function escMd(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([`*_[\]|\\])/g, '\\$1')
    .replace(/^(\s*)([#>+-])/gm, '$1\\$2');
}

const RESULT = { done: 'erledigt', failed: 'hat nicht geklappt' } as const;

export const markdownRenderer: DocRenderer = {
  id: 'markdown',
  fileName: 'doku.md',
  render(m) {
    const L: string[] = [`# ${escMd(m.title)}`, ''];
    L.push(`- Datum: ${m.date}`);
    if (m.customer) L.push(`- Kunde/Referenz: ${escMd(m.customer)}`);
    if (m.variant !== 'customer') L.push(`- Status: ${m.status}`);
    if (m.duration) L.push(`- Zeitaufwand: ${m.duration}`);
    L.push('', '## Problem', '', escMd(m.problem || '(keine Schilderung)'), '');
    if (m.summary) L.push('## Ursache und Lösung', '', escMd(m.summary), '');
    if (m.steps.length) {
      L.push('## Schritte', '');
      for (const s of m.steps) {
        L.push(`${s.n}. ${escMd(s.text)}${s.outcome ? ` (${RESULT[s.outcome]})` : ''}`);
        if (s.comment) L.push(`   - Kommentar: ${escMd(s.comment)}`);
        if (s.image) L.push('', `   ![Schritt ${s.n}](images/${s.image.name})`, '');
        else if (s.imageMissing) L.push('   - (Bild nicht verfügbar)');
      }
      L.push('');
    }
    if (m.commands.length) {
      L.push('## Serverbefehle (vom Supporter ausgeführt)', '');
      for (const c of m.commands) L.push(`- ${c.mode === 'changing' ? '**Ändernd**' : 'Nur lesen'}: ${escMd(c.explanation)}`, '', '  ```', `  ${c.command.replace(/```/g, "'''")}`, '  ```', '');
    }
    if (m.notes.length || m.supporterNotes) {
      L.push('## Hinweise und Zusatzinfos', '');
      for (const n of m.notes) L.push(`- ${escMd(n)}`);
      if (m.supporterNotes) L.push('', escMd(m.supporterNotes));
      L.push('');
    }
    if (m.usageLine) L.push('## Technik', '', escMd(m.usageLine), '');
    return L.join('\n');
  },
};

export const htmlRenderer: DocRenderer = {
  id: 'html',
  fileName: 'doku.html',
  render(m) {
    const e = escHtml;
    const parts: string[] = [];
    parts.push(`<h1>${e(m.title)}</h1>`);
    const meta = [`Datum: ${e(m.date)}`];
    if (m.customer) meta.push(`Kunde/Referenz: ${e(m.customer)}`);
    if (m.variant !== 'customer') meta.push(`Status: ${e(m.status)}`);
    if (m.duration) meta.push(`Zeitaufwand: ${e(m.duration)}`);
    parts.push(`<p class="meta">${meta.join(' · ')}</p>`);
    parts.push(`<h2>Problem</h2><p class="pre">${e(m.problem || '(keine Schilderung)')}</p>`);
    if (m.summary) parts.push(`<h2>Ursache und Lösung</h2><p class="pre">${e(m.summary)}</p>`);
    if (m.steps.length) {
      parts.push('<h2>Schritte</h2><ol>');
      for (const s of m.steps) {
        let li = `<li><p>${e(s.text)}${s.outcome ? ` <em>(${RESULT[s.outcome]})</em>` : ''}</p>`;
        if (s.comment) li += `<p class="meta">Kommentar: ${e(s.comment)}</p>`;
        if (s.image) li += `<img alt="Schritt ${s.n}" src="data:image/jpeg;base64,${s.image.data.toString('base64')}">`;
        else if (s.imageMissing) li += '<p class="meta">(Bild nicht verfügbar)</p>';
        parts.push(`${li}</li>`);
      }
      parts.push('</ol>');
    }
    if (m.commands.length) {
      parts.push('<h2>Serverbefehle (vom Supporter ausgeführt)</h2><ul>');
      for (const c of m.commands) parts.push(`<li>${c.mode === 'changing' ? '<strong>Ändernd</strong>' : 'Nur lesen'}: ${e(c.explanation)}<pre>${e(c.command)}</pre></li>`);
      parts.push('</ul>');
    }
    if (m.notes.length || m.supporterNotes) {
      parts.push('<h2>Hinweise und Zusatzinfos</h2><ul>');
      for (const n of m.notes) parts.push(`<li>${e(n)}</li>`);
      parts.push('</ul>');
      if (m.supporterNotes) parts.push(`<p class="pre">${e(m.supporterNotes)}</p>`);
    }
    if (m.usageLine) parts.push(`<h2>Technik</h2><p>${e(m.usageLine)}</p>`);
    return [
      '<!doctype html><html lang="de"><head><meta charset="utf-8">',
      // Keine Skripte, nur eingebettete Bilder und Inline-Stil.
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">',
      `<title>${e(m.title)}</title>`,
      '<style>body{font:15px/1.5 "Segoe UI",system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#1c2330}img{max-width:100%;border:1px solid #d9dfe8;border-radius:6px}.meta{color:#5d6879;font-size:13px}.pre{white-space:pre-wrap}pre{background:#f4f6f9;padding:6px 10px;border-radius:6px;overflow:auto}</style>',
      '</head><body>',
      parts.join('\n'),
      '</body></html>',
    ].join('\n');
  },
};

// ---------- Export ----------
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Bereinigt einen Dateinamen: keine Pfadtrenner, Steuerzeichen, reservierte Windows-Namen oder Punkte/Leerzeichen am Ende. */
export function sanitizeFileName(name: string, fallback = 'doku'): string {
  let s = name
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .replace(/^[. ]+/, '');
  if (s.length > 80) s = s.slice(0, 80).replace(/[. ]+$/, '');
  if (!s || RESERVED.test(s.split('.')[0] ?? '')) return fallback;
  return s;
}

export interface WriteResult {
  dir: string;
  files: number;
}

/**
 * Schreibt das Paket (doku.md, doku.html, images/) in <ziel>/<bereinigter Name>. Existiert der Ordner bereits, wird nur nach
 * ausdrücklicher Bestätigung (overwrite) überschrieben; sonst Fehler mit Code "exists".
 */
export function writeDocPackage(targetDir: string, folderName: string, model: DocModel, overwrite: boolean, fs = { writeFileSync, mkdirSync }): WriteResult {
  const dir = resolveInside(targetDir, sanitizeFileName(folderName));
  if (existsSync(dir) && !overwrite) throw Object.assign(new ShotError('Der Zielordner existiert bereits.'), { code: 'exists' });
  fs.mkdirSync(resolveInside(dir, 'images'), { recursive: true });
  let files = 0;
  for (const r of [markdownRenderer, htmlRenderer]) {
    fs.writeFileSync(resolveInside(dir, r.fileName), r.render(model), 'utf8');
    files++;
  }
  for (const s of model.steps) {
    if (!s.image) continue;
    fs.writeFileSync(resolveInside(dir, 'images', s.image.name), s.image.data);
    files++;
  }
  return { dir, files };
}
