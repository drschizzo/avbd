// Dev-only physics benchmark, exposed as `window.bench(...)` / `window.benchAll(...)`.
// Bakes a truncated preset, then times steady-state engine steps (CPU encode
// vs GPU wall time) with nothing else competing for the GPU.

import type { App } from '../app';

export interface BenchRow {
  key: string;
  bodies: number;
  joints: number;
  substeps: number;
  iters: number;
  bakeMsPerFrame: number;
  stepWallMs: number;
  stepCpuMs: number;
  dispatches: number;
  checksum: number;
}

export function installBench(app: App): void {
  // Surface WGSL compile errors (three.js only reports "invalid pipeline" later).
  const dev = app.device;
  const createShaderModule = dev.createShaderModule.bind(dev);
  dev.createShaderModule = (desc: GPUShaderModuleDescriptor) => {
    const module = createShaderModule(desc);
    void module.getCompilationInfo().then((info) => {
      for (const m of info.messages) {
        if (m.type === 'error') console.error(`WGSL: ${m.message} @${m.lineNum}: ${desc.code.split('\n')[m.lineNum - 1]?.trim()}`);
      }
    });
    return module;
  };

  const bench = async (key: string, frames = 90, steps = 30): Promise<BenchRow> => {
    app.autoBake = false;
    app.loadPreset(key);
    app.built.simFrames = Math.min(app.built.simFrames, frames);
    const t0 = performance.now();
    await app.bake();
    const bakeMs = performance.now() - t0;
    app.playing = false;
    const e = app.baker.engine!, r = app.stage.renderer, b = app.baker.batcher;
    await dev.queue.onSubmittedWorkDone();
    dev.pushErrorScope('validation');
    let cpu = 0;
    const d0 = b.dispatches;
    const s0 = performance.now();
    for (let i = 0; i < steps; i++) {
      const c0 = performance.now();
      b.begin();
      e.stepFixed(r);
      b.end();
      cpu += performance.now() - c0;
    }
    await dev.queue.onSubmittedWorkDone();
    const wall = (performance.now() - s0) / steps;
    const gpuError = await dev.popErrorScope();
    if (gpuError) throw new Error(`GPU validation error during bench: ${gpuError.message}`);
    // Sum of |y| as a cheap "did the simulation change" fingerprint.
    const states = await e.readRigidBodyStatesAsync(r);
    const checksum = states ? states.reduce((a, s: any) => a + Math.abs(s.position[1]), 0) : 0;
    return {
      key, bodies: e.getBodyCount() - 1, joints: app.built.joints.length,
      substeps: e.getSubsteps(), iters: e.getSolverIterations(),
      bakeMsPerFrame: +(bakeMs / frames).toFixed(1), stepWallMs: +wall.toFixed(2), stepCpuMs: +(cpu / steps).toFixed(2),
      dispatches: (b.dispatches - d0) / steps, checksum: +checksum.toFixed(3),
    };
  };
  // Loads a preset like a user would and measures the preview's frame
  // intervals while it bakes (needs a visible page). `paced: false` uses the
  // throughput bake (no display pacing) for comparison.
  const loadTest = async (key: string, paced = true) => {
    const layer = app.pushSettings({ pacedBake: paced, autoBake: false });
    // Intervals between preview renders (not rAF ticks, which may be skipped).
    const iv: number[] = [];
    const t0 = performance.now();
    let last = t0, firstMotion = -1;
    const stage = app.stage as any;
    const render = stage.render;
    stage.render = function (this: unknown, ...args: unknown[]) {
      const n = performance.now();
      iv.push(n - last);
      last = n;
      if (firstMotion < 0 && app.time > 0) firstMotion = n - t0;
      return render.apply(this, args);
    };
    try {
      app.loadPreset(key);
      await app.bake();
    } finally {
      stage.render = render;
      layer.pop();
    }
    const total = performance.now() - t0;
    iv.sort((a, b) => a - b);
    const q = (p: number) => +iv[Math.min(iv.length - 1, Math.floor(iv.length * p))].toFixed(1);
    return {
      key, paced, bakeS: +(total / 1000).toFixed(2), firstMotionMs: Math.round(firstMotion),
      fps: +(iv.length / (total / 1000)).toFixed(1), p50: q(0.5), p95: q(0.95), max: q(1),
      over33ms: iv.filter((x) => x > 33).length, slice: app.baker.sliceSteps,
    };
  };

  const w = window as any;
  w.bench = bench;
  w.loadTest = loadTest;
  w.benchAll = async (keys: string[], frames?: number) => {
    w.benchDone = false;
    w.benchOut = [];
    for (const k of keys) w.benchOut.push(await bench(k, frames));
    w.benchDone = true;
    console.table(w.benchOut);
    return w.benchOut;
  };
}
