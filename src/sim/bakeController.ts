// Baking as the editor drives it: (re)bakes when the scene changes, streams
// frames to the renderers as they come, matches continuous loops, runs the
// machine check on the result and repeats bakes for robustness trials.

import type { App } from '../app';
import type { BuiltScene } from '../scene/build';
import { analyzeBake, analyzeSamples, stepResults, type MachineReport } from './analysis';
import type { BakeProgress, BakeResult } from './baker';
import { matchLoop } from './loopMatch';

export interface TrialState {
  running: boolean;
  total: number;
  done: number;
  okRuns: number;
  /** per run: step id -> passed */
  results: Map<string, boolean>[];
  untilSuccess: boolean;
  /** run that succeeded and is kept on screen (untilSuccess) */
  kept: number;
  cancelled: boolean;
}

/** Pause after an edit before the automatic re-bake. */
const AUTO_BAKE_MS = 450;

export class BakeController {
  baking = false;
  progress: BakeProgress = { frame: 0, total: 1, recorded: 0, msPerFrame: 0 };
  error: string | null = null;
  result: BakeResult | null = null;
  /** physics changed since the last bake */
  stale = true;
  /** machine check of the last bake (see sim/analysis) */
  report: MachineReport | null = null;
  /** the report describes an older version of the scene */
  reportStale = false;
  analyzing = false;
  trials: TrialState | null = null;
  /** robustness trials: tiny per-run perturbation of the dynamic bodies */
  jitter: { seed: number; amount: number } | null = null;
  private reportPromise: Promise<MachineReport | null> | null = null;
  private timer = 0;

  constructor(private app: App) {}

  /** Frames available for playback (streamed while baking). */
  get current(): BakeResult | null { return this.result ?? this.app.baker.currentPartial; }

  get availableFrames(): number {
    if (this.result) return this.result.frames;
    if (this.baking) return this.progress.recorded;
    return 0;
  }

  /** A new document: its report and trials no longer apply. */
  forgetReport(): void {
    this.report = null;
    this.trials = null;
  }

  /** The scene changed: drop the bake on screen and re-bake soon if automatic. */
  invalidate(): void {
    if (this.report) this.reportStale = true;
    this.stale = true;
    this.cancel();
    this.result = null;
    this.app.bodies.setHistory(null);
    this.app.fluid.setHistory(null);
  }

  scheduleAuto(): void {
    if (!this.app.autoBake) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { void this.bake(); }, AUTO_BAKE_MS);
  }

  /** Stops a running bake; the scene stays to be baked. */
  cancel(): void {
    this.app.baker.cancel();
    this.baking = false;
  }

  async bake(): Promise<void> {
    const app = this.app;
    clearTimeout(this.timer);
    if (app.built.bodies.length === 0 && !app.built.fluid) { this.error = 'Add something to the scene first.'; app.emit('bake'); return; }
    this.error = null;
    this.baking = true;
    this.stale = false;
    this.progress = { frame: 0, total: app.built.simFrames, recorded: 0, msPerFrame: 0 };
    app.emit('bake');
    const built = app.built;
    let started = false;
    try {
      const res = await app.baker.bake(built, app.doc, (p) => {
        this.progress = p;
        // stream: start playback as soon as frames exist
        if (!started && p.recorded > 2) {
          started = true;
          this.result = null;
          app.bodies.setHistory(app.baker.currentPartial ?? null);
          app.fluid.setHistory(app.baker.currentPartial?.fluid ?? null);
          app.playIfIdle(true);
        }
        app.emit('bake-progress');
      });
      if (!res) return; // cancelled
      this.result = res;
      app.bodies.setHistory(res);
      if (res.tail) {
        const targets = await matchLoop(app.device, app.stage.renderer, res, built, app.doc);
        if (this.result !== res) return; // re-baked meanwhile
        if (targets) app.bodies.setLoopTargets(targets);
      }
      app.fluid.setHistory(res.fluid);
      this.baking = false;
      if (!app.exporting) this.reportPromise = this.analyze(res, built);
      app.playIfIdle(false);
      app.emit('bake');
    } catch (err: any) {
      console.error(err);
      this.error = String(err?.message ?? err);
      this.baking = false;
      this.stale = true;
      app.emit('bake');
    }
  }

  private async analyze(res: BakeResult, built: BuiltScene): Promise<MachineReport | null> {
    const app = this.app;
    this.analyzing = true;
    app.emit('report');
    try {
      const r = await analyzeBake(app.device, app.stage.renderer, res, built, app.doc);
      if (this.result !== res) return null; // re-baked meanwhile
      this.report = r;
      this.reportStale = false;
      app.refreshFollow();
      return r;
    } catch (err) {
      console.error('machine check failed', err);
      return null;
    } finally {
      this.analyzing = false;
      app.view.updateAnalysisVisuals();
      app.emit('report');
    }
  }

  /**
   * Bakes the machine `n` times, each run nudged by a fraction of a
   * millimetre (and the GPU's own run-to-run differences), and counts which
   * steps hold. `untilSuccess` stops at the first run where every step
   * works and keeps that bake on screen.
   */
  async runTrials(n: number, untilSuccess: boolean): Promise<void> {
    const app = this.app;
    if (this.trials?.running) { this.trials.cancelled = true; app.baker.cancel(); return; }
    const t: TrialState = { running: true, total: n, done: 0, okRuns: 0, results: [], untilSuccess, kept: -1, cancelled: false };
    this.trials = t;
    app.emit('trials');
    try {
      for (let i = 0; i < n && !t.cancelled; i++) {
        this.jitter = i === 0 ? null : { seed: i * 7919 + 13, amount: 0.0008 };
        app.rebuild();
        await this.bake();
        if (!this.result || t.cancelled) break;
        const r = await (this.reportPromise ?? Promise.resolve(null));
        if (!r) break;
        t.results.push(stepResults(r));
        t.done++;
        if (r.ok) t.okRuns++;
        app.emit('trials');
        if (untilSuccess && r.ok) { t.kept = i; break; }
      }
    } finally {
      // the bake on screen keeps its own (nudged) layout until the next edit
      this.jitter = null;
      t.running = false;
      app.emit('trials');
    }
  }

  /** Re-judges the last check (e.g. an object marked as decor) without baking. */
  rejudge(): void {
    const r = this.report;
    if (r && !this.reportStale) {
      this.report = analyzeSamples(r.samples, r.sampleTimes, this.app.built, this.app.doc);
      this.app.view.updateAnalysisVisuals();
    }
    this.app.emit('report');
  }
}
