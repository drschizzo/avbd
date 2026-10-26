// Gadgets: the moving parts of a chain-reaction machine (levers, hammers,
// wheels, pistons, cups, rollers), plus the drawn Path and the test Sensor.
// Hinges are two spherical joints on the axis: the engine has no revolute
// joint, and two points pinned on one line leave exactly one rotation free.

import * as THREE from 'three';
import type { Vec3 } from './doc';
import type { BuildCtx, EntityDef, Port } from './entities';
import { DEG, qAxis, v3, type Q4 } from './geom';
import { FILL_DEFAULTS, PATH_FILLS, buildPath, isTrack, pathPorts } from './path';

const DARK = '#2b2d33';

/** Pins body `b` to `a` (null = world) along `axis` through `pivot` (entity frame). */
export function hinge(ctx: BuildCtx, a: number | null, b: number, pivot: Vec3, axis: Vec3, halfSpan: number): void {
  const ax = new THREE.Vector3(...axis).normalize().multiplyScalar(Math.max(0.01, halfSpan));
  for (const s of [-1, 1]) {
    ctx.joint({ type: 'spherical', a, b, pivot: [pivot[0] + ax.x * s, pivot[1] + ax.y * s, pivot[2] + ax.z * s] });
  }
}

/**
 * Latch: a bar bridging the swing corridor under `bottom` (the lowest point
 * of a level hammer head or wrecking ball, entity frame). Its far end rests on
 * a stand outside the corridor, its near end (+`side`) on a thin loose prop.
 * The load is purely vertical, so it holds; knock the prop over and the bar
 * end drops, tipping the bar away and letting the arm swing: a release set
 * off by the machine itself, with no timer.
 */
export function latch(ctx: BuildCtx, bottom: Vec3, corridor: number, side: Vec3): void {
  const bt = 0.022, pt = 0.02, bw = 0.035, far = 0.06;
  const half = corridor + 0.03;
  const s = new THREE.Vector3(...side).normalize();
  const r = new THREE.Vector3(0, 1, 0).cross(s).normalize();
  const m = new THREE.Matrix4().makeBasis(r, new THREE.Vector3(0, 1, 0), s);
  const qq = new THREE.Quaternion().setFromRotationMatrix(m);
  const q: Q4 = [qq.x, qq.y, qq.z, qq.w];
  const at = (d: number, y: number): Vec3 => [bottom[0] + s.x * d, bottom[1] - y, bottom[2] + s.z * d];
  // a slick bar on a grippy prop: knocked below its top, the prop slips from
  // under the bar and pivots on its foot instead of sliding along
  ctx.body({ shape: 'box', he: [bw, bt, half], p: at(0, bt + 0.001), q, color: '#e63946', finish: 'gloss', density: 0.6, friction: 0.01, kind: 'dynamic' });
  // near end: a prop as thin as a domino, flush with the bar end
  const h = worldY(ctx, at(0, 2 * bt + 0.001));
  ctx.body({ shape: 'box', he: [bw + 0.02, h / 2, 0.015], p: at(corridor + 0.015, 2 * bt + 0.001 + h / 2), q, color: '#e9c46a', finish: 'gloss', density: 1, friction: 1, kind: 'dynamic' });
  // far end: a fixed stand, with a stop so the bar cannot ride along with a
  // knocked prop (the prop would slide instead of falling)
  ctx.body({ shape: 'box', he: [bw + 0.02, pt, far], p: at(-(corridor + far), 2 * bt + pt + 0.001), q, color: DARK, finish: 'metal', kind: 'static' });
  ctx.body({ shape: 'box', he: [bw + 0.02, bt, 0.01], p: at(-(half + 0.011), bt + 0.001), q, color: DARK, finish: 'metal', kind: 'static' });
  post(ctx, at(-(corridor + far), 2 * bt + 2 * pt + 0.001), 0.02);
}

/** World height of a point of the entity frame (for posts down to the floor). */
function worldY(ctx: BuildCtx, p: Vec3): number {
  const v = new THREE.Vector3(...p).applyQuaternion(new THREE.Quaternion(...ctx.worldQuat));
  return ctx.e.position[1] + v.y;
}

/** A static post from the floor up to local point `top` (skipped if the point is below the floor). */
function post(ctx: BuildCtx, top: Vec3, r: number, color = DARK): void {
  const h = worldY(ctx, top);
  if (h < 0.03) return;
  ctx.body({ shape: 'box', he: [r, h / 2, r], p: [top[0], top[1] - h / 2, top[2]], color, finish: 'satin', kind: 'static' });
}

export const GADGET_DEFS = {
  path: {
    label: 'Drawn path', category: 'Gadgets', icon: '〰', movable: false,
    params: [
      { key: 'fill', label: 'Fill', kind: 'select', options: PATH_FILLS },
      { key: 'size', label: 'Item (t,h,w)', kind: 'vec3', min: 0.01, max: 5, step: 0.005, show: (p: any) => !isTrack(p.fill) },
      { key: 'size', label: 'Track (w,wall,thick)', kind: 'vec3', min: 0, max: 5, step: 0.005, show: (p: any) => isTrack(p.fill) },
      { key: 'spacing', label: 'Spacing (×size)', kind: 'number', min: 0.2, max: 4, step: 0.01, show: (p: any) => !isTrack(p.fill) },
      { key: 'push', label: 'Push (deg tilt)', kind: 'number', min: 0, max: 40, step: 0.5, show: (p: any) => p.fill === 'dominoes' },
      { key: 'drop', label: 'Drop (m)', kind: 'number', min: -10, max: 10, step: 0.01 },
      { key: 'smooth', label: 'Smooth curve', kind: 'bool' },
      { key: 'closed', label: 'Closed loop', kind: 'bool' },
      { key: 'reverse', label: 'Reverse', kind: 'bool' },
    ],
    defaults: { fill: 'dominoes', points: [[-1.5, 0, 0], [1.5, 0, 0]], size: [...FILL_DEFAULTS.dominoes.size], spacing: FILL_DEFAULTS.dominoes.spacing, push: 12, drop: 0, smooth: true, closed: false, reverse: false },
    look: { colorMode: 'gradient' },
    build(ctx, p) {
      for (const b of buildPath(p)) {
        ctx.body({ shape: b.shape, he: b.he, p: b.p, q: b.q, idx: b.idx, t: b.t, angVel: b.angVel, kind: b.track ? 'static' : undefined });
      }
    },
    ports: (p) => pathPorts(p),
  },

  seesaw: {
    label: 'Seesaw', category: 'Gadgets', icon: '⚖', movable: false,
    params: [
      { key: 'length', label: 'Plank length', kind: 'number', min: 0.2, max: 10, step: 0.01 },
      { key: 'width', label: 'Plank width', kind: 'number', min: 0.05, max: 4, step: 0.01 },
      { key: 'thickness', label: 'Thickness', kind: 'number', min: 0.01, max: 0.5, step: 0.005 },
      { key: 'height', label: 'Axle height', kind: 'number', min: 0.05, max: 5, step: 0.01 },
      { key: 'pivotAt', label: 'Axle position', kind: 'number', min: 0.1, max: 0.9, step: 0.01, help: '0.5 = centre; lower values give a longer right arm (a catapult)' },
      { key: 'tilt', label: 'Tilt (°)', kind: 'number', min: -60, max: 60, step: 0.5, help: 'Start angle; the left end goes down for positive values' },
      { key: 'restOnFloor', label: 'Rest on floor', kind: 'bool', help: 'Tilts the plank until its left end touches the ground' },
      { key: 'load', label: 'Load', kind: 'select', options: ['none', 'ball', 'block'] },
      { key: 'loadSize', label: 'Load size', kind: 'number', min: 0.03, max: 2, step: 0.005 },
    ],
    defaults: { length: 2.4, width: 0.4, thickness: 0.06, height: 0.4, pivotAt: 0.5, tilt: 0, restOnFloor: true, load: 'ball', loadSize: 0.18 },
    look: { colorMode: 'cycle', finish: 'gloss' },
    build(ctx, p) {
      const L = p.length, W = p.width, T = p.thickness, H = p.height;
      const left = L * p.pivotAt, right = L - left;
      let tilt = p.tilt * DEG;
      if (p.restOnFloor) {
        const reach = worldY(ctx, [0, H, 0]) - T / 2;
        tilt = reach > 0 && reach < left ? Math.asin(reach / left) : tilt;
      }
      const q: Q4 = qAxis([0, 0, 1], tilt);
      const along = (d: number, up = 0): Vec3 => {
        const v = new THREE.Vector3(d, up, 0).applyQuaternion(new THREE.Quaternion(...q));
        return [v.x, H + v.y, v.z];
      };
      const plank = ctx.body({ shape: 'box', he: [L / 2, T / 2, W / 2], p: along((right - left) / 2), q, idx: 0, t: 0 });
      hinge(ctx, null, plank, [0, H, 0], [0, 0, 1], W / 2);
      // side posts and axle caps outside the plank, so nothing rubs on it
      for (const s of [-1, 1]) {
        post(ctx, [0, H - 0.03, s * (W / 2 + 0.05)], 0.03);
        ctx.body({ shape: 'sphere', he: [0.045, 0.045, 0.045], p: [0, H, s * (W / 2 + 0.05)], color: '#cfd3da', finish: 'chrome', kind: 'static' });
      }
      if (p.load !== 'none') {
        // the load sits on the low (left) end, held by a lip glued to the plank
        const r = p.loadSize / 2;
        const lipX = -left + 0.02;
        const lip = ctx.body({ shape: 'box', he: [0.015, Math.max(0.03, r * 0.7), W / 2], p: along(lipX, T / 2 + Math.max(0.03, r * 0.7)), q, idx: 1, t: 0.5 });
        ctx.joint({ type: 'fixed', a: plank, b: lip, pivot: along(lipX, T / 2) });
        const at = along(lipX + 0.015 + r + 0.01, T / 2 + r + 0.002);
        if (p.load === 'ball') ctx.body({ shape: 'sphere', he: [r, r, r], p: at, idx: 2, t: 1 });
        else ctx.body({ shape: 'box', he: [r, r, r], p: at, q, idx: 2, t: 1 });
      }
    },
  },

  ramp: {
    label: 'Ramp', category: 'Gadgets', icon: '◺', movable: false,
    params: [
      { key: 'length', label: 'Length', kind: 'number', min: 0.2, max: 20, step: 0.01 },
      { key: 'width', label: 'Width', kind: 'number', min: 0.05, max: 6, step: 0.01 },
      { key: 'angle', label: 'Slope (°)', kind: 'number', min: -60, max: 60, step: 0.5, help: 'Descends toward +x for positive values' },
      { key: 'rails', label: 'Side rails', kind: 'number', min: 0, max: 1, step: 0.005, help: 'Height of the side rails (0 = flat plank)' },
      { key: 'thickness', label: 'Thickness', kind: 'number', min: 0.01, max: 0.5, step: 0.005 },
      { key: 'legs', label: 'Legs', kind: 'bool' },
    ],
    defaults: { length: 2.5, width: 0.4, angle: 15, rails: 0.08, thickness: 0.05, legs: true },
    look: { colorMode: 'single', color: '', finish: 'satin' },
    phys: { body: 'static' },
    build(ctx, p) {
      // origin = centre of the running surface
      const a = -p.angle * DEG, T = p.thickness, W = p.width, L = p.length;
      const q = qAxis([0, 0, 1], a);
      const rot = (x: number, y: number, z: number): Vec3 => {
        const v = new THREE.Vector3(x, y, z).applyQuaternion(new THREE.Quaternion(...q));
        return [v.x, v.y, v.z];
      };
      ctx.body({ shape: 'box', he: [L / 2, T / 2, W / 2 + (p.rails > 0 ? T : 0)], p: rot(0, -T / 2, 0), q, kind: 'static' });
      if (p.rails > 0) for (const s of [-1, 1]) {
        ctx.body({ shape: 'box', he: [L / 2, p.rails / 2 + T / 2, T / 2], p: rot(0, p.rails / 2 - T / 2, s * (W / 2 + T / 2)), q, kind: 'static' });
      }
      if (p.legs) for (const x of [-L / 2 + 0.08, L / 2 - 0.08]) {
        const top = rot(x, -T, 0);
        for (const s of [-1, 1]) post(ctx, [top[0], top[1], s * (W / 2 - 0.03)], 0.025);
      }
    },
    ports(p) {
      const a = -p.angle * DEG, L = p.length;
      const c = Math.cos(a), s = Math.sin(a);
      return [
        { p: [-L / 2 * c, -L / 2 * s, 0], dir: [-c, -s, 0] },
        { p: [L / 2 * c, L / 2 * s, 0], dir: [c, s, 0] },
      ];
    },
  },

  hammer: {
    label: 'Hammer', category: 'Gadgets', icon: '⚒', movable: false,
    params: [
      { key: 'height', label: 'Axle height', kind: 'number', min: 0.2, max: 10, step: 0.01 },
      { key: 'arm', label: 'Arm length', kind: 'number', min: 0.1, max: 8, step: 0.01 },
      { key: 'head', label: 'Head (x,y,z)', kind: 'vec3', min: 0.02, max: 3, step: 0.01 },
      { key: 'headDensity', label: 'Head density ×', kind: 'number', min: 0.2, max: 100, step: 0.1 },
      { key: 'angle', label: 'Start angle (°)', kind: 'number', min: -175, max: 175, step: 1, help: 'From hanging straight down; positive = raised on the −x side, so it swings toward +x' },
      { key: 'releaseAt', label: 'Release at (s)', kind: 'number', min: 0, max: 60, step: 0.05, help: '0 = swings at once; otherwise a catch holds the arm and pulls away at this time' },
      { key: 'frame', label: 'Frame', kind: 'bool' },
    ],
    defaults: { height: 2, arm: 1.5, head: [0.35, 0.22, 0.22], headDensity: 6, angle: 70, releaseAt: 0, frame: true },
    look: { colorMode: 'single', color: '#e76f51', finish: 'gloss' },
    build(ctx, p) {
      const H = p.height, La = p.arm, [hx, hy, hz] = p.head as Vec3;
      const ang = p.angle * DEG;
      // the arm hangs along -y, turned about z: a positive angle raises it on the -x side
      const q = qAxis([0, 0, 1], -ang);
      const dir = new THREE.Vector3(0, -1, 0).applyQuaternion(new THREE.Quaternion(...q));
      const at = (d: number): Vec3 => [dir.x * d, H + dir.y * d, dir.z * d];
      const rodR = Math.max(0.015, Math.min(hy, hz) * 0.18);
      const arm = ctx.body({ shape: 'box', he: [rodR, La / 2, rodR], p: at(La / 2), q, color: '#cfd3da', finish: 'metal', idx: 0, t: 0, density: 0.5 });
      const head = ctx.body({ shape: 'box', he: [hx / 2, hy / 2, hz / 2], p: at(La + hy / 2 - rodR), q, idx: 1, t: 1, density: p.headDensity });
      ctx.joint({ type: 'fixed', a: arm, b: head, pivot: at(La) });
      hinge(ctx, null, arm, [0, H, 0], [0, 0, 1], Math.max(0.05, hz / 2));
      if (p.frame) {
        const zf = Math.max(0.12, hz / 2 + 0.08);
        for (const s of [-1, 1]) post(ctx, [0, H + 0.04, s * zf], 0.03);
        ctx.body({ shape: 'box', he: [0.035, 0.035, zf + 0.03], p: [0, H + 0.075, 0], color: DARK, finish: 'metal', kind: 'static' });
      }
      if (p.releaseAt > 0) {
        // a catch on the far side of the head slides away at release time
        const side = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion(...q));
        const s = Math.sign(ang) || 1;
        const hp = at(La + hy / 2 - rodR);
        const c: Vec3 = [hp[0] + side.x * s * (hx / 2 + 0.03), hp[1] + side.y * s * (hx / 2 + 0.03), hp[2]];
        ctx.body({
          shape: 'box', he: [0.025, 0.06, hz / 2 + 0.02], p: c, q, color: DARK, finish: 'metal', kind: 'kinematic',
          motion: { kind: 'gate', offset: [0, 0, hz + 0.3], open: p.releaseAt, close: 1e6, ease: 0.12, amplitude: 0 },
        });
      }
    },
  },

  freeWheel: {
    label: 'Free wheel', category: 'Gadgets', icon: '✣', movable: false,
    params: [
      { key: 'height', label: 'Axle height', kind: 'number', min: 0.1, max: 10, step: 0.01 },
      { key: 'radius', label: 'Radius', kind: 'number', min: 0.1, max: 5, step: 0.01 },
      { key: 'paddles', label: 'Paddles', kind: 'int', min: 3, max: 12 },
      { key: 'width', label: 'Width', kind: 'number', min: 0.05, max: 4, step: 0.01 },
      { key: 'thickness', label: 'Paddle thickness', kind: 'number', min: 0.01, max: 0.3, step: 0.005 },
      { key: 'phase', label: 'Start angle (°)', kind: 'number', min: 0, max: 360, step: 1 },
    ],
    defaults: { height: 1.2, radius: 0.6, paddles: 6, width: 0.35, thickness: 0.04, phase: 15 },
    look: { colorMode: 'cycle', finish: 'gloss' },
    build(ctx, p) {
      // Every paddle is hinged on the axle and glued to its neighbours: no hub
      // body, so no body carries more joints than the solver keeps per body.
      const n = Math.max(3, Math.round(p.paddles)), R = p.radius, t = p.thickness, W = p.width, H = p.height;
      const r0 = Math.max(0.04, (t / 2) / Math.sin(Math.PI / n) + 0.01);
      const len = R - r0;
      const ids: number[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + p.phase * DEG;
        const rm = r0 + len / 2;
        ids.push(ctx.body({ shape: 'box', he: [len / 2, t / 2, W / 2], p: [Math.cos(a) * rm, H + Math.sin(a) * rm, 0], q: qAxis([0, 0, 1], a), idx: i, t: i / n }));
      }
      for (let i = 0; i < n; i++) {
        hinge(ctx, null, ids[i], [0, H, 0], [0, 0, 1], W / 2);
        const a = ((i + 0.5) / n) * Math.PI * 2 + p.phase * DEG;
        ctx.joint({ type: 'fixed', a: ids[i], b: ids[(i + 1) % n], pivot: [Math.cos(a) * r0, H + Math.sin(a) * r0, 0] });
      }
      ctx.body({ shape: 'sphere', he: [r0 * 0.7, r0 * 0.7, r0 * 0.7], p: [0, H, W / 2 + r0 * 0.7 + 0.01], color: '#cfd3da', finish: 'chrome', kind: 'static' });
      for (const s of [-1, 1]) post(ctx, [0, H, s * (W / 2 + 0.06)], 0.03);
    },
  },

  piston: {
    label: 'Piston', category: 'Gadgets', icon: '⇥', movable: false,
    params: [
      { key: 'head', label: 'Pusher (x,y,z)', kind: 'vec3', min: 0.02, max: 3, step: 0.01 },
      { key: 'stroke', label: 'Stroke (m)', kind: 'number', min: 0.02, max: 5, step: 0.01 },
      { key: 'at', label: 'Push at (s)', kind: 'number', min: 0, max: 60, step: 0.05 },
      { key: 'speed', label: 'Push time (s)', kind: 'number', min: 0.03, max: 3, step: 0.01, help: 'Time to travel the stroke: short = a sharp hit' },
      { key: 'hold', label: 'Hold (s)', kind: 'number', min: 0, max: 60, step: 0.05, help: 'Time out before pulling back' },
      { key: 'housing', label: 'Housing', kind: 'bool' },
    ],
    defaults: { head: [0.08, 0.3, 0.3], stroke: 0.3, at: 0.5, speed: 0.25, hold: 1, housing: true },
    look: { colorMode: 'single', color: '#ffb703', finish: 'gloss' },
    phys: { body: 'static' },
    build(ctx, p) {
      // origin = centre of the pusher face at rest; pushes along +x
      const [hx, hy, hz] = p.head as Vec3;
      const gate = { kind: 'gate' as const, offset: [p.stroke, 0, 0] as Vec3, open: p.at, close: p.at + p.speed + p.hold, ease: p.speed, amplitude: 0 };
      ctx.body({ shape: 'box', he: [hx / 2, hy / 2, hz / 2], p: [-hx / 2, 0, 0], kind: 'kinematic', motion: gate, idx: 0, t: 0 });
      const rodL = p.stroke + 0.1;
      const rr = Math.min(hy, hz) * 0.15;
      ctx.body({ shape: 'box', he: [rodL / 2, rr, rr], p: [-hx - rodL / 2, 0, 0], color: '#cfd3da', finish: 'chrome', kind: 'kinematic', motion: gate });
      if (p.housing) {
        const bx = rodL * 0.9;
        ctx.body({ shape: 'box', he: [bx / 2, hy * 0.42, hz * 0.42], p: [-hx - p.stroke - 0.1 - bx / 2 + rodL * 0.25, 0, 0], color: DARK, finish: 'satin', kind: 'static' });
      }
    },
  },

  cup: {
    label: 'Cup', category: 'Gadgets', icon: '⊔', movable: false,
    params: [
      { key: 'size', label: 'Inner size', kind: 'vec3', min: 0.05, max: 5, step: 0.01 },
      { key: 'thickness', label: 'Wall thickness', kind: 'number', min: 0.005, max: 0.3, step: 0.005 },
      { key: 'mode', label: 'Mode', kind: 'select', options: ['static', 'free', 'hanging'], help: 'static: a fixed target · free: a loose box that can be knocked over · hanging: swings from an axle above its rim' },
      { key: 'hang', label: 'Hang length', kind: 'number', min: 0.05, max: 5, step: 0.01 },
    ],
    defaults: { size: [0.4, 0.3, 0.4], thickness: 0.03, mode: 'static', hang: 0.25 },
    look: { colorMode: 'single', color: '', finish: 'glass' },
    build(ctx, p) {
      const [w, h, d] = p.size as Vec3, t = p.thickness;
      const kind = p.mode === 'static' ? 'static' : 'dynamic';
      const floor = ctx.body({ shape: 'box', he: [w / 2 + t, t / 2, d / 2 + t], p: [0, t / 2, 0], kind, idx: 0, t: 0 });
      const walls = [
        ctx.body({ shape: 'box', he: [t / 2, h / 2, d / 2 + t], p: [-w / 2 - t / 2, t + h / 2, 0], kind, idx: 1, t: 0.25 }),
        ctx.body({ shape: 'box', he: [t / 2, h / 2, d / 2 + t], p: [w / 2 + t / 2, t + h / 2, 0], kind, idx: 2, t: 0.5 }),
        ctx.body({ shape: 'box', he: [w / 2, h / 2, t / 2], p: [0, t + h / 2, -d / 2 - t / 2], kind, idx: 3, t: 0.75 }),
        ctx.body({ shape: 'box', he: [w / 2, h / 2, t / 2], p: [0, t + h / 2, d / 2 + t / 2], kind, idx: 4, t: 1 }),
      ];
      if (kind === 'dynamic') {
        walls.forEach((wb, i) => {
          const c = [[-w / 2, t, 0], [w / 2, t, 0], [0, t, -d / 2], [0, t, d / 2]][i] as Vec3;
          ctx.joint({ type: 'fixed', a: floor, b: wb, pivot: c });
        });
      }
      if (p.mode === 'hanging') {
        // two hanger arms glued to the side walls, hinged on an axle above the
        // rim (across z): the cup tips over when its load is off-centre
        const top = t + h + p.hang;
        const armL = p.hang + h / 2;
        for (const [k, s] of [[2, -1], [3, 1]] as const) {
          const z = s * (d / 2 + t + 0.012);
          const arm = ctx.body({ shape: 'box', he: [0.008, armL / 2, 0.008], p: [0, top - armL / 2, z], color: '#cfd3da', finish: 'metal', idx: 5, t: 0 });
          ctx.joint({ type: 'fixed', a: walls[k], b: arm, pivot: [0, t + h / 2, z] });
          hinge(ctx, null, arm, [0, top, z], [0, 0, 1], 0.006);
          ctx.body({ shape: 'sphere', he: [0.025, 0.025, 0.025], p: [0, top, s * (d / 2 + t + 0.05)], color: DARK, finish: 'metal', kind: 'static' });
          post(ctx, [0, top, s * (d / 2 + t + 0.08)], 0.02);
        }
      }
    },
    ports(p) {
      const [, h] = p.size as Vec3;
      return [{ p: [0, p.thickness + h, 0], dir: [0, 1, 0] }];
    },
  },

  rollers: {
    label: 'Rollers', category: 'Gadgets', icon: '⦾', movable: false,
    params: [
      { key: 'count', label: 'Rollers', kind: 'int', min: 2, max: 60 },
      { key: 'radius', label: 'Roller radius', kind: 'number', min: 0.02, max: 1, step: 0.005 },
      { key: 'gap', label: 'Gap', kind: 'number', min: 0, max: 0.5, step: 0.005 },
      { key: 'speed', label: 'Surface speed (m/s)', kind: 'number', min: -10, max: 10, step: 0.05, help: 'Rounded so every roller makes whole turns per loop' },
      { key: 'rails', label: 'Side rails', kind: 'bool' },
      { key: 'width', label: 'Rail spacing', kind: 'number', min: 0.05, max: 4, step: 0.01 },
    ],
    defaults: { count: 10, radius: 0.08, gap: 0.01, speed: 1.2, rails: true, width: 0.35 },
    look: { colorMode: 'single', color: '#cfd3da', finish: 'chrome' },
    phys: { body: 'static' },
    build(ctx, p) {
      const n = Math.max(2, Math.round(p.count)), r = p.radius, pitch = 2 * r + p.gap;
      // surface speed v = ω r, ω = 2π cycles / D; spin about -z carries toward +x
      const cycles = Math.max(1, Math.round(Math.abs(p.speed) * ctx.duration / (2 * Math.PI * r)));
      const spin = { kind: 'spin' as const, axis: [0, 0, -1] as Vec3, cycles, amplitude: p.speed < 0 ? -45 : 45 };
      const span = (n - 1) * pitch;
      for (let i = 0; i < n; i++) {
        ctx.body({ shape: 'sphere', he: [r, r, r], p: [-span / 2 + i * pitch, r, 0], kind: 'kinematic', motion: { ...spin, pivot: [-span / 2 + i * pitch, r, 0] }, idx: i, t: i / (n - 1) });
      }
      if (p.rails) for (const s of [-1, 1]) {
        ctx.body({ shape: 'box', he: [span / 2 + r, r * 0.9, 0.015], p: [0, r * 1.4, s * p.width / 2], color: DARK, finish: 'satin', kind: 'static' });
      }
    },
    ports(p) {
      const n = Math.max(2, Math.round(p.count)), pitch = 2 * p.radius + p.gap, span = (n - 1) * pitch;
      return [
        { p: [-span / 2 - p.radius, 2 * p.radius, 0], dir: [-1, 0, 0] },
        { p: [span / 2 + p.radius, 2 * p.radius, 0], dir: [1, 0, 0] },
      ];
    },
  },

  sensor: {
    label: 'Sensor', category: 'Testing', icon: '◫', movable: false,
    params: [
      { key: 'size', label: 'Zone size', kind: 'vec3', min: 0.02, max: 40, step: 0.01 },
      { key: 'watch', label: 'Watch', kind: 'entity', help: 'Which object must enter the zone (any = any moving body)' },
      { key: 'count', label: 'Bodies needed', kind: 'int', min: 1, max: 10000 },
    ],
    defaults: { size: [0.6, 0.6, 0.6], watch: '', count: 1 },
    look: { colorMode: 'single', color: '#7ce0a0', finish: 'hidden' },
    build() { /* a test zone: no bodies, read by the machine analysis */ },
  },
} satisfies Record<string, EntityDef>;

export type GadgetType = keyof typeof GADGET_DEFS;
export type { Port };
void v3;
