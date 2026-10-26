// Self-checks for the course's 2D engine. Run `miniSelfTest()` in the dev
// console: every number below is compared against theory or against a value
// that cost real debugging to get right.

import { CHALLENGES, SLOTS, verify } from './lab';
import { Mini, makeBox, makeCircle, type Params } from './mini';

const W = { x0: -3, x1: 3, y0: 0 };
type Case = { name: string; run(): string | null };

const stack = (n: number, p: Partial<Params>) => {
  const m = new Mini(p, { bounds: W });
  for (let i = 0; i < n; i++) m.add(makeBox(0, 0.25 + i * 0.502, 0.25, 0.25));
  m.commitInitial();
  return m;
};
const runFor = (m: Mini, frames: number) => { for (let f = 0; f < frames; f++) m.step(); };
const finite = (m: Mini) => m.bodies.every((b) => Number.isFinite(b.x) && Number.isFinite(b.y) && Math.abs(b.y) < 50);

const CASES: Case[] = [
  {
    name: 'a resting box does not sink and does not drift',
    run() {
      const m = stack(1, {});
      runFor(m, 240);
      const b = m.bodies[0];
      if (Math.abs(b.y - 0.25) > 2e-3) return `y = ${b.y}, expected 0.25`;
      if (Math.abs(b.x) > 1e-3) return `drifted to x = ${b.x}`;
      return null;
    },
  },
  {
    name: 'penetration decreases monotonically with iterations',
    run() {
      const pens = [2, 4, 8, 16, 32].map((it) => {
        const m = stack(10, { iterations: it });
        let mx = 0;
        for (let f = 0; f < 240; f++) { m.step(); if (f > 60) mx = Math.max(mx, m.stats.pen); }
        return finite(m) ? mx : NaN;
      });
      if (pens.some(Number.isNaN)) return `diverged: ${pens}`;
      for (let i = 1; i < pens.length; i++) if (pens[i] > pens[i - 1] * 1.3) return `not converging: ${pens.map((p) => (p * 1000).toFixed(2)).join(' ')} mm`;
      if (pens[pens.length - 1] > 2e-4) return `final penetration ${pens[pens.length - 1] * 1000} mm`;
      return null;
    },
  },
  {
    name: 'a dropped body does not bounce with restitution 0',
    run() {
      const m = new Mini({}, { bounds: W });
      m.add(makeCircle(0, 2, 0.25));
      m.commitInitial();
      let top = 0;
      for (let f = 0; f < 180; f++) { m.step(); if (f > 40) top = Math.max(top, m.bodies[0].y); }
      if (top > 0.33) return `bounced back up to y = ${top}`;
      return null;
    },
  },
  {
    name: 'a box on a slope slides at g(sin θ − μ cos θ)',
    run() {
      const th = 0.3;
      for (const [mu, want] of [[0, 2.90], [0.2, 1.03], [0.5, 0], [0.8, 0]] as const) {
        const m = new Mini({ friction: mu, substeps: 4 }, { bounds: { x0: -40, x1: 40, y0: -20 } });
        const r = makeBox(0, 0, 20, 0.1, { m: 0 }); r.a = th; m.add(r);
        // sit the box on the ramp surface: a point of the ramp axis, pushed
        // out along the ramp normal by both half-thicknesses
        const t = 2, d = 0.1 + 0.15 + 0.002;
        const b = makeBox(t * Math.cos(th) - d * Math.sin(th), t * Math.sin(th) + d * Math.cos(th), 0.15, 0.15);
        b.a = th; m.add(b);
        m.commitInitial();
        runFor(m, 40);
        const along = () => m.bodies[1].vx * Math.cos(th) + m.bodies[1].vy * Math.sin(th);
        const v0 = along();
        runFor(m, 30);
        const acc = -(along() - v0) / (30 / 60);
        if (Math.abs(acc - want) > 0.3) return `μ=${mu}: ${acc.toFixed(3)} m/s², expected ${want}`;
      }
      return null;
    },
  },
  {
    name: 'a rolling circle keeps its world-fixed lever arm and does not sink',
    run() {
      const m = new Mini({ friction: 0.5 }, { bounds: W });
      m.add(makeCircle(-2, 0.3, 0.3, { vx: 8, w: -26 }));
      m.commitInitial();
      let minY = 9;
      for (let f = 0; f < 120; f++) { m.step(); minY = Math.min(minY, m.bodies[0].y); }
      if (minY < 0.29) return `sank to y = ${minY}, radius is 0.3`;
      return null;
    },
  },
  {
    name: 'impulses land on the floor: a speculative contact does not stop a body mid-air',
    run() {
      const m = new Mini({ solver: 'pgs', iterations: 10, substeps: 4 }, { bounds: W });
      m.add(makeBox(0, 1, 0.25, 0.25));
      m.commitInitial();
      runFor(m, 120);
      const y = m.bodies[0].y;
      if (Math.abs(y - 0.25) > 5e-3) return `rests at y = ${y}, expected 0.25`;
      return null;
    },
  },
  {
    name: 'a heavy box rests on a light one (mass ratios 100 and 1000)',
    run() {
      for (const r of [100, 1000]) {
        for (const it of [6, 10, 16]) {
          const m = new Mini({ iterations: it }, { bounds: W });
          m.add(makeBox(0, 0.25, 0.25, 0.25));
          m.add(makeBox(0, 0.75, 0.25, 0.25, { m: r }));
          m.commitInitial();
          let lo = 9, hi = 0;
          for (let f = 0; f < 300; f++) { m.step(); if (f > 30) { lo = Math.min(lo, m.bodies[1].y); hi = Math.max(hi, m.bodies[1].y); } }
          // without the α stabilisation the heavy box was thrown metres up
          if (hi > 0.77 || lo < 0.7) return `ratio ${r}, ${it} iterations: heavy box between y = ${lo.toFixed(3)} and ${hi.toFixed(3)}, expected ≈ 0.75`;
        }
      }
      return null;
    },
  },
  {
    name: 'without a solver, bodies fall through the floor',
    run() {
      const m = stack(1, { solver: 'none' });
      runFor(m, 60);
      if (m.bodies[0].y > -1) return `still at y = ${m.bodies[0].y}`;
      return null;
    },
  },
  {
    name: 'every solver survives a pyramid, a heavy block and loose circles, without gaining energy',
    run() {
      for (const solver of ['pgs', 'penalty', 'avbd'] as const) {
        const m = new Mini({ solver, iterations: 10, substeps: 2 }, { bounds: W });
        for (let L = 0; L < 5; L++) for (let i = 0; i < 5 - L; i++) m.add(makeBox((i - (4 - L) / 2) * 0.42, 0.2 + L * 0.402, 0.2, 0.2));
        m.add(makeBox(0, 4, 0.5, 0.5, { m: 40 }));
        for (let i = 0; i < 8; i++) m.add(makeCircle(-1 + i * 0.25, 5 + i * 0.3, 0.1, { vx: (i % 3) - 1 }));
        m.commitInitial();
        m.step();
        const e0 = m.stats.energy;
        let eMax = -Infinity;
        for (let f = 0; f < 300; f++) { m.step(); if (f > 60) eMax = Math.max(eMax, m.stats.energy); }
        if (!finite(m)) return `${solver} diverged`;
        // finite is not enough: the old AVBD dual update stayed finite while
        // pumping kinetic energy into this very scene (13 kJ after 10 s)
        if (eMax > e0) return `${solver} gained energy: ${e0.toFixed(0)} J → ${eMax.toFixed(0)} J`;
      }
      return null;
    },
  },
  {
    name: 'the iteration trace replays the recorded poses',
    run() {
      const m = stack(3, { iterations: 4, substeps: 1 });
      m.record = true;
      runFor(m, 30);
      if (m.trace.length < 6) return `only ${m.trace.length} trace entries`;
      const last = m.trace[m.trace.length - 1];
      m.applyTrace(0);
      const moved = Math.abs(m.bodies[0].y - last.pose[1]);
      m.applyTrace(m.trace.length - 1);
      if (Math.abs(m.bodies[0].y - last.pose[1]) > 1e-12) return 'applyTrace did not restore the last pose';
      void moved;
      return null;
    },
  },
];

/**
 * Every workshop challenge must accept its reference solution and reject the
 * starter code — otherwise the challenge checks nothing.
 */
export function labSelfTest(): boolean {
  let bad = 0;
  for (const c of CHALLENGES) {
    const sol = verify(c, SLOTS[c.slot].sol);
    const start = verify(c, c.starter);
    if (!sol.ok) { bad++; console.error(`✗ ${c.id}: the reference solution fails — ${sol.msg}`); } else if (start.ok) { bad++; console.error(`✗ ${c.id}: the starter code passes — the challenge verifies nothing`); } else console.log(`✓ ${c.id} — rejects the starter with: ${start.msg}`);
  }
  console.log(bad === 0 ? `All ${CHALLENGES.length} challenges are sound.` : `${bad} challenge(s) broken.`);
  return bad === 0;
}

export function courseSelfTest(): boolean {
  const a = miniSelfTest();
  const b = labSelfTest();
  return a && b;
}

export function miniSelfTest(): boolean {
  let bad = 0;
  for (const c of CASES) {
    let err: string | null;
    try { err = c.run(); } catch (e: any) { err = `threw: ${e?.message ?? e}`; }
    if (err) { bad++; console.error(`✗ ${c.name}\n   ${err}`); } else console.log(`✓ ${c.name}`);
  }
  console.log(bad === 0 ? `All ${CASES.length} checks passed.` : `${bad} / ${CASES.length} checks failed.`);
  return bad === 0;
}
