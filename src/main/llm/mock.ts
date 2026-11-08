import type { Recommendation } from '../../shared/types';
import { buildCallText, buildRecommendText, buildSummaryText, estimateTokens } from './prompt';
import type { CallSuggestion } from './schema';
import type { LlmProvider, LlmResult, ProviderContext, ProviderDefinition, RecommendRequest } from './types';

interface Scripted {
  text: string;
  reason: string;
  fx: number;
  fy: number;
}

/** Feste Schrittfolge relativ zur Bildgröße, damit Demo und Tests ohne Key und deterministisch laufen. */
export const MOCK_SCRIPT: Scripted[] = [
  { text: 'Klicken Sie unten links auf das Startmenü.', reason: 'Von dort erreichen Sie die Einstellungen.', fx: 0.03, fy: 0.97 },
  { text: 'Öffnen Sie die Einstellungen (Zahnrad).', reason: 'Dort liegen die Netzwerkoptionen.', fx: 0.5, fy: 0.5 },
  { text: 'Wählen Sie „Netzwerk und Internet“.', reason: 'Hier sehen Sie den Verbindungsstatus.', fx: 0.75, fy: 0.3 },
];

export const MOCK_CALL_QUESTIONS = [
  'Wer ist genau betroffen (eine Person oder mehrere)?',
  'Seit wann tritt das Problem auf?',
  'Was wurde zuletzt geändert (Update, neue Software, Umzug)?',
  'Wie lautet die Fehlermeldung genau?',
  'Lässt sich das Problem jederzeit nachstellen?',
  'Welches Gerät, System und Programm ist betroffen?',
  'Funktioniert es auf einem anderen Gerät oder Konto?',
  'Hilft ein Neustart kurzfristig?',
];

/**
 * Deterministische Entscheidungen nach Stichworten im Problemtext:
 * "passwort" -> answer_directly, "rückruf" -> contact_customer, "eskalier" -> escalate, "warten" -> wait_check,
 * "langsam" -> erst ask_customer, danach start_remote, "neustart" -> mitten im Ablauf answer_directly,
 * "unsicher" -> do_step mit confidence low (außer in der größten Stufe), sonst start_remote.
 */
function decide(req: RecommendRequest, tier: string): Recommendation {
  const text = `${req.problem} ${req.notes.map((n) => n.text).join(' ')}`.toLowerCase();
  const p = req.problem.toLowerCase();
  const last = req.events[req.events.length - 1];

  if (req.imageSize) {
    const { width, height } = req.imageSize;
    if (p.includes('neustart') && req.history.length >= 2) {
      return { action: 'answer_directly', instruction: 'Sagen Sie dem Kunden, er soll den Rechner neu starten.', reason: 'Ein Neustart behebt das ohne weitere Klicks.', steps: ['Speichern und Programme schließen', 'Neu starten'], risk: 'Ungespeicherte Arbeit geht verloren.' };
    }
    if (req.history.length >= MOCK_SCRIPT.length) {
      return { action: 'close', instruction: 'Prüfen Sie, ob das Problem behoben ist, und schließen Sie den Fall ab.', reason: 'Alle geplanten Schritte sind erledigt.', result: 'solved' };
    }
    const s = MOCK_SCRIPT[req.history.length]!;
    return {
      action: 'do_step',
      instruction: s.text,
      reason: s.reason,
      target: { x: Math.round(s.fx * (width - 1)), y: Math.round(s.fy * (height - 1)) },
      confidence: p.includes('unsicher') && tier !== 'large' ? 'low' : 'high',
    };
  }

  if (req.prefer === 'question') {
    return { action: 'ask_customer', instruction: 'Fragen Sie den Kunden, seit wann das Problem besteht.', reason: 'Der Zeitpunkt grenzt die Ursache ein.', options: ['Seit dem Update', 'Schon länger', 'Weiß nicht'] };
  }
  if (last?.response === 'other') {
    return { action: 'ask_customer', instruction: 'Fragen Sie den Kunden, was genau gegen den Vorschlag spricht.', reason: 'Der Vorschlag wurde abgelehnt, der Grund fehlt.' };
  }
  if (last?.action === 'answer_directly' && last.response === 'done') {
    return { action: 'close', instruction: 'Schließen Sie den Fall ab, wenn der Kunde bestätigt, dass es läuft.', reason: 'Die Lösung wurde weitergegeben.', result: 'solved' };
  }
  if (p.includes('server')) {
    const acc = req.serverAccess;
    if (!acc || acc.state === 'unclear') {
      return { action: 'check_server_access', instruction: 'Fragen Sie den Kunden, ob wir Zugriff auf den Server haben (RDP, SSH oder Webkonsole).', reason: 'Die Symptome deuten auf den Server; ohne Zugriff lohnt kein Prüfplan.', accessKinds: ['rdp', 'ssh', 'web'] };
    }
    if (acc.state === 'no') {
      return { action: 'contact_customer', instruction: 'Bitten Sie den Kunden um Serverzugriff oder lassen Sie ihn die Prüfung selbst ausführen.', reason: 'Ohne Zugriff kann nur der Kunde prüfen.', talkingPoints: ['Zugriff anfragen', 'Alternativ: Kunde führt Befehle selbst aus'] };
    }
    return {
      action: 'answer_directly',
      instruction: 'Prüfen Sie zuerst Dienststatus und Speicherplatz auf dem Server.',
      reason: 'Häufige Ursachen lassen sich mit Nur-Lesen-Befehlen eingrenzen.',
      risk: 'Nur lesende Befehle zuerst; ändernde erst nach Backup.',
      commands: [
        { command: 'Get-Service | Where-Object Status -ne Running', explanation: 'Zeigt gestoppte Dienste.', mode: 'readonly' },
        { command: 'Restart-Service -Name Spooler', explanation: 'Startet den Druckdienst neu.', mode: 'changing', risk: 'Laufende Druckaufträge gehen verloren.', backup: 'Warteschlange vorher exportieren; Dienst notfalls wieder starten.' },
      ],
    };
  }
  if (p.includes('passwort')) {
    return { action: 'answer_directly', instruction: 'Nennen Sie dem Kunden den Weg zum Passwort-Reset im Self-Service-Portal.', reason: 'Das lässt sich ohne Fernwartung lösen.', steps: ['Portal öffnen', '„Passwort vergessen“ wählen', 'Link in der E-Mail folgen'] };
  }
  if (p.includes('rückruf')) {
    return { action: 'contact_customer', instruction: 'Rufen Sie den Kunden zurück und holen Sie die Freigabe ein.', reason: 'Ohne Zustimmung des Kunden geht es nicht weiter.', talkingPoints: ['Stand schildern', 'Freigabe einholen', 'Zeitfenster vereinbaren'] };
  }
  if (p.includes('eskalier')) {
    return { action: 'escalate', instruction: 'Übergeben Sie den Fall an den 2nd Level.', reason: 'Das Problem liegt außerhalb Ihres Zuständigkeitsbereichs.', handover: `Problem: ${req.problem.slice(0, 200)}. Bisher ${req.history.length} Schritte, ohne Erfolg.`, to: '2nd Level' };
  }
  if (p.includes('warten')) {
    return { action: 'wait_check', instruction: 'Warten Sie fünf Minuten und prüfen Sie dann das Ergebnis.', reason: 'Die Synchronisierung braucht Zeit.', minutes: 5 };
  }
  if (p.includes('langsam') && !text.includes('antwort')) {
    return { action: 'ask_customer', instruction: 'Fragen Sie den Kunden, ob es nur ein Programm oder das ganze System betrifft.', reason: 'Das entscheidet, ob Fernwartung nötig ist.', options: ['Nur ein Programm', 'Ganzes System'] };
  }
  return { action: 'start_remote', instruction: 'Öffnen Sie jetzt die Fernwartung und lassen Sie sich den Bildschirm zeigen.', reason: 'Das Problem lässt sich nur am Bildschirm klären.', show: 'Das Fenster mit der Fehlermeldung' };
}

export function createMockProvider(ctx: ProviderContext = { getApiKey: () => undefined, getModel: (t) => `mock-${t}` }): LlmProvider {
  const result = <T>(value: T, text: string, tier: Parameters<ProviderContext['getModel']>[0], image?: string): LlmResult<T> => ({
    value,
    model: ctx.getModel(tier),
    imageBytes: image ? Math.floor((image.length * 3) / 4) : 0,
    usage: { inputTokens: estimateTokens(text), outputTokens: 80 },
  });
  return {
    id: 'mock',
    name: 'Mock (Demo ohne Key)',
    listModels: async () => ['mock-small', 'mock-medium', 'mock-large'],
    async recommend(req, opts) {
      const r = result(decide(req, opts.tier), buildRecommendText(req), opts.tier, req.screenshotJpegBase64);
      if (req.imageSize) r.usage.inputTokens = estimateTokens(buildRecommendText(req), req.imageSize);
      return r;
    },
    async callQuestions(req, opts, onPartial) {
      const asked = new Set(req.asked);
      const next = MOCK_CALL_QUESTIONS.filter((q) => !asked.has(q)).slice(0, 3);
      const questions = (next.length ? next : ['Gibt es noch etwas, das ich wissen sollte?']).map((text) => ({ text }));
      onPartial?.([questions[0]!.text]);
      const answered = req.notes.length;
      const p = req.problem.toLowerCase();
      const out: CallSuggestion = {
        questions,
        readiness: answered >= 3 ? (p.includes('passwort') ? 'solvable' : 'remote') : 'more',
      };
      if (answered >= 2) out.suspicion = 'Verdacht: Das Problem begann nach einer Änderung (z. B. Update); passt zu den bisherigen Angaben.';
      return result(out, buildCallText(req), opts.tier);
    },
    async summarize(req, opts) {
      const text = `Mock-Zusammenfassung: ${req.history.length} Schritte, Ergebnis ${req.result === 'solved' ? 'gelöst' : 'nicht gelöst'}.`;
      return result(text, buildSummaryText(req), opts.tier);
    },
  };
}

export const mockDefinition: ProviderDefinition = {
  id: 'mock',
  name: 'Mock (Demo ohne Key)',
  requiresKey: false,
  tiers: { small: 'mock-small', medium: 'mock-medium', large: 'mock-large' },
  knownModels: ['mock-small', 'mock-medium', 'mock-large'],
  create: (ctx) => createMockProvider(ctx),
};
