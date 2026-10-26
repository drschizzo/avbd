// CPU side of the liquid: particle seeding (water blocks, sources) and the
// simulation box. Particles are sorted by spawn frame so the active set is
// always a prefix [0, activeCount) of the GPU buffers.

import * as THREE from 'three';
import type { SceneDoc, Vec3 } from '../scene/doc';
import { entityQuat, type BuiltBody } from '../scene/build';
import { Rng, hashString } from '../scene/rng';

export const PARTICLES_PER_CELL = 8; // 2 per axis

export interface FluidBuilt {
  count: number;
  /** world position + spawn frame (4 floats per particle) */
  pos: Float32Array;
  /** world velocity (4 floats per particle) */
  vel: Float32Array;
  /** per particle: spawn frame, loop stagger, 1 if present at frame 0, 0 */
  anim: Float32Array;
  /** simulation box */
  origin: Vec3;
  h: number;
  dims: [number, number, number];
  spacing: number;
  /** particles active after each frame (prefix sums of the spawn schedule) */
  activeAt: Int32Array;
  initialCount: number;
}

const MAX_NODES = 2_600_000;

export function buildFluid(doc: SceneDoc, bodies: BuiltBody[], simFrames: number): FluidBuilt | null {
  const blocks = doc.entities.filter((e) => e.enabled && e.type === 'fluidBlock');
  const sources = doc.entities.filter((e) => e.enabled && e.type === 'fluidSource');
  if (blocks.length === 0 && sources.length === 0) return null;
  const fs = doc.fluid;
  let h = Math.max(0.01, fs.cell);

  // --- simulation box
  const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  if (fs.bounds && fs.bounds.length === 6) {
    min.set(fs.bounds[0], fs.bounds[1], fs.bounds[2]);
    max.set(fs.bounds[3], fs.bounds[4], fs.bounds[5]);
  } else {
    const grow = (v: THREE.Vector3) => { min.min(v); max.max(v); };
    for (const e of blocks) {
      const q = entityQuat(e);
      const [sx, sy, sz] = e.params.size as Vec3;
      for (const cx of [-0.5, 0.5]) for (const cy of [0, 1]) for (const cz of [-0.5, 0.5]) {
        grow(new THREE.Vector3(cx * sx, cy * sy, cz * sz).applyQuaternion(q).add(new THREE.Vector3(...e.position)));
      }
    }
    for (const e of sources) {
      const p = new THREE.Vector3(...e.position);
      grow(p.clone().addScalar(e.params.radius + 0.2));
      grow(p.clone().addScalar(-e.params.radius - 0.2));
    }
    // scenery the liquid may touch: everything present at the start
    for (const b of bodies) {
      if (b.spawnFrame > 0) continue;
      const r = Math.hypot(b.he[0], b.he[1], b.he[2]);
      grow(new THREE.Vector3(b.pos[0] - r, b.pos[1] - r, b.pos[2] - r));
      grow(new THREE.Vector3(b.pos[0] + r, b.pos[1] + r, b.pos[2] + r));
    }
    min.addScalar(-0.3);
    max.addScalar(0.3);
    max.y += 0.4;
  }
  if (doc.physics.ground && !(fs.bounds && fs.bounds.length === 6)) min.y = 0;
  // grid with 2 boundary cells on each side
  const size = max.clone().sub(min);
  let dims: [number, number, number];
  for (;;) {
    dims = [Math.ceil(size.x / h) + 4, Math.ceil(size.y / h) + 4, Math.ceil(size.z / h) + 4];
    if (dims[0] * dims[1] * dims[2] <= MAX_NODES) break;
    h *= 1.08;
  }
  // the floor sits exactly on node layer 2 so the ground plane is a domain wall
  const origin: Vec3 = [min.x - 2 * h, min.y - 2 * h, min.z - 2 * h];
  const spacing = h / 2;

  // --- particles
  type P = { p: Vec3; v: Vec3; f: number };
  const parts: P[] = [];
  const cap = Math.max(1, Math.round(fs.maxParticles));
  const inside = (p: Vec3) => p[0] > origin[0] + 2.5 * h && p[1] > origin[1] + 2.5 * h && p[2] > origin[2] + 2.5 * h
    && p[0] < origin[0] + (dims[0] - 2.5) * h && p[1] < origin[1] + (dims[1] - 2.5) * h && p[2] < origin[2] + (dims[2] - 2.5) * h;

  for (const e of blocks) {
    const rng = new Rng(hashString(e.id) ^ 0x9e3779b9);
    const q = entityQuat(e);
    const T = new THREE.Vector3(...e.position);
    const [sx, sy, sz] = e.params.size as Vec3;
    const nx = Math.max(1, Math.round(sx / spacing)), ny = Math.max(1, Math.round(sy / spacing)), nz = Math.max(1, Math.round(sz / spacing));
    const v = new THREE.Vector3();
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
      if (parts.length >= cap) break;
      const jit = spacing * 0.15;
      v.set(
        -sx / 2 + (i + 0.5) * (sx / nx) + rng.range(-jit, jit),
        (j + 0.5) * (sy / ny) + rng.range(-jit, jit),
        -sz / 2 + (k + 0.5) * (sz / nz) + rng.range(-jit, jit),
      ).applyQuaternion(q).add(T);
      const p: Vec3 = [v.x, v.y, v.z];
      if (inside(p)) parts.push({ p, v: [0, 0, 0], f: 0 });
    }
  }

  const fps = doc.fps;
  for (const e of sources) {
    const rng = new Rng(hashString(e.id) ^ 0x51ed27);
    const q = entityQuat(e);
    const dir = new THREE.Vector3(0, -1, 0).applyQuaternion(q).normalize();
    const u = new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize();
    const w = new THREE.Vector3().crossVectors(dir, u).normalize();
    const T = new THREE.Vector3(...e.position);
    const r = e.params.radius, speed = Math.max(0.05, e.params.speed);
    // disk lattice of the nozzle
    const disk: [number, number][] = [];
    const n = Math.ceil(r / spacing);
    for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) {
      const x = a * spacing + (b % 2 ? spacing / 2 : 0), y = b * spacing * 0.866;
      if (x * x + y * y <= r * r) disk.push([x, y]);
    }
    if (disk.length === 0) disk.push([0, 0]);
    const f0 = Math.max(1, Math.round(e.params.start * fps)), f1 = Math.min(simFrames - 1, Math.round(e.params.end * fps));
    // layer L leaves the nozzle at time L*spacing/speed; it is spawned at the
    // next frame boundary, already advanced by the distance travelled since,
    // so the stream has a uniform spacing (no per-frame banding)
    let L = 0;
    for (let f = f0; f < f1 && parts.length < cap; f++) {
      const travelled = speed * (f + 1 - f0) / fps;
      for (; L * spacing < travelled && parts.length < cap; L++) {
        const along = travelled - L * spacing;
        for (const [x, y] of disk) {
          if (parts.length >= cap) break;
          const jit = spacing * 0.22;
          const pw = T.clone()
            .addScaledVector(u, x + rng.range(-jit, jit))
            .addScaledVector(w, y + rng.range(-jit, jit))
            .addScaledVector(dir, along + rng.range(-jit, jit));
          const p: Vec3 = [pw.x, pw.y, pw.z];
          if (inside(p)) parts.push({ p, v: [dir.x * speed, dir.y * speed, dir.z * speed], f });
        }
      }
    }
  }
  if (parts.length === 0) return null;
  parts.sort((a, b) => a.f - b.f);

  const count = parts.length;
  const pos = new Float32Array(count * 4), vel = new Float32Array(count * 4), anim = new Float32Array(count * 4);
  let initialCount = 0;
  for (let i = 0; i < count; i++) {
    const P = parts[i];
    pos.set([P.p[0], P.p[1], P.p[2], P.f], i * 4);
    vel.set([P.v[0], P.v[1], P.v[2], 0], i * 4);
    if (P.f === 0) initialCount++;
  }
  // loop stagger: initial liquid returns bottom layer first
  const order = parts.map((_, i) => i).filter((i) => parts[i].f === 0).sort((a, b) => parts[a].p[1] - parts[b].p[1]);
  const stag = new Float32Array(count);
  order.forEach((i, r) => { stag[i] = r / Math.max(1, order.length - 1); });
  for (let i = 0; i < count; i++) anim.set([parts[i].f, stag[i], parts[i].f === 0 ? 1 : 0, 0], i * 4);

  const activeAt = new Int32Array(simFrames + 1);
  let c = 0;
  for (let f = 0; f <= simFrames; f++) {
    while (c < count && parts[c].f <= f) c++;
    activeAt[f] = c;
  }
  return { count, pos, vel, anim, origin, h, dims, spacing, activeAt, initialCount };
}
