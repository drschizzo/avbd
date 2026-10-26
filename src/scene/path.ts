// Drawn paths: a polyline of control points (entity frame) smoothed into a
// centripetal Catmull-Rom curve, then filled with a row of objects (dominoes,
// marbles, blocks) or built into a track (rail, ramp, low wall).

import * as THREE from 'three';
import type { Vec3 } from './doc';
import { DEG, qAxis, qBasis, qMul, type Q4 } from './geom';

export type PathFill = 'dominoes' | 'marbles' | 'blocks' | 'rail' | 'track' | 'wall';
export const PATH_FILLS: PathFill[] = ['dominoes', 'marbles', 'blocks', 'rail', 'track', 'wall'];
export const TRACK_FILLS: PathFill[] = ['rail', 'track', 'wall'];
export const isTrack = (f: string): boolean => TRACK_FILLS.includes(f as PathFill);

/** Sensible defaults when switching fill (sizes in metres). */
export const FILL_DEFAULTS: Record<PathFill, { size: Vec3; spacing: number }> = {
  dominoes: { size: [0.08, 0.5, 0.25], spacing: 0.55 },
  marbles: { size: [0.18, 0.18, 0.18], spacing: 1.08 },
  blocks: { size: [0.3, 0.3, 0.3], spacing: 1.15 },
  rail: { size: [0.3, 0.1, 0.04], spacing: 1 },
  track: { size: [0.5, 0, 0.05], spacing: 1 },
  wall: { size: [0.06, 0.3, 0.06], spacing: 1 },
};

export interface PathSample {
  p: THREE.Vector3;
  t: THREE.Vector3; // unit tangent
  s: number; // arc length
}

/** Dense polyline along the (smoothed) control points, with arc length. */
export function densePath(points: Vec3[], smooth: boolean, closed: boolean): { pts: THREE.Vector3[]; cum: number[] } {
  const ctrl = points.map((p) => new THREE.Vector3(...p));
  if (ctrl.length < 2) return { pts: ctrl, cum: ctrl.map(() => 0) };
  let pts: THREE.Vector3[];
  if (smooth && ctrl.length > 2) {
    const curve = new THREE.CatmullRomCurve3(ctrl, closed, 'centripetal');
    const n = Math.max(64, ctrl.length * 24);
    pts = curve.getPoints(n);
  } else {
    pts = [...ctrl];
    if (closed) pts.push(ctrl[0].clone());
    // subdivide straight segments so walking them is exact anyway
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  return { pts, cum };
}

/** Points every `step` metres along the dense path (from `start`). */
export function walkPath(d: { pts: THREE.Vector3[]; cum: number[] }, step: number, start = 0, maxCount = 4000): PathSample[] {
  const out: PathSample[] = [];
  const { pts, cum } = d;
  if (pts.length < 2 || step <= 1e-6) return out;
  const L = cum[cum.length - 1];
  let k = 0;
  for (let s = start; s <= L + 1e-6 && out.length < maxCount; s += step) {
    while (k < pts.length - 2 && cum[k + 1] < s) k++;
    const seg = Math.max(1e-9, cum[k + 1] - cum[k]);
    const f = Math.min(1, Math.max(0, (s - cum[k]) / seg));
    const p = pts[k].clone().lerp(pts[k + 1], f);
    const t = pts[k + 1].clone().sub(pts[k]);
    if (t.lengthSq() < 1e-12) t.set(1, 0, 0);
    out.push({ p, t: t.normalize(), s });
  }
  return out;
}

export function pathLength(points: Vec3[], smooth: boolean, closed: boolean): number {
  const d = densePath(points, smooth, closed);
  return d.cum[d.cum.length - 1] ?? 0;
}

/** Ramer–Douglas–Peucker simplification of a drawn stroke. */
export function simplify(points: THREE.Vector3[], tolerance: number): THREE.Vector3[] {
  if (points.length <= 2) return points.map((p) => p.clone());
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  const line = new THREE.Line3();
  const tmp = new THREE.Vector3();
  while (stack.length) {
    const [a, b] = stack.pop()!;
    line.set(points[a], points[b]);
    let best = -1, bestD = tolerance;
    for (let i = a + 1; i < b; i++) {
      line.closestPointToPoint(points[i], true, tmp);
      const d = tmp.distanceTo(points[i]);
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return points.filter((_, i) => keep[i]).map((p) => p.clone());
}

/** Resamples a stroke to points roughly `step` apart (keeps both ends). */
export function resample(points: THREE.Vector3[], step: number): THREE.Vector3[] {
  if (points.length < 2) return points.map((p) => p.clone());
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + points[i].distanceTo(points[i - 1]));
  const L = cum[cum.length - 1];
  const n = Math.max(1, Math.round(L / step));
  const out: THREE.Vector3[] = [];
  let k = 0;
  for (let i = 0; i <= n; i++) {
    const s = (L * i) / n;
    while (k < points.length - 2 && cum[k + 1] < s) k++;
    const f = (s - cum[k]) / Math.max(1e-9, cum[k + 1] - cum[k]);
    out.push(points[k].clone().lerp(points[k + 1], Math.min(1, Math.max(0, f))));
  }
  return out;
}

// ---------------------------------------------------------------------------

export interface PathBody {
  shape: 'box' | 'sphere';
  he: Vec3;
  p: Vec3;
  q?: Q4;
  idx: number;
  t: number;
  angVel?: Vec3;
  track: boolean;
}

/** Horizontal side vector of a tangent (falls back to `prev` on vertical tangents). */
function sideOf(t: THREE.Vector3, prev: THREE.Vector3 | null): THREE.Vector3 {
  const s = new THREE.Vector3().crossVectors(t, new THREE.Vector3(0, 1, 0));
  if (s.lengthSq() < 1e-6) return prev ? prev.clone() : new THREE.Vector3(0, 0, 1);
  s.normalize();
  if (prev && s.dot(prev) < 0) s.negate();
  return s;
}

/** Bodies of a path entity, in its local frame. */
export function buildPath(p: Record<string, any>): PathBody[] {
  const fill = (p.fill ?? 'dominoes') as PathFill;
  let pts: Vec3[] = (p.points as Vec3[] | undefined)?.filter((x) => Array.isArray(x) && x.length === 3) ?? [];
  if (pts.length < 2) return [];
  if (p.reverse) pts = [...pts].reverse();
  const closed = !!p.closed && pts.length > 2;
  const dense = densePath(pts, p.smooth !== false, closed);
  const L = dense.cum[dense.cum.length - 1];
  if (L < 1e-3) return [];
  // Drop: the start is raised, the drawn end keeps its height.
  const drop = Number(p.drop) || 0;
  if (drop !== 0) dense.pts.forEach((q, i) => { q.y += drop * (1 - dense.cum[i] / L); });
  const out: PathBody[] = [];
  const [sx, sy, sz] = p.size as Vec3;

  if (fill === 'dominoes' || fill === 'blocks' || fill === 'marbles') {
    const along = fill === 'dominoes' ? sy : fill === 'marbles' ? sx : sx;
    const step = Math.max(0.01, (p.spacing ?? 1) * along);
    const samples = walkPath(dense, step, 0, 4000);
    // a closed loop must not put its last item onto the first
    if (closed && samples.length > 1 && L - samples[samples.length - 1].s < step * 0.5) samples.pop();
    samples.forEach((smp, i) => {
      const yaw = Math.atan2(-smp.t.z, smp.t.x);
      const u = samples.length > 1 ? i / (samples.length - 1) : 0;
      if (fill === 'marbles') {
        const r = sx / 2;
        out.push({ shape: 'sphere', he: [r, r, r], p: [smp.p.x, smp.p.y + r + 0.0005, smp.p.z], idx: i, t: u, track: false });
        return;
      }
      const he: Vec3 = [sx / 2, sy / 2, sz / 2];
      let q = qAxis([0, 1, 0], yaw);
      let pos: Vec3 = [smp.p.x, smp.p.y + sy / 2 + 0.0005, smp.p.z];
      let angVel: Vec3 | undefined;
      if (fill === 'dominoes' && i === 0 && (p.push ?? 0) > 0) {
        // tip the first domino forward around its bottom front edge
        const tilt = p.push * DEG;
        const fwd: Vec3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
        const side: Vec3 = [Math.sin(yaw), 0, Math.cos(yaw)];
        q = qMul(qAxis(side, -tilt), q);
        const pivot: Vec3 = [smp.p.x + fwd[0] * sx / 2, smp.p.y, smp.p.z + fwd[2] * sx / 2];
        const rel = new THREE.Vector3(-sx / 2, sy / 2, 0).applyQuaternion(new THREE.Quaternion(...q));
        pos = [pivot[0] + rel.x, pivot[1] + rel.y + 0.0005, pivot[2] + rel.z];
        angVel = [side[0] * -2.0, 0, side[2] * -2.0];
      }
      out.push({ shape: 'box', he, p: pos, q, idx: i, t: u, angVel, track: false });
    });
    return out;
  }

  // Tracks: short straight pieces following the curve, the path itself being
  // the running surface (top of the floor). Each piece laps FORWARD over the
  // next one only, and sits a hair below its predecessor: a seam is then at
  // worst a sub-millimetre drop, never a step up - AVBD contacts are
  // inelastic, and a rail of 50 tiny steps brakes a marble to a crawl.
  const segLen = Math.min(0.35, Math.max(0.06, L / Math.ceil(L / 0.22)));
  const n = Math.max(1, Math.round(L / segLen));
  const step = L / n;
  const nodes = walkPath(dense, step, 0, 5000);
  if (nodes.length < n + 1) {
    const last = dense.pts[dense.pts.length - 1];
    nodes.push({ p: last.clone(), t: last.clone().sub(dense.pts[dense.pts.length - 2]).normalize(), s: L });
  }
  const width = fill === 'wall' ? 0 : sx;
  const wallH = fill === 'track' ? 0 : sy;
  const thick = Math.max(0.01, sz);
  const sink = Math.min(0.0005, 0.03 / n);
  let prevSide: THREE.Vector3 | null = null;
  for (let i = 0; i < n; i++) {
    const a = nodes[i].p, b = nodes[Math.min(i + 1, nodes.length - 1)].p;
    const t = b.clone().sub(a);
    const len = t.length();
    if (len < 1e-5) continue;
    t.normalize();
    const side = sideOf(t, prevSide);
    prevSide = side;
    const up = new THREE.Vector3().crossVectors(side, t).normalize();
    const q = qBasis(t, up, side);
    const ext = i < n - 1 || closed ? Math.max(thick * 1.5, width * 0.25) : 0;
    const mid = a.clone().add(b).multiplyScalar(0.5).addScaledVector(t, ext / 2);
    mid.y -= sink * i;
    const half = len / 2 + ext / 2;
    const u = n > 1 ? i / (n - 1) : 0;
    const put = (offUp: number, offSide: number, he: Vec3) => {
      const c = mid.clone().addScaledVector(up, offUp).addScaledVector(side, offSide);
      out.push({ shape: 'box', he, p: [c.x, c.y, c.z], q, idx: i, t: u, track: true });
    };
    if (fill === 'wall') {
      put(sy / 2, 0, [half, sy / 2, thick / 2]);
      continue;
    }
    put(-thick / 2, 0, [half, thick / 2, width / 2 + (wallH > 0 ? thick : 0)]);
    if (wallH > 0) {
      for (const s of [-1, 1]) put(wallH / 2 - thick / 2 + 0.0005, s * (width / 2 + thick / 2), [half, wallH / 2 + thick / 2, thick / 2]);
    }
  }
  return out;
}

/** Track ends, as connection ports (entity frame, direction pointing out). */
export function pathPorts(p: Record<string, any>): { p: Vec3; dir: Vec3 }[] {
  if (!isTrack(p.fill) || p.closed) return [];
  let pts: Vec3[] = p.points ?? [];
  if (pts.length < 2) return [];
  if (p.reverse) pts = [...pts].reverse();
  const dense = densePath(pts, p.smooth !== false, false);
  const P = dense.pts, L = dense.cum[dense.cum.length - 1];
  const drop = Number(p.drop) || 0;
  const a = P[0].clone(), b = P[P.length - 1].clone();
  a.y += drop;
  const ta = P[0].clone().sub(P[1]).normalize();
  const tb = P[P.length - 1].clone().sub(P[P.length - 2]).normalize();
  void L;
  return [
    { p: [a.x, a.y, a.z], dir: [ta.x, ta.y, ta.z] },
    { p: [b.x, b.y, b.z], dir: [tb.x, tb.y, tb.z] },
  ];
}

/** Generated shapes for a new path (entity frame). */
export function shapePoints(shape: string, size = 3): Vec3[] {
  const out: Vec3[] = [];
  switch (shape) {
    case 'arc': for (let i = 0; i <= 8; i++) { const a = (i / 8) * Math.PI; out.push([-Math.cos(a) * size / 2, 0, -Math.sin(a) * size / 2 + size / 4]); } break;
    case 's-curve': for (let i = 0; i <= 10; i++) { const u = i / 10; out.push([(u - 0.5) * size * 1.4, 0, Math.sin(u * Math.PI * 2) * size * 0.25]); } break;
    case 'circle': for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; out.push([Math.cos(a) * size / 2, 0, Math.sin(a) * size / 2]); } break;
    case 'helix': {
      const turns = 2, per = 12, r = size / 3, h = size * 0.5;
      for (let i = 0; i <= turns * per; i++) { const a = (i / per) * Math.PI * 2; out.push([Math.cos(a) * r, h * (1 - i / (turns * per)), Math.sin(a) * r]); }
      break;
    }
    case 'zigzag': for (let i = 0; i <= 6; i++) out.push([(i / 6 - 0.5) * size * 1.4, 0, (i % 2 ? 0.3 : -0.3) * size / 2]); break;
    case 'line':
    default: out.push([-size / 2, 0, 0], [size / 2, 0, 0]); break;
  }
  return out;
}
