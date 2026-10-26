// Small vector / quaternion helpers shared by the entity builders.

import * as THREE from 'three';
import type { Vec3 } from './doc';

export type Q4 = [number, number, number, number];

export const v3 = (x: number, y: number, z: number): Vec3 => [x, y, z];
export const DEG = Math.PI / 180;

export const qAxis = (ax: Vec3, angle: number): Q4 => {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...ax).normalize(), angle);
  return [q.x, q.y, q.z, q.w];
};

export const qMul = (a: Q4, b: Q4): Q4 => {
  const q = new THREE.Quaternion(...a).multiply(new THREE.Quaternion(...b));
  return [q.x, q.y, q.z, q.w];
};

/** Quaternion of the frame whose local x, y, z axes are the given unit vectors. */
export const qBasis = (x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3): Q4 => {
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  return [q.x, q.y, q.z, q.w];
};

export const rotate = (q: Q4, v: Vec3): Vec3 => {
  const r = new THREE.Vector3(...v).applyQuaternion(new THREE.Quaternion(...q));
  return [r.x, r.y, r.z];
};

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
