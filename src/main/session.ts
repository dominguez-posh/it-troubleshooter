import type {
  AppError,
  CallQuestion,
  CallView,
  CostAction,
  HistoryEntry,
  LlmLogEntry,
  ModelTier,
  RecEvent,
  RecResponse,
  Recommendation,
  Result,
  ServerAccess,
  SessionNote,
  SessionPhase,
  SessionView,
  Step,
  StepOutcome,
  TierModels,
  Routing,
} from '../shared/types';
import { stepFromRec } from '../shared/types';
import { imagePointToDesktopDip, type CaptureGeometry } from '../shared/coords';
import { ActivityTracker, REQUEST_TIMEOUT_MS, safeDetail } from './activity';
import type { AutoAdvance, WatchOptions } from './autoAdvance';
import { CaptureError, type CaptureOptions, type Capturer } from './captureTypes';
import { estimateCostUsd, precheckUsd, type CostGuard, type Price } from './cost';
import type { SessionPersistence, SessionSnapshot } from './incidents';
import { LlmError, type ProviderRegistry } from './llm';
import { buildRecommendText, buildSummaryText, dedupeQuestions, estimateTokens, sanitize, SYSTEM_PROMPT } from './llm/prompt';
import { chooseTier, routeCall, type RouteContext } from './llm/router';
import type { CallSuggestion } from './llm/schema';
import type { CallOptions, LlmProvider, LlmResult, RecommendRequest } from './llm/types';
import type { OverlayController } from './overlay';
import { deriveTitle } from '../shared/incident';

export interface SessionDeps {
  registry: ProviderRegistry;
  capturer: Capturer;
  overlay: OverlayController;
  persistence: SessionPersistence;
  cost: CostGuard;
  getProviderId(): string;
  getApiKey(providerId: string): string | undefined;
  getModels(providerId: string): TierModels;
  getRouting(): Routing;
  getFailedThreshold(): number;
  getDropBack(): boolean;
  getCaptureOptions(): { maxWidth: number; quality: number };
  getReevaluate(): boolean;
  getAutoAdvance?(): boolean;
  getPriceOverrides?(): Record<string, Price>;
  autoAdvance?: Pick<AutoAdvance, 'watch' | 'stop'>;
  now?(): number;
  timeoutMs?: number;
  onChange?(view: SessionView): void;
  onStart?(): void;
  onEnd?(): void;
}

interface Current {
  step: Step;
  geometry: CaptureGeometry;
}

interface CallState {
  questions: CallQuestion[];
  suspicion: string | null;
  readiness: CallView['readiness'];
  answered: number;
  loading: boolean;
  /** Alle bisher vorgeschlagenen oder beantworteten Fragen (zum Entdoppeln). */
  known: string[];
}

export const STARTER_QUESTIONS = [
  'Wer ist betroffen (eine Person oder mehrere)?',
  'Seit wann tritt das Problem auf?',
  'Was wurde zuletzt geändert (Update, neue Software, Umzug)?',
  'Wie lautet die Fehlermeldung genau?',
  'Lässt sich das Problem nachstellen, und auf welchem Gerät/System/Programm?',
];

const MAX_NOTE = 1000;
const MAX_NOTES = 50;
const MAX_OUT_TOKENS = 2048;
/** Grobe Größe des System-Prompts in Tokens für die Vorabschätzung. */
const SYSTEM_TOKENS = Math.ceil(SYSTEM_PROMPT.length / 3.5);

export function toAppError(e: unknown): AppError {
  if (e instanceof LlmError) return { code: e.code, message: e.message };
  if (e instanceof CaptureError) return { code: 'capture', message: e.message };
  if (e instanceof Error && /^[A-ZÄÖÜ]/.test(e.message) && e.message.length < 200) return { code: 'internal', message: e.message };
  return { code: 'internal', message: 'Unerwarteter Fehler. Bitte erneut versuchen.' };
}

const fail = (error: AppError): Result<never> => ({ ok: false, error });

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new LlmError('timeout', 'Keine Antwort innerhalb des Zeitlimits.')), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** Zustand und Ablauf einer Sitzung zu einem Incident. Screenshots werden nie gespeichert, nur kurz im Speicher gehalten. */
export class SessionService {
  private incidentId: string | null = null;
  private problem = '';
  private history: HistoryEntry[] = [];
  private notes: SessionNote[] = [];
  private events: RecEvent[] = [];
  private recommendation: Recommendation | null = null;
  private phase: SessionPhase | null = null;
  private current: Current | null = null;
  private result: 'solved' | 'unsolved' | null = null;
  private call: CallState | null = null;
  private holding = false;
  private timerPaused = false;
  private serverAccess: ServerAccess | null = null;
  private recPostponed = false;
  private sourceId = '';
  private targetWindow: string | null = null;
  private overlayShown = false;
  private busy = false;
  private opToken = 0;
  private sticky: ModelTier | null = null;
  private lastRequest: LlmLogEntry | null = null;
  private lastAction: (() => Promise<Result<SessionView>>) | null = null;
  readonly activity: ActivityTracker;
  private readonly now: () => number;

  constructor(private readonly deps: SessionDeps) {
    this.now = deps.now ?? Date.now;
    this.activity = new ActivityTracker(this.now, () => this.notify());
  }

  // ---------- Sicht ----------
  get isActive(): boolean {
    return this.incidentId !== null && this.result === null;
  }
  get activeIncidentId(): string | null {
    return this.incidentId;
  }

  private callView(): CallView | null {
    const c = this.call;
    if (!c) return null;
    return { questions: c.questions.map((q) => ({ ...q })), suspicion: c.suspicion, readiness: c.readiness, answered: c.answered, loading: c.loading };
  }

  view(): SessionView {
    const id = this.incidentId;
    const usage = id ? this.deps.persistence.usageOf(id) : { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const timer = id ? this.deps.persistence.timerInfo(id) : { running: false, elapsedMs: 0 };
    return {
      incidentId: id,
      problem: this.problem,
      history: this.history.map((h) => ({ ...h })),
      notes: this.notes.map((n) => ({ ...n })),
      phase: this.phase,
      recommendation: this.recommendation,
      recPostponed: this.recPostponed,
      holding: this.holding,
      current: this.current ? { index: this.history.length + 1, step: this.current.step, overlayShown: this.overlayShown } : null,
      result: this.result,
      timer,
      lastRequest: this.lastRequest,
      usage,
      reopenCount: id ? this.deps.persistence.reopenCount(id) : 0,
      serverAccess: this.serverAccess,
      activity: this.activity.current(),
      activityLog: this.activity.entries().slice(-15),
      cost: this.deps.cost.view(usage.costUsd),
      call: this.callView(),
    };
  }

  private notify(): void {
    this.deps.onChange?.(this.view());
  }

  private snapshot(): SessionSnapshot {
    return {
      problem: this.problem,
      phase: this.phase,
      recommendation: this.recommendation,
      events: this.events,
      history: this.history,
      notes: this.notes,
      currentStep: this.current?.step ?? null,
      call: this.call !== null,
      holding: this.holding,
      timerPaused: this.timerPaused,
      serverAccess: this.serverAccess,
    };
  }

  private persist(): void {
    if (this.incidentId) this.deps.persistence.sync(this.incidentId, this.snapshot());
  }

  // ---------- Ablauf-Hilfen ----------
  private async guarded(fn: () => Promise<Result<SessionView>>): Promise<Result<SessionView>> {
    if (this.busy) return fail({ code: 'internal', message: 'Es läuft bereits eine Anfrage. Bitte warten oder abbrechen.' });
    this.busy = true;
    const token = ++this.opToken;
    this.lastAction = () => this.guarded(fn);
    try {
      return await fn();
    } catch (e) {
      const err = toAppError(e);
      if (token === this.opToken) this.activity.error(err.code, e instanceof LlmError ? e.retryAfterSec : undefined);
      return fail(err);
    } finally {
      if (token === this.opToken) this.busy = false;
      this.notify();
    }
  }

  private provider(): LlmProvider {
    const pid = this.deps.getProviderId();
    const def = this.deps.registry.get(pid);
    if (def.requiresKey && !this.deps.getApiKey(pid)) {
      throw new LlmError('no_key', `Für ${def.name} ist noch kein API-Key hinterlegt. Bitte in den Einstellungen eintragen.`);
    }
    const models = this.deps.getModels(pid);
    return def.create({ getApiKey: () => this.deps.getApiKey(pid), getModel: (t) => models[t] });
  }

  private failedStreak(): number {
    let n = 0;
    for (let i = this.history.length - 1; i >= 0 && this.history[i]!.outcome === 'failed'; i--) n++;
    return n;
  }

  /** Ein LLM-Aufruf mit Stufenwahl, Eskalation, Kostenprüfung, Zeitlimit und Aktivitätsanzeige. */
  private async llm<T>(
    task: 'triage' | 'step' | 'summary' | 'call',
    estTokens: number,
    call: (provider: LlmProvider, opts: CallOptions) => Promise<LlmResult<T>>,
    uncertain?: (v: T) => boolean,
  ): Promise<T> {
    const provider = this.provider();
    const pid = this.deps.getProviderId();
    const models = this.deps.getModels(pid);
    const ov = this.deps.getPriceOverrides?.() ?? {};
    const incUsd = this.incidentId ? this.deps.persistence.usageOf(this.incidentId).costUsd : 0;
    const estFor = (tier: ModelTier) => precheckUsd(models[tier], estTokens, MAX_OUT_TOKENS, ov);
    const ctx: RouteContext = {
      routing: this.deps.getRouting(),
      models,
      failedStreak: this.failedStreak(),
      failedThreshold: this.deps.getFailedThreshold(),
      reopenCount: this.incidentId ? this.deps.persistence.reopenCount(this.incidentId) : 0,
      historyLen: this.history.length,
      sticky: this.deps.getDropBack() ? null : this.sticky,
      canAfford: (tier) => this.deps.cost.canAfford(estFor(tier), incUsd),
    };
    const first = chooseTier(task, ctx);
    const chk = this.deps.cost.check(estFor(first.tier), incUsd);
    if (!chk.allowed) {
      throw new LlmError('limit', `${chk.reason ?? 'Limit erreicht'} - pausiert. Bitte das Limit anheben oder einmal fortfahren (Kopfzeile).`);
    }
    this.deps.cost.consumeOnceIfNeeded(estFor(first.tier), incUsd);
    const token = this.opToken;
    const timeout = this.deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const label = (tier: ModelTier) => `${models[tier]} (${tier})`;
    const routed = await routeCall(
      task,
      ctx,
      (tier) =>
        withTimeout(
          call(provider, {
            tier,
            onEvent: (e) => {
              if (e.type === 'validating') this.activity.set('validating');
              else this.activity.set('retrying', { attempt: { n: e.attempt, of: e.of }, detail: e.reason });
            },
          }),
          timeout,
        ),
      uncertain,
      {
        onCall: (tier) => this.activity.set('requesting', { detail: label(tier) }),
        onEscalate: (reason) => this.activity.set('escalating', { detail: reason }),
      },
    );
    if (token !== this.opToken) throw new LlmError('internal', 'Die Anfrage wurde abgebrochen.');
    const cost = estimateCostUsd(routed.entry.model, routed.entry, ov);
    const entry = { ...routed.entry, costUsd: cost.usd, costUnknown: cost.unknownModel };
    this.lastRequest = { ...entry, at: new Date(this.now()).toISOString() };
    this.deps.cost.record(entry);
    if (this.incidentId) this.deps.persistence.recordLlm(this.incidentId, entry);
    this.sticky = !this.deps.getDropBack() && entry.escalated ? entry.tier : null;
    return routed.value;
  }

  private baseRequest(): RecommendRequest {
    return { problem: this.problem, history: this.history, notes: this.notes, events: this.events, serverAccess: this.serverAccess };
  }

  /** Hauptempfehlung holen; mit Screenshot nur im Schritt-Modus (nach Fernwartungsstart). */
  private async fetchRecommendation(opts: { withImage: boolean; prefer?: 'question'; resumed?: boolean }): Promise<{ rec: Recommendation; geometry?: CaptureGeometry; sourceName?: string }> {
    const req = this.baseRequest();
    if (opts.prefer) req.prefer = opts.prefer;
    if (opts.resumed) req.resumed = true;
    let geometry: CaptureGeometry | undefined;
    let sourceName: string | undefined;
    if (opts.withImage) {
      this.deps.overlay.hide();
      const sid = this.sourceId || (await this.deps.capturer.defaultSourceId()) || '';
      if (!sid) throw new CaptureError('Es ist keine Aufnahmequelle verfügbar.');
      this.sourceId = sid;
      const co = this.deps.getCaptureOptions();
      const capOpts: CaptureOptions = { maxWidth: co.maxWidth, quality: co.quality, onPhase: (p) => this.activity.set(p) };
      const cap = await this.deps.capturer.capture(sid, capOpts);
      req.screenshotJpegBase64 = cap.jpegBase64;
      req.imageSize = cap.imageSize;
      geometry = cap.geometry;
      sourceName = cap.sourceName;
    }
    const est = SYSTEM_TOKENS + estimateTokens(buildRecommendText(req), req.imageSize);
    const rec = await this.llm(
      opts.withImage ? 'step' : 'triage',
      est,
      (p, o) => p.recommend(req, o),
      (r) => r.confidence === 'low',
    );
    const out: { rec: Recommendation; geometry?: CaptureGeometry; sourceName?: string } = { rec };
    if (geometry) out.geometry = geometry;
    if (sourceName !== undefined) out.sourceName = sourceName;
    return out;
  }

  private async presentStep(cur: Current): Promise<void> {
    const tip = cur.step.target ? imagePointToDesktopDip(cur.step.target, cur.geometry) : null;
    await this.deps.overlay.show(tip, cur.step.text);
    this.overlayShown = true;
  }

  private async apply(r: { rec: Recommendation; geometry?: CaptureGeometry; sourceName?: string }): Promise<void> {
    this.deps.autoAdvance?.stop();
    this.recommendation = r.rec;
    this.recPostponed = false;
    if (r.rec.action === 'do_step' && r.geometry) {
      this.phase = 'steps';
      this.current = { step: stepFromRec(r.rec), geometry: r.geometry };
      this.targetWindow = r.sourceName ?? null;
      this.persist();
      await this.presentStep(this.current);
      this.activity.set('please_click', { detail: sanitize(this.current.step.text, 60) });
      this.startAutoAdvance();
    } else {
      this.phase = 'rec';
      this.current = null;
      this.deps.overlay.hide();
      this.overlayShown = false;
      this.persist();
      this.activity.idle();
    }
  }

  private startAutoAdvance(): void {
    if (!this.deps.autoAdvance || !this.deps.getAutoAdvance?.() || !this.current) return;
    const w: WatchOptions = {
      sourceId: this.sourceId,
      targetWindow: this.targetWindow,
      stepText: safeDetail(sanitize(this.current.step.text, 60)) ?? 'siehe Pfeil',
      onTrigger: () => void this.report('done'),
      onStatus: (kind, detail) => {
        if (kind === 'change_detected' || this.activity.current().kind !== 'idle') this.activity.set(kind, detail ? { detail } : {});
      },
    };
    void this.deps.autoAdvance.watch(w);
  }

  private clearLocal(): void {
    this.incidentId = null;
    this.problem = '';
    this.history = [];
    this.notes = [];
    this.events = [];
    this.recommendation = null;
    this.phase = null;
    this.current = null;
    this.result = null;
    this.call = null;
    this.holding = false;
    this.timerPaused = false;
    this.serverAccess = null;
    this.recPostponed = false;
    this.overlayShown = false;
    this.sticky = null;
    this.lastRequest = null;
  }

  private addNote(text: string): void {
    const t = text.trim().slice(0, MAX_NOTE);
    if (!t) return;
    this.notes = [...this.notes, { text: t, afterSteps: this.history.length }].slice(-MAX_NOTES);
  }

  private resumeFromHolding(): void {
    if (this.holding || this.timerPaused) {
      this.holding = false;
      this.timerPaused = false;
    }
  }

  private requireActive(): void {
    if (!this.isActive) throw new Error('Es gibt keine aktive Sitzung.');
  }

  // ---------- Öffentliche Aktionen ----------
  /** Neuer Fall: legt einen Incident an und holt die Einschätzung ohne Screenshot. */
  start(problem: string): Promise<Result<SessionView>> {
    return this.guarded(async () => {
      const p = problem.trim();
      if (!p) return fail({ code: 'internal', message: 'Bitte zuerst das Problem beschreiben.' });
      if (p.length > 4000) return fail({ code: 'internal', message: 'Die Problembeschreibung ist zu lang (max. 4000 Zeichen).' });
      if (this.isActive) return fail({ code: 'internal', message: 'Es läuft bereits eine aktive Sitzung. Bitte zuerst pausieren oder abschließen.' });
      this.clearLocal();
      this.problem = p;
      this.incidentId = this.deps.persistence.create(p, false);
      this.deps.onStart?.();
      this.notify();
      try {
        await this.apply(await this.fetchRecommendation({ withImage: false }));
      } catch (e) {
        // Der Fall bleibt als Entwurf erhalten, damit die Schilderung nicht verloren geht.
        this.deps.persistence.pause(this.incidentId, this.snapshot());
        this.clearLocal();
        this.deps.onEnd?.();
        throw e;
      }
      return { ok: true, value: this.view() };
    });
  }

  /** Fall wieder aufnehmen (abgeschlossene Fälle mit Begründung). Aufnahme startet erst, wenn Fernwartung wieder nötig ist. */
  resume(incidentId: string, reason?: string): Promise<Result<SessionView>> {
    return this.guarded(async () => {
      if (this.isActive) return fail({ code: 'internal', message: 'Es läuft bereits eine aktive Sitzung. Bitte zuerst pausieren oder abschließen.' });
      const inc = this.deps.persistence.beginResume(incidentId, reason);
      this.clearLocal();
      this.incidentId = inc.id;
      this.problem = inc.problem;
      this.history = inc.history;
      this.notes = inc.notes;
      this.events = inc.events;
      this.serverAccess = inc.serverAccess;
      this.deps.onStart?.();
      this.notify();
      try {
        await this.apply(await this.fetchRecommendation({ withImage: false, resumed: true }));
      } catch (e) {
        this.deps.persistence.pause(inc.id, this.snapshot());
        this.clearLocal();
        this.deps.onEnd?.();
        throw e;
      }
      return { ok: true, value: this.view() };
    });
  }

  startRemote(sourceId?: string): Promise<Result<SessionView>> {
    return this.guarded(async () => {
      this.requireActive();
      if (sourceId) this.sourceId = sourceId;
      this.call = null;
      this.resumeFromHolding();
      this.persist();
      await this.apply(await this.fetchRecommendationForSteps());
      return { ok: true, value: this.view() };
    });
  }

  /** Mit Screenshot den ersten Schritt holen. Liefert der Server etwas anderes (z. B. answer_directly), gilt das. */
  private fetchRecommendationForSteps() {
    return this.fetchRecommendation({ withImage: true });
  }

  askFirst(): Promise<Result<SessionView>> {
    return this.guarded(async () => {
      this.requireActive();
      this.call = null;
      this.resumeFromHolding();
      await this.apply(await this.fetchRecommendation({ withImage: false, prefer: 'question' }));
      return { ok: true, value: this.view() };
    });
  }

  /** Eingabe des Supporters (Zusatzinfo, Antwort auf Rückfrage). Löst je nach Phase eine neue Empfehlung aus. */
  async note(text: string): Promise<Result<SessionView>> {
    try {
      this.requireActive();
    } catch (e) {
      return fail(toAppError(e));
    }
    const t = text.trim();
    if (!t) return fail({ code: 'internal', message: 'Bitte einen Text eingeben.' });
    this.addNote(t);
    this.resumeFromHolding();
    this.persist();
    this.notify();
    if (this.busy || this.call) return { ok: true, value: this.view() };
    if (this.phase === 'steps') {
      if (!this.deps.getReevaluate()) return { ok: true, value: this.view() };
      return this.guarded(async () => {
        await this.apply(await this.fetchRecommendation({ withImage: true }));
        return { ok: true, value: this.view() };
      });
    }
    return this.guarded(async () => {
      await this.apply(await this.fetchRecommendation({ withImage: false }));
      return { ok: true, value: this.view() };
    });
  }

  /** Reaktion auf die Hauptempfehlung: Gemacht, Anders, Später. */
  react(response: RecResponse, comment?: string, ack?: boolean): Promise<Result<SessionView>> {
    return this.guarded(async () => {
      this.requireActive();
      const rec = this.recommendation;
      if (!rec || this.phase !== 'rec') return fail({ code: 'internal', message: 'Es gibt keine offene Empfehlung.' });
      if (rec.action === 'check_server_access' && response === 'done') {
        return fail({ code: 'internal', message: 'Bitte Ja, Nein oder Unklar wählen.' });
      }
      if (response === 'done' && rec.commands?.some((c) => c.mode === 'changing') && !ack) {
        return fail({ code: 'internal', message: 'Ändernde Befehle: Bitte zuerst bestätigen, dass du die Warnung verstanden hast.' });
      }
      const ev: RecEvent = { at: new Date(this.now()).toISOString(), action: rec.action, instruction: sanitize(rec.instruction, 200), response };
      const c = comment?.trim().slice(0, 500);
      if (c) ev.comment = c;
      this.events = [...this.events, ev].slice(-100);
      if (response === 'later') {
        this.recPostponed = true;
        this.persist();
        return { ok: true, value: this.view() };
      }
      if (response === 'other') {
        if (c) this.addNote(`Gegenvorschlag/Grund zur abgelehnten Empfehlung: ${c}`);
        this.resumeFromHolding();
        this.persist();
        await this.apply(await this.fetchRecommendation({ withImage: false }));
        return { ok: true, value: this.view() };
      }
      // done
      switch (rec.action) {
        case 'ask_customer':
          this.persist();
          return { ok: true, value: this.view() };
        case 'start_remote':
          this.persist();
          this.resumeFromHolding();
          await this.apply(await this.fetchRecommendationForSteps());
          return { ok: true, value: this.view() };
        case 'contact_customer':
        case 'escalate':
          this.holding = true;
          this.persist();
          this.activity.set('waiting_customer');
          return { ok: true, value: this.view() };
        case 'close':
          this.doFinish(rec.result ?? 'solved');
          return { ok: true, value: this.view() };
        default:
          this.persist();
          await this.apply(await this.fetchRecommendation({ withImage: false }));
          return { ok: true, value: this.view() };
      }
    });
  }

  setServerAccess(access: ServerAccess): Promise<Result<SessionView>> {
    return this.guarded(async () => {
      this.requireActive();
      if (!['yes', 'no', 'unclear'].includes(access.state)) return fail({ code: 'internal', message: 'Ungültige Angabe.' });
      const a: ServerAccess = { state: access.state };
      if (access.kind && ['rdp', 'ssh', 'web', 'other'].includes(access.kind)) a.kind = access.kind;
      const note = access.note?.trim().slice(0, 100);
      if (note) a.note = note;
      this.serverAccess = a;
      const label = { yes: 'ja', no: 'nein', unclear: 'unklar' }[a.state];
      this.addNote(`Serverzugriff: ${label}${a.kind ? ` (${a.kind})` : ''}${a.note ? `, ${a.note}` : ''}`);
      if (this.recommendation?.action === 'check_server_access') {
        this.events = [...this.events, { at: new Date(this.now()).toISOString(), action: 'check_server_access' as const, instruction: sanitize(this.recommendation.instruction, 200), response: 'done' as const }].slice(-100);
      }
      this.persist();
      await this.apply(await this.fetchRecommendation({ withImage: this.phase === 'steps' }));
      return { ok: true, value: this.view() };
    });
  }

  report(outcome: StepOutcome, comment?: string): Promise<Result<SessionView>> {
    return this.guarded(async () => {
      this.requireActive();
      if (!this.current || this.phase !== 'steps') return fail({ code: 'internal', message: 'Es gibt keinen offenen Schritt.' });
      this.deps.autoAdvance?.stop();
      const entry: HistoryEntry = { step: this.current.step, outcome };
      const c = comment?.trim().slice(0, 1000);
      if (c) entry.comment = c;
      const prevHistory = this.history;
      this.history = [...this.history, entry];
      try {
        await this.apply(await this.fetchRecommendation({ withImage: true }));
      } catch (e) {
        // Zustand zurück: Der Nutzer kann es erneut versuchen; Pfeil wieder zeigen.
        this.history = prevHistory;
        if (this.current) await this.presentStep(this.current).catch(() => undefined);
        throw e;
      }
      return { ok: true, value: this.view() };
    });
  }

  private doFinish(result: 'solved' | 'unsolved'): void {
    this.deps.autoAdvance?.stop();
    if (this.current) {
      this.history = [...this.history, { step: this.current.step, outcome: result === 'solved' ? 'done' : 'failed' }];
      this.current = null;
    }
    this.call = null;
    this.holding = false;
    this.result = result;
    this.deps.overlay.hide();
    this.overlayShown = false;
    if (this.incidentId) {
      this.persist();
      this.deps.persistence.finish(this.incidentId, result);
    }
    this.activity.idle();
    this.deps.onEnd?.();
  }

  async finish(result: 'solved' | 'unsolved'): Promise<Result<SessionView>> {
    try {
      this.requireActive();
    } catch (e) {
      return fail(toAppError(e));
    }
    this.doFinish(result);
    this.notify();
    return { ok: true, value: this.view() };
  }

  /** Sitzung pausieren (Incident bleibt offen, Zeitmessung stoppt). */
  async pause(): Promise<Result<SessionView>> {
    if (this.incidentId && this.result === null) {
      this.deps.autoAdvance?.stop();
      this.deps.overlay.hide();
      this.deps.persistence.pause(this.incidentId, this.snapshot());
      this.opToken++;
      this.busy = false;
      this.clearLocal();
      this.activity.idle();
      this.deps.onEnd?.();
    }
    this.notify();
    return { ok: true, value: this.view() };
  }

  /** Abgeschlossene Sitzung verlassen ("Neues Problem"). Aktive Sitzungen werden pausiert. */
  async reset(): Promise<Result<null>> {
    if (this.isActive) await this.pause();
    else {
      this.deps.overlay.hide();
      this.clearLocal();
      this.activity.idle();
    }
    this.notify();
    return { ok: true, value: null };
  }

  async setTimerRunning(running: boolean): Promise<Result<SessionView>> {
    if (!this.isActive) return fail({ code: 'internal', message: 'Es gibt keine aktive Sitzung.' });
    this.timerPaused = !running;
    this.persist();
    if (running) this.activity.idle();
    else this.activity.set('paused');
    return { ok: true, value: this.view() };
  }

  async toggleOverlay(): Promise<Result<SessionView>> {
    if (!this.current) return fail({ code: 'internal', message: 'Es gibt keinen offenen Schritt.' });
    if (this.overlayShown) {
      this.deps.overlay.hide();
      this.overlayShown = false;
    } else {
      await this.presentStep(this.current);
    }
    this.notify();
    return { ok: true, value: this.view() };
  }

  /** Hängende oder gescheiterte Anfrage erneut ausführen. */
  async retryLast(): Promise<Result<SessionView>> {
    if (!this.lastAction) return fail({ code: 'internal', message: 'Nichts zu wiederholen.' });
    this.opToken++;
    this.busy = false;
    return this.lastAction();
  }

  /** Anfrage abbrechen; "manuell weiter" merkt das als Notiz und lässt den Supporter ohne KI fortfahren. */
  async abortRequest(manual: boolean): Promise<Result<SessionView>> {
    this.opToken++;
    this.busy = false;
    this.deps.autoAdvance?.stop();
    if (manual && this.isActive) {
      this.addNote('KI-Anfrage abgebrochen, der Supporter macht manuell weiter.');
      this.persist();
    }
    this.activity.idle();
    this.notify();
    return { ok: true, value: this.view() };
  }

  async costAction(a: CostAction): Promise<Result<SessionView>> {
    try {
      if (a.type === 'ack') this.deps.cost.ack();
      else if (a.type === 'raise') this.deps.cost.raise(a.eur);
      else if (a.type === 'once') this.deps.cost.allowOnce();
      else this.deps.cost.reset();
    } catch (e) {
      return fail(toAppError(e));
    }
    if (this.activity.current().kind === 'error') this.activity.idle();
    this.notify();
    return { ok: true, value: this.view() };
  }

  /** Kurze Zusammenfassung (kleine Stufe, nur Text). Gibt null zurück, wenn das Modell nicht erreichbar oder das Limit erreicht ist. */
  async summarize(inc: { problem: string; history: HistoryEntry[]; notes: SessionNote[] }, result: 'solved' | 'unsolved'): Promise<string | null> {
    try {
      const req = { problem: inc.problem, history: inc.history, notes: inc.notes, result };
      const est = SYSTEM_TOKENS + estimateTokens(buildSummaryText(req));
      const text = await this.llm('summary', est, (p, o) => p.summarize(req, o));
      this.activity.idle();
      return text;
    } catch {
      this.activity.idle();
      return null;
    }
  }

  // ---------- Telefonat-Modus ----------
  /** Telefonat starten: hängt sich an die aktive Sitzung oder legt einen neuen Incident an. Lokale Einstiegsfragen ohne API-Aufruf. */
  async startCall(): Promise<Result<SessionView>> {
    if (this.call) return { ok: true, value: this.view() };
    if (!this.isActive) {
      this.clearLocal();
      this.incidentId = this.deps.persistence.create('', true);
      this.deps.onStart?.();
    }
    this.call = {
      questions: STARTER_QUESTIONS.map((text) => ({ text, asked: false })),
      suspicion: null,
      readiness: 'more',
      answered: 0,
      loading: false,
      known: [...STARTER_QUESTIONS],
    };
    this.persist();
    this.notify();
    return { ok: true, value: this.view() };
  }

  /** Stichworte aus dem Gespräch (optional zu einer Frage) -> nächste Fragen von der kleinen Modellstufe, ohne Bild. */
  callInput(text: string, question?: string): Promise<Result<SessionView>> {
    return this.guarded(async () => {
      this.requireActive();
      const c = this.call;
      if (!c) return fail({ code: 'internal', message: 'Das Telefonat ist nicht aktiv.' });
      const t = text.trim();
      if (!t) return fail({ code: 'internal', message: 'Bitte Stichworte eingeben.' });
      this.addNote(question ? `Frage "${sanitize(question, 120)}": ${t}` : `Telefonat: ${t}`);
      if (question) {
        const q = c.questions.find((x) => x.text === question);
        if (q) q.asked = true;
      }
      c.answered += 1;
      c.loading = true;
      this.persist();
      this.notify();
      try {
        const est = SYSTEM_TOKENS + estimateTokens(this.problem + this.notes.map((n) => n.text).join(' ') + c.known.join(' '));
        const sug: CallSuggestion = await this.llm('call', est, (p, o) =>
          p.callQuestions({ problem: this.problem, notes: this.notes, asked: c.known }, o, (partial) => {
            this.activity.set('chat_writing');
            const fresh = dedupeQuestions(partial.map((text) => ({ text })), c.known);
            if (fresh.length) {
              c.questions = fresh.slice(0, 3).map((q) => ({ text: q.text, asked: false }));
              this.notify();
            }
          }),
        );
        const fresh = dedupeQuestions(sug.questions, c.known).slice(0, 3);
        c.questions = (fresh.length ? fresh : [{ text: 'Gibt es noch etwas, das ich wissen sollte?' }]).map((q) => {
          const o: CallQuestion = { text: q.text, asked: false };
          if ('why' in q && typeof q.why === 'string') o.why = q.why;
          return o;
        });
        c.known = [...c.known, ...c.questions.map((q) => q.text)].slice(-60);
        c.suspicion = sug.suspicion ?? c.suspicion;
        c.readiness = sug.readiness;
        this.activity.idle();
      } finally {
        c.loading = false;
      }
      return { ok: true, value: this.view() };
    });
  }

  /** Telefonat beenden; optional direkt in die Einschätzung (Antwort, Rückfrage oder Fernwartung). */
  endCall(toTriage: boolean): Promise<Result<SessionView>> {
    return this.guarded(async () => {
      this.requireActive();
      this.call = null;
      this.persist();
      if (toTriage) {
        if (!this.problem && this.notes.length) this.problem = deriveTitle(this.notes[0]!.text.replace(/^Telefonat:\s*/, ''));
        await this.apply(await this.fetchRecommendation({ withImage: false }));
      }
      return { ok: true, value: this.view() };
    });
  }
}
