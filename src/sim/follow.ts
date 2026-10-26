// Follow camera: where the action is, read from the machine check's sampled
// poses. Each object (entity) that moves pulls the camera toward its moving
// bodies, weighted by its squared speed and by novelty (what has just started moving
// counts more than what has been moving for a while: a pouring hourglass must
// not hold the shot while a marble sets off a row). The track is smoothed
// over time (weighted by activity, so quiet moments hold the last shot) and
// framed by the spread of what moves.

import type { BuiltScene } from '../scene/build';
import { KIND_DYNAMIC } from '../scene/build';
import { FOLLOW_DEFAULTS, type CameraSettings, type SceneDoc, type Vec3 } from '../scene/doc';
import type { MachineReport } from './analysis';

export interface FollowRaw {
  times: number[];
  /** per sample: activity-weighted centre and spread of the action, weight */
  cx: Float64Array; cy: Float64Array; cz: Float64Array;
  spread: Float64Array;
  weight: Float64Array;
}

export interface FollowTrack {
  times: number[];
  target: Vec3[];
  radius: number[];
}

/** Activity per sample, from the report's sampled poses (simulation seconds). */
export function followRaw(report: MachineReport, built: BuiltScene, doc: SceneDoc): FollowRaw | null {
  const S = report.samples.length;
  if (S < 3) return null;
  const f32 = report.samples.map((u) => new Float32Array(u.buffer, u.byteOffset, u.length));
  const times = report.sampleTimes;
  // dynamic bodies of the entities the camera may look at, grouped by entity
  const groups = new Map<number, number[]>();
  built.bodies.forEach((b, i) => {
    if (b.kind !== KIND_DYNAMIC) return;
    const e = doc.entities[b.entity];
    if (!e || e.camera === false) return;
    let g = groups.get(b.entity);
    if (!g) groups.set(b.entity, (g = []));
    g.push(i);
  });
  const ents = [...groups.values()];
  const firstMove = new Float64Array(ents.length).fill(-1);
  const out: FollowRaw = {
    times: [...times],
    cx: new Float64Array(S), cy: new Float64Array(S), cz: new Float64Array(S),
    spread: new Float64Array(S), weight: new Float64Array(S),
  };
  const ec = new Float64Array(ents.length * 4); // x, y, z, weight
  const es = new Float64Array(ents.length); // spread within the entity
  for (let s = 1; s < S; s++) {
    const dt = Math.max(1e-3, times[s] - times[s - 1]);
    const P = f32[s], Q = f32[s - 1];
    const t = times[s];
    ents.forEach((ids, n) => {
      let w = 0, x = 0, y = 0, z = 0, vmax = 0;
      for (const i of ids) {
        const k = (i + 1) * 4;
        const py = P[k + 1];
        if (py < -1) continue; // fell out of the world
        const dx = P[k] - Q[k], dy = py - Q[k + 1], dz = P[k + 2] - Q[k + 2];
        const v = Math.sqrt(dx * dx + dy * dy + dz * dz) / dt;
        if (v < 0.05 || v > 15) continue; // at rest, or a spawn teleport
        const wv = Math.min(v, 3);
        w += wv; x += P[k] * wv; y += py * wv; z += P[k + 2] * wv;
        if (v > vmax) vmax = v;
      }
      if (w <= 0) { ec[n * 4 + 3] = 0; return; }
      x /= w; y /= w; z /= w;
      let ss = 0;
      for (const i of ids) {
        const k = (i + 1) * 4;
        const dx = P[k] - Q[k], dy = P[k + 1] - Q[k + 1], dz = P[k + 2] - Q[k + 2];
        const v = Math.sqrt(dx * dx + dy * dy + dz * dz) / dt;
        if (v < 0.05 || v > 15 || P[k + 1] < -1) continue;
        const wv = Math.min(v, 3);
        ss += wv * ((P[k] - x) ** 2 + (P[k + 1] - y) ** 2 + (P[k + 2] - z) ** 2);
      }
      if (firstMove[n] < 0 && vmax > 0.15) firstMove[n] = t;
      const age = firstMove[n] < 0 ? 0 : t - firstMove[n];
      const novelty = 0.08 + 0.92 * Math.exp(-age / 2);
      ec[n * 4] = x; ec[n * 4 + 1] = y; ec[n * 4 + 2] = z;
      // squared speed: the fast main event outweighs what still rocks or rolls
      // slowly elsewhere (a seesaw settling, a marble idling on a shelf)
      ec[n * 4 + 3] = Math.min(vmax, 3) ** 2 * novelty;
      es[n] = Math.sqrt(ss / w);
    });
    let W = 0, X = 0, Y = 0, Z = 0;
    for (let n = 0; n < ents.length; n++) {
      const w = ec[n * 4 + 3];
      if (w <= 0) continue;
      W += w; X += ec[n * 4] * w; Y += ec[n * 4 + 1] * w; Z += ec[n * 4 + 2] * w;
    }
    if (W <= 0) continue;
    X /= W; Y /= W; Z /= W;
    let V = 0;
    for (let n = 0; n < ents.length; n++) {
      const w = ec[n * 4 + 3];
      if (w <= 0) continue;
      V += w * ((ec[n * 4] - X) ** 2 + (ec[n * 4 + 1] - Y) ** 2 + (ec[n * 4 + 2] - Z) ** 2 + es[n] ** 2);
    }
    out.cx[s] = X; out.cy[s] = Y; out.cz[s] = Z;
    out.spread[s] = Math.sqrt(V / W);
    out.weight[s] = W;
  }
  return out.weight.some((w) => w > 0) ? out : null;
}

/** Gaussian smoothing weighted by activity: quiet samples hold the last shot. */
export function followTrack(raw: FollowRaw, smooth: number): FollowTrack {
  const T = raw.times, S = T.length;
  const sig = Math.max(0.05, smooth), sigR = sig * 1.6;
  const target: Vec3[] = [], radius: number[] = [];
  const dt = Math.max(1e-3, (T[S - 1] - T[0]) / Math.max(1, S - 1));
  const reach = Math.ceil((3 * sigR) / dt);
  let last: Vec3 | null = null, lastR = 1;
  for (let s = 0; s < S; s++) {
    let W = 0, X = 0, Y = 0, Z = 0, WR = 0, R = 0;
    for (let j = Math.max(0, s - reach); j <= Math.min(S - 1, s + reach); j++) {
      const w = raw.weight[j];
      if (w <= 0) continue;
      const d = T[j] - T[s];
      const g = Math.exp(-(d * d) / (2 * sig * sig)) * w;
      const gr = Math.exp(-(d * d) / (2 * sigR * sigR)) * w;
      W += g; X += raw.cx[j] * g; Y += raw.cy[j] * g; Z += raw.cz[j] * g;
      WR += gr; R += raw.spread[j] * gr;
    }
    if (W > 1e-4) last = [X / W, Y / W, Z / W];
    if (WR > 1e-4) lastR = R / WR;
    target.push(last ? [...last] as Vec3 : [NaN, NaN, NaN]);
    radius.push(lastR);
  }
  // before the first motion: the first shot
  const first = target.findIndex((p) => !Number.isNaN(p[0]));
  for (let s = 0; s < first; s++) { target[s] = [...target[first]] as Vec3; radius[s] = radius[first]; }
  return { times: [...T], target, radius };
}

/** Target and framed radius at simulation time t (seconds). */
export function followAt(track: FollowTrack, t: number): { target: Vec3; radius: number } {
  const T = track.times, S = T.length;
  if (t <= T[0]) return { target: track.target[0], radius: track.radius[0] };
  if (t >= T[S - 1]) return { target: track.target[S - 1], radius: track.radius[S - 1] };
  let lo = 0, hi = S - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
  const u = (t - T[lo]) / Math.max(1e-6, T[hi] - T[lo]);
  const a = track.target[lo], b = track.target[hi];
  return {
    target: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u],
    radius: track.radius[lo] + (track.radius[hi] - track.radius[lo]) * u,
  };
}

/** Camera distance that frames a sphere of `radius` (at least the closeness), never farther than the wide shot. */
export function followDistance(c: CameraSettings, radius: number, wide: number): number {
  const r = Math.max(c.followSize ?? FOLLOW_DEFAULTS.followSize, radius * 1.5);
  const d = r / Math.tan((c.fov * Math.PI) / 360);
  return Math.min(wide, d);
}
