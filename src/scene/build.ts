// SceneDoc -> flat list of rigid bodies / joints / kinematic motions.

import * as THREE from 'three';
import type { Entity, Finish, SceneDoc, Vec3 } from './doc';
import { defaultMotion } from './doc';
import { ENTITY_DEFS, type LocalBody, type LocalJoint, type Q4 } from './entities';
import { PALETTES, hexToLinear, samplePalette } from './palettes';
import { Rng, hashString } from './rng';
import { buildFluid, type FluidBuilt } from '../fluid/fluidBuild';
import {
  MOTION_GATE, MOTION_NONE, MOTION_SLIDE, MOTION_SPIN, MOTION_SWING, type SimMotion,
} from '../sim/motion';
import { boomerangSpans } from '../sim/loopTime';

export const KIND_DYNAMIC = 0;
export const KIND_STATIC = 1;
export const KIND_KINEMATIC = 2;

export interface BuiltBody {
  shape: 0 | 1; // box | sphere
  he: Vec3;
  pos: Vec3;
  quat: Q4;
  vel: Vec3;
  angVel: Vec3;
  mass: number;
  friction: number;
  kind: number;
  motion: number;
  localPos: Vec3;
  localQuat: Q4;
  spawnFrame: number;
  entity: number; // index in doc.entities
  color: [number, number, number]; // linear RGB
  finish: Finish;
  stagger: number; // 0..1 ordering for loop transitions
}

export interface BuiltJoint {
  type: 'spherical' | 'fixed' | 'spring';
  a: number | null;
  b: number;
  anchorA: Vec3;
  anchorB: Vec3;
  stiffness: number;
  fracture: number;
  collide: boolean;
}

export interface BuiltScene {
  bodies: BuiltBody[];
  joints: BuiltJoint[];
  motions: SimMotion[];
  initialCount: number;
  bounds: { min: Vec3; max: Vec3 };
  fps: number;
  duration: number;
  /** number of simulated frames (boomerang simulates half the loop) */
  simFrames: number;
  /** MLS-MPM liquid, when the scene has water blocks or sources */
  fluid: FluidBuilt | null;
}

const DEG = Math.PI / 180;

export function entityQuat(e: Entity): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(e.rotation[0] * DEG, e.rotation[1] * DEG, e.rotation[2] * DEG, 'XYZ'));
}

function motionKind(k: string): number {
  switch (k) {
    case 'spin': return MOTION_SPIN;
    case 'swing': return MOTION_SWING;
    case 'slide': return MOTION_SLIDE;
    case 'gate': return MOTION_GATE;
    default: return MOTION_NONE;
  }
}

export interface BuildOptions {
  onlyEntity?: string;
  /** solo: build only these entity ids */
  only?: Set<string>;
  /** robustness trials: nudge dynamic bodies by up to `amount` m / 10·amount rad */
  jitter?: { seed: number; amount: number };
}

export function buildScene(doc: SceneDoc, opts: BuildOptions = {}): BuiltScene {
  const fps = doc.fps;
  const palette = PALETTES[doc.render.palette] ?? PALETTES.sorbet;
  const bodies: BuiltBody[] = [];
  const joints: BuiltJoint[] = [];
  const motions: SimMotion[] = [];

  // Emitters last so that dynamic spawns follow all initial bodies.
  const order = doc.entities.map((e, i) => i).sort((a, b) => {
    const ea = doc.entities[a].type === 'emitter' ? 1 : 0;
    const eb = doc.entities[b].type === 'emitter' ? 1 : 0;
    return ea - eb || a - b;
  });

  for (const ei of order) {
    const e = doc.entities[ei];
    if (!e.enabled) continue;
    if (opts.onlyEntity && e.id !== opts.onlyEntity) continue;
    if (opts.only && !opts.only.has(e.id)) continue;
    const def = ENTITY_DEFS[e.type];
    if (!def) continue;
    const rq = entityQuat(e);
    const T = new THREE.Vector3(...e.position);
    const rng = new Rng(hashString(e.id) ^ Math.imul(doc.seed, 2654435761));

    let kind = e.phys.body === 'static' ? KIND_STATIC : e.phys.body === 'kinematic' ? KIND_KINEMATIC : KIND_DYNAMIC;
    let motionIndex = -1;
    if (kind !== KIND_DYNAMIC && e.motion.kind !== 'none') {
      kind = KIND_KINEMATIC;
      const ax = new THREE.Vector3(...e.motion.axis);
      if (ax.lengthSq() < 1e-9) ax.set(0, 1, 0);
      ax.normalize();
      motionIndex = motions.length;
      const isAngle = e.motion.kind !== 'slide';
      motions.push({
        kind: motionKind(e.motion.kind),
        origin: [T.x, T.y, T.z],
        baseQuat: [rq.x, rq.y, rq.z, rq.w],
        axis: [ax.x, ax.y, ax.z],
        cycles: e.motion.kind === 'spin' ? e.motion.cycles * (e.motion.amplitude < 0 ? -1 : 1) : e.motion.cycles,
        amp: isAngle ? e.motion.amplitude * DEG : e.motion.amplitude,
        phase: e.motion.phase,
        offset: [...e.motion.offset] as Vec3,
        tOpen: e.motion.open,
        tClose: e.motion.close,
        ease: e.motion.ease,
      });
    } else if (kind === KIND_KINEMATIC) {
      kind = KIND_STATIC;
    }

    const localBodies: LocalBody[] = [];
    const handles: number[] = [];
    const localJoints: LocalJoint[] = [];
    def.build({
      e, rng, duration: doc.duration, fps, gravity: doc.physics.gravity, worldQuat: [rq.x, rq.y, rq.z, rq.w],
      body(b) { localBodies.push(b); handles.push(localBodies.length - 1); return localBodies.length - 1; },
      joint(j) { localJoints.push(j); },
      posOf(h) { return localBodies[h].p; },
      heOf(h) { return localBodies[h].he; },
    }, e.params);

    // colour parameter for 'height' mode
    let minY = Infinity, maxY = -Infinity;
    for (const b of localBodies) { minY = Math.min(minY, b.p[1]); maxY = Math.max(maxY, b.p[1]); }
    const statics = e.look.color === '' ? palette.statics : e.look.color;

    // per-body motions (shared when identical)
    const bodyMotion = new Map<string, number>();
    const motionOf = (lb: LocalBody): number => {
      const m = lb.motion!;
      const key = JSON.stringify(m);
      const known = bodyMotion.get(key);
      if (known !== undefined) return known;
      const def = { ...defaultMotion(), ...m };
      const ax = new THREE.Vector3(...def.axis);
      if (ax.lengthSq() < 1e-9) ax.set(0, 1, 0);
      ax.normalize().applyQuaternion(rq);
      const o = new THREE.Vector3(...(m.pivot ?? [0, 0, 0])).applyQuaternion(rq).add(T);
      const off = new THREE.Vector3(...def.offset).applyQuaternion(rq);
      const isAngle = def.kind !== 'slide';
      motions.push({
        kind: motionKind(def.kind),
        origin: [o.x, o.y, o.z],
        baseQuat: [rq.x, rq.y, rq.z, rq.w],
        axis: [ax.x, ax.y, ax.z],
        cycles: def.kind === 'spin' ? def.cycles * (def.amplitude < 0 ? -1 : 1) : def.cycles,
        amp: isAngle ? def.amplitude * DEG : def.amplitude,
        phase: def.phase,
        offset: [off.x, off.y, off.z],
        tOpen: def.open,
        tClose: def.close,
        ease: def.ease,
      });
      bodyMotion.set(key, motions.length - 1);
      return motions.length - 1;
    };

    const base = bodies.length;
    const v = new THREE.Vector3();
    const q = new THREE.Quaternion();
    for (let i = 0; i < localBodies.length; i++) {
      const lb = localBodies[i];
      let bk = lb.kind === undefined ? kind : (lb.kind === 'static' ? KIND_STATIC : lb.kind === 'kinematic' ? KIND_KINEMATIC : KIND_DYNAMIC);
      let bodyMotionIndex = bk === KIND_KINEMATIC ? motionIndex : -1;
      let localPos: Vec3 = [...lb.p] as Vec3;
      if (lb.motion && lb.motion.kind && lb.motion.kind !== 'none' && bk !== KIND_DYNAMIC) {
        bk = KIND_KINEMATIC;
        bodyMotionIndex = motionOf(lb);
        const pv = lb.motion.pivot ?? [0, 0, 0];
        localPos = [lb.p[0] - pv[0], lb.p[1] - pv[1], lb.p[2] - pv[2]];
      } else if (bk === KIND_KINEMATIC && bodyMotionIndex < 0) {
        bk = KIND_STATIC;
      }
      v.set(...lb.p).applyQuaternion(rq).add(T);
      q.set(...(lb.q ?? [0, 0, 0, 1] as Q4)).premultiply(rq);
      const lv = new THREE.Vector3(...(lb.vel ?? [0, 0, 0])).applyQuaternion(rq).add(new THREE.Vector3(...e.phys.velocity));
      const lw = new THREE.Vector3(...(lb.angVel ?? [0, 0, 0])).applyQuaternion(rq).add(new THREE.Vector3(...e.phys.angularVelocity));
      const he = lb.he;
      const vol = lb.shape === 'sphere' ? (4 / 3) * Math.PI * he[0] ** 3 : 8 * he[0] * he[1] * he[2];
      // density 1 => a 0.5 m cube weighs 1 kg (keeps penalties well conditioned)
      const density = e.phys.density * (lb.density ?? 1) * 8;
      const mass = bk === KIND_DYNAMIC ? Math.max(1e-4, density * vol) : 0;

      let color: [number, number, number];
      if (lb.color) color = hexToLinear(lb.color === '@statics' ? statics : lb.color);
      else if (bk !== KIND_DYNAMIC && e.look.colorMode === 'single') color = hexToLinear(statics);
      else {
        const off = e.look.paletteOffset | 0;
        const n = palette.colors.length;
        switch (e.look.colorMode) {
          case 'single': color = hexToLinear(e.look.color || palette.colors[0]); break;
          case 'gradient': color = samplePalette(palette, ((lb.t ?? 0) + off / n) % 1.0000001); break;
          case 'height': color = samplePalette(palette, maxY > minY ? (lb.p[1] - minY) / (maxY - minY) : 0.5); break;
          case 'random': color = hexToLinear(palette.colors[(Math.floor(rng.next() * n) + off) % n]); break;
          case 'cycle':
          default: color = hexToLinear(palette.colors[(((lb.idx ?? i) + off) % n + n) % n]); break;
        }
      }
      const spawnAt = lb.spawnAt ?? e.phys.spawnAt;
      bodies.push({
        shape: lb.shape === 'sphere' ? 1 : 0,
        he: [...he] as Vec3,
        pos: [v.x, v.y, v.z],
        quat: [q.x, q.y, q.z, q.w],
        vel: bk === KIND_DYNAMIC ? [lv.x, lv.y, lv.z] : [0, 0, 0],
        angVel: bk === KIND_DYNAMIC ? [lw.x, lw.y, lw.z] : [0, 0, 0],
        mass,
        friction: lb.friction ?? e.phys.friction,
        kind: bk,
        motion: bodyMotionIndex,
        localPos,
        localQuat: (lb.q ? [...lb.q] : [0, 0, 0, 1]) as Q4,
        spawnFrame: bk === KIND_DYNAMIC ? Math.max(0, Math.round(spawnAt * fps)) : 0,
        entity: ei,
        color,
        finish: lb.finish ?? e.look.finish,
        stagger: 0,
      });
    }

    for (const j of localJoints) {
      const pw = new THREE.Vector3(...j.pivot).applyQuaternion(rq).add(T);
      const pwB = j.pivotB ? new THREE.Vector3(...j.pivotB).applyQuaternion(rq).add(T) : pw;
      const toLocal = (bi: number, w: THREE.Vector3): Vec3 => {
        const b = bodies[base + bi];
        const inv = new THREE.Quaternion(...b.quat).invert();
        const l = w.clone().sub(new THREE.Vector3(...b.pos)).applyQuaternion(inv);
        return [l.x, l.y, l.z];
      };
      joints.push({
        type: j.type,
        a: j.a === null ? null : base + j.a,
        b: base + j.b,
        anchorA: j.a === null ? [pw.x, pw.y, pw.z] : toLocal(j.a, pw),
        anchorB: toLocal(j.b, pwB),
        stiffness: j.stiffness ?? Infinity,
        fracture: j.fracture ?? 0,
        collide: j.collide ?? false,
      });
    }
  }

  // Reorder: initial bodies first (stable), then spawned ones by spawn frame.
  const idx = bodies.map((_, i) => i);
  idx.sort((a, b) => {
    const fa = bodies[a].spawnFrame > 0 ? 1 : 0, fb = bodies[b].spawnFrame > 0 ? 1 : 0;
    if (fa !== fb) return fa - fb;
    if (fa === 1 && bodies[a].spawnFrame !== bodies[b].spawnFrame) return bodies[a].spawnFrame - bodies[b].spawnFrame;
    return a - b;
  });
  const remap = new Int32Array(bodies.length);
  idx.forEach((oldI, newI) => { remap[oldI] = newI; });
  const sorted = idx.map((i) => bodies[i]);
  const initialCount = sorted.findIndex((b) => b.spawnFrame > 0);
  const nInitial = initialCount < 0 ? sorted.length : initialCount;
  const outJoints = joints
    .map((j) => ({ ...j, a: j.a === null ? null : remap[j.a], b: remap[j.b] }))
    .filter((j) => j.b < nInitial && (j.a === null || j.a < nInitial));

  computeStagger(sorted, doc);
  if (opts.jitter && opts.jitter.amount > 0) jitterBodies(sorted, outJoints, opts.jitter);

  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of sorted) {
    if (b.finish === 'hidden') continue;
    const r = Math.max(b.he[0], b.he[1], b.he[2]);
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], b.pos[k] - r); max[k] = Math.max(max[k], b.pos[k] + r); }
  }
  if (!isFinite(min[0])) { min[0] = min[1] = min[2] = -2; max[0] = max[1] = max[2] = 2; min[1] = 0; }

  const frames = Math.round(doc.duration * fps);
  const simFrames = doc.loop.mode === 'boomerang' ? Math.ceil(boomerangSpans(doc).sim * fps) + 1 : frames + 1;

  const fluid = opts.onlyEntity ? null : buildFluid(doc, sorted, simFrames);
  if (fluid) {
    for (let i = 0; i < fluid.initialCount; i++) {
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], fluid.pos[i * 4 + k]); max[k] = Math.max(max[k], fluid.pos[i * 4 + k]); }
    }
  }
  return { bodies: sorted, joints: outJoints, motions, initialCount: nInitial, bounds: { min, max }, fps, duration: doc.duration, simFrames, fluid };
}

/**
 * Trials: the same machine, nudged by a fraction of a millimetre. A chain
 * reaction that only works for one exact layout is a chain that will break;
 * jointed bodies are left alone (moving one end of a joint preloads it).
 */
function jitterBodies(bodies: BuiltBody[], joints: BuiltJoint[], j: { seed: number; amount: number }): void {
  const rng = new Rng(j.seed * 2654435761 + 97);
  const jointed = new Set<number>();
  for (const x of joints) { jointed.add(x.b); if (x.a !== null) jointed.add(x.a); }
  const q = new THREE.Quaternion(), dq = new THREE.Quaternion(), ax = new THREE.Vector3();
  bodies.forEach((b, i) => {
    if (b.kind !== KIND_DYNAMIC || jointed.has(i)) return;
    b.pos = [b.pos[0] + rng.range(-j.amount, j.amount), b.pos[1] + rng.range(0, j.amount * 0.5), b.pos[2] + rng.range(-j.amount, j.amount)];
    ax.set(0, 1, 0);
    dq.setFromAxisAngle(ax, rng.range(-j.amount, j.amount) * 10);
    q.set(...b.quat).premultiply(dq);
    b.quat = [q.x, q.y, q.z, q.w];
  });
}

function computeStagger(bodies: BuiltBody[], doc: SceneDoc): void {
  const dyn = bodies.map((b, i) => i).filter((i) => bodies[i].kind === KIND_DYNAMIC);
  if (dyn.length === 0) return;
  let cx = 0, cz = 0;
  for (const i of dyn) { cx += bodies[i].pos[0]; cz += bodies[i].pos[2]; }
  cx /= dyn.length; cz /= dyn.length;
  const rng = new Rng(doc.seed * 7919 + 13);
  const key = (i: number): number => {
    const b = bodies[i];
    switch (doc.loop.order) {
      case 'random': return rng.next();
      case 'index': return i;
      case 'distance': return Math.hypot(b.pos[0] - cx, b.pos[2] - cz);
      case 'height':
      default: return b.pos[1] + b.spawnFrame * 1e-4;
    }
  };
  const keys = dyn.map((i) => ({ i, k: key(i) })).sort((a, b) => a.k - b.k);
  const n = Math.max(1, keys.length - 1);
  keys.forEach((e, r) => { bodies[e.i].stagger = r / n; });
}
