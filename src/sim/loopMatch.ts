// Continuous loops: pairs every body with an interchangeable twin.
//
// The recorded pass starts where the warm-up ended, so its last frames and the
// warm-up's last frames are two takes of the same moment of a cycle: the same
// pile, the same stream, the same churn, but not the same grain in the same
// place. Bodies that look identical (same shape, size, colour and finish) can
// trade places, so each body of the recorded pass is matched with the one of
// the warm-up that ends up closest to it, and the loop blend steers it onto
// that body's trajectory. At the seam, frame D shows body i where frame 0 shows
// its twin: same picture, nothing jumps.
//
// Boxes may also be turned by any rotation that maps the box onto itself (a
// cube has 24), whichever is closest; spheres take whatever rotation they had.

import type { BuiltScene } from '../scene/build';
import { KIND_DYNAMIC } from '../scene/build';
import type { SceneDoc } from '../scene/doc';
import type { BakeResult } from './baker';
import { packQuat } from '../render/bodies';

type Q = [number, number, number, number];

function decodeQuat(p: number): Q {
  const idx = p >>> 30;
  const c = [(p & 1023) / 1023 - 0.5, ((p >>> 10) & 1023) / 1023 - 0.5, ((p >>> 20) & 1023) / 1023 - 0.5].map((x) => x * 1.41421356);
  const w = Math.sqrt(Math.max(0, 1 - c[0] * c[0] - c[1] * c[1] - c[2] * c[2]));
  const q: number[] = [...c];
  q.splice(idx, 0, w);
  return q as Q;
}

function qmul(a: Q, b: Q): Q {
  return [
    a[3] * b[0] + b[3] * a[0] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] + b[3] * a[1] + a[2] * b[0] - a[0] * b[2],
    a[3] * b[2] + b[3] * a[2] + a[0] * b[1] - a[1] * b[0],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
const conj = (q: Q): Q => [-q[0], -q[1], -q[2], q[3]];
const qdot = (a: Q, b: Q) => Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);

/** Rotations (local frame) that map a box with half extents he onto itself. */
function boxSymmetries(he: number[]): Q[] {
  const eq = (a: number, b: number) => Math.abs(a - b) <= 1e-4 * Math.max(a, b);
  const s = Math.SQRT1_2;
  const gens: Q[] = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]; // half turns
  if (eq(he[1], he[2])) gens.push([s, 0, 0, s]); // quarter turns about x
  if (eq(he[0], he[2])) gens.push([0, s, 0, s]);
  if (eq(he[0], he[1])) gens.push([0, 0, s, s]);
  const group: Q[] = [[0, 0, 0, 1]];
  for (let k = 0; k < group.length && group.length < 24; k++) {
    for (const g of gens) {
      const c = qmul(group[k], g);
      if (!group.some((x) => qdot(x, c) > 0.999)) group.push(c);
    }
  }
  return group;
}

/** Linear RGB -> 10:10:10 (sqrt-encoded) with bit 30 set: "fade to this colour". */
function packColor(c: number[]): number {
  const e = (x: number) => Math.max(0, Math.min(1023, Math.round(Math.sqrt(Math.max(0, x)) * 1023)));
  return (e(c[0]) | (e(c[1]) << 10) | (e(c[2]) << 20) | (1 << 30)) >>> 0;
}

/** Copies a few recorded frames of the history back to the CPU. */
export async function readFrames(device: GPUDevice, renderer: any, res: BakeResult, slots: number[]): Promise<Uint32Array[]> {
  const src = renderer.backend.get(res.history)?.buffer as GPUBuffer | undefined;
  if (!src) throw new Error('history buffer not on the GPU');
  const bytes = res.stride * 16;
  const staging = device.createBuffer({ size: bytes * slots.length, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  slots.forEach((s, k) => enc.copyBufferToBuffer(src, s * bytes, staging, k * bytes, bytes));
  device.queue.submit([enc.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const all = new Uint32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return slots.map((_, k) => all.subarray(k * res.stride * 4, (k + 1) * res.stride * 4));
}

/**
 * Returns the per-body loop targets (engine-indexed uvec4: twin index, packed
 * symmetry quaternion) for a continuous bake, or null if it has no tail.
 */
export async function matchLoop(device: GPUDevice, renderer: any, res: BakeResult, built: BuiltScene, doc: SceneDoc): Promise<Uint32Array | null> {
  const tail = res.tail;
  if (!tail) return null;
  const N = res.stride;
  const end = res.frames - 1;
  const mid = Math.max(tail.start, end - Math.round((doc.loop.outro * res.fps) / (2 * res.recordEvery)));
  const tailSlot = (f: number) => tail.base + (f - tail.start);
  const [pMid, pEnd, wMid, wEnd] = await readFrames(device, renderer, res, [mid, end, tailSlot(mid), tailSlot(end)]);
  const f32 = (u: Uint32Array) => new Float32Array(u.buffer, u.byteOffset, u.length);
  const PM = f32(pMid), PE = f32(pEnd), WM = f32(wMid), WE = f32(wEnd);

  const out = new Uint32Array(N * 4);
  const id = packQuat([0, 0, 0, 1]);
  for (let i = 0; i < N; i++) { out[i * 4] = i; out[i * 4 + 1] = id; }

  // bodies held by joints keep their own trajectory (a strand of beads cannot trade places)
  const jointed = new Set<number>();
  for (const j of built.joints) { jointed.add(j.b); if (j.a !== null) jointed.add(j.a); }
  const classes = new Map<string, number[]>();
  built.bodies.forEach((b, i) => {
    if (b.kind !== KIND_DYNAMIC || jointed.has(i)) return;
    // colour is not part of the class: it can cross-fade (see below)
    const key = `${b.shape}|${b.he.map((x) => x.toFixed(4))}|${b.finish}`;
    let list = classes.get(key);
    if (!list) classes.set(key, (list = []));
    list.push(i + 1); // engine index
  });

  const d2 = (A: Float32Array, i: number, B: Float32Array, j: number) => {
    const dx = A[i * 4] - B[j * 4], dy = A[i * 4 + 1] - B[j * 4 + 1], dz = A[i * 4 + 2] - B[j * 4 + 2];
    return dx * dx + dy * dy + dz * dz;
  };
  // both ends of the blend matter: halfway it is half-applied, at the end fully
  const colorKey = (i: number) => built.bodies[i - 1].color.map((x) => x.toFixed(3)).join();
  const colorOf = new Map<number, string>();
  for (const list of classes.values()) for (const i of list) colorOf.set(i, colorKey(i));
  // A body may take the place of a twin of another colour and cross-fade to
  // it, but only when that spares it a trip of a couple of body sizes: in a
  // well-mixed pile of three colours the nearest twin of the same colour is
  // ~1.7 bodies away, and gliding that far through the pile reads worse than
  // a colour change.
  let swapCost = 0;
  const cost = (i: number, j: number) => d2(PM, i, WM, j) + d2(PE, i, WE, j) + (colorOf.get(i) === colorOf.get(j) ? 0 : swapCost);

  let moved = 0, total = 0, hops = 0, swaps = 0;
  for (const members of classes.values()) {
    const n = members.length;
    const heMax = Math.max(...built.bodies[members[0] - 1].he);
    swapCost = (globalThis as any).__matchNoSwap ? 1e9 : 2 * (2.5 * heMax) ** 2;
    const twin = new Map<number, number>();
    if (n === 1) twin.set(members[0], members[0]);
    else {
      // candidate twins: K nearest warm-up end positions, through a grid
      const K = Math.min(n, 12);
      // cell size from the bulk (10th-90th percentiles): bodies that fell
      // away (recycled streams drop hundreds of metres) must not inflate it
      const lo = [0, 0, 0], hi = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        const xs = members.map((j) => WE[j * 4 + k]).sort((a, b) => a - b);
        lo[k] = xs[Math.floor((n - 1) * 0.1)];
        hi[k] = xs[Math.ceil((n - 1) * 0.9)];
      }
      const vol = Math.max(1e-6, (hi[0] - lo[0] + 1e-3) * (hi[1] - lo[1] + 1e-3) * (hi[2] - lo[2] + 1e-3));
      const cell = Math.max(1e-3, Math.cbrt((vol / (n * 0.8 * 0.8 * 0.8)) * 4));
      const cellOf = (x: number, k: number) => Math.floor((x - lo[k]) / cell);
      const grid = new Map<string, number[]>();
      for (const j of members) {
        const key = `${cellOf(WE[j * 4], 0)},${cellOf(WE[j * 4 + 1], 1)},${cellOf(WE[j * 4 + 2], 2)}`;
        let l = grid.get(key);
        if (!l) grid.set(key, (l = []));
        l.push(j);
      }
      const cand = new Map<number, number[]>();
      const pairs: [number, number, number][] = [];
      for (const i of members) {
        const c = [cellOf(PE[i * 4], 0), cellOf(PE[i * 4 + 1], 1), cellOf(PE[i * 4 + 2], 2)];
        let found: number[] = [];
        for (let r = 1; r <= 4; r++) {
          found = [];
          for (let x = c[0] - r; x <= c[0] + r; x++) for (let y = c[1] - r; y <= c[1] + r; y++) for (let z = c[2] - r; z <= c[2] + r; z++) {
            const l = grid.get(`${x},${y},${z}`);
            if (l) found.push(...l);
          }
          if (found.length >= K || found.length === n) break;
        }
        if (found.length < K) found = members.slice(); // strayed far from the others
        found.sort((a, b) => cost(i, a) - cost(i, b));
        const best = found.slice(0, K);
        cand.set(i, best);
        for (const j of best) pairs.push([cost(i, j), i, j]);
      }
      // greedy, cheapest pairs first
      pairs.sort((a, b) => a[0] - b[0]);
      const taken = new Set<number>();
      for (const [, i, j] of pairs) {
        if (twin.has(i) || taken.has(j)) continue;
        twin.set(i, j); taken.add(j);
      }
      const leftI = members.filter((i) => !twin.has(i));
      const leftJ = members.filter((j) => !taken.has(j));
      for (const i of leftI) {
        let bi = 0, bc = Infinity;
        leftJ.forEach((j, k) => { const c = cost(i, j); if (c < bc) { bc = c; bi = k; } });
        twin.set(i, leftJ[bi]); taken.add(leftJ[bi]);
        leftJ.splice(bi, 1);
        cand.get(i)!.push(twin.get(i)!);
      }
      // pairwise swaps fix what the greedy pass got wrong
      const owner = new Map<number, number>();
      for (const [i, j] of twin) owner.set(j, i);
      for (let pass = 0; pass < 6; pass++) {
        let improved = false;
        for (const i of members) {
          for (const j of cand.get(i)!) {
            const ji = twin.get(i)!;
            if (j === ji) continue;
            const i2 = owner.get(j)!;
            if (cost(i, j) + cost(i2, ji) + 1e-9 < cost(i, ji) + cost(i2, j)) {
              twin.set(i, j); twin.set(i2, ji); owner.set(j, i); owner.set(ji, i2);
              improved = true;
            }
          }
        }
        if (!improved) break;
      }
    }
    for (const i of members) {
      const j = twin.get(i)!;
      const b = built.bodies[i - 1];
      const qi = decodeQuat(pEnd[i * 4 + 3]), qj = decodeQuat(wEnd[j * 4 + 3]);
      let g: Q;
      if (b.shape === 1) g = qmul(conj(qj), qi); // a sphere may keep its own spin
      else {
        g = [0, 0, 0, 1];
        let best = -1;
        for (const s of boxSymmetries(b.he)) {
          const d = qdot(qi, qmul(qj, s));
          if (d > best) { best = d; g = s; }
        }
      }
      out[i * 4] = j;
      out[i * 4 + 1] = packQuat(g);
      // a twin farther than a few body sizes would be reached by flying
      // through whatever lies between: hop there instead (shrink, pop up).
      // A fast body may glide farther unnoticed: allow what it travels itself
      // over half the blend (a falling stream never hops).
      const dist = Math.sqrt(Math.max(d2(PE, i, WE, j), d2(PM, i, WM, j)));
      const own = Math.sqrt(d2(PE, i, PM, i));
      if (dist > 0.2 + 4 * Math.max(...b.he) + own) { out[i * 4 + 2] = 1; hops++; }
      if (colorOf.get(i) !== colorOf.get(j)) { out[i * 4 + 3] = packColor(built.bodies[j - 1].color); swaps++; }
      moved += Math.sqrt(d2(PE, i, WE, j));
      total++;
    }
  }
  if (total > 0) console.info(`[loop] matched ${total} bodies in ${classes.size} classes, mean seam offset ${(moved / total).toFixed(3)} m, ${hops} hops, ${swaps} colour swaps`);
  return out;
}
