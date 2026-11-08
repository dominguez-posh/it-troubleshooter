import { z } from 'zod';
import type { ImageSize, Step } from '../../shared/types';
import { clamp } from '../../shared/coords';
import { LlmError } from './types';

/** Toleranz, um die ein Ziel außerhalb des Bildes noch auf den Rand gezogen wird. */
const EDGE_TOLERANCE = 0.05;

const rawStepSchema = z.object({
  text: z.string().trim().min(1, 'text fehlt').max(400),
  target: z
    .object({ x: z.number().finite(), y: z.number().finite() })
    .nullish()
    .transform((t) => t ?? null),
  reason: z
    .string()
    .trim()
    .max(800)
    .optional()
    .transform((r) => (r ? r : undefined)),
});

/**
 * Prüft die Antwort des Modells streng und liefert einen sauberen Step.
 * Ziele knapp außerhalb des Bildes werden auf den Rand gezogen, alles andere ist ein Fehler.
 */
export function validateStep(raw: unknown, imageSize: ImageSize): Step {
  const parsed = rawStepSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new LlmError('invalid_response', `Antwort des Modells ist ungültig (${detail}).`);
  }
  const { text, target, reason } = parsed.data;
  let fixed: Step['target'] = null;
  if (target) {
    const mx = imageSize.width * EDGE_TOLERANCE;
    const my = imageSize.height * EDGE_TOLERANCE;
    if (target.x < -mx || target.y < -my || target.x > imageSize.width + mx || target.y > imageSize.height + my) {
      throw new LlmError(
        'invalid_response',
        `Pfeilziel (${Math.round(target.x)}, ${Math.round(target.y)}) liegt außerhalb des Bildes ${imageSize.width}x${imageSize.height}.`,
      );
    }
    fixed = {
      x: Math.round(clamp(target.x, 0, imageSize.width - 1)),
      y: Math.round(clamp(target.y, 0, imageSize.height - 1)),
    };
  }
  const step: Step = { text, target: fixed };
  if (reason) step.reason = reason;
  return step;
}

/** JSON-Schema des Werkzeugs, über das das Modell den Schritt liefert. */
export const STEP_TOOL_NAME = 'next_step';

export const STEP_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: 'Kurze, konkrete Handlungsanweisung auf Deutsch für genau einen Schritt (z. B. "Klicken Sie auf Start").',
    },
    target: {
      type: 'object',
      description:
        'Pixelposition im Screenshot, auf die der Pfeil zeigen soll (Ursprung oben links). Weglassen, wenn der Schritt keine Position auf dem Bildschirm hat.',
      properties: {
        x: { type: 'number', description: 'Horizontale Pixelposition' },
        y: { type: 'number', description: 'Vertikale Pixelposition' },
      },
      required: ['x', 'y'],
    },
    reason: {
      type: 'string',
      description: 'Optionale kurze Begründung, warum dieser Schritt sinnvoll ist.',
    },
  },
  required: ['text'],
} as const;
