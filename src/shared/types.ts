/** Gemeinsame Typen für Main, Preload und Renderer. Enthält keine Laufzeitabhängigkeiten. */

export interface ImageSize {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Ein vom LLM vorgeschlagener nächster Schritt. Ziel in Pixeln des gesendeten Screenshots. */
export interface Step {
  text: string;
  target: Point | null;
  reason?: string;
}

export type StepOutcome = 'done' | 'failed';

export interface HistoryEntry {
  step: Step;
  outcome: StepOutcome;
  comment?: string;
}

export interface NextStepRequest {
  problem: string;
  history: HistoryEntry[];
  screenshotJpegBase64: string;
  imageSize: ImageSize;
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
  | 'internal';

export interface AppError {
  code: ErrorCode;
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export interface ProviderInfo {
  id: string;
  name: string;
  requiresKey: boolean;
  keySet: boolean;
  defaultModel: string;
  knownModels: string[];
}

export interface SettingsView {
  providerId: string;
  model: string;
  excludeMainWindow: boolean;
  providers: ProviderInfo[];
  encryptionAvailable: boolean;
}

export interface SettingsPatch {
  providerId?: string;
  model?: string;
  excludeMainWindow?: boolean;
}

export interface StepView {
  index: number;
  step: Step;
  /** Ob der Pfeil im Overlay gerade angezeigt wird. */
  overlayShown: boolean;
}

export interface SessionView {
  problem: string;
  history: HistoryEntry[];
  current: StepView | null;
  solved: boolean;
}

/** Schmale API, die der Preload dem Renderer bereitstellt. */
export interface RendererApi {
  getSettings(): Promise<SettingsView>;
  updateSettings(patch: SettingsPatch): Promise<Result<SettingsView>>;
  setApiKey(providerId: string, key: string): Promise<Result<SettingsView>>;
  clearApiKey(providerId: string): Promise<Result<SettingsView>>;
  listModels(providerId: string): Promise<Result<string[]>>;
  listSources(): Promise<Result<CaptureSourceInfo[]>>;
  startSession(problem: string, sourceId: string): Promise<Result<SessionView>>;
  reportStep(outcome: StepOutcome, comment?: string): Promise<Result<SessionView>>;
  markSolved(): Promise<Result<SessionView>>;
  resetSession(): Promise<Result<null>>;
  toggleOverlay(): Promise<Result<SessionView>>;
}

export const IPC = {
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  setApiKey: 'key:set',
  clearApiKey: 'key:clear',
  listModels: 'models:list',
  listSources: 'sources:list',
  startSession: 'session:start',
  reportStep: 'session:report',
  markSolved: 'session:solved',
  resetSession: 'session:reset',
  toggleOverlay: 'overlay:toggle',
  overlayShow: 'overlay:show',
} as const;

export interface OverlayPayload {
  /** Pfeilspitze in CSS-Pixeln (DIP) relativ zum Overlay-Fenster; null = nur Text. */
  tip: Point | null;
  text: string;
  /** Größe des Overlay-Fensters in DIP, für das Layout. */
  viewport: ImageSize;
}
