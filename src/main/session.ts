import type { AppError, HistoryEntry, Result, SessionView, Step, StepOutcome } from '../shared/types';
import { imagePointToDesktopDip, type CaptureGeometry } from '../shared/coords';
import { CaptureError, type Capturer } from './captureTypes';
import { LlmError, type ProviderRegistry } from './llm';
import type { OverlayController } from './overlay';

export interface SessionDeps {
  registry: ProviderRegistry;
  capturer: Capturer;
  overlay: OverlayController;
  getProviderId(): string;
  getModel(providerId: string): string;
  getApiKey(providerId: string): string | undefined;
}

interface Current {
  step: Step;
  geometry: CaptureGeometry;
}

export function toAppError(e: unknown): AppError {
  if (e instanceof LlmError) return { code: e.code, message: e.message };
  if (e instanceof CaptureError) return { code: 'capture', message: e.message };
  // Unbekannte Fehler nicht im Detail durchreichen (könnten interne Daten enthalten).
  return { code: 'internal', message: 'Unerwarteter Fehler. Bitte erneut versuchen.' };
}

const fail = (error: AppError): Result<never> => ({ ok: false, error });

/** Zustand und Ablauf einer Hilfe-Sitzung. Screenshots werden nie gespeichert, nur kurz im Speicher gehalten. */
export class SessionService {
  private problem = '';
  private sourceId = '';
  private history: HistoryEntry[] = [];
  private current: Current | null = null;
  private solved = false;
  private overlayShown = false;
  private busy = false;

  constructor(private readonly deps: SessionDeps) {}

  view(): SessionView {
    return {
      problem: this.problem,
      history: this.history.map((h) => ({ ...h })),
      current: this.current ? { index: this.history.length + 1, step: this.current.step, overlayShown: this.overlayShown } : null,
      solved: this.solved,
    };
  }

  private async guarded<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.busy) return fail({ code: 'internal', message: 'Es läuft bereits eine Anfrage. Bitte warten.' });
    this.busy = true;
    try {
      return await fn();
    } catch (e) {
      return fail(toAppError(e));
    } finally {
      this.busy = false;
    }
  }

  /** Screenshot -> LLM -> neuen Schritt liefern (ohne Zustand zu ändern). */
  private async fetchStep(history: HistoryEntry[]): Promise<Current> {
    const providerId = this.deps.getProviderId();
    const def = this.deps.registry.get(providerId);
    if (def.requiresKey && !this.deps.getApiKey(providerId)) {
      throw new LlmError('no_key', `Für ${def.name} ist noch kein API-Key hinterlegt. Bitte in den Einstellungen eintragen.`);
    }
    const provider = def.create({
      getApiKey: () => this.deps.getApiKey(providerId),
      getModel: () => this.deps.getModel(providerId),
    });
    // Overlay vor der Aufnahme weg, zusätzlich zum Capture-Schutz des Overlay-Fensters.
    this.deps.overlay.hide();
    const cap = await this.deps.capturer.capture(this.sourceId);
    const step = await provider.nextStep({
      problem: this.problem,
      history,
      screenshotJpegBase64: cap.jpegBase64,
      imageSize: cap.imageSize,
    });
    return { step, geometry: cap.geometry };
  }

  private async present(cur: Current): Promise<void> {
    const tip = cur.step.target ? imagePointToDesktopDip(cur.step.target, cur.geometry) : null;
    await this.deps.overlay.show(tip, cur.step.text);
    this.overlayShown = true;
  }

  start(problem: string, sourceId: string): Promise<Result<SessionView>> {
    return this.guarded(async () => {
      const p = problem.trim();
      if (!p) return fail({ code: 'internal', message: 'Bitte zuerst das Problem beschreiben.' });
      if (p.length > 4000) return fail({ code: 'internal', message: 'Die Problembeschreibung ist zu lang (max. 4000 Zeichen).' });
      this.problem = p;
      this.sourceId = sourceId;
      this.history = [];
      this.current = null;
      this.solved = false;
      this.overlayShown = false;
      try {
        this.current = await this.fetchStep([]);
      } catch (e) {
        this.problem = '';
        throw e;
      }
      await this.present(this.current);
      return { ok: true, value: this.view() };
    });
  }

  report(outcome: StepOutcome, comment?: string): Promise<Result<SessionView>> {
    return this.guarded(async () => {
      if (!this.current || this.solved) return fail({ code: 'internal', message: 'Es gibt keinen offenen Schritt.' });
      const entry: HistoryEntry = { step: this.current.step, outcome };
      const c = comment?.trim().slice(0, 1000);
      if (c) entry.comment = c;
      const nextHistory = [...this.history, entry];
      try {
        const next = await this.fetchStep(nextHistory);
        this.history = nextHistory;
        this.current = next;
      } catch (e) {
        // Zustand bleibt unverändert, der Nutzer kann es erneut versuchen; Pfeil wieder zeigen.
        if (this.overlayShown) await this.present(this.current).catch(() => undefined);
        throw e;
      }
      await this.present(this.current);
      return { ok: true, value: this.view() };
    });
  }

  async markSolved(): Promise<Result<SessionView>> {
    if (this.current && !this.solved) {
      this.history = [...this.history, { step: this.current.step, outcome: 'done' }];
      this.current = null;
    }
    this.solved = true;
    this.deps.overlay.hide();
    this.overlayShown = false;
    return { ok: true, value: this.view() };
  }

  async reset(): Promise<Result<null>> {
    this.deps.overlay.hide();
    this.problem = '';
    this.sourceId = '';
    this.history = [];
    this.current = null;
    this.solved = false;
    this.overlayShown = false;
    return { ok: true, value: null };
  }

  async toggleOverlay(): Promise<Result<SessionView>> {
    if (!this.current) return fail({ code: 'internal', message: 'Es gibt keinen offenen Schritt.' });
    if (this.overlayShown) {
      this.deps.overlay.hide();
      this.overlayShown = false;
    } else {
      await this.present(this.current);
    }
    return { ok: true, value: this.view() };
  }
}
