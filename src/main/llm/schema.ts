import { z } from 'zod';
import type { CallReadiness, ImageSize, Recommendation } from '../../shared/types';
import { clamp } from '../../shared/coords';
import { LlmError } from './types';

/** Toleranz, um die ein Ziel außerhalb des Bildes noch auf den Rand gezogen wird. */
const EDGE_TOLERANCE = 0.05;

function invalid(err: z.ZodError): LlmError {
  const detail = err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  return new LlmError('invalid_response', `Antwort des Modells ist ungültig (${detail}).`);
}

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((r) => (r ? r : undefined));

const strList = (max: number, itemMax: number) =>
  z
    .array(z.string().trim().min(1).max(itemMax))
    .max(max)
    .optional()
    .transform((a) => (a && a.length ? a : undefined));

function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export const REC_ACTIONS = [
  'ask_customer',
  'start_remote',
  'contact_customer',
  'answer_directly',
  'do_step',
  'wait_check',
  'escalate',
  'close',
  'check_server_access',
] as const;

const commandSchema = z
  .object({
    command: z.string().trim().min(1).max(300),
    explanation: z.string().trim().min(1).max(200),
    mode: z.enum(['readonly', 'changing']),
    risk: optText(200),
    backup: optText(200),
  })
  .refine((c) => c.mode === 'readonly' || (!!c.risk && !!c.backup), {
    message: 'ändernde Befehle brauchen risk und backup (Rückfallplan)',
  });

const base = {
  commands: z.array(commandSchema).max(4).optional().transform((a) => (a && a.length ? a.map((c) => clean(c)) : undefined)),
  instruction: z.string().trim().min(1, 'instruction fehlt').max(280),
  reason: z.string().trim().min(1, 'reason fehlt').max(500),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  risk: optText(300),
  // Genau eine Alternative (ein Objekt): ein Array wird abgelehnt.
  alternative: z.object({ action: z.enum(REC_ACTIONS), instruction: z.string().trim().min(1).max(280) }).optional(),
};

const recSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('ask_customer'),
    ...base,
    options: strList(4, 120).refine((a) => a === undefined || a.length >= 2, 'options braucht 2 bis 4 Einträge'),
  }),
  z.object({ action: z.literal('start_remote'), ...base, show: optText(200) }),
  z.object({
    action: z.literal('contact_customer'),
    ...base,
    talkingPoints: z.array(z.string().trim().min(1).max(200)).min(1, 'talkingPoints fehlt').max(4),
  }),
  z.object({ action: z.literal('answer_directly'), ...base, steps: strList(10, 300) }),
  z.object({
    action: z.literal('do_step'),
    ...base,
    target: z
      .object({ x: z.number().finite(), y: z.number().finite() })
      .nullish()
      .transform((t) => t ?? null),
  }),
  z.object({ action: z.literal('wait_check'), ...base, minutes: z.number().int().min(1).max(240).optional() }),
  z.object({
    action: z.literal('escalate'),
    ...base,
    handover: z.string().trim().min(1, 'handover fehlt').max(1500),
    to: optText(100),
  }),
  z.object({ action: z.literal('close'), ...base, result: z.enum(['solved', 'unsolved']).optional() }),
  z.object({
    action: z.literal('check_server_access'),
    ...base,
    accessKinds: z
      .array(z.enum(['rdp', 'ssh', 'web', 'other']))
      .max(4)
      .optional()
      .transform((a) => (a && a.length ? a : undefined)),
  }),
]);

export interface RecContext {
  /** Gesetzt, wenn ein Screenshot gesendet wurde: do_step erlaubt, start_remote nicht. Sonst umgekehrt. */
  imageSize?: ImageSize;
}

/**
 * Prüft die Empfehlung streng: genau eine Hauptempfehlung, höchstens eine Alternative, Aktion passend zum Kontext
 * (do_step nur mit Screenshot, start_remote nur ohne), Pfeilziel im Bild.
 */
export function validateRecommendation(raw: unknown, ctx: RecContext = {}): Recommendation {
  const p = recSchema.safeParse(raw);
  if (!p.success) throw invalid(p.error);
  const rec = clean(p.data) as Recommendation;
  if (rec.action === 'do_step') {
    if (!ctx.imageSize) throw new LlmError('invalid_response', 'do_step ist ohne Screenshot nicht erlaubt.');
    if (rec.target) {
      const { width, height } = ctx.imageSize;
      const mx = width * EDGE_TOLERANCE;
      const my = height * EDGE_TOLERANCE;
      if (rec.target.x < -mx || rec.target.y < -my || rec.target.x > width + mx || rec.target.y > height + my) {
        throw new LlmError(
          'invalid_response',
          `Pfeilziel (${Math.round(rec.target.x)}, ${Math.round(rec.target.y)}) liegt außerhalb des Bildes ${width}x${height}.`,
        );
      }
      rec.target = { x: Math.round(clamp(rec.target.x, 0, width - 1)), y: Math.round(clamp(rec.target.y, 0, height - 1)) };
    }
  } else if (rec.action === 'start_remote' && ctx.imageSize) {
    throw new LlmError('invalid_response', 'start_remote ist mit Screenshot nicht sinnvoll (Fernwartung läuft bereits).');
  }
  return rec;
}

const callSchema = z.object({
  questions: z
    .array(z.object({ text: z.string().trim().min(1).max(200), why: optText(200) }))
    .min(1, 'mindestens eine Frage')
    .max(5),
  suspicion: optText(500),
  readiness: z.enum(['more', 'remote', 'solvable']).default('more'),
});

export interface CallSuggestion {
  questions: Array<{ text: string; why?: string }>;
  suspicion?: string;
  readiness: CallReadiness;
}

export function validateCallSuggestion(raw: unknown): CallSuggestion {
  const p = callSchema.safeParse(raw);
  if (!p.success) throw invalid(p.error);
  const out: CallSuggestion = { questions: p.data.questions.map((q) => clean(q)), readiness: p.data.readiness };
  if (p.data.suspicion) out.suspicion = p.data.suspicion;
  return out;
}

const summarySchema = z.object({ text: z.string().trim().min(1, 'text fehlt').max(1000) });

export function validateSummary(raw: unknown): string {
  const p = summarySchema.safeParse(raw);
  if (!p.success) throw invalid(p.error);
  return p.data.text;
}

export const REC_TOOL_NAME = 'recommend';
export const CALL_TOOL_NAME = 'call_questions';
export const SUMMARY_TOOL_NAME = 'summary';

export const REC_TOOL_INPUT_SCHEMA = {
  type: 'object',
  description: 'Genau eine Hauptempfehlung, höchstens eine Alternative.',
  properties: {
    action: {
      type: 'string',
      enum: [...REC_ACTIONS],
      description:
        'check_server_access = fragen, ob Zugriff auf den Server des Kunden besteht (RDP, SSH, Webkonsole), sobald Symptome auf Server, Dienste, Logs, Datenbank, Netzwerk oder Berechtigungen deuten; ask_customer = Kunden eine konkrete Frage stellen; start_remote = jetzt Fernwartung öffnen (nur ohne Screenshot); contact_customer = Kunden kontaktieren/zurückrufen; answer_directly = Lösung ohne Fernwartung mitteilen; do_step = genau ein Klick-Schritt (nur mit Screenshot); wait_check = kurz warten und Ergebnis prüfen; escalate = an 2nd Level/Hersteller/Kollegen übergeben; close = Fall vermutlich gelöst, Abschluss vorschlagen.',
    },
    instruction: { type: 'string', description: 'Ein Satz im Imperativ auf Deutsch, so wie ein Kollege sprechen würde. Bei do_step: der Klick-Schritt.' },
    reason: { type: 'string', description: 'Kurze Begründung.' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Wie sicher bist du (bei do_step: Schritt und Pfeilposition).' },
    risk: { type: 'string', description: 'Risiko-Hinweis vor heiklen Aktionen (Datenverlust, Neustart, Registry, Rechte, Backup).' },
    alternative: {
      type: 'object',
      description: 'Höchstens eine Alternative.',
      properties: { action: { type: 'string', enum: [...REC_ACTIONS] }, instruction: { type: 'string' } },
      required: ['action', 'instruction'],
    },
    options: { type: 'array', items: { type: 'string' }, description: 'ask_customer: optional 2 bis 4 Schnellantworten.' },
    accessKinds: { type: 'array', items: { type: 'string', enum: ['rdp', 'ssh', 'web', 'other'] }, description: 'check_server_access: naheliegende Zugriffsarten.' },
    commands: {
      type: 'array',
      description: 'Nur bei bestätigtem Serverzugriff: konkrete Prüfbefehle zum Kopieren (höchstens 4). Der Supporter führt sie selbst aus.',
      items: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          explanation: { type: 'string' },
          mode: { type: 'string', enum: ['readonly', 'changing'] },
          risk: { type: 'string', description: 'Pflicht bei changing.' },
          backup: { type: 'string', description: 'Backup/Rückfallplan, Pflicht bei changing.' },
        },
        required: ['command', 'explanation', 'mode'],
      },
    },
    show: { type: 'string', description: 'start_remote: welches Fenster/welchen Bereich der Kunde zeigen soll.' },
    talkingPoints: { type: 'array', items: { type: 'string' }, description: 'contact_customer: Gesprächsleitfaden, 2 bis 3 Stichpunkte.' },
    steps: { type: 'array', items: { type: 'string' }, description: 'answer_directly: optionale Teilschritte.' },
    target: {
      type: 'object',
      description: 'do_step: Pixelposition im Screenshot (Ursprung oben links); weglassen, wenn der Schritt keine Position hat.',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y'],
    },
    minutes: { type: 'number', description: 'wait_check: Wartezeit in Minuten.' },
    handover: { type: 'string', description: 'escalate: Zusammenfassung für die Übergabe.' },
    to: { type: 'string', description: 'escalate: an wen (z. B. 2nd Level, Hersteller).' },
    result: { type: 'string', enum: ['solved', 'unsolved'], description: 'close: Ergebnis.' },
  },
  required: ['action', 'instruction', 'reason'],
} as const;

export const CALL_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      description: '2 bis 3 nächste Fragen, nach Wichtigkeit sortiert, kurz, nichts bereits Beantwortetes wiederholen.',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, why: { type: 'string', description: 'Optional, sehr kurz.' } },
        required: ['text'],
      },
    },
    suspicion: { type: 'string', description: 'Optional: wahrscheinliche Ursache(n) mit kurzer Begründung.' },
    readiness: {
      type: 'string',
      enum: ['more', 'remote', 'solvable'],
      description: 'more = noch Fragen nötig; remote = genug Infos, Fernwartung nötig; solvable = Lösung ohne Fernwartung möglich.',
    },
  },
  required: ['questions', 'readiness'],
} as const;

export const SUMMARY_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string', description: '1 bis 3 Sätze, Deutsch, ohne Passwörter, Schlüssel oder personenbezogene Daten.' } },
  required: ['text'],
} as const;
