// Machine check: reads the baked history back and tells, for every object,
// whether and when it was set in motion, where a chain of dominoes stopped,
// when each sensor zone was reached, and whether everything is at rest before
// the loop transition. Times are video seconds (recorded frame / fps).

import * as THREE from 'three/webgpu';
import type { BakeResult } from './baker';
import type { BuiltScene } from '../scene/build';
import { KIND_DYNAMIC } from '../scene/build';
import type { SceneDoc, Vec3 } from '../scene/doc';
import { readFrames } from './loopMatch';
import { unpackQuat } from '../render/bodies';
import { boomerangSpans } from './loopTime';
import { isTrack } from '../scene/path';

export type StepStatus = 'ok' | 'partial' | 'idle' | 'decor';

export interface EntityReport {
  id: string;
  index: number;
  name: string;
  type: string;
  expected: boolean;
  /** a row (dominoes, drawn row): every piece must go */
  chain: boolean;
  bodies: number;
  activated: number;
  first: number | null;
  last: number | null;
  status: StepStatus;
  /** where a row stopped: the first piece that never moved */
  breakAt: { pos: Vec3; t: number } | null;
  lost: number; // bodies that fell out of the world
}

export interface SensorReport {
  id: string;
  name: string;
  watch: string;
  needed: number;
  reached: number; // max bodies inside at once
  triggered: number | null;
}

export interface MachineReport {
  simEnd: number; // last analysed time (s)
  sampleDt: number;
  entities: EntityReport[];
  sensors: SensorReport[];
  /** last first-activation of an expected object */
  chainEnd: number | null;
  /** last moment anything dynamic was still moving */
  motionEnd: number | null;
  /** start of the loop transition (null = none / not relevant) */
  outroStart: number | null;
  ok: boolean;
  issues: { level: 'bad' | 'warn' | 'info'; text: string; fix?: 'duration' | 'boomerang'; value?: number }[];
  /** sampled poses for trajectories: slot per sample, engine-indexed uvec4 */
  samples: Uint32Array[];
  sampleTimes: number[];
}

const BUDGET = 48 * 1024 * 1024;

export async function analyzeBake(device: GPUDevice, renderer: any, res: BakeResult, built: BuiltScene, doc: SceneDoc): Promise<MachineReport> {
  const N = res.stride;
  const frameBytes = N * 16;
  const fpsRec = res.fps / res.recordEvery;
  // ~30 samples per second at most, fewer for big scenes
  let every = Math.max(1, Math.round(fpsRec / 30));
  while ((res.frames / every) * frameBytes > BUDGET && every < res.frames) every++;
  const slots: number[] = [];
  for (let f = 0; f < res.frames; f += every) slots.push(f);
  if (slots[slots.length - 1] !== res.frames - 1) slots.push(res.frames - 1);
  // a few hundred frames per staging buffer
  const samples: Uint32Array[] = [];
  const chunk = Math.max(1, Math.floor((16 * 1024 * 1024) / frameBytes));
  for (let i = 0; i < slots.length; i += chunk) {
    const part = await readFrames(device, renderer, res, slots.slice(i, i + chunk));
    for (const p of part) samples.push(new Uint32Array(p));
  }
  const times = slots.map((f) => (f * res.recordEvery) / res.fps);
  return analyzeSamples(samples, times, built, doc);
}

export function analyzeSamples(samples: Uint32Array[], times: number[], built: BuiltScene, doc: SceneDoc): MachineReport {
  const S = samples.length;
  const B = built.bodies;
  const f32 = samples.map((u) => new Float32Array(u.buffer, u.byteOffset, u.length));
  const q0: number[] = [0, 0, 0, 1], q1: number[] = [0, 0, 0, 1];
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();

  // ---- per body: first activation, last motion, lost
  const firstAct = new Float64Array(B.length).fill(-1);
  const lastMove = new Float64Array(B.length).fill(-1);
  const lost = new Uint8Array(B.length);
  const dyn: number[] = [];
  B.forEach((b, i) => { if (b.kind === KIND_DYNAMIC && b.spawnFrame === 0) dyn.push(i); });
  const spawned: number[] = [];
  B.forEach((b, i) => { if (b.kind === KIND_DYNAMIC && b.spawnFrame > 0) spawned.push(i); });
  const dtS = S > 1 ? Math.max(1e-3, times[1] - times[0]) : 1;
  const win = Math.max(1, Math.round(0.5 / dtS));
  const mThr = 0.03;
  for (const i of dyn) {
    const b = B[i];
    const size = b.shape === 1 ? 2 * b.he[0] : 2 * Math.min(b.he[0], b.he[1], b.he[2]);
    const dThr = Math.max(0.01, 0.25 * size);
    const k = (i + 1) * 4;
    const P0 = f32[0];
    unpackQuat(samples[0][k + 3], q0);
    qa.set(q0[0], q0[1], q0[2], q0[3]);
    for (let s = 1; s < S; s++) {
      const P = f32[s];
      const dx = P[k] - P0[k], dy = P[k + 1] - P0[k + 1], dz = P[k + 2] - P0[k + 2];
      if (P[k + 1] < -3) { lost[i] = 1; }
      if (firstAct[i] < 0) {
        let moved = dx * dx + dy * dy + dz * dz > dThr * dThr;
        if (!moved) {
          unpackQuat(samples[s][k + 3], q1);
          qb.set(q1[0], q1[1], q1[2], q1[3]);
          moved = qa.angleTo(qb) > 0.35; // 20°: a domino merely leaning is not set off
        }
        if (moved) firstAct[i] = times[s];
      }
      // still moving: displaced by more than 3 cm, or turned by more than
      // 9°, over the last half second (slow creep is not motion)
      const Pp = f32[s - win];
      if (s < win) continue;
      const ex = P[k] - Pp[k], ey = P[k + 1] - Pp[k + 1], ez = P[k + 2] - Pp[k + 2];
      let moving = ex * ex + ey * ey + ez * ez > mThr * mThr;
      if (!moving && b.shape === 0) {
        unpackQuat(samples[s - win][k + 3], q0);
        unpackQuat(samples[s][k + 3], q1);
        qb.set(q1[0], q1[1], q1[2], q1[3]);
        moving = new THREE.Quaternion(q0[0], q0[1], q0[2], q0[3]).angleTo(qb) > 0.16;
      }
      if (moving && P[k + 1] > -3) lastMove[i] = times[s];
    }
  }
  // spawned bodies count for "still moving" only
  for (const i of spawned) {
    const k = (i + 1) * 4;
    const sf = B[i].spawnFrame / doc.fps;
    for (let s = win; s < S; s++) {
      if (times[s - win] < sf + 0.02) continue;
      const P = f32[s], Pp = f32[s - win];
      const ex = P[k] - Pp[k], ey = P[k + 1] - Pp[k + 1], ez = P[k + 2] - Pp[k + 2];
      if (ex * ex + ey * ey + ez * ez > mThr * mThr && P[k + 1] > -3) lastMove[i] = times[s];
    }
  }

  // ---- per entity
  const byEntity = new Map<number, number[]>();
  for (const i of dyn) { const l = byEntity.get(B[i].entity) ?? []; l.push(i); byEntity.set(B[i].entity, l); }
  const entities: EntityReport[] = [];
  doc.entities.forEach((e, ei) => {
    const list = byEntity.get(ei);
    if (!list || list.length === 0 || !e.enabled) return;
    const chain = e.type === 'dominoes' || (e.type === 'path' && !isTrack(e.params.fill));
    let activated = 0, first = Infinity, last = -Infinity, lostN = 0;
    for (const i of list) {
      if (lost[i]) lostN++;
      if (firstAct[i] < 0) continue;
      activated++;
      first = Math.min(first, firstAct[i]);
      last = Math.max(last, firstAct[i]);
    }
    const expected = e.expect !== false;
    let status: StepStatus = !expected ? 'decor' : activated === 0 ? 'idle' : chain && activated < list.length ? 'partial' : 'ok';
    let breakAt: EntityReport['breakAt'] = null;
    if (chain && activated > 0 && activated < list.length) {
      // rows are built in order: the first still piece after a moved one
      const sorted = [...list].sort((a, b) => a - b);
      let k = sorted.findIndex((i) => firstAct[i] < 0);
      if (k === 0) { // pushed from the other end, or from the middle
        k = sorted.findIndex((i) => firstAct[i] >= 0);
        k = Math.max(0, k - 1);
      }
      const bi = sorted[k];
      const prev = sorted.filter((i) => firstAct[i] >= 0).reduce((m, i) => Math.max(m, firstAct[i]), 0);
      breakAt = { pos: [...B[bi].pos] as Vec3, t: prev };
    }
    if (status === 'partial' && !chain) status = 'ok';
    entities.push({
      id: e.id, index: ei, name: e.name, type: e.type, expected, chain, bodies: list.length, activated,
      first: activated ? first : null, last: activated ? last : null, status, breakAt, lost: lostN,
    });
  });
  entities.sort((a, b) => (a.first ?? 1e9) - (b.first ?? 1e9) || a.index - b.index);

  // ---- sensors
  const sensors: SensorReport[] = [];
  const v = new THREE.Vector3();
  for (const e of doc.entities) {
    if (e.type !== 'sensor' || !e.enabled) continue;
    const watchIdx = e.params.watch ? doc.entities.findIndex((x) => x.id === e.params.watch) : -1;
    const watched = [...dyn, ...spawned].filter((i) => (watchIdx < 0 ? true : B[i].entity === watchIdx));
    const inv = new THREE.Quaternion().setFromEuler(new THREE.Euler(e.rotation[0] * Math.PI / 180, e.rotation[1] * Math.PI / 180, e.rotation[2] * Math.PI / 180, 'XYZ')).invert();
    const [sx, sy, sz] = e.params.size as Vec3;
    const need = Math.max(1, Math.round(e.params.count ?? 1));
    let triggered: number | null = null, reached = 0;
    for (let s = 0; s < S; s++) {
      const P = f32[s];
      let n = 0;
      for (const i of watched) {
        if (B[i].spawnFrame / doc.fps > times[s]) continue;
        const k = (i + 1) * 4;
        v.set(P[k] - e.position[0], P[k + 1] - e.position[1], P[k + 2] - e.position[2]).applyQuaternion(inv);
        if (Math.abs(v.x) <= sx / 2 && Math.abs(v.y) <= sy / 2 && Math.abs(v.z) <= sz / 2) n++;
      }
      reached = Math.max(reached, n);
      if (n >= need && triggered === null && s > 0) triggered = times[s];
    }
    const wn = watchIdx >= 0 ? doc.entities[watchIdx].name : 'any body';
    sensors.push({ id: e.id, name: e.name, watch: wn, needed: need, reached, triggered });
  }

  // ---- timing and loop
  const simEnd = times[S - 1] ?? 0;
  const exp = entities.filter((x) => x.expected);
  const chainEnd = exp.reduce<number | null>((m, x) => (x.first === null ? m : Math.max(m ?? 0, x.last ?? x.first)), null);
  let motionEnd: number | null = null;
  for (const i of [...dyn, ...spawned]) if (lastMove[i] >= 0) motionEnd = Math.max(motionEnd ?? 0, lastMove[i]);
  const mode = doc.loop.mode;
  const outroStart = mode === 'reassemble' || mode === 'shrink' || mode === 'sink' ? doc.duration - doc.loop.outro
    : mode === 'boomerang' ? boomerangSpans(doc).sim : null;

  const issues: MachineReport['issues'] = [];
  const idle = exp.filter((x) => x.status === 'idle');
  const partial = exp.filter((x) => x.status === 'partial');
  const missed = sensors.filter((x) => x.triggered === null);
  if (exp.length && exp.every((x) => x.status === 'idle')) issues.push({ level: 'bad', text: 'Nothing moved: give the machine a start (a pushed domino, a released hammer, a piston, a ball with a speed).' });
  for (const x of partial) issues.push({ level: 'bad', text: `${x.name}: the row stopped after ${x.activated} of ${x.bodies} — at ${x.breakAt?.t.toFixed(2)} s.` });
  for (const x of idle) if (!exp.every((y) => y.status === 'idle')) issues.push({ level: 'bad', text: `${x.name} was never set in motion.` });
  for (const x of missed) issues.push({ level: 'bad', text: `Sensor “${x.name}” was not reached (${x.reached}/${x.needed} of ${x.watch}).` });
  const lostN = entities.reduce((a, x) => a + x.lost, 0);
  if (lostN > 0) issues.push({ level: 'warn', text: `${lostN} bodies fell out of the world (under the floor or off the edge).` });
  if (motionEnd !== null && outroStart !== null && mode !== 'boomerang' && motionEnd > outroStart - 0.05) {
    const want = Math.min(30, Math.ceil((motionEnd + doc.loop.outro + 0.6) * 2) / 2);
    issues.push({
      level: motionEnd > simEnd - 0.1 ? 'bad' : 'warn',
      text: motionEnd > simEnd - 0.1 ? 'Still moving at the very end of the clip: the machine needs more time.' : `Still moving at ${motionEnd.toFixed(1)} s, after the loop transition starts (${outroStart.toFixed(1)} s): parts will be pulled back while they move.`,
      fix: want > doc.duration ? 'duration' : undefined, value: want,
    });
  } else if (mode === 'boomerang' && motionEnd !== null && motionEnd > simEnd - 0.1) {
    issues.push({ level: 'info', text: 'Boomerang: the rewind starts while things still move — fine, it plays them backwards.' });
  }
  if (mode === 'continuous') issues.push({ level: 'info', text: 'A chain reaction is not a steady process: “continuous” loops will look odd. Boomerang or reassemble suit machines.', fix: 'boomerang' });
  // nothing required to move (a rain of cubes, a kinematic piece) is not a failure
  const ok = idle.length === 0 && partial.length === 0 && missed.length === 0;
  return { simEnd, sampleDt: S > 1 ? times[1] - times[0] : 0, entities, sensors, chainEnd, motionEnd, outroStart, ok, issues, samples, sampleTimes: times };
}

/** Pass / fail of each step in a report (for robustness trials). */
export function stepResults(r: MachineReport): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const e of r.entities) if (e.expected) m.set(e.id, e.status === 'ok');
  for (const s of r.sensors) m.set(s.id, s.triggered !== null);
  return m;
}
