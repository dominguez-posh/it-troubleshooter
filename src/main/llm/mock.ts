import type { NextStepRequest, Step } from '../../shared/types';
import type { LlmProvider, ProviderDefinition } from './types';

interface Scripted {
  text: string;
  reason: string;
  fx: number;
  fy: number;
}

/** Feste Schrittfolge relativ zur Bildgröße, damit Demo und Tests ohne Key und deterministisch laufen. */
const SCRIPT: Scripted[] = [
  { text: 'Klicken Sie unten links auf das Startmenü.', reason: 'Von dort erreichen Sie die Einstellungen.', fx: 0.03, fy: 0.97 },
  { text: 'Öffnen Sie die Einstellungen (Zahnrad).', reason: 'Dort liegen die Netzwerkoptionen.', fx: 0.5, fy: 0.5 },
  { text: 'Wählen Sie „Netzwerk und Internet“.', reason: 'Hier sehen Sie den Verbindungsstatus.', fx: 0.75, fy: 0.3 },
];

export function createMockProvider(): LlmProvider {
  return {
    id: 'mock',
    name: 'Mock (Demo ohne Key)',
    listModels: async () => ['mock-1'],
    async nextStep(req: NextStepRequest): Promise<Step> {
      const i = req.history.length;
      if (i >= SCRIPT.length) {
        return {
          text: 'Prüfen Sie, ob das Problem jetzt behoben ist. Falls ja, klicken Sie auf „Problem gelöst“.',
          target: null,
          reason: 'Das Demo-Skript hat keine weiteren Schritte.',
        };
      }
      const s = SCRIPT[i]!;
      return {
        text: s.text,
        reason: s.reason,
        target: {
          x: Math.round(s.fx * (req.imageSize.width - 1)),
          y: Math.round(s.fy * (req.imageSize.height - 1)),
        },
      };
    },
  };
}

export const mockDefinition: ProviderDefinition = {
  id: 'mock',
  name: 'Mock (Demo ohne Key)',
  requiresKey: false,
  defaultModel: 'mock-1',
  knownModels: ['mock-1'],
  create: () => createMockProvider(),
};
