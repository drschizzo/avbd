// Diagrams that show the solver at work run the real mini engine — which is
// far too expensive to redo every animation frame. So they do exactly what the
// application itself does: simulate once into a recording, then play it back.
// A recording is keyed by its parameters and rebuilt only when one changes.

import { Mini, makeBox, makeCircle, separation, type Body, type Params } from './mini';

export interface Rec {
  /** [x, y, a] per body per frame */
  poses: Float64Array;
  n: number;
  frames: number;
  /** half extents and shape, for drawing */
  shape: { hw: number; hh: number; circle: boolean; m: number; a0: number }[];
  /** worst penetration per frame (m) */
  pen: Float64Array;
  /** per-frame contact count */
  nc: Int32Array;
  /** final worst penetration over the settled part of the clip */
  settled: number;
  diverged: boolean;
  bounds: { x0: number; x1: number; y0: number };
}

export type Builder = (m: Mini) => void;

const cache = new Map<string, Rec>();
const MAX = 96;

/**
 * Some diagrams plot a dozen points, each one a whole simulation. Computing
 * them all on the first frame would freeze the page, so they ask for them
 * lazily: at most a couple of new recordings per drawn frame, the rest arrive
 * over the next few frames and the curve fills in.
 */
let budget = 0;
export function beginBudget(n: number): void { budget = n; }

/** Simulates `frames` frames of `build` under `params` and records every frame. */
export function record(key: string, build: Builder, params: Partial<Params>, frames: number, bounds = { x0: -3, x1: 3, y0: 0 }): Rec {
  return recordLazy(key, build, params, frames, bounds, false)!;
}

/** Same, but returns null instead of blocking when the frame budget is spent. */
export function recordMaybe(key: string, build: Builder, params: Partial<Params>, frames: number, bounds = { x0: -3, x1: 3, y0: 0 }): Rec | null {
  return recordLazy(key, build, params, frames, bounds, true);
}

function recordLazy(key: string, build: Builder, params: Partial<Params>, frames: number, bounds: { x0: number; x1: number; y0: number }, lazy: boolean): Rec | null {
  const k = `${key}|${frames}|${JSON.stringify(params)}`;
  const hit = cache.get(k);
  if (hit) return hit;
  if (lazy && budget <= 0) return null;
  budget--;
  const m = new Mini(params, { bounds });
  build(m);
  m.commitInitial();
  const n = m.bodies.length;
  const poses = new Float64Array(n * 3 * frames);
  const pen = new Float64Array(frames);
  const nc = new Int32Array(frames);
  let diverged = false;
  for (let f = 0; f < frames; f++) {
    if (!diverged) {
      m.step();
      for (const b of m.bodies) if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || Math.abs(b.y) > 40) diverged = true;
    }
    const o = f * n * 3;
    m.bodies.forEach((b, i) => { poses[o + i * 3] = b.x; poses[o + i * 3 + 1] = b.y; poses[o + i * 3 + 2] = b.a; });
    pen[f] = diverged ? NaN : m.stats.pen;
    nc[f] = m.contacts.length;
  }
  let settled = 0;
  for (let f = Math.floor(frames * 0.45); f < frames; f++) if (Number.isFinite(pen[f])) settled = Math.max(settled, pen[f]);
  const rec: Rec = {
    poses, n, frames, pen, nc, settled, diverged, bounds,
    shape: m.bodies.map((b) => ({ hw: b.hw, hh: b.hh, circle: b.shape === 'circle', m: b.m, a0: 0 })),
  };
  if (cache.size > MAX) cache.delete(cache.keys().next().value as string);
  cache.set(k, rec);
  return rec;
}

/** Pose of body `i` at frame `f` of a recording. */
export function poseOf(r: Rec, f: number, i: number): [number, number, number] {
  const o = (Math.min(r.frames - 1, Math.max(0, Math.floor(f))) * r.n + i) * 3;
  return [r.poses[o], r.poses[o + 1], r.poses[o + 2]];
}

// ------------------------------------------------------------------ scenes

export const BUILD = {
  stack: (n: number) => (m: Mini) => { for (let i = 0; i < n; i++) m.add(makeBox(0, 0.25 + i * 0.502, 0.25, 0.25)); },
  oneBox: () => (m: Mini) => { m.add(makeBox(0, 1.4, 0.25, 0.25)); },
  dropBall: () => (m: Mini) => { m.add(makeCircle(0, 2, 0.25)); },
  slope: (deg: number) => (m: Mini) => {
    const th = (deg * Math.PI) / 180;
    const r = makeBox(0, 0, 2.6, 0.1, { m: 0 }); r.a = th; m.add(r);
    const d = 0.1 + 0.15 + 0.004, t = 1.1;
    const b = makeBox(t * Math.cos(th) - d * Math.sin(th), t * Math.sin(th) + d * Math.cos(th), 0.15, 0.15);
    b.a = th; m.add(b);
  },
  chain: (links: number) => (m: Mini) => {
    for (let i = 0; i < links; i++) m.add(makeCircle(-0.9 + i * 0.22, 1.6, 0.1));
  },
} as const;

/** Solver index used by the course values → mini engine solver name. */
export const SOLVERS = ['none', 'pgs', 'penalty', 'avbd'] as const;
export const solverOf = (v: number): Params['solver'] => SOLVERS[Math.max(0, Math.min(3, Math.round(v)))];

export { Mini, makeBox, makeCircle, separation };
export type { Body, Params };
