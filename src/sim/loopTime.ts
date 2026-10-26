// Video time -> simulated time for boomerang loops.
//
// The clip is split into a forward run, played at the true physics speed and
// slowing down smoothly into the apex, and a rewind that accelerates to
// `rewind` x the forward speed and lands softly back on frame 0. Only the
// forward span is simulated, so a fast rewind leaves more of the clip to real
// physics.

import type { SceneDoc } from '../scene/doc';

/** Ease-in / ease-out fractions of the rewind (cosine ramps). */
const RAMP_IN = 0.35;
const RAMP_OUT = 0.25;
const REWIND_AVG = 1 - RAMP_IN / 2 - RAMP_OUT / 2;

export interface BoomerangSpans {
  /** forward run (video seconds) */
  forward: number;
  /** rewind (video seconds) */
  rewind: number;
  /** slow-down into the apex (video seconds, inside the forward run) */
  apex: number;
  /** simulated span (sim seconds) */
  sim: number;
  /** peak rewind speed (sim seconds per video second) */
  peak: number;
}

export function boomerangSpans(doc: SceneDoc): BoomerangSpans {
  const D = doc.duration;
  const peak = Math.max(0.5, doc.loop.rewind ?? 1.5);
  const apex = Math.max(0, Math.min(D * 0.4, doc.loop.apex ?? 0.6));
  // forward: sim = forward - apex / 2 (cosine slow-down); rewind: sim = peak * avg * rewind
  const rewind = (D - apex / 2) / (1 + REWIND_AVG * peak);
  const forward = D - rewind;
  return { forward, rewind, apex, sim: forward - apex / 2, peak };
}

/** Simulated time shown at video time t (seconds). */
export function boomerangSimTime(s: BoomerangSpans, t: number, duration: number): number {
  let u = t % duration;
  if (u < 0) u += duration;
  if (u < s.forward) {
    const k = s.forward - s.apex;
    if (u <= k || s.apex <= 0) return Math.min(u, s.sim);
    const x = u - k;
    return Math.min(s.sim, k + 0.5 * (x + (s.apex / Math.PI) * Math.sin((Math.PI * x) / s.apex)));
  }
  const r = Math.min(1, (u - s.forward) / Math.max(s.rewind, 1e-6));
  let W: number;
  if (r < RAMP_IN) W = 0.5 * (r - (RAMP_IN / Math.PI) * Math.sin((Math.PI * r) / RAMP_IN));
  else if (r <= 1 - RAMP_OUT) W = RAMP_IN / 2 + (r - RAMP_IN);
  else {
    const q = 1 - r;
    W = REWIND_AVG - 0.5 * (q - (RAMP_OUT / Math.PI) * Math.sin((Math.PI * q) / RAMP_OUT));
  }
  return Math.max(0, s.sim * (1 - W / REWIND_AVG));
}
