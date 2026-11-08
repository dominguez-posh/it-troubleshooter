/** Gemeinsame Typen für Main, Preload und Renderer. Enthält keine Laufzeitabhängigkeiten. */
import type { Incident, IncidentStatus, IncidentSummary, TimeEntry, TimeEntryDraft, TimeEntryStatus } from './incident';

export interface ImageSize {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Confidence = 'low' | 'medium' | 'high';

/** Ein vom LLM vorgeschlagener nächster Schritt. Ziel in Pixeln des gesendeten Screenshots. */
export interface Step {
  text: string;
  target: Point | null;
  reason?: string;
  confidence?: Confidence;
}

/** Genau eine Hauptempfehlung ("Next Best Action"), wie sie ein Senior Support Engineer geben würde. */
export type RecommendationAction =
  | 'ask_customer'
  | 'start_remote'
  | 'contact_customer'
  | 'answer_directly'
  | 'do_step'
  | 'wait_check'
  | 'escalate'
  | 'close'
  | 'check_server_access';

export interface Alternative {
  action: RecommendationAction;
  instruction: string;
}

/** Befehl zum Kopieren. Das Tool führt NIE selbst Befehle aus; nur der Supporter. */
export interface RecCommand {
  command: string;
  explanation: string;
  mode: 'readonly' | 'changing';
  risk?: string;
  /** Backup bzw. Rückfallplan (bei changing Pflicht). */
  backup?: string;
}

export type ServerAccessState = 'yes' | 'no' | 'unclear';
export type ServerAccessKind = 'rdp' | 'ssh' | 'web' | 'other';
/** Zugriff auf den Server des Kunden. Enthält bewusst keine Zugangsdaten. */
export interface ServerAccess {
  state: ServerAccessState;
  kind?: ServerAccessKind;
  /** Servername oder Rolle, Freitext (kein Passwort). */
  note?: string;
}

interface RecBase {
  /** Ein Satz im Imperativ, so wie ein Kollege sprechen würde. */
  instruction: string;
  reason: string;
  confidence?: Confidence;
  /** Risiko-Hinweis vor heiklen Aktionen. */
  risk?: string;
  alternative?: Alternative;
  /** Konkrete Prüfschritte als kopierbare Befehle (nur mit Serverzugriff). */
  commands?: RecCommand[];
}
export interface AskCustomerRec extends RecBase {
  action: 'ask_customer';
  options?: string[];
}
export interface StartRemoteRec extends RecBase {
  action: 'start_remote';
  /** Welches Fenster bzw. welchen Bereich der Kunde zeigen soll. */
  show?: string;
}
export interface ContactCustomerRec extends RecBase {
  action: 'contact_customer';
  talkingPoints: string[];
}
export interface AnswerDirectlyRec extends RecBase {
  action: 'answer_directly';
  steps?: string[];
}
export interface DoStepRec extends RecBase {
  action: 'do_step';
  /** Pfeilziel in Pixeln des Screenshots. */
  target: Point | null;
}
export interface WaitCheckRec extends RecBase {
  action: 'wait_check';
  minutes?: number;
}
export interface EscalateRec extends RecBase {
  action: 'escalate';
  handover: string;
  to?: string;
}
export interface CloseRec extends RecBase {
  action: 'close';
  result?: 'solved' | 'unsolved';
}
export interface CheckServerAccessRec extends RecBase {
  action: 'check_server_access';
  /** Naheliegende Zugriffsart, falls bekannt. */
  accessKinds?: ServerAccessKind[];
}
export type Recommendation =
  | CheckServerAccessRec
  | AskCustomerRec
  | StartRemoteRec
  | ContactCustomerRec
  | AnswerDirectlyRec
  | DoStepRec
  | WaitCheckRec
  | EscalateRec
  | CloseRec;

/** 'steps' = Pfeil-Schritt mit Screenshot ist offen, 'rec' = eine andere Empfehlung ist offen. */
export type SessionPhase = 'rec' | 'steps';

export type RecResponse = 'done' | 'other' | 'later';

/** Reaktion des Supporters auf eine Empfehlung (Teil des Incident-Verlaufs, fließt in die nächste Empfehlung). */
export interface RecEvent {
  at: string;
  action: RecommendationAction;
  instruction: string;
  response: RecResponse;
  comment?: string;
}

/** Schritt aus einer do_step-Empfehlung. */
export function stepFromRec(r: DoStepRec): Step {
  const s: Step = { text: r.instruction, target: r.target };
  if (r.reason) s.reason = r.reason;
  if (r.confidence) s.confidence = r.confidence;
  return s;
}

export type StepOutcome = 'done' | 'failed';

export interface HistoryEntry {
  step: Step;
  outcome: StepOutcome;
  comment?: string;
}

/** Zusatzinfo des Supporters (z. B. aus dem Begleit-Chat). afterSteps = Anzahl bereits abgeschlossener Schritte beim Eingang. */
export interface SessionNote {
  text: string;
  afterSteps: number;
}

/** Sichtbare KI-Aktivität. Texte enthalten nie Keys oder Inhalte von Eingaben/Screenshots. */
export type ActivityKind =
  | 'idle'
  | 'capturing'
  | 'resizing'
  | 'requesting'
  | 'validating'
  | 'retrying'
  | 'escalating'
  | 'ratelimit'
  | 'error'
  | 'paused'
  | 'waiting_customer'
  | 'waiting_target'
  | 'please_click'
  | 'change_detected'
  | 'no_change'
  | 'chat_writing';

export interface ActivityState {
  kind: ActivityKind;
  since: number;
  /** Kurzer, unkritischer Zusatz, z. B. Modell/Stufe oder Fehlercode. */
  detail?: string;
  /** Bei ratelimit: Ende der Wartezeit (ms seit Epoche). */
  until?: number;
  /** Bei retrying: Versuch n von m. */
  attempt?: { n: number; of: number };
  hint?: string;
}

export interface ActivityLogEntry {
  at: number;
  kind: ActivityKind;
  detail?: string;
  durationMs: number;
}

/** Verweis auf einen lokal gespeicherten Screenshot (die Bilddaten liegen nie in der JSON). */
export interface ShotRef {
  /** Zufällige Kennung (nur [a-z0-9-]); der Renderer referenziert Bilder ausschließlich darüber. */
  id: string;
  at: string;
  /** Nummer des Schritts (1-basiert). */
  stepIndex: number;
  text: string;
  target: Point | null;
  imageSize: ImageSize;
  /** "Bildschirm" oder Fenstertitel. */
  source: string;
  outcome?: StepOutcome;
  /** Für die Doku behalten. */
  keep: boolean;
  sha256: string;
  bytes: number;
  /** Geschwärzte Kopie vorhanden (Doku-Export nutzt dann nur diese). */
  redacted: boolean;
  encrypted: boolean;
}

export interface ShotsInfo {
  /** Wird für den aktiven Incident gespeichert? */
  enabled: boolean;
  count: number;
  error: string | null;
  encrypted: boolean;
}

export type DocVariant = 'short' | 'full' | 'customer';

export interface DocRequest {
  variant: DocVariant;
  /** Indizes (1-basiert) der Schritte, die in die Doku kommen. */
  steps: number[];
  summary: string;
}

export interface DocPreview {
  title: string;
  summary: string;
  summarySource: 'llm' | 'fallback';
  steps: Array<{ index: number; text: string; outcome: StepOutcome | null; shotId: string | null }>;
}

export interface DocExportResult {
  dir: string;
  files: number;
}

/** Normierte Rechtecke (0..1) im Bild. */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Modell-Stufen: so klein wie möglich, so groß wie nötig. */
export type ModelTier = 'small' | 'medium' | 'large';
export const TIERS: ModelTier[] = ['small', 'medium', 'large'];
export type TaskKind = 'triage' | 'step' | 'summary' | 'call';

/** Eine vorgeschlagene Frage im Telefonat-Modus. */
export interface CallQuestion {
  text: string;
  why?: string;
  asked: boolean;
}

export type CallReadiness = 'more' | 'remote' | 'solvable';

/** Zustand des Telefonat-Modus (ohne Screenshot, nur Stichworte und Fragen). */
export interface CallView {
  questions: CallQuestion[];
  suspicion: string | null;
  readiness: CallReadiness;
  answered: number;
  loading: boolean;
}

export interface LlmLogEntry {
  at: string;
  task: TaskKind;
  tier: ModelTier;
  model: string;
  /** Warum diese Stufe, z. B. "Triage" oder "2x nicht geklappt". */
  reason: string;
  escalated: boolean;
  inputTokens: number;
  outputTokens: number;
  /** Größe des mitgesendeten Bildes in Bytes (0 = kein Bild). */
  imageBytes: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Geschätzte Kosten in USD (Schätzung, keine Rechnung). */
  costUsd?: number;
  /** Modell nicht in der Preistabelle: mit teuerster bekannter Stufe gerechnet. */
  costUnknown?: boolean;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type CostLevel = 'ok' | 'warn' | 'warn90' | 'limit';
export type CostPeriod = 'day' | 'month' | 'total';

/** Kostenübersicht (Schätzung in Euro) für Kopfzeile, Statuszeilen und Overlay. */
export interface CostView {
  periodEur: number;
  incidentEur: number;
  period: CostPeriod;
  warnEur: number | null;
  limitEur: number | null;
  level: CostLevel;
  /** Hinweis wurde noch nicht mit "Verstanden" bestätigt. */
  unacknowledged: boolean;
  unknownModel: boolean;
  /** Nächste Anfrage ist einmalig freigegeben. */
  onceAllowed: boolean;
}

export type CostAction = { type: 'ack' } | { type: 'raise'; eur: number } | { type: 'once' } | { type: 'reset' };

export interface NextStepRequest {
  problem: string;
  history: HistoryEntry[];
  screenshotJpegBase64: string;
  imageSize: ImageSize;
  notes?: SessionNote[];
}

export type CaptureKind = 'screen' | 'window';

export interface CaptureSourceInfo {
  id: string;
  name: string;
  kind: CaptureKind;
  /** Kleine Vorschau als data-URL (nur im Speicher). */
  thumbnailDataUrl: string;
}

export type ErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'no_key'
  | 'invalid_response'
  | 'capture'
  | 'api'
  | 'timeout'
  | 'limit'
  | 'internal';

export interface AppError {
  code: ErrorCode;
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export type TierModels = Record<ModelTier, string>;
export type Routing = Record<TaskKind, ModelTier>;

export interface ProviderInfo {
  id: string;
  name: string;
  requiresKey: boolean;
  keySet: boolean;
  /** Standard-Modelle je Stufe. */
  defaultTiers: TierModels;
  knownModels: string[];
}

export interface SettingsView {
  providerId: string;
  /** Wirksame Modelle je Stufe für den gewählten Anbieter. */
  tierModels: TierModels;
  routing: Routing;
  /** Eskalation bei so vielen "Hat nicht geklappt" in Folge. */
  failedThreshold: number;
  /** Nach einer Eskalation für den nächsten Schritt wieder bei der Basisstufe beginnen. */
  dropBackToBase: boolean;
  maxImageWidth: number;
  jpegQuality: number;
  excludeMainWindow: boolean;
  /** Nachricht im Begleit-Chat löst sofort einen neuen Schritt aus. */
  chatReevaluate: boolean;
  /** Globales Tastenkürzel zum Fokussieren des Chat-Eingabefelds. */
  chatShortcut: boolean;
  chatShortcutLabel: string;
  /** Globales Tastenkürzel für "Jetzt Telefonat mit Kunden". */
  callShortcut: boolean;
  callShortcutLabel: string;
  /** Kleines Statuspill im Overlay bei längeren Wartezeiten. */
  activityPill: boolean;
  /** Auto-Weiter: nächster Schritt nach erkanntem Klick/Bildschirmänderung (Standard aus). */
  autoAdvance: boolean;
  /** Aufbewahrungsfrist für Screenshots in Tagen. */
  shotRetentionDays: number;
  /** Erweiterter Modus (Standard: Einfach). */
  advancedMode: boolean;
  /** Willkommens-Assistent wurde abgeschlossen oder übersprungen. */
  onboardingDone: boolean;
  costWarnEur: number | null;
  costLimitEur: number | null;
  costIncidentLimitEur: number | null;
  costPeriod: CostPeriod;
  usdEurRate: number;
  providers: ProviderInfo[];
  encryptionAvailable: boolean;
}

export interface SettingsPatch {
  providerId?: string;
  /** Leerer String setzt die Stufe auf den Standard zurück. */
  tierModels?: Partial<TierModels>;
  routing?: Partial<Routing>;
  failedThreshold?: number;
  dropBackToBase?: boolean;
  maxImageWidth?: number;
  jpegQuality?: number;
  excludeMainWindow?: boolean;
  chatReevaluate?: boolean;
  chatShortcut?: boolean;
  callShortcut?: boolean;
  activityPill?: boolean;
  autoAdvance?: boolean;
  shotRetentionDays?: number;
  advancedMode?: boolean;
  onboardingDone?: boolean;
  /** null = kein Wert. */
  costWarnEur?: number | null;
  costLimitEur?: number | null;
  costIncidentLimitEur?: number | null;
  costPeriod?: CostPeriod;
  usdEurRate?: number;
}

export interface StepView {
  index: number;
  step: Step;
  /** Ob der Pfeil im Overlay gerade angezeigt wird. */
  overlayShown: boolean;
}

export interface SessionView {
  incidentId: string | null;
  problem: string;
  history: HistoryEntry[];
  notes: SessionNote[];
  /** null = keine aktive Sitzung. */
  phase: SessionPhase | null;
  /** Aktuelle Hauptempfehlung ("Jetzt tun"). */
  recommendation: Recommendation | null;
  /** Empfehlung wurde mit "Später" zurückgestellt. */
  recPostponed: boolean;
  /** Wartet auf den Kunden (Zeitmessung pausiert). */
  holding: boolean;
  current: StepView | null;
  /** Gesetzt, sobald die Sitzung abgeschlossen wurde. */
  result: 'solved' | 'unsolved' | null;
  timer: { running: boolean; elapsedMs: number };
  /** Letzte LLM-Anfrage (Stufe, Modell, Grund, Tokens) und Summe für diesen Incident. */
  lastRequest: LlmLogEntry | null;
  usage: UsageTotals;
  reopenCount: number;
  serverAccess: ServerAccess | null;
  activity: ActivityState;
  activityLog: ActivityLogEntry[];
  cost: CostView;
  shots: ShotsInfo;
  /** Telefonat-Modus aktiv (sonst null). */
  call: CallView | null;
}

export interface IncidentPatch {
  title?: string;
  customer?: string;
  supporterNotes?: string;
}

/** Schmale API, die der Preload dem Renderer bereitstellt. */
export interface RendererApi {
  getSettings(): Promise<SettingsView>;
  updateSettings(patch: SettingsPatch): Promise<Result<SettingsView>>;
  setApiKey(providerId: string, key: string): Promise<Result<SettingsView>>;
  clearApiKey(providerId: string): Promise<Result<SettingsView>>;
  listModels(providerId: string): Promise<Result<string[]>>;
  listSources(): Promise<Result<CaptureSourceInfo[]>>;

  getSession(): Promise<SessionView>;
  startSession(problem: string): Promise<Result<SessionView>>;
  startRemote(sourceId?: string): Promise<Result<SessionView>>;
  askFirst(): Promise<Result<SessionView>>;
  addNote(text: string): Promise<Result<SessionView>>;
  reactRecommendation(response: RecResponse, comment?: string, ack?: boolean): Promise<Result<SessionView>>;
  setServerAccess(access: ServerAccess): Promise<Result<SessionView>>;
  retryLast(): Promise<Result<SessionView>>;
  abortRequest(manual: boolean): Promise<Result<SessionView>>;
  copyText(text: string): void;
  costAction(a: CostAction): Promise<Result<SessionView>>;
  startCall(): Promise<Result<SessionView>>;
  callInput(text: string, question?: string): Promise<Result<SessionView>>;
  endCall(toTriage: boolean): Promise<Result<SessionView>>;
  reportStep(outcome: StepOutcome, comment?: string): Promise<Result<SessionView>>;
  finishSession(result: 'solved' | 'unsolved'): Promise<Result<SessionView>>;
  pauseSession(): Promise<Result<SessionView>>;
  setTimerRunning(running: boolean): Promise<Result<SessionView>>;
  resetSession(): Promise<Result<null>>;
  toggleOverlay(): Promise<Result<SessionView>>;
  openChat(): Promise<Result<null>>;
  onSessionChanged(cb: (view: SessionView) => void): void;

  listIncidents(): Promise<Result<IncidentSummary[]>>;
  getIncident(id: string): Promise<Result<Incident>>;
  updateIncident(id: string, patch: IncidentPatch): Promise<Result<Incident>>;
  setIncidentStatus(id: string, status: IncidentStatus): Promise<Result<Incident>>;
  setIncidentDuration(id: string, minutes: number): Promise<Result<Incident>>;
  deleteIncident(id: string): Promise<Result<null>>;
  /** reason ist Pflicht bei abgeschlossenen Fällen (gelöst/nicht gelöst). */
  resumeIncident(id: string, reason?: string): Promise<Result<SessionView>>;
  finishIncident(id: string, result: 'solved' | 'unsolved'): Promise<Result<Incident>>;

  setStoreShots(incidentId: string, on: boolean): Promise<Result<Incident>>;
  listShots(incidentId: string): Promise<Result<ShotRef[]>>;
  /** Liefert das Bild als data-URL (Variante "export" = geschwärzt, mit eingebranntem Pfeil). */
  getShot(incidentId: string, shotId: string, variant: 'original' | 'redacted' | 'export'): Promise<Result<string>>;
  setShotKeep(incidentId: string, shotId: string, keep: boolean): Promise<Result<ShotRef[]>>;
  discardShot(incidentId: string, shotId: string): Promise<Result<ShotRef[]>>;
  redactShot(incidentId: string, shotId: string, rects: NormRect[]): Promise<Result<ShotRef[]>>;
  deleteIncidentShots(incidentId: string): Promise<Result<ShotRef[]>>;
  deleteAllShots(): Promise<Result<number>>;
  prepareDoc(incidentId: string, variant: DocVariant): Promise<Result<DocPreview>>;
  exportDoc(incidentId: string, req: DocRequest): Promise<Result<DocExportResult | null>>;
  prepareTimeEntry(incidentId: string, result: 'solved' | 'unsolved'): Promise<Result<TimeEntryDraft>>;
  saveTimeEntry(draft: TimeEntryDraft): Promise<Result<TimeEntry>>;
  listTimeEntries(): Promise<Result<TimeEntry[]>>;
  setTimeEntriesStatus(ids: string[], status: TimeEntryStatus): Promise<Result<TimeEntry[]>>;
  deleteTimeEntry(id: string): Promise<Result<TimeEntry[]>>;
  exportTimeEntriesCsv(ids: string[]): Promise<Result<{ path: string; count: number } | null>>;
}

export interface ChatState {
  session: SessionView;
  reevaluate: boolean;
}

export type ChatMoveRequest = { mode: 'move' | 'resize'; dx: -1 | 0 | 1; dy: -1 | 0 | 1 };

/** Schmale API des Begleit-Chatfensters. */
export interface ChatApi {
  getState(): Promise<ChatState>;
  report(outcome: StepOutcome, comment?: string): Promise<Result<SessionView>>;
  addNote(text: string): Promise<Result<SessionView>>;
  reactRecommendation(response: RecResponse, comment?: string, ack?: boolean): Promise<Result<SessionView>>;
  setServerAccess(access: ServerAccess): Promise<Result<SessionView>>;
  retryLast(): Promise<Result<SessionView>>;
  abortRequest(manual: boolean): Promise<Result<SessionView>>;
  copyText(text: string): void;
  startCall(): Promise<Result<SessionView>>;
  callInput(text: string, question?: string): Promise<Result<SessionView>>;
  endCall(toTriage: boolean): Promise<Result<SessionView>>;
  setReevaluate(value: boolean): Promise<Result<boolean>>;
  moveWindow(req: ChatMoveRequest): Promise<void>;
  setHistoryExpanded(expanded: boolean): Promise<void>;
  close(): Promise<void>;
  onSessionChanged(cb: (view: SessionView) => void): void;
  onFocusInput(cb: () => void): void;
}

export const IPC = {
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  setApiKey: 'key:set',
  clearApiKey: 'key:clear',
  listModels: 'models:list',
  listSources: 'sources:list',
  getSession: 'session:get',
  startSession: 'session:start',
  startRemote: 'session:remote',
  askFirst: 'session:ask',
  addNote: 'session:note',
  react: 'session:react',
  serverAccess: 'session:server-access',
  retryLast: 'session:retry',
  abortRequest: 'session:abort',
  costAction: 'cost:action',
  chatServerAccess: 'chat:server-access',
  chatRetry: 'chat:retry',
  chatAbort: 'chat:abort',
  chatReact: 'chat:react',
  startCall: 'session:call',
  callInput: 'session:call-input',
  endCall: 'session:call-end',
  chatStartCall: 'chat:call',
  chatCallInput: 'chat:call-input',
  chatEndCall: 'chat:call-end',
  reportStep: 'session:report',
  finishSession: 'session:finish',
  pauseSession: 'session:pause',
  setTimerRunning: 'session:timer',
  resetSession: 'session:reset',
  toggleOverlay: 'overlay:toggle',
  overlayShow: 'overlay:show',
  openChat: 'chat:open',
  chatState: 'chat:state',
  chatReport: 'chat:report',
  chatAddNote: 'chat:note',
  chatSetReevaluate: 'chat:reevaluate',
  chatMove: 'chat:move',
  chatHistory: 'chat:history',
  chatClose: 'chat:close',
  chatFocusInput: 'chat:focus-input',
  sessionChanged: 'session:changed',
  listIncidents: 'incident:list',
  getIncident: 'incident:get',
  updateIncident: 'incident:update',
  setIncidentStatus: 'incident:status',
  setIncidentDuration: 'incident:duration',
  deleteIncident: 'incident:delete',
  resumeIncident: 'incident:resume',
  finishIncident: 'incident:finish',
  prepareTimeEntry: 'time:prepare',
  saveTimeEntry: 'time:save',
  listTimeEntries: 'time:list',
  setTimeEntriesStatus: 'time:status',
  deleteTimeEntry: 'time:delete',
  exportTimeEntriesCsv: 'time:export',
  setStoreShots: 'shots:store',
  listShots: 'shots:list',
  getShot: 'shots:get',
  setShotKeep: 'shots:keep',
  discardShot: 'shots:discard',
  redactShot: 'shots:redact',
  deleteIncidentShots: 'shots:delete-incident',
  deleteAllShots: 'shots:delete-all',
  prepareDoc: 'doc:prepare',
  exportDoc: 'doc:export',
} as const;

export interface OverlayPayload {
  /** Pfeilspitze in CSS-Pixeln (DIP) relativ zum Overlay-Fenster; null = nur Text. */
  tip: Point | null;
  text: string;
  /** Größe des Overlay-Fensters in DIP, für das Layout. */
  viewport: ImageSize;
  /** Kleines Statuspill (Aktivität/Kosten) am Rand; null = keins. */
  pill: string | null;
}
