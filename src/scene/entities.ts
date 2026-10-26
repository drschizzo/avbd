// Entity catalogue: parameter schemas (drive the UI) and local-space builders
// (drive the physics). Builders work in the entity's local frame: +Y up, origin
// at the entity position (base centre for structures, centre for primitives).

import * as THREE from 'three';
import type { BodyKind, Entity, EntityType, Finish, Look, MotionDef, Phys, Vec3 } from './doc';
import { defaultLook, defaultMotion, defaultPhys } from './doc';
import type { Rng } from './rng';
import { GADGET_DEFS, hinge, latch } from './gadgets';

export type Q4 = [number, number, number, number];

export interface ParamSpec {
  key: string;
  label: string;
  /** 'entity': the id of another entity of the scene ('' = any) */
  kind: 'number' | 'int' | 'bool' | 'select' | 'vec3' | 'entity';
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  help?: string;
  /** shown only when this returns true (the panel re-renders on select changes) */
  show?: (params: Record<string, any>) => boolean;
}

/** A connection point (entity frame): parts snap end to end on these. */
export interface Port {
  p: Vec3;
  dir: Vec3; // unit, pointing out of the part
}

export interface LocalBody {
  shape: 'box' | 'sphere';
  he: Vec3;
  p: Vec3;
  q?: Q4;
  /** colour parameter: index for 'cycle', 0..1 for 'gradient' */
  idx?: number;
  t?: number;
  color?: string; // hard override
  finish?: Finish;
  kind?: BodyKind; // override of the entity body kind
  vel?: Vec3; // local frame
  angVel?: Vec3;
  density?: number;
  spawnAt?: number;
  friction?: number;
  /**
   * Kinematic motion of this body alone (overrides the entity motion). Axis
   * and offset are in the entity frame; the motion pivots around `pivot`
   * (entity frame, default origin). Bodies with identical motions share it.
   */
  motion?: Partial<MotionDef> & { pivot?: Vec3 };
}

export interface LocalJoint {
  type: 'spherical' | 'fixed' | 'spring';
  a: number | null; // local body handle, null = world
  b: number;
  pivot: Vec3; // local-frame pivot (spherical/fixed) / anchor on A (spring)
  pivotB?: Vec3; // spring: anchor on B
  stiffness?: number;
  fracture?: number;
  collide?: boolean;
}

export interface BuildCtx {
  e: Entity;
  rng: Rng;
  duration: number;
  fps: number;
  gravity: number;
  /** world-space quaternion of the entity (for gravity-aware emitters) */
  worldQuat: Q4;
  body(b: LocalBody): number;
  joint(j: LocalJoint): void;
  posOf(h: number): Vec3;
  heOf(h: number): Vec3;
}

export interface EntityDef {
  label: string;
  category: 'Primitives' | 'Structures' | 'Mechanisms' | 'Gadgets' | 'Scenery' | 'Sources' | 'Liquids' | 'Testing';
  icon: string;
  params: ParamSpec[];
  defaults: Record<string, any>;
  look?: Partial<Look>;
  phys?: Partial<Phys>;
  motion?: Partial<MotionDef>;
  /** whether body kind / motion are editable for this entity */
  movable: boolean;
  build(ctx: BuildCtx, p: Record<string, any>): void;
  ports?(p: Record<string, any>): Port[];
}

const v3 = (x: number, y: number, z: number): Vec3 => [x, y, z];
const qAxis = (ax: Vec3, angle: number): Q4 => {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...ax).normalize(), angle);
  return [q.x, q.y, q.z, q.w];
};
const qMul = (a: Q4, b: Q4): Q4 => {
  const q = new THREE.Quaternion(...a).multiply(new THREE.Quaternion(...b));
  return [q.x, q.y, q.z, q.w];
};
const half = (s: Vec3): Vec3 => [s[0] / 2, s[1] / 2, s[2] / 2];
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------

export const ENTITY_DEFS: Record<EntityType, EntityDef> = {
  box: {
    label: 'Box', category: 'Primitives', icon: '▣', movable: true,
    params: [{ key: 'size', label: 'Size', kind: 'vec3', min: 0.02, max: 40, step: 0.01 }],
    defaults: { size: [1, 1, 1] },
    build(ctx, p) {
      ctx.body({ shape: 'box', he: half(p.size), p: v3(0, 0, 0), idx: 0, t: 0.5 });
    },
  },

  sphere: {
    label: 'Sphere', category: 'Primitives', icon: '●', movable: true,
    params: [{ key: 'radius', label: 'Radius', kind: 'number', min: 0.02, max: 20, step: 0.01 }],
    defaults: { radius: 0.5 },
    build(ctx, p) {
      ctx.body({ shape: 'sphere', he: [p.radius, p.radius, p.radius], p: v3(0, 0, 0), idx: 0, t: 0.5 });
    },
  },

  wall: {
    label: 'Brick wall', category: 'Structures', icon: '▦', movable: false,
    params: [
      { key: 'rows', label: 'Rows', kind: 'int', min: 1, max: 80 },
      { key: 'cols', label: 'Columns', kind: 'int', min: 1, max: 80 },
      { key: 'brick', label: 'Brick', kind: 'vec3', min: 0.02, max: 5, step: 0.01 },
      { key: 'gap', label: 'Gap', kind: 'number', min: 0, max: 0.2, step: 0.001 },
      { key: 'bond', label: 'Running bond', kind: 'bool' },
      { key: 'glue', label: 'Glue (break force)', kind: 'number', min: 0, max: 100000, step: 1, help: '0 = loose bricks; >0 = fixed joints that break above this force' },
    ],
    defaults: { rows: 10, cols: 8, brick: [0.6, 0.3, 0.3], gap: 0.004, bond: true, glue: 0 },
    look: { colorMode: 'random' },
    build(ctx, p) {
      const [bx, by, bz] = p.brick as Vec3;
      const ids: number[][] = [];
      const width = p.cols * (bx + p.gap);
      for (let r = 0; r < p.rows; r++) {
        ids.push([]);
        const offset = p.bond && r % 2 === 1 ? (bx + p.gap) / 2 : 0;
        for (let c = 0; c < p.cols; c++) {
          let x = -width / 2 + (bx + p.gap) * (c + 0.5) + offset;
          let w = bx;
          if (p.bond && r % 2 === 1 && c === p.cols - 1) { // half brick to keep edges flush
            w = bx / 2 - p.gap / 2;
            x = width / 2 - w / 2 - p.gap / 2;
          }
          const y = by / 2 + r * (by + p.gap) + 0.0005;
          ids[r].push(ctx.body({ shape: 'box', he: [w / 2, by / 2, bz / 2], p: v3(x, y, 0), idx: r * p.cols + c, t: r / Math.max(1, p.rows - 1) }));
        }
        if (p.bond && r % 2 === 1) {
          const w = bx / 2 - p.gap / 2;
          const x = -width / 2 + w / 2 + p.gap / 2;
          const y = by / 2 + r * (by + p.gap) + 0.0005;
          ids[r].unshift(ctx.body({ shape: 'box', he: [w / 2, by / 2, bz / 2], p: v3(x, y, 0), idx: r * p.cols + p.cols, t: r / Math.max(1, p.rows - 1) }));
        }
      }
      if (p.glue > 0) glueGrid(ctx, ids, p.glue, (by + p.gap));
    },
  },

  pyramid: {
    label: 'Pyramid', category: 'Structures', icon: '◭', movable: false,
    params: [
      { key: 'base', label: 'Base count', kind: 'int', min: 1, max: 60 },
      { key: 'brick', label: 'Block', kind: 'vec3', min: 0.02, max: 5, step: 0.01 },
      { key: 'gap', label: 'Gap', kind: 'number', min: 0, max: 0.3, step: 0.001 },
      { key: 'mode', label: 'Shape', kind: 'select', options: ['2d', '3d'] },
    ],
    defaults: { base: 12, brick: [0.5, 0.5, 0.5], gap: 0.02, mode: '2d' },
    look: { colorMode: 'height' },
    build(ctx, p) {
      const [bx, by, bz] = p.brick as Vec3;
      let i = 0;
      for (let layer = 0; layer < p.base; layer++) {
        const n = p.base - layer;
        const y = by / 2 + layer * by + 0.0005;
        if (p.mode === '3d') {
          for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
            ctx.body({ shape: 'box', he: half(p.brick), p: v3((a - (n - 1) / 2) * (bx + p.gap), y, (b - (n - 1) / 2) * (bz + p.gap)), idx: i++, t: layer / p.base });
          }
        } else {
          for (let a = 0; a < n; a++) {
            ctx.body({ shape: 'box', he: half(p.brick), p: v3((a - (n - 1) / 2) * (bx + p.gap), y, 0), idx: i++, t: layer / p.base });
          }
        }
      }
    },
  },

  tower: {
    label: 'Tower', category: 'Structures', icon: '▥', movable: false,
    params: [
      { key: 'style', label: 'Style', kind: 'select', options: ['jenga', 'ring', 'column'] },
      { key: 'levels', label: 'Levels', kind: 'int', min: 1, max: 120 },
      { key: 'block', label: 'Block', kind: 'vec3', min: 0.02, max: 5, step: 0.01 },
      { key: 'ringCount', label: 'Blocks per ring', kind: 'int', min: 3, max: 64 },
      { key: 'radius', label: 'Ring radius', kind: 'number', min: 0.1, max: 20, step: 0.01 },
      { key: 'gap', label: 'Gap', kind: 'number', min: 0, max: 0.2, step: 0.001 },
    ],
    defaults: { style: 'ring', levels: 16, block: [0.5, 0.25, 0.25], ringCount: 12, radius: 1.1, gap: 0.004 },
    look: { colorMode: 'height' },
    build(ctx, p) {
      const [bx, by, bz] = p.block as Vec3;
      let i = 0;
      for (let l = 0; l < p.levels; l++) {
        const y = by / 2 + l * (by + 0.0005) + 0.0005;
        const t = l / Math.max(1, p.levels - 1);
        if (p.style === 'jenga') {
          const rot = l % 2 === 0 ? 0 : Math.PI / 2;
          for (let k = -1; k <= 1; k++) {
            const off = k * (bz + p.gap);
            const pos: Vec3 = rot === 0 ? [0, y, off] : [off, y, 0];
            ctx.body({ shape: 'box', he: half(p.block), p: pos, q: qAxis([0, 1, 0], rot), idx: i++, t });
          }
        } else if (p.style === 'ring') {
          const n = p.ringCount;
          // keep the inner corners of neighbouring blocks from overlapping
          const minR = bx / (2 * Math.tan(Math.PI / n)) + bz / 2 + p.gap * 2;
          const R = Math.max(p.radius, minR);
          for (let k = 0; k < n; k++) {
            const a = (k + (l % 2) * 0.5) / n * Math.PI * 2;
            ctx.body({ shape: 'box', he: half(p.block), p: [Math.cos(a) * R, y, Math.sin(a) * R], q: qAxis([0, 1, 0], -a + Math.PI / 2), idx: i++, t });
          }
        } else {
          ctx.body({ shape: 'box', he: half(p.block), p: [0, y, 0], q: qAxis([0, 1, 0], l * 0.15), idx: i++, t });
        }
      }
    },
  },

  dominoes: {
    label: 'Dominoes', category: 'Structures', icon: '⫼', movable: false,
    params: [
      { key: 'count', label: 'Count', kind: 'int', min: 2, max: 3000 },
      { key: 'size', label: 'Domino (t,h,w)', kind: 'vec3', min: 0.01, max: 5, step: 0.01 },
      { key: 'path', label: 'Path', kind: 'select', options: ['line', 'spiral', 'circle', 'wave', 'arc', 'zigzag'] },
      { key: 'spacing', label: 'Spacing (×h)', kind: 'number', min: 0.2, max: 1.2, step: 0.01 },
      { key: 'radius', label: 'Radius / amplitude / inner', kind: 'number', min: 0.1, max: 30, step: 0.01 },
      { key: 'turns', label: 'Turns / waves', kind: 'number', min: 0.1, max: 20, step: 0.05 },
      { key: 'push', label: 'Push (deg tilt)', kind: 'number', min: 0, max: 40, step: 0.5 },
    ],
    defaults: { count: 120, size: [0.08, 0.5, 0.25], path: 'spiral', spacing: 0.55, radius: 0.9, turns: 3, push: 12 },
    look: { colorMode: 'gradient' },
    build(ctx, p) {
      const [th, h, w] = p.size as Vec3;
      const step = p.spacing * h;
      const pts = dominoPath(p.path, p.count, step, p.radius, p.turns, h);
      for (let i = 0; i < pts.length; i++) {
        const { x, z, yaw } = pts[i];
        let q = qAxis([0, 1, 0], yaw);
        let pos: Vec3 = [x, h / 2 + 0.0005, z];
        let angVel: Vec3 | undefined;
        if (i === 0 && p.push > 0) {
          // tilt the first domino forward around its bottom front edge
          const tilt = p.push * DEG;
          const fwd: Vec3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
          const side: Vec3 = [Math.sin(yaw), 0, Math.cos(yaw)];
          q = qMul(qAxis(side, -tilt), q);
          const pivot: Vec3 = [x + fwd[0] * th / 2, 0, z + fwd[2] * th / 2];
          const rel = new THREE.Vector3(-th / 2, h / 2, 0).applyQuaternion(new THREE.Quaternion(...q));
          pos = [pivot[0] + rel.x, rel.y + 0.0005, pivot[2] + rel.z];
          angVel = [side[0] * -2.0, 0, side[2] * -2.0];
        }
        ctx.body({
          shape: 'box', he: [th / 2, h / 2, w / 2], p: pos, q, idx: i, t: i / Math.max(1, pts.length - 1),
          angVel,
        });
      }
    },
  },

  grid: {
    label: 'Block grid', category: 'Structures', icon: '⁙', movable: false,
    params: [
      { key: 'counts', label: 'Counts', kind: 'vec3', min: 1, max: 60, step: 1 },
      { key: 'shape', label: 'Shape', kind: 'select', options: ['box', 'sphere', 'mixed'] },
      { key: 'size', label: 'Size', kind: 'number', min: 0.02, max: 4, step: 0.01 },
      { key: 'gap', label: 'Gap', kind: 'number', min: 0, max: 2, step: 0.005 },
      { key: 'jitter', label: 'Jitter', kind: 'number', min: 0, max: 1, step: 0.01 },
    ],
    defaults: { counts: [6, 6, 6], shape: 'box', size: 0.35, gap: 0.02, jitter: 0 },
    look: { colorMode: 'random' },
    build(ctx, p) {
      const [nx, ny, nz] = (p.counts as Vec3).map((v) => Math.max(1, Math.round(v)));
      const s = p.size, st = s + p.gap;
      let i = 0;
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) for (let z = 0; z < nz; z++) {
        const sphere = p.shape === 'sphere' || (p.shape === 'mixed' && ctx.rng.next() < 0.5);
        const j = p.jitter * p.gap * 0.5;
        const pos: Vec3 = [
          (x - (nx - 1) / 2) * st + ctx.rng.range(-j, j),
          s / 2 + y * st + 0.0005,
          (z - (nz - 1) / 2) * st + ctx.rng.range(-j, j),
        ];
        ctx.body(sphere
          ? { shape: 'sphere', he: [s / 2, s / 2, s / 2], p: pos, idx: i, t: y / Math.max(1, ny - 1) }
          : { shape: 'box', he: [s / 2, s / 2, s / 2], p: pos, idx: i, t: y / Math.max(1, ny - 1) });
        i++;
      }
    },
  },

  chain: {
    label: 'Chain / bridge', category: 'Mechanisms', icon: '⛓', movable: false,
    params: [
      { key: 'links', label: 'Links', kind: 'int', min: 2, max: 400 },
      { key: 'linkType', label: 'Link', kind: 'select', options: ['bead', 'plank'] },
      { key: 'radius', label: 'Bead radius / plank thickness', kind: 'number', min: 0.01, max: 1, step: 0.005 },
      { key: 'plank', label: 'Plank (l,w)', kind: 'vec3', min: 0.02, max: 5, step: 0.01 },
      { key: 'strands', label: 'Strands', kind: 'int', min: 1, max: 80 },
      { key: 'strandSpacing', label: 'Strand spacing', kind: 'number', min: 0.02, max: 5, step: 0.01 },
      { key: 'layout', label: 'Layout', kind: 'select', options: ['hanging', 'span'] },
      { key: 'anchors', label: 'Anchors', kind: 'select', options: ['start', 'both', 'none'] },
      { key: 'slack', label: 'Anchor distance (span)', kind: 'number', min: 0.3, max: 1.0, step: 0.01 },
      { key: 'breakForce', label: 'Break force', kind: 'number', min: 0, max: 100000, step: 1 },
    ],
    defaults: { links: 24, linkType: 'bead', radius: 0.07, plank: [0.3, 1.0, 0], strands: 1, strandSpacing: 0.3, layout: 'hanging', anchors: 'start', slack: 0.92, breakForce: 0 },
    look: { colorMode: 'gradient', finish: 'pearl' },
    build(ctx, p) {
      const plank = p.linkType === 'plank';
      const linkLen = plank ? p.plank[0] : p.radius * 2;
      for (let s = 0; s < p.strands; s++) {
        const z = (s - (p.strands - 1) / 2) * p.strandSpacing;
        const ids: number[] = [];
        const span = p.layout === 'span';
        // joint pivots along the chain: a vertical line (hanging) or a sagging
        // parabola whose arc length matches the chain (span, anchors "slack" apart)
        const n = p.links;
        const pivots: [number, number][] = [];
        if (span) {
          const total = n * linkLen;
          const chord = total * Math.min(0.999, Math.max(0.3, p.slack));
          const arc = (sag: number) => {
            let L = 0, px = -chord / 2, py = 0;
            for (let k = 1; k <= 200; k++) {
              const x = -chord / 2 + (chord * k) / 200;
              const y = -sag * (1 - (2 * x / chord) ** 2);
              L += Math.hypot(x - px, y - py); px = x; py = y;
            }
            return L;
          };
          let lo = 0, hi = total;
          for (let it = 0; it < 50; it++) { const mid = (lo + hi) / 2; if (arc(mid) < total) lo = mid; else hi = mid; }
          const sag = lo;
          // place the n+1 pivots at equal arc-length fractions (exact endpoints)
          const M = 6000;
          const dense: [number, number][] = [];
          const cum: number[] = [0];
          for (let k = 0; k <= M; k++) {
            const x = -chord / 2 + (chord * k) / M;
            dense.push([x, -sag * (1 - (2 * x / chord) ** 2)]);
            if (k > 0) cum.push(cum[k - 1] + Math.hypot(dense[k][0] - dense[k - 1][0], dense[k][1] - dense[k - 1][1]));
          }
          let k = 0;
          for (let i = 0; i <= n; i++) {
            const target = (cum[M] * i) / n;
            while (k < M && cum[k + 1] < target) k++;
            const f = k < M ? (target - cum[k]) / Math.max(1e-9, cum[k + 1] - cum[k]) : 0;
            const a = dense[k], b = dense[Math.min(M, k + 1)];
            pivots.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
          }
        } else {
          for (let i = 0; i <= n; i++) pivots.push([0, -i * linkLen]);
        }
        for (let i = 0; i < n; i++) {
          const [x0, y0] = pivots[i], [x1, y1] = pivots[i + 1];
          const mid: Vec3 = span ? [(x0 + x1) / 2, (y0 + y1) / 2, z] : [0, (y0 + y1) / 2, z];
          const ang = Math.atan2(y1 - y0, x1 - x0);
          const t = i / Math.max(1, n - 1);
          ids.push(plank
            ? ctx.body({ shape: 'box', he: [linkLen / 2 * 0.96, p.radius / 2, p.plank[1] / 2], p: mid, q: span ? qAxis([0, 0, 1], ang) : qAxis([0, 0, 1], Math.PI / 2), idx: i, t })
            : ctx.body({ shape: 'sphere', he: [p.radius, p.radius, p.radius], p: mid, idx: i, t }));
        }
        const fr = p.breakForce > 0 ? p.breakForce : undefined;
        const zs = plank ? [-p.plank[1] * 0.4, p.plank[1] * 0.4] : [0];
        for (let i = 0; i + 1 < ids.length; i++) {
          for (const dz of zs) {
            const [px, py] = pivots[i + 1];
            ctx.joint({ type: 'spherical', a: ids[i], b: ids[i + 1], pivot: [span ? px : 0, py, z + dz], fracture: fr });
          }
        }
        if (p.anchors !== 'none') {
          for (const dz of zs) {
            const [sx, sy] = pivots[0];
            ctx.joint({ type: 'spherical', a: null, b: ids[0], pivot: [span ? sx : 0, sy, z + dz] });
            if (p.anchors === 'both') {
              const [ex, ey] = pivots[n];
              ctx.joint({ type: 'spherical', a: null, b: ids[ids.length - 1], pivot: [span ? ex : 0, ey, z + dz] });
            }
          }
        }
      }
    },
  },

  wreckingBall: {
    label: 'Wrecking ball', category: 'Mechanisms', icon: '◉', movable: false,
    params: [
      { key: 'length', label: 'Cable length', kind: 'number', min: 0.3, max: 30, step: 0.01 },
      { key: 'links', label: 'Cable segments', kind: 'int', min: 1, max: 40 },
      { key: 'ballRadius', label: 'Ball radius', kind: 'number', min: 0.05, max: 5, step: 0.01 },
      { key: 'ballDensity', label: 'Ball density ×', kind: 'number', min: 1, max: 500, step: 1, help: 'AVBD handles large mass ratios' },
      { key: 'angle', label: 'Release angle', kind: 'number', min: 0, max: 170, step: 1 },
      { key: 'heading', label: 'Swing heading', kind: 'number', min: -180, max: 180, step: 1 },
      { key: 'releaseAt', label: 'Release at (s)', kind: 'number', min: 0, max: 60, step: 0.05, help: '0 = swings at once; otherwise a catch holds the ball and pulls away at this time' },
      { key: 'latch', label: 'Latch', kind: 'bool', help: 'The cable starts level (one rigid hinged rod), the ball resting on a bar held up by a thin prop: knock the prop over to release it' },
      { key: 'latchFlip', label: 'Prop on the other side', kind: 'bool', show: (p: any) => !!p.latch },
    ],
    defaults: { length: 3.2, links: 8, ballRadius: 0.6, ballDensity: 30, angle: 70, heading: 0, releaseAt: 0, latch: false, latchFlip: false },
    look: { colorMode: 'single', color: '#2b2d42', finish: 'metal' },
    build(ctx, p) {
      const L = p.length;
      // a latched ball hangs from a rigid rod: a sagging cable would drag it
      // off the frictionless block
      const n = p.latch ? 1 : Math.max(1, Math.round(p.links));
      const seg = L / n;
      const ang = (p.latch ? 90 : p.angle) * DEG;
      const hd = p.heading * DEG;
      // pendulum direction (from anchor down), rotated by the release angle in the heading plane
      const dir = new THREE.Vector3(Math.sin(ang) * Math.cos(hd), -Math.cos(ang), Math.sin(ang) * -Math.sin(hd)).normalize();
      const at = (d: number): Vec3 => [dir.x * d, dir.y * d, dir.z * d];
      const qr = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().negate());
      const q: Q4 = [qr.x, qr.y, qr.z, qr.w];
      const ids: number[] = [];
      const thick = Math.max(0.02, p.ballRadius * 0.07);
      for (let i = 0; i < n; i++) {
        ids.push(ctx.body({
          shape: 'box', he: [thick, seg / 2 * 0.97, thick], p: at(seg * (i + 0.5)), q,
          idx: i, t: 0.2, finish: 'chrome', color: '#cfd3da', density: p.ballDensity * 0.6,
        }));
      }
      const ball = ctx.body({ shape: 'sphere', he: [p.ballRadius, p.ballRadius, p.ballRadius], p: at(L + p.ballRadius), idx: 0, t: 1, density: p.ballDensity });
      // latched: hinged, so it cannot drift sideways along the latch bar
      if (p.latch) hinge(ctx, null, ids[0], [0, 0, 0], [Math.sin(hd), 0, Math.cos(hd)], 0.06);
      else ctx.joint({ type: 'spherical', a: null, b: ids[0], pivot: [0, 0, 0] });
      for (let i = 0; i + 1 < ids.length; i++) ctx.joint({ type: 'spherical', a: ids[i], b: ids[i + 1], pivot: at(seg * (i + 1)) });
      // latched: the ball is welded to its rod (on a ball joint it would fold
      // over and roll off the block)
      ctx.joint({ type: p.latch ? 'fixed' : 'spherical', a: ids[ids.length - 1], b: ball, pivot: at(L) });
      if (p.latch) {
        const c = at(L + p.ballRadius);
        const f = p.latchFlip ? -1 : 1;
        latch(ctx, [c[0], c[1] - p.ballRadius, c[2]], p.ballRadius + 0.03, [f * Math.sin(hd), 0, f * Math.cos(hd)]);
      } else if (p.releaseAt > 0 && ang > 0.01) {
        // a catch under the ball, square to the swing, slides out sideways at
        // release time (same idea as the hammer's)
        const down = new THREE.Vector3(-Math.cos(ang) * Math.cos(hd), -Math.sin(ang), Math.cos(ang) * Math.sin(hd));
        const side = new THREE.Vector3(Math.sin(hd), 0, Math.cos(hd));
        const up = new THREE.Vector3().crossVectors(side, down).normalize();
        const m = new THREE.Matrix4().makeBasis(down, up, side);
        const cq = new THREE.Quaternion().setFromRotationMatrix(m);
        const R = p.ballRadius, th = Math.max(0.03, R * 0.12);
        const c = new THREE.Vector3(...at(L + R)).addScaledVector(down, R + th + 0.002);
        const off = side.clone().multiplyScalar(2 * R + 0.4);
        ctx.body({
          shape: 'box', he: [th, R * 0.7, R * 0.7], p: [c.x, c.y, c.z], q: [cq.x, cq.y, cq.z, cq.w], color: '#2b2d33', finish: 'metal', kind: 'kinematic',
          motion: { kind: 'gate', offset: [off.x, off.y, off.z], open: p.releaseAt, close: 1e6, ease: 0.15, amplitude: 0 },
        });
        // a post up to the catch, so it does not hang in mid-air
        const low = c.clone().addScaledVector(down, th + 0.01);
        const h = ctx.e.position[1] + low.y - R * 0.7;
        if (h > 0.05) ctx.body({ shape: 'box', he: [0.03, h / 2, 0.03], p: [low.x, low.y - R * 0.7 - h / 2, low.z], color: '#2b2d33', finish: 'metal', kind: 'static' });
      }
    },
  },

  hourglass: {
    label: 'Hourglass', category: 'Mechanisms', icon: '⧗', movable: false,
    params: [
      { key: 'radius', label: 'Bulb radius', kind: 'number', min: 0.2, max: 5, step: 0.01 },
      { key: 'neck', label: 'Neck radius', kind: 'number', min: 0.03, max: 2, step: 0.005 },
      { key: 'height', label: 'Half height', kind: 'number', min: 0.3, max: 8, step: 0.01 },
      { key: 'cone', label: 'Cone fraction', kind: 'number', min: 0.2, max: 1, step: 0.01 },
      { key: 'segments', label: 'Segments', kind: 'int', min: 8, max: 48 },
      { key: 'grains', label: 'Grains', kind: 'int', min: 0, max: 20000 },
      { key: 'grainRadius', label: 'Grain radius', kind: 'number', min: 0.01, max: 0.3, step: 0.001 },
      { key: 'flipAt', label: 'Flip at (s)', kind: 'number', min: 0, max: 60, step: 0.05 },
      { key: 'flipTime', label: 'Flip duration (s)', kind: 'number', min: 0.2, max: 5, step: 0.05 },
      { key: 'stand', label: 'Stand', kind: 'bool' },
      { key: 'sandBelow', label: 'Sand starts below', kind: 'bool', help: 'Start with the sand at rest in the lower bulb (flip first, then pour)' },
      { key: 'glassFriction', label: 'Glass friction', kind: 'number', min: 0, max: 1, step: 0.01, help: 'Low values let the last grains slide off the cone' },
    ],
    defaults: { radius: 0.75, neck: 0.2, height: 1.25, cone: 0.62, segments: 24, grains: 1300, grainRadius: 0.035, flipAt: 6.45, flipTime: 2.25, stand: true, sandBelow: false, glassFriction: 0.4 },
    look: { colorMode: 'cycle', color: '', finish: 'gloss' },
    phys: { body: 'static', friction: 0.5 },
    build(ctx, p) {
      hourglassBuild(ctx, p);
    },
  },

  wheel: {
    label: 'Paddle wheel', category: 'Mechanisms', icon: '✲', movable: false,
    params: [
      { key: 'radius', label: 'Radius', kind: 'number', min: 0.1, max: 10, step: 0.01 },
      { key: 'paddles', label: 'Paddles', kind: 'int', min: 2, max: 32 },
      { key: 'width', label: 'Width', kind: 'number', min: 0.05, max: 10, step: 0.01 },
      { key: 'thickness', label: 'Paddle thickness', kind: 'number', min: 0.01, max: 1, step: 0.005 },
      { key: 'turns', label: 'Turns per loop', kind: 'int', min: -20, max: 20, help: 'Whole turns so the loop stays seamless; negative reverses' },
      { key: 'rims', label: 'Side rims', kind: 'bool' },
    ],
    defaults: { radius: 0.8, paddles: 8, width: 0.7, thickness: 0.05, turns: 2, rims: true },
    look: { colorMode: 'cycle', finish: 'gloss' },
    phys: { body: 'static' },
    build(ctx, p) {
      // every part spins about the entity origin (the axle, along local z)
      const turns = Math.round(p.turns) || 1;
      const spin = { kind: 'spin' as const, axis: [0, 0, 1] as Vec3, cycles: Math.abs(turns), amplitude: turns < 0 ? -45 : 45 };
      const R = p.radius, n = Math.max(2, Math.round(p.paddles)), w = p.width, t = p.thickness;
      const hub = Math.max(t * 2, R * 0.18);
      ctx.body({ shape: 'box', he: [hub, hub, w / 2 + t], p: [0, 0, 0], color: '#2b2d33', finish: 'metal', kind: 'kinematic', motion: spin });
      const len = R - hub * 0.6;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const rm = hub * 0.6 + len / 2;
        ctx.body({ shape: 'box', he: [len / 2, t / 2, w / 2], p: [Math.cos(a) * rm, Math.sin(a) * rm, 0], q: qAxis([0, 0, 1], a), idx: i, t: i / n, kind: 'kinematic', motion: spin });
      }
      if (p.rims) {
        // rims as thin rings of plates on both faces keep water in the buckets
        const segs = n * 2;
        for (const sz of [-1, 1]) for (let i = 0; i < segs; i++) {
          const a = ((i + 0.5) / segs) * Math.PI * 2;
          const chord = 2 * R * Math.sin(Math.PI / segs) * 1.08;
          ctx.body({ shape: 'box', he: [R * 0.22, chord / 2, t / 2], p: [Math.cos(a) * R * 0.78, Math.sin(a) * R * 0.78, sz * (w / 2 + t / 2)], q: qAxis([0, 0, 1], a), color: '#ffffff', finish: 'glass', kind: 'kinematic', motion: spin });
        }
      }
      // axle supports
      const h = ctx.e.position[1];
      for (const sz of [-1, 1]) {
        ctx.body({ shape: 'box', he: [0.06, h / 2, 0.06], p: [0, -h / 2, sz * (w / 2 + t + 0.12)], color: '#3b2a20', finish: 'satin' });
      }
    },
  },

  drum: {
    label: 'Tumbler drum', category: 'Mechanisms', icon: '◎', movable: false,
    params: [
      { key: 'radius', label: 'Inner radius', kind: 'number', min: 0.3, max: 6, step: 0.01 },
      { key: 'length', label: 'Depth', kind: 'number', min: 0.2, max: 6, step: 0.01 },
      { key: 'segments', label: 'Segments', kind: 'int', min: 8, max: 64 },
      { key: 'thickness', label: 'Shell thickness', kind: 'number', min: 0.02, max: 0.5, step: 0.005 },
      { key: 'lifters', label: 'Lifters', kind: 'int', min: 0, max: 16 },
      { key: 'lifterHeight', label: 'Lifter height', kind: 'number', min: 0.02, max: 1, step: 0.01 },
      { key: 'turns', label: 'Turns per loop', kind: 'int', min: -10, max: 10, help: 'Whole turns keep the loop seamless; negative reverses' },
      { key: 'window', label: 'Glass front', kind: 'bool' },
    ],
    defaults: { radius: 1.2, length: 0.9, segments: 32, thickness: 0.1, lifters: 6, lifterHeight: 0.16, turns: 2, window: true },
    look: { colorMode: 'single', color: '', finish: 'satin' },
    phys: { body: 'static' },
    build(ctx, p) {
      // A shell of plates and inner lifter vanes spins about the axle (local
      // z) between two fixed end walls; the front one is glass. Lifters carry
      // the load up and drop it, so it cascades instead of just sliding.
      const turns = Math.round(p.turns) || 1;
      const spin = { kind: 'spin' as const, axis: [0, 0, 1] as Vec3, cycles: Math.abs(turns), amplitude: turns < 0 ? -45 : 45 };
      const R = p.radius, L = p.length, t = p.thickness, n = Math.max(8, Math.round(p.segments));
      const chord = 2 * (R + t) * Math.tan(Math.PI / n) * 1.04;
      for (let i = 0; i < n; i++) {
        const a = ((i + 0.5) / n) * Math.PI * 2;
        ctx.body({ shape: 'box', he: [t / 2, chord / 2, L / 2], p: [Math.cos(a) * (R + t / 2), Math.sin(a) * (R + t / 2), 0], q: qAxis([0, 0, 1], a), kind: 'kinematic', motion: spin });
      }
      const m = Math.max(0, Math.round(p.lifters)), lh = p.lifterHeight;
      for (let k = 0; k < m; k++) {
        const a = (k / m) * Math.PI * 2;
        ctx.body({ shape: 'box', he: [lh / 2 + t / 4, 0.03, L / 2], p: [Math.cos(a) * (R - lh / 2 + t / 4), Math.sin(a) * (R - lh / 2 + t / 4), 0], q: qAxis([0, 0, 1], a), color: '#2b2d33', finish: 'metal', kind: 'kinematic', motion: spin });
      }
      const W = R + t + 0.06;
      ctx.body({ shape: 'box', he: [W, W, t / 2], p: [0, 0, -(L / 2 + t / 2)] });
      if (p.window) ctx.body({ shape: 'box', he: [W, W, 0.03], p: [0, 0, L / 2 + 0.03], color: '#ffffff', finish: 'glass' });
      else ctx.body({ shape: 'box', he: [W, W, t / 2], p: [0, 0, L / 2 + t / 2] });
      // plinth under the drum
      const h = ctx.e.position[1];
      const hb = h - (R + t + 0.04);
      if (hb > 0.05) ctx.body({ shape: 'box', he: [R * 0.65, hb / 2, L / 2 + t + 0.08], p: [0, -(R + t + 0.04) - hb / 2, 0], color: '#2b2d33', finish: 'satin' });
    },
  },

  pendulumWave: {
    label: 'Pendulum wave', category: 'Mechanisms', icon: '≀', movable: false,
    params: [
      { key: 'count', label: 'Pendulums', kind: 'int', min: 2, max: 40 },
      { key: 'cycles', label: 'Swings of the longest', kind: 'int', min: 1, max: 60, help: 'Per loop; each next pendulum makes one more, so they all line up again at the seam' },
      { key: 'amplitude', label: 'Amplitude (°)', kind: 'number', min: 1, max: 60, step: 0.5 },
      { key: 'spacing', label: 'Spacing', kind: 'number', min: 0.02, max: 1, step: 0.005 },
      { key: 'bob', label: 'Bob radius', kind: 'number', min: 0.01, max: 0.5, step: 0.005 },
    ],
    defaults: { count: 15, cycles: 10, amplitude: 24, spacing: 0.1, bob: 0.038 },
    look: { colorMode: 'gradient', color: '', finish: 'gloss' },
    phys: { body: 'static' },
    build(ctx, p) {
      // Pendulum n swings (cycles + n) times per loop. Its length is the one
      // that real gravity gives that period, so the pattern - waves, two
      // interleaved rows, three... - is the true one, and it closes exactly.
      const n = Math.max(2, Math.round(p.count));
      const span = (n - 1) * p.spacing;
      for (let k = 0; k < n; k++) {
        const c = Math.max(1, Math.round(p.cycles)) + k;
        const T = ctx.duration / c;
        const len = (ctx.gravity * T * T) / (4 * Math.PI * Math.PI);
        const x = -span / 2 + k * p.spacing;
        const swing = { kind: 'swing' as const, axis: [1, 0, 0] as Vec3, cycles: c, amplitude: p.amplitude, phase: 0.25, pivot: [x, 0, 0] as Vec3 };
        ctx.body({ shape: 'box', he: [0.004, len / 2, 0.004], p: [x, -len / 2, 0], color: '#cfd3da', finish: 'metal', kind: 'kinematic', motion: swing });
        ctx.body({ shape: 'sphere', he: [p.bob, p.bob, p.bob], p: [x, -len - p.bob * 0.6, 0], idx: k, t: k / (n - 1), kind: 'kinematic', motion: swing });
      }
      // beam and posts
      const h = ctx.e.position[1];
      ctx.body({ shape: 'box', he: [span / 2 + 0.12, 0.025, 0.035], p: [0, 0.025, 0], color: '#2b2d33', finish: 'metal' });
      for (const sx of [-1, 1]) ctx.body({ shape: 'box', he: [0.025, (h + 0.05) / 2, 0.025], p: [sx * (span / 2 + 0.1), -h / 2 + 0.025, 0], color: '#2b2d33', finish: 'metal' });
      ctx.body({ shape: 'box', he: [span / 2 + 0.2, 0.015, 0.22], p: [0, -h + 0.015, 0], color: '@statics', finish: 'satin' });
    },
  },

  container: {
    label: 'Container', category: 'Scenery', icon: '⊔', movable: true,
    params: [
      { key: 'size', label: 'Inner size', kind: 'vec3', min: 0.1, max: 60, step: 0.01 },
      { key: 'thickness', label: 'Wall thickness', kind: 'number', min: 0.01, max: 2, step: 0.01 },
      { key: 'floor', label: 'Floor', kind: 'bool' },
      { key: 'lid', label: 'Lid', kind: 'bool' },
    ],
    defaults: { size: [3, 1.5, 3], thickness: 0.08, floor: true, lid: false },
    look: { colorMode: 'single', color: '', finish: 'glass' },
    phys: { body: 'static' },
    build(ctx, p) {
      const [w, h, d] = p.size as Vec3, t = p.thickness;
      const y0 = p.floor ? t : 0;
      if (p.floor) ctx.body({ shape: 'box', he: [w / 2 + t, t / 2, d / 2 + t], p: [0, t / 2, 0] });
      if (p.lid) ctx.body({ shape: 'box', he: [w / 2 + t, t / 2, d / 2 + t], p: [0, y0 + h + t / 2, 0] });
      ctx.body({ shape: 'box', he: [t / 2, h / 2, d / 2 + t], p: [-w / 2 - t / 2, y0 + h / 2, 0] });
      ctx.body({ shape: 'box', he: [t / 2, h / 2, d / 2 + t], p: [w / 2 + t / 2, y0 + h / 2, 0] });
      ctx.body({ shape: 'box', he: [w / 2, h / 2, t / 2], p: [0, y0 + h / 2, -d / 2 - t / 2] });
      ctx.body({ shape: 'box', he: [w / 2, h / 2, t / 2], p: [0, y0 + h / 2, d / 2 + t / 2] });
    },
  },

  funnel: {
    label: 'Funnel', category: 'Scenery', icon: '⏷', movable: true,
    params: [
      { key: 'segments', label: 'Segments', kind: 'int', min: 4, max: 48 },
      { key: 'top', label: 'Top radius', kind: 'number', min: 0.1, max: 20, step: 0.01 },
      { key: 'bottom', label: 'Bottom radius', kind: 'number', min: 0.05, max: 20, step: 0.01 },
      { key: 'height', label: 'Height', kind: 'number', min: 0.1, max: 20, step: 0.01 },
      { key: 'thickness', label: 'Thickness', kind: 'number', min: 0.01, max: 1, step: 0.01 },
    ],
    defaults: { segments: 16, top: 2.2, bottom: 0.45, height: 1.6, thickness: 0.06 },
    look: { colorMode: 'single', color: '', finish: 'glass' },
    phys: { body: 'static' },
    build(ctx, p) {
      // One ring of full-height planks has to be cut for the WIDEST
      // circumference, so by the time it reaches the throat each plank laps
      // over half a dozen neighbours. On glass every lap is another Fresnel
      // layer, which drew the dark wedges fanning out across the cone. Short
      // rings, each cut for its own radius, keep the overlap small and even.
      const n = p.segments, t = p.thickness;
      const slope = Math.atan2(p.top - p.bottom, p.height);
      const slant = Math.hypot(p.top - p.bottom, p.height);
      const rMax = Math.max(p.top, p.bottom), rMin = Math.max(Math.min(p.top, p.bottom), 1e-3);
      const arc = 2 * Math.PI * rMax / n;
      // enough rings that no single one spans more than ~1.6x in radius, and
      // that planks stay roughly as tall as they are wide
      const rows = Math.max(1, Math.min(8, Math.max(
        Math.round(slant / Math.max(arc, 1e-3)),
        Math.ceil(Math.log(rMax / rMin) / Math.log(1.6)),
      )));
      const halfL = slant / rows / 2 * 1.3; // rings overlap along the slope too
      for (let j = 0; j < rows; j++) {
        const u = (j + 0.5) / rows;
        const R = p.bottom + (p.top - p.bottom) * u;
        // cut for the ring's WIDEST edge, so the lap stays thin there and only
        // grows mildly toward the narrow edge - the seams read as a facet line
        // rather than as a bright wedge
        const rWide = p.bottom + (p.top - p.bottom) * Math.max(u, (j + 1) / rows);
        const halfW = Math.PI * rWide / n * 1.12;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          let q = qAxis([0, 0, 1], -slope);
          q = qMul(qAxis([0, 1, 0], -a), q);
          ctx.body({ shape: 'box', he: [t / 2, halfL, halfW], p: [Math.cos(a) * (R + t / 2), p.height * u, Math.sin(a) * (R + t / 2)], q });
        }
      }
    },
  },

  galton: {
    label: 'Galton board', category: 'Scenery', icon: '⋮', movable: false,
    params: [
      { key: 'rows', label: 'Pin rows', kind: 'int', min: 4, max: 40 },
      { key: 'spacing', label: 'Pin spacing', kind: 'number', min: 0.08, max: 1, step: 0.005 },
      { key: 'pegRadius', label: 'Pin radius', kind: 'number', min: 0.005, max: 0.2, step: 0.001 },
      { key: 'beadRadius', label: 'Bead radius', kind: 'number', min: 0.01, max: 0.2, step: 0.001 },
      { key: 'beads', label: 'Beads', kind: 'int', min: 0, max: 6000, help: 'Beads in the hopper at the start' },
      { key: 'binHeight', label: 'Bin height', kind: 'number', min: 0.1, max: 10, step: 0.01 },
      { key: 'funnelGap', label: 'Hopper opening', kind: 'number', min: 0.05, max: 3, step: 0.01 },
      { key: 'gateOpen', label: 'Gate opens (s)', kind: 'number', min: 0, max: 60, step: 0.05 },
      { key: 'gateClose', label: 'Gate closes (s)', kind: 'number', min: 0, max: 60, step: 0.05 },
    ],
    defaults: { rows: 16, spacing: 0.14, pegRadius: 0.018, beadRadius: 0.025, beads: 520, binHeight: 1.3, funnelGap: 0.5, gateOpen: 0.2, gateClose: 9.2 },
    look: { colorMode: 'gradient', color: '', finish: 'gloss' },
    phys: { body: 'static', friction: 0.1 },
    build(ctx, p) {
      galtonBuild(ctx, p);
    },
  },

  stairs: {
    label: 'Stairs', category: 'Scenery', icon: '⌸', movable: true,
    params: [
      { key: 'steps', label: 'Steps', kind: 'int', min: 1, max: 80 },
      { key: 'step', label: 'Step (w,h,d)', kind: 'vec3', min: 0.02, max: 10, step: 0.01 },
      { key: 'solid', label: 'Solid', kind: 'bool' },
    ],
    defaults: { steps: 8, step: [2, 0.25, 0.4], solid: true },
    look: { colorMode: 'gradient', finish: 'satin' },
    phys: { body: 'static' },
    build(ctx, p) {
      const [w, h, d] = p.step as Vec3;
      for (let i = 0; i < p.steps; i++) {
        const height = p.solid ? (p.steps - i) * h : h;
        const y = p.solid ? height / 2 : (p.steps - i - 0.5) * h;
        ctx.body({ shape: 'box', he: [w / 2, height / 2, d / 2], p: [0, y, i * d], idx: i, t: i / Math.max(1, p.steps - 1) });
      }
    },
  },

  pegboard: {
    label: 'Peg field', category: 'Scenery', icon: '⁘', movable: true,
    params: [
      { key: 'counts', label: 'Pegs (x, -, z)', kind: 'vec3', min: 1, max: 60, step: 1 },
      { key: 'spacing', label: 'Spacing', kind: 'number', min: 0.05, max: 4, step: 0.01 },
      { key: 'radius', label: 'Peg radius', kind: 'number', min: 0.01, max: 1, step: 0.005 },
      { key: 'shape', label: 'Shape', kind: 'select', options: ['sphere', 'box'] },
    ],
    defaults: { counts: [9, 1, 9], spacing: 0.45, radius: 0.08, shape: 'sphere' },
    look: { colorMode: 'single', color: '#e9e9ef', finish: 'chrome' },
    phys: { body: 'static' },
    build(ctx, p) {
      const nx = Math.round(p.counts[0]), nz = Math.round(p.counts[2]);
      for (let x = 0; x < nx; x++) for (let z = 0; z < nz; z++) {
        const off = (z % 2) * 0.5;
        const pos: Vec3 = [(x + off - (nx - 1) / 2) * p.spacing, 0, (z - (nz - 1) / 2) * p.spacing * 0.87];
        if (p.shape === 'box') ctx.body({ shape: 'box', he: [p.radius, p.radius, p.radius], p: pos, q: qAxis([1, 0, 1], Math.PI / 4) });
        else ctx.body({ shape: 'sphere', he: [p.radius, p.radius, p.radius], p: pos });
      }
    },
  },

  fluidBlock: {
    label: 'Water block', category: 'Liquids', icon: '▤', movable: false,
    params: [
      { key: 'size', label: 'Size', kind: 'vec3', min: 0.05, max: 20, step: 0.01, help: 'Box of liquid; the position is its base centre' },
    ],
    defaults: { size: [1, 0.8, 1] },
    build() { /* particles come from src/fluid/fluidBuild.ts */ },
  },

  fluidSource: {
    label: 'Water source', category: 'Liquids', icon: '⛲', movable: false,
    params: [
      { key: 'radius', label: 'Nozzle radius', kind: 'number', min: 0.02, max: 2, step: 0.005 },
      { key: 'speed', label: 'Speed (m/s)', kind: 'number', min: 0, max: 20, step: 0.05 },
      { key: 'start', label: 'Start (s)', kind: 'number', min: 0, max: 60, step: 0.05 },
      { key: 'end', label: 'End (s)', kind: 'number', min: 0, max: 60, step: 0.05 },
    ],
    defaults: { radius: 0.12, speed: 2.5, start: 0.2, end: 4 },
    build() { /* particles come from src/fluid/fluidBuild.ts */ },
  },

  emitter: {
    label: 'Emitter', category: 'Sources', icon: '⇣', movable: false,
    params: [
      { key: 'shape', label: 'Shape', kind: 'select', options: ['box', 'sphere', 'mixed'] },
      { key: 'rate', label: 'Rate (/s)', kind: 'number', min: 0.1, max: 2000, step: 0.1 },
      { key: 'start', label: 'Start (s)', kind: 'number', min: 0, max: 60, step: 0.05 },
      { key: 'end', label: 'End (s)', kind: 'number', min: 0, max: 60, step: 0.05 },
      { key: 'sizeMin', label: 'Size min', kind: 'number', min: 0.02, max: 4, step: 0.005 },
      { key: 'sizeMax', label: 'Size max', kind: 'number', min: 0.02, max: 4, step: 0.005 },
      { key: 'elongation', label: 'Box elongation', kind: 'number', min: 1, max: 6, step: 0.05 },
      { key: 'area', label: 'Area radius', kind: 'number', min: 0, max: 20, step: 0.01 },
      { key: 'areaShape', label: 'Area shape', kind: 'select', options: ['disk', 'square', 'line'] },
      { key: 'speed', label: 'Speed', kind: 'number', min: 0, max: 60, step: 0.1 },
      { key: 'spread', label: 'Spread (deg)', kind: 'number', min: 0, max: 90, step: 0.5 },
      { key: 'tumble', label: 'Tumble', kind: 'number', min: 0, max: 30, step: 0.1 },
      { key: 'maxCount', label: 'Max bodies', kind: 'int', min: 1, max: 30000 },
    ],
    defaults: { shape: 'box', rate: 40, start: 0.2, end: 6, sizeMin: 0.18, sizeMax: 0.3, elongation: 1, area: 0.6, areaShape: 'disk', speed: 2, spread: 8, tumble: 3, maxCount: 2000 },
    look: { colorMode: 'cycle' },
    build(ctx, p) {
      emitterBuild(ctx, p);
    },
  },
  ...GADGET_DEFS,
};

// ---------------------------------------------------------------------------

function glueGrid(ctx: BuildCtx, rows: number[][], force: number, _rowH: number): void {
  // Glue neighbours using the pivot halfway between centres (computed by the
  // builder from initial poses). Horizontal neighbours and vertical overlaps.
  const pos = ctx.posOf, heOf = ctx.heOf;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const sorted = [...row].sort((a, b) => pos(a)[0] - pos(b)[0]);
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = pos(sorted[i]), b = pos(sorted[i + 1]);
      ctx.joint({ type: 'fixed', a: sorted[i], b: sorted[i + 1], pivot: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], fracture: force, collide: true });
    }
    if (r === 0) continue;
    for (const top of row) {
      const pt = pos(top), ht = heOf(top);
      for (const bot of rows[r - 1]) {
        const pb = pos(bot), hb = heOf(bot);
        const overlap = Math.min(pt[0] + ht[0], pb[0] + hb[0]) - Math.max(pt[0] - ht[0], pb[0] - hb[0]);
        if (overlap > 0.25 * Math.min(ht[0], hb[0])) {
          const cx = (Math.min(pt[0] + ht[0], pb[0] + hb[0]) + Math.max(pt[0] - ht[0], pb[0] - hb[0])) / 2;
          ctx.joint({ type: 'fixed', a: bot, b: top, pivot: [cx, (pt[1] + pb[1]) / 2, pt[2]], fracture: force, collide: true });
        }
      }
    }
  }
}

function dominoPath(path: string, count: number, step: number, radius: number, turns: number, height: number): { x: number; z: number; yaw: number }[] {
  // Sample a dense polyline then walk it at constant arc length.
  const N = Math.max(2000, count * 20);
  let pts: [number, number][] = [];
  const total = count * step;
  if (path === 'spiral') {
    // Archimedean spiral, arms spaced wider than a domino so arms never touch;
    // grown from the centre until long enough, then walked from the outside in.
    const pitch = Math.max(height * 1.25, step * 1.5);
    const b = pitch / (2 * Math.PI);
    let theta = 0, len = 0;
    const r0 = Math.max(radius, height);
    pts.push([r0, 0]);
    while (len < total * 1.02 + step) {
      const r = r0 + b * theta;
      const dTheta = Math.min(0.05, (step * 0.1) / r);
      theta += dTheta;
      const rn = r0 + b * theta;
      const p: [number, number] = [Math.cos(theta) * rn, Math.sin(theta) * rn];
      const q = pts[pts.length - 1];
      len += Math.hypot(p[0] - q[0], p[1] - q[1]);
      pts.push(p);
    }
    pts.reverse();
    void turns;
  }
  for (let i = 0; i <= N && path !== 'spiral'; i++) {
    const u = i / N;
    let x = 0, z = 0;
    switch (path) {
      case 'line': x = (u - 0.5) * total; break;
      case 'circle': {
        const R = Math.max(radius, total / (2 * Math.PI) * 1.02);
        const a = u * Math.PI * 2 * 0.985; x = Math.cos(a) * R; z = Math.sin(a) * R; break;
      }
      case 'arc': { const a = (u - 0.5) * Math.PI; x = Math.sin(a) * radius * 3; z = -Math.cos(a) * radius * 3 + radius * 3; break; }
      case 'wave': x = (u - 0.5) * total; z = Math.sin(u * Math.PI * 2 * turns) * radius; break;
      case 'zigzag': { x = (u - 0.5) * total; const w = (u * turns * 2) % 2; z = (w < 1 ? w : 2 - w) * radius * 2 - radius; break; }
      default: x = (u - 0.5) * total; break;
    }
    pts.push([x, z]);
  }
  const out: { x: number; z: number; yaw: number }[] = [];
  let acc = 0, target = 0, k = 0;
  for (let i = 1; i < pts.length && k < count; i++) {
    const dx = pts[i][0] - pts[i - 1][0], dz = pts[i][1] - pts[i - 1][1];
    const seg = Math.hypot(dx, dz);
    while (acc + seg >= target && k < count) {
      const f = seg > 0 ? (target - acc) / seg : 0;
      const x = pts[i - 1][0] + dx * f, z = pts[i - 1][1] + dz * f;
      out.push({ x, z, yaw: Math.atan2(-dz, dx) });
      target += step; k++;
    }
    acc += seg;
  }
  return out;
}

function emitterBuild(ctx: BuildCtx, p: Record<string, any>): void {
  const fps = ctx.fps;
  const start = Math.max(0, p.start), end = Math.max(start, p.end);
  const total = Math.min(p.maxCount, Math.floor((end - start) * p.rate));
  if (total <= 0) return;
  const sizeMax = Math.max(p.sizeMin, p.sizeMax);
  const speed = Math.max(p.speed, 0);
  const cell = sizeMax * Math.max(1, p.elongation) * 1.15;
  // Batches are spaced so a batch clears the spawn zone (one cell) before the
  // next one appears; gravity along the emission direction helps clearing.
  const down = new THREE.Vector3(0, -1, 0).applyQuaternion(new THREE.Quaternion(...ctx.worldQuat));
  const g = Math.max(0, -down.y) * ctx.gravity;
  const clearTime = g > 1e-3 ? (-speed + Math.sqrt(speed * speed + 2 * g * cell)) / g : cell / Math.max(speed, 0.05);
  const batchFrames = Math.max(1, Math.ceil(clearTime * fps * 1.05));
  const slots: [number, number][] = [];
  const R = Math.max(p.area, cell * 0.01);
  const n = Math.max(1, Math.ceil(R / cell));
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const x = i * cell, z = j * cell;
    const inside = p.areaShape === 'square' ? true : p.areaShape === 'line' ? j === 0 : x * x + z * z <= R * R + 1e-9;
    if (inside) slots.push([x, z]);
  }
  if (slots.length === 0) slots.push([0, 0]);
  const perBatchMax = slots.length;
  let emitted = 0;
  let carry = 0;
  for (let f = Math.round(start * fps); f <= Math.round(end * fps) && emitted < total; f += batchFrames) {
    carry += p.rate * batchFrames / fps;
    let k = Math.min(perBatchMax, Math.floor(carry), total - emitted);
    carry -= k;
    if (k <= 0) continue;
    // shuffle slots
    const order = slots.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(ctx.rng.next() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (let s = 0; s < k; s++) {
      const [sx, sz] = slots[order[s]];
      const jit = p.areaShape === 'line' ? 0 : cell * 0.12;
      const size = ctx.rng.range(p.sizeMin, sizeMax);
      const sphere = p.shape === 'sphere' || (p.shape === 'mixed' && ctx.rng.next() < 0.5);
      const spread = p.spread * DEG * Math.sqrt(ctx.rng.next());
      const az = ctx.rng.next() * Math.PI * 2;
      const dir: Vec3 = [Math.sin(spread) * Math.cos(az), -Math.cos(spread), Math.sin(spread) * Math.sin(az)];
      const v = speed * ctx.rng.range(0.9, 1.1);
      const tum = p.tumble;
      const q = randomQuat(ctx.rng);
      const tNorm = emitted / Math.max(1, total - 1);
      const elong = sphere ? 1 : ctx.rng.range(1, p.elongation);
      ctx.body({
        shape: sphere ? 'sphere' : 'box',
        he: sphere ? [size / 2, size / 2, size / 2] : [size / 2 * elong, size / 2, size / 2],
        p: [sx + ctx.rng.range(-jit, jit), 0, sz + ctx.rng.range(-jit, jit)],
        q: sphere ? undefined : q,
        vel: [dir[0] * v, dir[1] * v, dir[2] * v],
        angVel: [ctx.rng.range(-tum, tum), ctx.rng.range(-tum, tum), ctx.rng.range(-tum, tum)],
        spawnAt: f / fps,
        idx: emitted, t: tNorm,
      });
      emitted++;
    }
  }
}

// Galton board: a single-layer channel (depth just above one bead), diamond
// pins spanning the full depth, bins aligned under the last pin row, and a
// hopper closed by a sliding kinematic gate. Beads start in the hopper.
function galtonBuild(ctx: BuildCtx, p: Record<string, any>): void {
  const s = p.spacing, rows = Math.max(1, Math.round(p.rows));
  const pr = Math.min(p.pegRadius, s * 0.4);
  const br = p.beadRadius;
  const depth = br * 1.08 * 2 * 1.12;
  const base = 0.08;
  const K = Math.ceil(rows / 2) + 1; // bins at k*s, |k| <= K
  const halfW = (K + 0.5) * s;
  const wood = '#2a2b31';
  const glassT = 0.02, wallT = 0.05;
  // pins grip (tangential speed is dissipated on every bounce), the hopper is
  // slippery so it drains
  const pinFriction = p.pinFriction ?? 0.3, slick = 0.02;

  // base plate (beads land on it)
  ctx.body({ shape: 'box', he: [halfW + wallT, base / 2, depth / 2 + glassT * 2], p: [0, base / 2, 0], color: wood, finish: 'satin' });
  const y0 = base;
  // bin dividers (the outer two are the side walls)
  for (let k = -K; k < K; k++) {
    const x = (k + 0.5) * s;
    ctx.body({ shape: 'box', he: [0.008, p.binHeight / 2, depth / 2], p: [x, y0 + p.binHeight / 2, 0], color: '#e6e8ee', finish: 'satin', friction: 1.0 });
  }
  // pins: last row offset by half a spacing so its pins sit on the dividers
  const pitch = s * 0.866;
  const yLast = y0 + p.binHeight + pr + 0.004;
  for (let r = 0; r < rows; r++) {
    const y = yLast + (rows - 1 - r) * pitch;
    const half = (rows - 1 - r) % 2 === 0;
    const kMin = half ? -K : -(K - 1), kMax = half ? K - 1 : K - 1;
    for (let k = kMin; k <= kMax; k++) {
      const x = (k + (half ? 0.5 : 0)) * s;
      // round pins: a flat or diamond face turns the fall into sideways speed
      ctx.body({ shape: 'sphere', he: [pr, pr, pr], p: [x, y, 0], color: '#dfe3ea', finish: 'chrome', friction: pinFriction });
    }
  }
  const pegTop = yLast + (rows - 1) * pitch;

  // hopper: two boards sloping down to a central opening, closed by a gate
  const ang = 40 * DEG;
  const g = Math.max(br * 1.2, p.funnelGap / 2);
  const yF = pegTop + Math.max(s * 1.4, 0.18);
  const boardT = 0.03;
  const run = halfW - g;
  const hF = run * Math.tan(ang);
  const len = run / Math.cos(ang);
  for (const sgn of [-1, 1]) {
    // top surface of the board passes through (g, yF) and (halfW, yF + hF)
    const cx = sgn * (g + run / 2), cy = yF + hF / 2 - boardT / 2 / Math.cos(ang);
    ctx.body({ shape: 'box', he: [len / 2 + 0.01, boardT / 2, depth / 2], p: [cx, cy, 0], q: qAxis([0, 0, 1], sgn * ang), color: wood, finish: 'satin', friction: slick });
  }
  // the gate sits just under the boards so it can slide out beneath them
  const gateT = 0.024;
  const gateTop = yF - boardT / Math.cos(ang) - 0.006;
  const gateY = gateTop - gateT / 2;
  const gatePos: Vec3 = [0, gateY, 0];
  ctx.body({
    shape: 'box', he: [g + 0.04, gateT / 2, depth / 2 * 0.98], p: gatePos, color: '#e9c46a', finish: 'metal', friction: slick,
    motion: { kind: 'gate', offset: [2 * g + 0.1, 0, 0], open: p.gateOpen, close: Math.max(p.gateOpen + 0.3, p.gateClose), ease: 0.25, amplitude: 0, pivot: gatePos },
  });

  // beads: loose hexagonal packing in the hopper, lowest first. Sizes vary a
  // little and positions are jittered: a perfect monodisperse crystal forms
  // stable arches over the opening and the hopper jams.
  const bMax = br * 1.08;
  const d = bMax * 2 * 1.03;
  const tanA = Math.tan(ang), cosA = Math.cos(ang);
  const floorAt = (x: number) => (Math.abs(x) <= g ? gateTop + bMax : yF + (Math.abs(x) - g) * tanA + bMax / cosA) + 0.002;
  const N = Math.max(0, Math.round(p.beads));
  const pts: [number, number][] = [];
  let top = yF + hF;
  for (let row = 0; pts.length < N * 1.0 + 200 && row < 4000; row++) {
    const y = gateTop + bMax + 0.002 + row * d * 0.866;
    const off = row % 2 ? d / 2 : 0;
    for (let x = -halfW + bMax + 0.003 + off; x <= halfW - bMax - 0.003; x += d) {
      if (y >= floorAt(x)) pts.push([x, y]);
    }
    top = y;
  }
  pts.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const chosen = pts.slice(0, N);
  if (chosen.length) top = Math.max(yF + hF, chosen[chosen.length - 1][1] + br);
  const slack = (d - 2 * bMax) / 2;
  chosen.forEach(([x, y], i) => {
    const r = br * ctx.rng.range(0.92, 1.08);
    const jx = ctx.rng.range(-slack, slack), jy = ctx.rng.range(0, slack);
    ctx.body({ shape: 'sphere', he: [r, r, r], p: [x + jx, y + jy, 0], kind: 'dynamic', idx: i, t: i / Math.max(1, N - 1), friction: 0.4, density: 4 });
  });

  // case: side walls, solid back board, front glass
  const yTop = top + 0.25;
  const H = yTop - y0;
  for (const sgn of [-1, 1]) {
    ctx.body({ shape: 'box', he: [wallT / 2, H / 2, depth / 2 + glassT * 2], p: [sgn * (halfW + wallT / 2), y0 + H / 2, 0], color: wood, finish: 'satin' });
  }
  ctx.body({ shape: 'box', he: [halfW + wallT, wallT / 2, depth / 2 + glassT * 2], p: [0, yTop + wallT / 2, 0], color: wood, finish: 'satin' });
  ctx.body({ shape: 'box', he: [halfW, H / 2, glassT], p: [0, y0 + H / 2, -depth / 2 - glassT], color: '@statics', finish: 'satin', friction: 0.3 });
  ctx.body({ shape: 'box', he: [halfW, H / 2, glassT], p: [0, y0 + H / 2, depth / 2 + glassT], finish: 'glass', friction: 0.3 });
}

// Hourglass: two glass bulbs (rings of slanted plates) between wooden caps,
// built around the entity origin (the neck), which is also the pivot of the
// 180° flip. The shape is symmetric under that half turn, so the flipped
// hourglass at the end of the clip looks exactly like the one at the start.
function hourglassBuild(ctx: BuildCtx, p: Record<string, any>): void {
  const R = p.radius, nk = Math.min(p.neck, R * 0.9), Hh = p.height;
  const n = Math.max(8, Math.round(p.segments / 2) * 2); // even: symmetric under the flip
  const t = Math.max(0.03, R * 0.07);
  const hc = Hh * Math.min(1, Math.max(0.2, p.cone));
  const capT = Math.max(0.08, R * 0.17);
  const capHalf = R + t + Math.max(0.1, R * 0.16);
  const wood = '#3b2a20';
  const flip = { kind: 'gate' as const, axis: [0, 0, 1] as Vec3, amplitude: 180, open: p.flipAt, close: 1e6, ease: p.flipTime, offset: [0, 0, 0] as Vec3 };

  // meridian profile of the upper bulb (r, y); the lower bulb mirrors it
  const prof: [number, number][] = [];
  const coneSteps = 5;
  for (let i = 0; i <= coneSteps; i++) {
    const f = i / coneSteps;
    // eased so the bulb rounds into the cylinder
    const e = Math.sin(f * Math.PI / 2);
    prof.push([nk + (R - nk) * e, hc * f]);
  }
  prof.push([R, Hh]);
  for (const sy of [1, -1]) {
    for (let k = 0; k + 1 < prof.length; k++) {
      const [r0, y0] = prof[k], [r1, y1] = prof[k + 1];
      const dr = r1 - r0, dy = (y1 - y0) * sy;
      const len = Math.hypot(dr, dy);
      const nr = dy / len * sy, ny = -dr / len * sy; // outward normal in the meridian plane
      const rm = (r0 + r1) / 2 + nr * t / 2, ym = sy * (y0 + y1) / 2 + ny * t / 2;
      const w = 2 * (Math.max(r0, r1) + t) * Math.tan(Math.PI / n) * 1.15;
      const tilt = Math.atan2(-dr, dy);
      for (let i = 0; i < n; i++) {
        // plate centres (not seams) face ±x: mid-flip the whole pile rests there
        const a = (i / n) * Math.PI * 2;
        const q = qMul(qAxis([0, 1, 0], -a), qAxis([0, 0, 1], tilt));
        ctx.body({ shape: 'box', he: [t / 2, len / 2 + 0.002, w / 2], p: [Math.cos(a) * rm, ym, Math.sin(a) * rm], q, finish: 'glass', color: '#ffffff', kind: 'kinematic', motion: flip, friction: p.glassFriction ?? 0.4 });
      }
    }
    // cap and pillars
    ctx.body({ shape: 'box', he: [capHalf, capT / 2, capHalf], p: [0, sy * (Hh + capT / 2), 0], color: wood, finish: 'satin', kind: 'kinematic', motion: flip });
  }
  const pr = Math.max(0.025, R * 0.045);
  const P = capHalf - pr * 2.2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    ctx.body({ shape: 'box', he: [pr, Hh, pr], p: [sx * P, 0, sz * P], color: wood, finish: 'satin', kind: 'kinematic', motion: flip });
  }
  // stand: two posts holding the pivot at the neck height
  if (p.stand) {
    const h = ctx.e.position[1];
    const zPost = capHalf + 0.16;
    for (const sz of [-1, 1]) {
      ctx.body({ shape: 'box', he: [0.07, h / 2 + 0.05, 0.07], p: [0, -h / 2 + 0.05, sz * zPost], color: wood, finish: 'satin' });
      ctx.body({ shape: 'box', he: [0.05, 0.05, (zPost - capHalf) / 2 + 0.02], p: [0, 0, sz * (capHalf + (zPost - capHalf) / 2)], color: '#c9a227', finish: 'metal' });
    }
    ctx.body({ shape: 'box', he: [0.5, 0.04, zPost + 0.2], p: [0, -h + 0.04, 0], color: wood, finish: 'satin' });
  }

  // grains: jittered lattice inside the upper bulb, lowest first
  const gr = p.grainRadius;
  const d = gr * 2 * 1.06;
  const rAt = (y: number) => {
    if (y >= hc) return R;
    const f = Math.max(0, y / hc);
    return nk + (R - nk) * Math.sin(f * Math.PI / 2);
  };
  const pts: Vec3[] = [];
  for (let y = gr * 1.5; y < Hh - gr * 1.2; y += d * 0.82) {
    const rr = rAt(y) - gr * 1.6;
    if (rr <= 0) continue;
    const off = (Math.round(y / (d * 0.82)) % 2) * d / 2;
    for (let x = -rr; x <= rr; x += d) for (let z = -rr; z <= rr; z += d) {
      const xx = x + off, zz = z + off;
      if (xx * xx + zz * zz <= rr * rr) pts.push([xx, y, zz]);
    }
  }
  // fill from the bottom of whichever bulb holds the sand (mirrored below)
  pts.sort((a, b) => (p.sandBelow ? b[1] - a[1] : a[1] - b[1]));
  const N = Math.min(pts.length, Math.max(0, Math.round(p.grains)));
  for (let i = 0; i < N; i++) {
    const [x, y0, z] = pts[i];
    const y = p.sandBelow ? -y0 : y0;
    const j = (d - 2 * gr) * 0.45;
    // two grain sizes (one size alone packs into crystals that jam the neck),
    // each with its own colour: grains of a class are interchangeable, which
    // is what lets a continuous loop trade them across the seam
    const big = ctx.rng.next() < 0.5 ? 1 : 0;
    const r = gr * (big ? 1.08 : 0.92);
    ctx.body({ shape: 'sphere', he: [r, r, r], p: [x + ctx.rng.range(-j, j), y, z + ctx.rng.range(-j, j)], kind: 'dynamic', idx: big * 3, t: big ? 0.75 : 0.15, friction: 0.5, density: 3 });
  }
}

function randomQuat(rng: Rng): Q4 {
  const u1 = rng.next(), u2 = rng.next() * Math.PI * 2, u3 = rng.next() * Math.PI * 2;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
}

// ---------------------------------------------------------------------------

export function createEntity(type: EntityType, overrides: Partial<Entity> = {}): Entity {
  const def = ENTITY_DEFS[type];
  const e: Entity = {
    id: Math.random().toString(36).slice(2, 10),
    type,
    name: def.label,
    enabled: true,
    position: [0, type === 'box' ? 0.5 : type === 'sphere' ? 0.5 : 0, 0],
    rotation: [0, 0, 0],
    params: structuredClone(def.defaults),
    look: { ...defaultLook(), ...(def.look ?? {}) },
    phys: { ...defaultPhys(), ...(def.phys ?? {}) },
    motion: { ...defaultMotion(), ...(def.motion ?? {}) },
  };
  return { ...e, ...overrides, params: { ...e.params, ...(overrides.params ?? {}) }, look: { ...e.look, ...(overrides.look ?? {}) }, phys: { ...e.phys, ...(overrides.phys ?? {}) }, motion: { ...e.motion, ...(overrides.motion ?? {}) } };
}
