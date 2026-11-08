import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SCHEMA_VERSION, type Incident, type TimeEntry } from '../shared/incident';

const point = z.object({ x: z.number(), y: z.number() });
const step = z.object({
  text: z.string(),
  target: point.nullable().default(null),
  reason: z.string().optional(),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
});
const action = z.enum(['ask_customer', 'start_remote', 'contact_customer', 'answer_directly', 'do_step', 'wait_check', 'escalate', 'close', 'check_server_access']);
const status = z.enum(['draft', 'call', 'triage', 'waiting', 'remote', 'paused', 'solved', 'unsolved']);
const iso = z.string().default(() => new Date().toISOString());

const incidentSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  title: z.string().default('Ohne Titel'),
  customer: z.string().default(''),
  problem: z.string().default(''),
  createdAt: iso,
  updatedAt: iso,
  status: status.default('paused'),
  recommendation: z
    .object({ action, instruction: z.string(), reason: z.string() })
    .passthrough()
    .nullable()
    .default(null),
  inSteps: z.boolean().default(false),
  events: z
    .array(
      z.object({
        at: z.string(),
        action,
        instruction: z.string(),
        response: z.enum(['done', 'other', 'later']),
        comment: z.string().optional(),
      }),
    )
    .default([]),
  history: z
    .array(z.object({ step, outcome: z.enum(['done', 'failed']), comment: z.string().optional() }))
    .default([]),
  currentStep: step.nullable().default(null),
  notes: z.array(z.object({ text: z.string(), afterSteps: z.number().int().min(0) })).default([]),
  supporterNotes: z.string().default(''),
  segments: z
    .array(z.object({ start: z.string(), end: z.string().nullable(), kind: z.enum(['work', 'call']).optional() }))
    .default([]),
  manualAdjustmentMs: z.number().default(0),
  loggedMs: z.number().default(0),
  lastActiveAt: z.string().optional(),
  reopens: z.array(z.object({ at: z.string(), reason: z.string(), previousStatus: status })).default([]),
  serverAccess: z
    .object({ state: z.enum(['yes', 'no', 'unclear']), kind: z.enum(['rdp', 'ssh', 'web', 'other']).optional(), note: z.string().max(100).optional() })
    .nullable()
    .default(null),
  storeShots: z.boolean().default(true),
  shots: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]{8,40}$/),
        at: z.string(),
        stepIndex: z.number().int().min(1),
        text: z.string(),
        target: point.nullable().default(null),
        imageSize: z.object({ width: z.number(), height: z.number() }),
        source: z.string().default(''),
        outcome: z.enum(['done', 'failed']).optional(),
        keep: z.boolean().default(true),
        sha256: z.string(),
        bytes: z.number(),
        redacted: z.boolean().default(false),
        encrypted: z.boolean().default(false),
      }),
    )
    .default([]),
  commandsUsed: z
    .array(z.object({ command: z.string(), explanation: z.string(), mode: z.enum(['readonly', 'changing']) }))
    .default([]),
  usage: z
    .object({ requests: z.number().default(0), inputTokens: z.number().default(0), outputTokens: z.number().default(0), costUsd: z.number().default(0) })
    .default({ requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }),
  llmLog: z
    .array(
      z.object({
        at: z.string(),
        task: z.enum(['triage', 'step', 'summary', 'call']),
        tier: z.enum(['small', 'medium', 'large']),
        model: z.string(),
        reason: z.string(),
        escalated: z.boolean(),
        inputTokens: z.number(),
        outputTokens: z.number(),
        imageBytes: z.number(),
        cacheReadTokens: z.number().optional(),
        cacheCreationTokens: z.number().optional(),
        costUsd: z.number().optional(),
        costUnknown: z.boolean().optional(),
      }),
    )
    .default([]),
});

const entrySchema = z.object({
  id: z.string().min(1),
  date: z.string(),
  start: z.string(),
  end: z.string(),
  durationMinutes: z.number(),
  incidentId: z.string(),
  incidentTitle: z.string(),
  customer: z.string().default(''),
  description: z.string().default(''),
  result: z.enum(['solved', 'unsolved']),
  status: z.enum(['open', 'transferred']).default('open'),
  createdAt: z.string(),
});

export interface StoreData {
  schemaVersion: number;
  incidents: Incident[];
  timeEntries: TimeEntry[];
}

export interface LoadReport {
  dropped: number;
  corruptBackup?: string;
  migratedFrom?: number;
}

/**
 * Migrationspfad: Version 0 (Array von Incidents oder Objekt ohne schemaVersion) -> 1.
 * Neuere Versionen werden abgelehnt (nicht überschreiben).
 */
export function migrate(raw: unknown): { data: StoreData; dropped: number; from: number } {
  let from = 0;
  let incidentsRaw: unknown[];
  let entriesRaw: unknown[] = [];
  if (Array.isArray(raw)) {
    incidentsRaw = raw;
  } else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    from = typeof o['schemaVersion'] === 'number' ? o['schemaVersion'] : 0;
    if (from > SCHEMA_VERSION) throw new Error(`Speicherformat ${from} ist neuer als unterstützt (${SCHEMA_VERSION}).`);
    incidentsRaw = Array.isArray(o['incidents']) ? o['incidents'] : [];
    entriesRaw = Array.isArray(o['timeEntries']) ? o['timeEntries'] : [];
  } else {
    throw new Error('Unbekanntes Speicherformat.');
  }
  let dropped = 0;
  const incidents: Incident[] = [];
  for (const r of incidentsRaw) {
    const p = incidentSchema.safeParse(r);
    if (!p.success) {
      dropped++;
      continue;
    }
    const d = p.data;
    incidents.push({ ...d, lastActiveAt: d.lastActiveAt ?? d.updatedAt, recommendation: d.recommendation as Incident['recommendation'] });
  }
  const timeEntries: TimeEntry[] = [];
  for (const r of entriesRaw) {
    const p = entrySchema.safeParse(r);
    if (p.success) timeEntries.push(p.data);
    else dropped++;
  }
  return { data: { schemaVersion: SCHEMA_VERSION, incidents, timeEntries }, dropped, from };
}

export interface FsDeps {
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
}

/** Lokale JSON-Datei mit Schema-Version. Schreibt atomar (temporäre Datei, dann umbenennen). Keine Screenshots, keine Keys. */
export class IncidentStore {
  private readonly file: string;
  private incidentsMap = new Map<string, Incident>();
  private entries: TimeEntry[] = [];

  constructor(
    private readonly dir: string,
    private readonly fsDeps: FsDeps = { writeFileSync, renameSync },
  ) {
    this.file = join(dir, 'incidents.json');
  }

  load(): LoadReport {
    this.incidentsMap.clear();
    this.entries = [];
    if (!existsSync(this.file)) return { dropped: 0 };
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return { dropped: 0 };
    }
    try {
      const { data, dropped, from } = migrate(JSON.parse(text));
      for (const i of data.incidents) this.incidentsMap.set(i.id, i);
      this.entries = data.timeEntries;
      const rep: LoadReport = { dropped };
      if (from !== SCHEMA_VERSION) {
        rep.migratedFrom = from;
        this.save();
      }
      return rep;
    } catch {
      // Beschädigte oder zu neue Datei nicht überschreiben: beiseite legen und leer starten.
      const backup = join(this.dir, `incidents.corrupt-${Date.now()}.json`);
      try {
        this.fsDeps.renameSync(this.file, backup);
      } catch {
        // egal
      }
      return { dropped: 0, corruptBackup: backup };
    }
  }

  save(): void {
    mkdirSync(this.dir, { recursive: true });
    const data: StoreData = { schemaVersion: SCHEMA_VERSION, incidents: [...this.incidentsMap.values()], timeEntries: this.entries };
    const tmp = `${this.file}.tmp`;
    this.fsDeps.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    this.fsDeps.renameSync(tmp, this.file);
  }

  incidents(): Incident[] {
    return [...this.incidentsMap.values()];
  }
  get(id: string): Incident | undefined {
    return this.incidentsMap.get(id);
  }
  put(inc: Incident): void {
    this.incidentsMap.set(inc.id, inc);
    this.save();
  }
  remove(id: string): boolean {
    const ok = this.incidentsMap.delete(id);
    if (ok) this.save();
    return ok;
  }

  timeEntries(): TimeEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }
  addEntry(e: TimeEntry): void {
    this.entries.push(e);
    this.save();
  }
  updateEntries(ids: string[], patch: Partial<Pick<TimeEntry, 'status'>>): void {
    const set = new Set(ids);
    this.entries = this.entries.map((e) => (set.has(e.id) ? { ...e, ...patch } : e));
    this.save();
  }
  removeEntry(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.save();
  }
}
