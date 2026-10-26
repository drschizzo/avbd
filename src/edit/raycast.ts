// CPU ray casts against the built scene (rest poses), with surface normals:
// what placement, drawing and "drop to surface" stand on.

import * as THREE from 'three/webgpu';
import type { BuiltScene } from '../scene/build';
import { KIND_DYNAMIC } from '../scene/build';

export interface SceneHit {
  t: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  body: number; // -1 = ground
}

export interface CastOptions {
  /** entity indices to ignore */
  exclude?: Set<number>;
  /** ignore dynamic bodies (draw on the scenery only) */
  staticOnly?: boolean;
  ground?: boolean;
}

const _q = new THREE.Quaternion();
const _inv = new THREE.Quaternion();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _c = new THREE.Vector3();

export function castScene(built: BuiltScene, ray: THREE.Ray, opts: CastOptions = {}): SceneHit | null {
  let best: SceneHit | null = null;
  const n = new THREE.Vector3();
  for (let i = 0; i < built.bodies.length; i++) {
    const b = built.bodies[i];
    if (b.spawnFrame > 0) continue;
    if (opts.exclude?.has(b.entity)) continue;
    if (opts.staticOnly && b.kind === KIND_DYNAMIC) continue;
    _c.set(...b.pos);
    _q.set(...b.quat);
    _inv.copy(_q).invert();
    _o.copy(ray.origin).sub(_c).applyQuaternion(_inv);
    _d.copy(ray.direction).applyQuaternion(_inv);
    const t = b.shape === 1 ? sphereHit(_o, _d, b.he[0], n) : boxHit(_o, _d, b.he, n);
    if (t < 0 || (best && t >= best.t)) continue;
    best = { t, point: ray.at(t, new THREE.Vector3()), normal: n.clone().applyQuaternion(_q).normalize(), body: i };
  }
  if (opts.ground !== false && Math.abs(ray.direction.y) > 1e-6) {
    const t = -ray.origin.y / ray.direction.y;
    if (t > 0 && (!best || t < best.t)) best = { t, point: ray.at(t, new THREE.Vector3()), normal: new THREE.Vector3(0, 1, 0), body: -1 };
  }
  return best;
}

function boxHit(o: THREE.Vector3, d: THREE.Vector3, he: [number, number, number], nOut: THREE.Vector3): number {
  let tmin = -Infinity, tmax = Infinity, axis = -1, sign = 0;
  const oa = [o.x, o.y, o.z], da = [d.x, d.y, d.z];
  for (let k = 0; k < 3; k++) {
    if (Math.abs(da[k]) < 1e-12) {
      if (oa[k] < -he[k] || oa[k] > he[k]) return -1;
      continue;
    }
    let t1 = (-he[k] - oa[k]) / da[k], t2 = (he[k] - oa[k]) / da[k];
    let s = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = k; sign = s; }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  if (tmax < 0) return -1;
  if (tmin < 0) return -1; // ray starts inside: not a surface to stand on
  nOut.set(0, 0, 0);
  if (axis === 0) nOut.x = sign; else if (axis === 1) nOut.y = sign; else nOut.z = sign;
  return tmin;
}

function sphereHit(o: THREE.Vector3, d: THREE.Vector3, r: number, nOut: THREE.Vector3): number {
  const b = o.dot(d), c = o.lengthSq() - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  if (t < 0) return -1;
  nOut.copy(o).addScaledVector(d, t).normalize();
  return t;
}

/** World AABB of the rest poses of the given entities (spawned bodies excluded). */
export function entityBounds(built: BuiltScene, entities: Set<number>): THREE.Box3 {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const b of built.bodies) {
    if (!entities.has(b.entity) || b.spawnFrame > 0) continue;
    if (b.shape === 1) {
      const r = b.he[0];
      box.expandByPoint(v.set(b.pos[0] - r, b.pos[1] - r, b.pos[2] - r));
      box.expandByPoint(v.set(b.pos[0] + r, b.pos[1] + r, b.pos[2] + r));
      continue;
    }
    _q.set(...b.quat);
    for (let k = 0; k < 8; k++) {
      v.set(k & 1 ? b.he[0] : -b.he[0], k & 2 ? b.he[1] : -b.he[1], k & 4 ? b.he[2] : -b.he[2]).applyQuaternion(_q);
      box.expandByPoint(v.set(v.x + b.pos[0], v.y + b.pos[1], v.z + b.pos[2]));
    }
  }
  return box;
}
