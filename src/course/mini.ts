// A small 2D rigid-body engine, written for the course: it is the only way to
// show what happens *inside* one time step (per-iteration positions, penalty
// stiffness and Lagrange multipliers growing, a stack converging or not).
//
// It implements, on the same scene and the same contact set, the four solvers
// the course compares:
//   'none'    integration only, nothing stops interpenetration
//   'pgs'     sequential impulses on velocities (classic Gauss-Seidel + Baumgarte)
//   'penalty' position-level block descent with a fixed stiffness (VBD)
//   'avbd'    the same, plus the Lagrange multiplier and the rising penalty
//
// Everything is deterministic and instrumented: `trace` records one entry per
// iteration so a diagram can scrub through the solve.

export type Shape = 'box' | 'circle';
export type Solver = 'none' | 'pgs' | 'penalty' | 'avbd';

export interface Body {
  shape: Shape;
  /** half extents (box) — for a circle, hw = hh = radius */
  hw: number;
  hh: number;
  x: number;
  y: number;
  a: number; // angle (rad)
  vx: number;
  vy: number;
  w: number; // angular velocity
  m: number; // 0 => static
  I: number;
  invM: number;
  invI: number;
  friction: number;
  restitution: number;
  colour?: number; // palette index, for drawing
  tag?: string;
  /** set by the solver each substep: inertial prediction */
  px: number;
  py: number;
  pa: number;
  /** position at the start of the substep (velocity update) */
  ox: number;
  oy: number;
  oa: number;
  asleep?: boolean;
}

export interface Contact {
  a: number; // body index
  b: number; // body index (may be static)
  /** anchors in each body's local frame */
  rax: number; ray: number;
  rbx: number; rby: number;
  /** world normal, pointing from b towards a */
  nx: number; ny: number;
  /**
   * Circle side: its lever arm must stay world-fixed along ±n·r. Rotating it
   * with the body makes a fast-rolling circle report false separation and sink
   * through the floor — the same bug the GPU engine had with spheres.
   */
  sa: boolean; sb: boolean;
  /** current signed separation (negative = penetrating) */
  C: number;
  /** separation when the substep started, for the α stabilisation */
  c0: number;
  /**
   * The two anchors are the same material point for a box/box contact, so the
   * raw anchor difference is 0 at generation time: this offset carries the
   * separation measured by collision detection, and the constraint then tracks
   * how the two rigid motions pull that point apart.
   */
  bias: number;
  /** penalty stiffness (kept across substeps) and multiplier (rebuilt each substep) */
  k: number;
  /** ceiling of k for this contact: kCap × M/h² of its heavier body */
  kMax: number;
  lam: number;
  kt: number;
  /** PGS impulse accumulators */
  jn: number;
  jt: number;
  /** id used to match the contact with the previous step */
  id: string;
  fresh: boolean;
}

export interface Params {
  solver: Solver;
  gravity: number;
  h: number; // frame step (s)
  substeps: number;
  iterations: number;
  /**
   * AVBD penalty ramp, as in the paper and the GPU engine: after each sweep, a
   * contact that still pushes gains k += β·|C| (N/m per metre of violation).
   * The stiffness therefore only grows where, and as long as, it is needed.
   * An earlier version multiplied k by β up to a fixed ceiling: it pumped
   * energy into mixed scenes and threw heavy bodies off light ones.
   */
  beta: number;
  /** AVBD: starting stiffness of a new contact (N/m) */
  kMin: number;
  /**
   * AVBD: stiffness ceiling, in multiples of M/h² of the heavier body of the
   * contact. Relative, not absolute: a 1 000 kg block needs a thousand times
   * the stiffness of a 1 kg one to be held, while above ≈ 10–30 × M/h² the
   * block descent stops converging (a stack at one substep explodes).
   */
  kCap: number;
  /** AVBD: warm-start decay of the stiffness k between substeps */
  gamma: number;
  /**
   * AVBD stabilisation, as in the paper and the GPU engine: the solver drives
   * C̃ = C − α·min(0, C₀) to zero, C₀ being the separation when the substep
   * starts, so only a fraction 1 − α of an existing overlap is removed per
   * substep. Off (0) by default here: with these stiffnesses the overlap left
   * by a substep is tiny, while forgiving 95 % of it each substep lets the
   * residual of every solve pile up — a landed box slowly sinks.
   */
  alpha: number;
  /** penalty solver: fixed stiffness */
  k: number;
  /** PGS: Baumgarte position bias (fraction of penetration per step) */
  bias: number;
  /** PGS: allowed penetration before the bias kicks in */
  slop: number;
  /** AVBD: dead band — the multiplier is left alone once |C| is below it (m) */
  tol: number;
  /**
   * Contacts are generated this far before they touch (speculative contacts).
   * They stay inactive while separated, but they are warm-started, so the
   * first frame of a real impact is not met with a brand-new soft contact.
   */
  margin: number;
  /** safety clamp on one block solve's displacement (m / rad) */
  maxMove: number;
  /** AVBD: run the dual update after every sweep (true) or once per substep */
  dualEvery: boolean;
  friction: number;
  restitution: number;
  drag: number;
}

export function defaultParams(p: Partial<Params> = {}): Params {
  return {
    solver: 'avbd', gravity: 9.81, h: 1 / 60, substeps: 4, iterations: 8,
    beta: 1e6, kMin: 1e3, kCap: 3, gamma: 0.99, alpha: 0, k: 2e4,
    bias: 0.2, slop: 0.005, tol: 1e-6, margin: 0.05, maxMove: 0.25, dualEvery: true, friction: 0.5, restitution: 0, drag: 0, ...p,
  };
}

/** One recorded iteration: enough to draw the solve in slow motion. */
export interface TraceStep {
  substep: number;
  iter: number; // -1 = inertial prediction, iterations then dual update
  phase: 'predict' | 'iterate' | 'dual' | 'velocity';
  /** body poses after this step */
  pose: Float64Array; // [x, y, a] * nBodies
  /** worst penetration (metres, positive number) */
  pen: number;
  /** per-contact state */
  contacts: { nx: number; ny: number; px: number; py: number; C: number; k: number; lam: number }[];
  /** total residual |H dx + g| of the last block solve, a convergence proxy */
  residual: number;
}

export interface MiniOpts {
  bounds?: { x0: number; x1: number; y0: number }; // walls + floor
  seed?: number;
}

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

/**
 * Friction keeps its own small, per-substep penalty: it restarts at `start`
 * every substep and grows by `growth` per sweep, up to `max`. It is clamped to
 * the Coulomb cone anyway, so it only needs to be stiff enough to stick.
 */
const FRICTION_K = { start: 1e4, growth: 5, max: 1e5 };

export function makeBox(x: number, y: number, hw: number, hh: number, opts: Partial<Body> = {}): Body {
  const m = opts.m ?? 1;
  // rectangle about its centre
  const I = m > 0 ? (m * (4 * hw * hw + 4 * hh * hh)) / 12 : 0;
  return finish({ shape: 'box', hw, hh, x, y, a: 0, m, I, ...opts });
}

export function makeCircle(x: number, y: number, r: number, opts: Partial<Body> = {}): Body {
  const m = opts.m ?? 1;
  const I = m > 0 ? 0.5 * m * r * r : 0;
  return finish({ shape: 'circle', hw: r, hh: r, x, y, a: 0, m, I, ...opts });
}

function finish(b: Partial<Body>): Body {
  const m = b.m ?? 1;
  const I = b.I ?? 1;
  return {
    shape: 'box', hw: 0.5, hh: 0.5, x: 0, y: 0, a: 0, vx: 0, vy: 0, w: 0,
    m, I, invM: m > 0 ? 1 / m : 0, invI: m > 0 && I > 0 ? 1 / I : 0,
    friction: 0.5, restitution: 0, px: 0, py: 0, pa: 0, ox: 0, oy: 0, oa: 0,
    ...b,
  } as Body;
}

// ---------------------------------------------------------------- the world

export class Mini {
  bodies: Body[] = [];
  contacts: Contact[] = [];
  params: Params;
  bounds: { x0: number; x1: number; y0: number };
  /** iteration trace of the last step (only when `record` is on) */
  trace: TraceStep[] = [];
  record = false;
  /** frames simulated so far */
  frame = 0;
  /** diagnostics of the last frame */
  stats = { pen: 0, contacts: 0, energy: 0, residual: 0 };
  private initial: Body[] = [];

  constructor(params: Partial<Params> = {}, opts: MiniOpts = {}) {
    this.params = defaultParams(params);
    this.bounds = opts.bounds ?? { x0: -3, x1: 3, y0: 0 };
  }

  add(b: Body): number {
    this.bodies.push(b);
    return this.bodies.length - 1;
  }

  /** Remembers the current poses as frame 0 (used by `reset`). */
  commitInitial(): void {
    this.initial = this.bodies.map((b) => ({ ...b }));
  }

  reset(): void {
    if (this.initial.length !== this.bodies.length) this.commitInitial();
    this.bodies = this.initial.map((b) => ({ ...b }));
    this.contacts = [];
    this.trace = [];
    this.frame = 0;
  }

  // -------------------------------------------------------------- collision

  /** Rebuilds the contact set, warm-starting k and λ from the previous one. */
  collide(): void {
    const prev = new Map<string, Contact>();
    for (const c of this.contacts) prev.set(c.id, c);
    const out: Contact[] = [];
    const push = (c: Omit<Contact, 'k' | 'lam' | 'kt' | 'jn' | 'jt' | 'fresh' | 'bias' | 'c0' | 'kMax'>) => {
      const old = prev.get(c.id);
      const P = this.params;
      const full = { ...c, bias: 0 } as Contact;
      const h = P.h / Math.max(1, P.substeps);
      const heavier = Math.max(this.bodies[c.a].m, c.b >= 0 ? this.bodies[c.b].m : 0);
      const kMax = Math.max(P.kMin, (P.kCap * heavier) / (h * h));
      full.bias = c.C - rawSeparation(this, full);
      out.push({
        ...full,
        c0: c.C,
        // Warm start: the stiffness carries over, decayed by γ, and λ is
        // rebuilt within each substep. The paper (and the GPU engine) also
        // carry λ, scaled by α·γ; here that was measurably worse — a stale λ
        // on top of a stiffness already sized for the load overshoots, and
        // heavy bodies resting on light ones were thrown up.
        k: old ? clamp(old.k * P.gamma, P.kMin, kMax) : P.kMin,
        lam: 0,
        kMax,
        kt: FRICTION_K.start,
        jn: old ? old.jn : 0,
        jt: old ? old.jt : 0,
        fresh: !old,
      });
    };
    const B = this.bodies;
    const P = this.params;
    // walls and floor are modelled as half-spaces, not bodies: the static body
    // index is -1 - wallIndex so the solver can skip its dof block
    for (let i = 0; i < B.length; i++) {
      if (B[i].m === 0) continue;
      for (const w of WALLS) {
        const nx = w.nx, ny = w.ny;
        const d = w.axis === 'y' ? this.bounds.y0 : (w.sign > 0 ? this.bounds.x0 : this.bounds.x1);
        collideHalfSpace(B[i], i, nx, ny, d, w.key, push, P.margin);
      }
      for (let j = i + 1; j < B.length; j++) {
        if (B[j].m === 0) continue;
        collidePair(B[i], i, B[j], j, push, P.margin);
      }
      // dynamic vs static body
      for (let j = 0; j < B.length; j++) {
        if (B[j].m !== 0) continue;
        collidePair(B[i], i, B[j], j, push, P.margin);
      }
    }
    this.contacts = out;
  }

  // ------------------------------------------------------------------ step

  step(): void {
    const P = this.params;
    this.trace = [];
    const h = P.h / Math.max(1, P.substeps);
    for (let s = 0; s < P.substeps; s++) {
      this.collide();
      this.predict(h);
      if (this.record) this.snap(s, -1, 'predict', 0);
      if (P.solver === 'pgs') this.solvePGS(h, s);
      else if (P.solver !== 'none') this.solveBlock(h, s);
      this.finishVelocities(h);
      if (this.record) this.snap(s, P.iterations, 'velocity', 0);
    }
    this.frame++;
    this.updateStats();
  }

  /** Inertial prediction: where each body would go with no constraint at all. */
  private predict(h: number): void {
    const P = this.params;
    const g = -P.gravity;
    for (const b of this.bodies) {
      b.ox = b.x; b.oy = b.y; b.oa = b.a;
      if (b.m === 0) { b.px = b.x; b.py = b.y; b.pa = b.a; continue; }
      const ay = g;
      const ax = 0;
      b.px = b.x + h * b.vx + h * h * ax;
      b.py = b.y + h * b.vy + h * h * ay;
      b.pa = b.a + h * b.w;
      // the solve starts from the prediction
      b.x = b.px; b.y = b.py; b.a = b.pa;
    }
    // separations are measured on the predicted poses
    this.refreshC();
  }

  private refreshC(): void {
    for (const c of this.contacts) c.C = separation(this, c);
  }

  /**
   * Position-level block descent (VBD / AVBD). Each body solves its own 3x3
   * system from the constraints that touch it, in sequence (Gauss-Seidel).
   */
  private solveBlock(h: number, substep: number): void {
    const P = this.params;
    const avbd = P.solver === 'avbd';
    const ih2 = 1 / (h * h);
    for (let it = 0; it < P.iterations; it++) {
      let res = 0;
      for (let i = 0; i < this.bodies.length; i++) {
        const b = this.bodies[i];
        if (b.m === 0) continue;
        // H = M/h² + Σ k JᵀJ,  g = M/h² (x − x̃) + Σ (k C + λ) J
        let gx = b.m * ih2 * (b.x - b.px);
        let gy = b.m * ih2 * (b.y - b.py);
        let ga = b.I * ih2 * angleDelta(b.a, b.pa);
        // symmetric 3x3, stored as 6 values
        let h00 = b.m * ih2, h11 = b.m * ih2, h22 = b.I * ih2;
        let h01 = 0, h02 = 0, h12 = 0;
        for (const c of this.contacts) {
          const sgn = c.a === i ? 1 : c.b === i ? -1 : 0;
          if (sgn === 0) continue;
          c.C = separation(this, c);
          const C = avbd ? stabilised(c, P.alpha) : c.C;
          const k = avbd ? c.k : P.k;
          const lam = avbd ? c.lam : 0;
          // one-sided: a separating contact with no stored multiplier is inactive
          const force = k * C + lam;
          const active = C < 0 || force < 0;
          const [jx, jy, ja] = jacobian(this, c, i, sgn);
          if (active) {
            gx += force * jx; gy += force * jy; ga += force * ja;
            h00 += k * jx * jx; h11 += k * jy * jy; h22 += k * ja * ja;
            h01 += k * jx * jy; h02 += k * jx * ja; h12 += k * jy * ja;
          }
          // friction: tangential constraint, clamped to the Coulomb cone
          const mu = P.friction * (c.a === i ? 1 : 1);
          if (mu > 0 && (C < 0 || active)) {
            const tx = -c.ny, ty = c.nx;
            const Ct = tangentDrift(this, c, tx, ty);
            const kt = avbd ? c.kt : P.k;
            const lim = mu * Math.abs(avbd ? c.lam : force);
            let ft = kt * Ct;
            ft = clamp(ft, -lim, lim);
            const jtx = sgn * tx, jty = sgn * ty;
            const jta = sgn * cross2(rotated(this, c, i), tx, ty);
            gx += ft * jtx; gy += ft * jty; ga += ft * jta;
            // A saturated contact must not keep its full stiffness (it is
            // sliding), but dropping it to zero makes the block solve apply a
            // constant force with no position feedback and the body oscillates
            // away. The secant stiffness |f| / |C| reproduces exactly the
            // clamped force in one solve, without overshooting.
            const ke = Math.abs(ft) >= lim ? Math.abs(ft) / Math.max(Math.abs(Ct), 1e-9) : kt;
            h00 += ke * jtx * jtx; h11 += ke * jty * jty; h22 += ke * jta * jta;
            h01 += ke * jtx * jty; h02 += ke * jtx * jta; h12 += ke * jty * jta;
          }
        }
        // solve the 3x3 (symmetric, positive definite thanks to M/h²)
        const d = solve3(h00, h01, h02, h11, h12, h22, -gx, -gy, -ga);
        // safety clamp: one badly conditioned iteration must not fling a body
        const mv = P.maxMove, L = Math.hypot(d[0], d[1]);
        const f = L > mv ? mv / L : 1;
        b.x += d[0] * f; b.y += d[1] * f;
        b.a += clamp(d[2], -mv * 4, mv * 4);
        res += Math.abs(gx) + Math.abs(gy) + Math.abs(ga);
      }
      if (this.record) this.snap(substep, it, 'iterate', res);
      this.stats.residual = res;
      // Primal–dual: the multiplier and the penalty are updated after *every*
      // sweep, not once per substep. This is what lets a moderate stiffness
      // converge to an exact contact — with a single update per substep, a
      // hard impact keeps most of its penetration and gives it back as a bounce.
      if (avbd && P.dualEvery) { this.dualUpdate(); if (this.record) this.snap(substep, it, 'dual', 0); }
    }
  }

  /**
   * Dual update of the augmented Lagrangian, run after each sweep (AVBD,
   * Giles et al. 2025): λ absorbs the force the penalty is still supplying —
   * clamped to ≤ 0, a contact pushes and never pulls — and, while the contact
   * is pushing, the penalty climbs in proportion to the remaining violation.
   * A contact that separates simply sees λ + k·C rise to 0: no special case.
   */
  private dualUpdate(): void {
    const P = this.params;
    for (const c of this.contacts) {
      c.C = separation(this, c);
      const C = stabilised(c, P.alpha);
      // dead band: a satisfied constraint is left alone, so that extra
      // iterations cannot pump the multiplier with rounding noise
      if (Math.abs(C) <= P.tol) continue;
      c.lam = Math.min(0, c.lam + c.k * C);
      if (c.lam < 0) c.k = Math.min(c.kMax, c.k + P.beta * Math.abs(C));
    }
    // Friction stays a per-substep penalty: its constraint is measured from
    // the start of the substep, so a multiplier carried over would apply a
    // force while the drift is still zero and pump energy in.
    for (const c of this.contacts) c.kt = Math.min(FRICTION_K.max, c.kt * FRICTION_K.growth);
  }

  /** Classic sequential impulses on velocities, for the comparison chapter. */
  private solvePGS(h: number, substep: number): void {
    const P = this.params;
    // velocity integration first (the prediction already moved positions, undo)
    for (const b of this.bodies) {
      b.x = b.ox; b.y = b.oy; b.a = b.oa;
      if (b.m === 0) continue;
      b.vy += -P.gravity * h;
    }
    this.refreshC();
    // warm start: re-apply last step's impulses, then keep accumulating
    for (const c of this.contacts) {
      const A = this.bodies[c.a], B = c.b >= 0 ? this.bodies[c.b] : null;
      const ra = rotated(this, c, c.a), rb = B ? rotated(this, c, c.b) : [0, 0];
      const tx = -c.ny, ty = c.nx;
      applyImpulse(A, B, ra, rb, c.nx * c.jn + tx * c.jt, c.ny * c.jn + ty * c.jt);
    }
    for (let it = 0; it < P.iterations; it++) {
      for (const c of this.contacts) {
        const A = this.bodies[c.a], B = c.b >= 0 ? this.bodies[c.b] : null;
        const ra = rotated(this, c, c.a), rb = B ? rotated(this, c, c.b) : [0, 0];
        const relN = relVel(A, B, ra, rb, c.nx, c.ny);
        const kn = effMass(A, B, ra, rb, c.nx, c.ny);
        if (kn <= 0) continue;
        // A speculative contact (still apart by C > 0) may close its gap this
        // substep: it only forbids approaching faster than C / h. Treating it
        // as touching stops bodies a margin short of each other, in mid-air.
        const pen = Math.max(0, -c.C - P.slop);
        const biasV = c.C > 0 ? -c.C / h : (P.bias * pen) / h;
        const rest = P.restitution > 0 && relN < -1 ? -P.restitution * relN : 0;
        let dj = (-(relN) + biasV + rest) / kn;
        const old = c.jn;
        c.jn = Math.max(0, old + dj);
        dj = c.jn - old;
        applyImpulse(A, B, ra, rb, c.nx * dj, c.ny * dj);
        // friction
        const tx = -c.ny, ty = c.nx;
        const relT = relVel(A, B, ra, rb, tx, ty);
        const kt = effMass(A, B, ra, rb, tx, ty);
        if (kt > 0) {
          const lim = P.friction * c.jn;
          let djt = -relT / kt;
          const oldT = c.jt;
          c.jt = clamp(oldT + djt, -lim, lim);
          djt = c.jt - oldT;
          applyImpulse(A, B, ra, rb, tx * djt, ty * djt);
        }
      }
      if (this.record) this.snap(substep, it, 'iterate', 0);
    }
    for (const b of this.bodies) {
      if (b.m === 0) continue;
      b.x += b.vx * h; b.y += b.vy * h; b.a += b.w * h;
    }
    this.refreshC();
  }

  /** v = (x − x_prev) / h — the velocity *is* the motion that happened. */
  private finishVelocities(h: number): void {
    const P = this.params;
    if (P.solver === 'pgs') {
      if (P.drag > 0) for (const b of this.bodies) { const f = 1 / (1 + P.drag * h); b.vx *= f; b.vy *= f; b.w *= f; }
      return;
    }
    for (const b of this.bodies) {
      if (b.m === 0) continue;
      b.vx = (b.x - b.ox) / h;
      b.vy = (b.y - b.oy) / h;
      b.w = angleDelta(b.a, b.oa) / h;
      if (P.drag > 0) { const f = 1 / (1 + P.drag * h); b.vx *= f; b.vy *= f; b.w *= f; }
    }
  }

  private updateStats(): void {
    let pen = 0, e = 0;
    for (const c of this.contacts) pen = Math.max(pen, -c.C);
    for (const b of this.bodies) {
      if (b.m === 0) continue;
      e += 0.5 * b.m * (b.vx * b.vx + b.vy * b.vy) + 0.5 * b.I * b.w * b.w + b.m * this.params.gravity * b.y;
    }
    this.stats.pen = pen;
    this.stats.contacts = this.contacts.length;
    this.stats.energy = e;
  }

  private snap(substep: number, iter: number, phase: TraceStep['phase'], residual: number): void {
    const pose = new Float64Array(this.bodies.length * 3);
    this.bodies.forEach((b, i) => { pose[i * 3] = b.x; pose[i * 3 + 1] = b.y; pose[i * 3 + 2] = b.a; });
    let pen = 0;
    const cs = this.contacts.map((c) => {
      const C = separation(this, c);
      pen = Math.max(pen, -C);
      const [px, py] = worldAnchor(this, c, c.a);
      return { nx: c.nx, ny: c.ny, px, py, C, k: c.k, lam: c.lam };
    });
    this.trace.push({ substep, iter, phase, pose, pen, contacts: cs, residual });
  }

  /** Restores the poses of a recorded iteration (for scrubbing a diagram). */
  applyTrace(i: number): void {
    const t = this.trace[clamp(i, 0, this.trace.length - 1)];
    if (!t) return;
    this.bodies.forEach((b, k) => { b.x = t.pose[k * 3]; b.y = t.pose[k * 3 + 1]; b.a = t.pose[k * 3 + 2]; });
  }
}

// --------------------------------------------------------------- geometry

const WALLS = [
  { key: 'floor', nx: 0, ny: 1, axis: 'y' as const, sign: 1 },
  { key: 'left', nx: 1, ny: 0, axis: 'x' as const, sign: 1 },
  { key: 'right', nx: -1, ny: 0, axis: 'x' as const, sign: -1 },
];

type Push = (c: Omit<Contact, 'k' | 'lam' | 'kt' | 'jn' | 'jt' | 'fresh' | 'bias' | 'c0' | 'kMax'>) => void;

/** Corners of a box in world space. */
export function corners(b: Body): [number, number][] {
  const c = Math.cos(b.a), s = Math.sin(b.a);
  const out: [number, number][] = [];
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    const lx = sx * b.hw, ly = sy * b.hh;
    out.push([b.x + lx * c - ly * s, b.y + lx * s + ly * c]);
  }
  return out;
}

function localOf(b: Body, wx: number, wy: number): [number, number] {
  const c = Math.cos(b.a), s = Math.sin(b.a);
  const dx = wx - b.x, dy = wy - b.y;
  return [dx * c + dy * s, -dx * s + dy * c];
}

function collideHalfSpace(b: Body, i: number, nx: number, ny: number, d: number, key: string, push: Push, M: number): void {
  if (b.shape === 'circle') {
    // with axis-aligned normals, d is the coordinate of the plane along that axis
    const along = nx !== 0 ? b.x : b.y;
    const dist = nx !== 0 ? (nx > 0 ? along - d : d - along) : along - d;
    if (dist - b.hw > M) return;
    push({ a: i, b: -1, rax: 0, ray: 0, rbx: 0, rby: 0, nx, ny, sa: true, sb: false, C: dist - b.hw, id: `${i}-${key}` });
    return;
  }
  for (const [ci, [wx, wy]] of corners(b).entries()) {
    const along = nx !== 0 ? wx : wy;
    const dist = nx !== 0 ? (nx > 0 ? along - d : d - along) : along - d;
    if (dist > M) continue;
    const [lx, ly] = localOf(b, wx, wy);
    push({ a: i, b: -1, rax: lx, ray: ly, rbx: 0, rby: 0, nx, ny, sa: false, sb: false, C: dist, id: `${i}-${key}-${ci}` });
  }
}

/** Box/box via SAT, circle cases analytically. Produces up to 2 points. */
function collidePair(A: Body, ia: number, B: Body, ib: number, push: Push, M: number): void {
  if (A.shape === 'circle' && B.shape === 'circle') {
    const dx = A.x - B.x, dy = A.y - B.y;
    const L = Math.hypot(dx, dy) || 1e-9;
    const C = L - A.hw - B.hw;
    if (C > M) return;
    const nx = dx / L, ny = dy / L;
    push({ a: ia, b: ib, rax: 0, ray: 0, rbx: 0, rby: 0, nx, ny, sa: true, sb: true, C, id: `${ia}-${ib}` });
    return;
  }
  if (A.shape === 'circle' || B.shape === 'circle') {
    const c = A.shape === 'circle' ? A : B;
    const box = A.shape === 'circle' ? B : A;
    const ic = A.shape === 'circle' ? ia : ib;
    const ibx = A.shape === 'circle' ? ib : ia;
    const [lx, ly] = localOf(box, c.x, c.y);
    const qx = clamp(lx, -box.hw, box.hw), qy = clamp(ly, -box.hh, box.hh);
    const ddx = lx - qx, ddy = ly - qy;
    let L = Math.hypot(ddx, ddy);
    let lnx: number, lny: number, C: number;
    if (L > 1e-7) { lnx = ddx / L; lny = ddy / L; C = L - c.hw; } else {
      // centre inside the box: push out along the shallowest face
      const ox = box.hw - Math.abs(lx), oy = box.hh - Math.abs(ly);
      if (ox < oy) { lnx = Math.sign(lx) || 1; lny = 0; C = -ox - c.hw; } else { lnx = 0; lny = Math.sign(ly) || 1; C = -oy - c.hw; }
    }
    if (C > M) return;
    const cs = Math.cos(box.a), sn = Math.sin(box.a);
    let nx = lnx * cs - lny * sn, ny = lnx * sn + lny * cs; // box -> world
    // normal must point from b towards a
    if (ic !== ia) { nx = -nx; ny = -ny; }
    const aIsCircle = A.shape === 'circle';
    push({
      a: ia, b: ib,
      rax: aIsCircle ? 0 : qx, ray: aIsCircle ? 0 : qy,
      rbx: aIsCircle ? qx : 0, rby: aIsCircle ? qy : 0,
      nx, ny, sa: aIsCircle, sb: !aIsCircle, C, id: `${ia}-${ibx}-c`,
    });
    return;
  }
  // box / box: separating axis on the 4 face normals
  let best = -Infinity, bn: [number, number] = [0, 1], ref = A, inc = B, flip = false;
  for (const [src, other, isA] of [[A, B, true], [B, A, false]] as const) {
    const cs = Math.cos(src.a), sn = Math.sin(src.a);
    const axes: [number, number][] = [[cs, sn], [-sn, cs]];
    for (const [ax, ay] of axes) {
      for (const s of [1, -1]) {
        const nx = ax * s, ny = ay * s;
        // distance from src's face along n to other's deepest point
        const faceD = (src.x * nx + src.y * ny) + (Math.abs(nx * cs + ny * sn) * src.hw + Math.abs(nx * -sn + ny * cs) * src.hh);
        let minP = Infinity;
        for (const [wx, wy] of corners(other)) minP = Math.min(minP, wx * nx + wy * ny);
        const sep = minP - faceD;
        if (sep > best) {
          best = sep;
          bn = [nx, ny];
          ref = src; inc = other; flip = !isA;
        }
      }
    }
  }
  if (best > M) return;
  // clip: keep the incident corners within 1.5 cm of the deepest
  const [nx0, ny0] = bn;
  const pts: [number, number, number][] = [];
  const faceD = (ref.x * nx0 + ref.y * ny0)
    + Math.abs(nx0 * Math.cos(ref.a) + ny0 * Math.sin(ref.a)) * ref.hw
    + Math.abs(-nx0 * Math.sin(ref.a) + ny0 * Math.cos(ref.a)) * ref.hh;
  for (const [wx, wy] of corners(inc)) {
    const sep = wx * nx0 + wy * ny0 - faceD;
    if (sep < best + 0.02) pts.push([wx, wy, sep]);
  }
  pts.sort((p, q) => p[2] - q[2]);
  const keep = pts.slice(0, 2);
  for (const [ci, [wx, wy, sep]] of keep.entries()) {
    // n must point from b (= body ib) towards a (= body ia)
    let nx = nx0, ny = ny0;
    if (!flip) { nx = -nx0; ny = -ny0; } // ref is A: the normal points away from A
    const [lax, lay] = localOf(A, wx, wy);
    const [lbx, lby] = localOf(B, wx, wy);
    push({ a: ia, b: ib, rax: lax, ray: lay, rbx: lbx, rby: lby, nx, ny, sa: false, sb: false, C: sep, id: `${ia}-${ib}-${flip ? 'b' : 'a'}${ci}` });
  }
}

// ------------------------------------------------------- constraint algebra

function rotatedOf(b: Body, lx: number, ly: number): [number, number] {
  const c = Math.cos(b.a), s = Math.sin(b.a);
  return [lx * c - ly * s, lx * s + ly * c];
}

/**
 * World lever arm of the contact on body `i`. Boxes rotate their arm with the
 * body; circles keep it world-fixed along the normal (see Contact.sa).
 */
export function rotated(m: Mini, c: Contact, i: number): [number, number] {
  if (i === c.a) {
    if (c.sa) return [-c.nx * m.bodies[c.a].hw, -c.ny * m.bodies[c.a].hw];
    return rotatedOf(m.bodies[c.a], c.rax, c.ray);
  }
  if (c.b >= 0) {
    if (c.sb) return [c.nx * m.bodies[c.b].hw, c.ny * m.bodies[c.b].hw];
    return rotatedOf(m.bodies[c.b], c.rbx, c.rby);
  }
  return [0, 0];
}

function worldAnchor(m: Mini, c: Contact, i: number): [number, number] {
  const b = m.bodies[i];
  const [rx, ry] = rotated(m, c, i);
  return [b.x + rx, b.y + ry];
}

/** The constraint AVBD actually solves: only 1 − α of the starting overlap. */
const stabilised = (c: Contact, alpha: number) => c.C - alpha * Math.min(0, c.c0);

/** Signed separation: ≥ 0 apart, < 0 interpenetrating. */
export function separation(m: Mini, c: Contact): number {
  return rawSeparation(m, c) + c.bias;
}

/** Anchor difference along the normal, before the generation-time offset. */
function rawSeparation(m: Mini, c: Contact): number {
  const A = m.bodies[c.a];
  const [rax, ray] = rotated(m, c, c.a);
  const ax = A.x + rax, ay = A.y + ray;
  if (c.b < 0) {
    // half-space through the world bound along the normal's axis
    const d = c.nx !== 0 ? (c.nx > 0 ? m.bounds.x0 : m.bounds.x1) : m.bounds.y0;
    const along = c.nx !== 0 ? ax : ay;
    return c.nx !== 0 ? (c.nx > 0 ? along - d : d - along) : along - d;
  }
  const B = m.bodies[c.b];
  const [rbx, rby] = rotated(m, c, c.b);
  return (ax - (B.x + rbx)) * c.nx + (ay - (B.y + rby)) * c.ny;
}

/**
 * Tangential drift of the contact's material point since the substep started.
 * Linearised the same way as the Jacobian used in the solve: Δx + Δθ (ẑ × r).
 */
function tangentDrift(m: Mini, c: Contact, tx: number, ty: number): number {
  const A = m.bodies[c.a];
  const [rax, ray] = rotated(m, c, c.a);
  let dx = (A.x - A.ox) - (A.a - A.oa) * ray;
  let dy = (A.y - A.oy) + (A.a - A.oa) * rax;
  if (c.b >= 0) {
    const B = m.bodies[c.b];
    const [rbx, rby] = rotated(m, c, c.b);
    dx -= (B.x - B.ox) - (B.a - B.oa) * rby;
    dy -= (B.y - B.oy) + (B.a - B.oa) * rbx;
  }
  return dx * tx + dy * ty;
}

/** ∂C/∂(x, y, θ) of body `i` for the normal constraint. */
function jacobian(m: Mini, c: Contact, i: number, sgn: number): [number, number, number] {
  const [rx, ry] = rotated(m, c, i);
  return [sgn * c.nx, sgn * c.ny, sgn * cross2([rx, ry], c.nx, c.ny)];
}

const cross2 = (r: [number, number] | number[], nx: number, ny: number) => r[0] * ny - r[1] * nx;

function relVel(A: Body, B: Body | null, ra: number[], rb: number[], nx: number, ny: number): number {
  const avx = A.vx - A.w * ra[1], avy = A.vy + A.w * ra[0];
  const bvx = B ? B.vx - B.w * rb[1] : 0, bvy = B ? B.vy + B.w * rb[0] : 0;
  return (avx - bvx) * nx + (avy - bvy) * ny;
}

function effMass(A: Body, B: Body | null, ra: number[], rb: number[], nx: number, ny: number): number {
  const ca = cross2(ra, nx, ny);
  let k = A.invM + A.invI * ca * ca;
  if (B) { const cb = cross2(rb, nx, ny); k += B.invM + B.invI * cb * cb; }
  return k;
}

function applyImpulse(A: Body, B: Body | null, ra: number[], rb: number[], ix: number, iy: number): void {
  A.vx += ix * A.invM; A.vy += iy * A.invM;
  A.w += A.invI * (ra[0] * iy - ra[1] * ix);
  if (B) {
    B.vx -= ix * B.invM; B.vy -= iy * B.invM;
    B.w -= B.invI * (rb[0] * iy - rb[1] * ix);
  }
}

const angleDelta = (a: number, b: number) => a - b;

/** Symmetric 3x3 solve (LDL with a small regularisation). */
export function solve3(
  a00: number, a01: number, a02: number, a11: number, a12: number, a22: number,
  b0: number, b1: number, b2: number,
): [number, number, number] {
  const e = 1e-12;
  const d0 = a00 + e;
  const l10 = a01 / d0, l20 = a02 / d0;
  const d1 = a11 - l10 * a01 + e;
  const l21 = (a12 - l20 * a01) / d1;
  const d2 = a22 - l20 * a02 - l21 * l21 * d1 + e;
  const y0 = b0;
  const y1 = b1 - l10 * y0;
  const y2 = b2 - l20 * y0 - l21 * y1;
  const z2 = y2 / d2;
  const z1 = y1 / d1 - l21 * z2;
  const z0 = y0 / d0 - l10 * z1 - l20 * z2;
  return [z0, z1, z2];
}
