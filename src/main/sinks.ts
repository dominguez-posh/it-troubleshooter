import { writeFileSync } from 'node:fs';
import type { TimeEntry } from '../shared/incident';

export interface SinkResult {
  /** IDs, die als übertragen gelten. */
  transferredIds: string[];
  detail?: string;
}

/** Austauschbare Schnittstelle zu Zeiterfassungssystemen (später z. B. API, Jira, Tempo). */
export interface TimeTrackingSink {
  readonly id: string;
  readonly name: string;
  submit(entries: TimeEntry[]): Promise<SinkResult>;
}

/** Schutz vor CSV-Injection (Excel & Co.): führende Formelzeichen werden neutralisiert. */
export function neutralize(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/** Eine Zelle nach RFC 4180: Komma, Anführungszeichen und Zeilenumbruch führen zu Anführungszeichen. */
export function csvCell(v: string | number): string {
  const s = typeof v === 'number' ? String(v) : neutralize(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const hhmm = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export const CSV_HEADER = ['Datum', 'Start', 'Ende', 'Dauer in Minuten', 'Incident', 'Kunde', 'Beschreibung'];

export function entriesToCsv(entries: TimeEntry[]): string {
  const rows = entries.map((e) => [e.date, hhmm(e.start), hhmm(e.end), e.durationMinutes, e.incidentTitle, e.customer, e.description]);
  return [CSV_HEADER, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** (a) Lokale Zeiterfassungs-Liste: speichert Einträge mit Status "offen". */
export class LocalListSink implements TimeTrackingSink {
  readonly id = 'local';
  readonly name = 'Lokale Zeiterfassungs-Liste';
  constructor(private readonly store: { addEntry(e: TimeEntry): void }) {}
  async submit(entries: TimeEntry[]): Promise<SinkResult> {
    for (const e of entries) this.store.addEntry({ ...e, status: 'open' });
    return { transferredIds: [] };
  }
}

/** (b) CSV-Export: schreibt die Einträge in eine Datei (UTF-8 mit BOM für Excel) und markiert sie als übertragen. */
export class CsvExportSink implements TimeTrackingSink {
  readonly id = 'csv';
  readonly name = 'CSV-Export';
  constructor(
    private readonly pickPath: () => Promise<string | null>,
    private readonly write: (path: string, data: string) => void = (p, d) => writeFileSync(p, d, 'utf8'),
  ) {}
  async submit(entries: TimeEntry[]): Promise<SinkResult> {
    const path = await this.pickPath();
    if (!path) return { transferredIds: [] };
    this.write(path, `${String.fromCharCode(0xfeff)}${entriesToCsv(entries)}`);
    return { transferredIds: entries.map((e) => e.id), detail: path };
  }
}
