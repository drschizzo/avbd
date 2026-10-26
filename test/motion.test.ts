import { describe, expect, it } from 'vitest';
import { MOTION_GATE, MOTION_SLIDE, MOTION_SPIN, MOTION_SWING, evalMotion, type SimMotion } from '../src/sim/motion';

const base = (kind: number, extra: Partial<SimMotion> = {}): SimMotion => ({
  kind, origin: [1, 2, 3], baseQuat: [0, 0, 0, 1], axis: [0, 1, 0], cycles: 2, amp: 0.7, phase: 0.1,
  offset: [0, -2, 0], tOpen: 2, tClose: 8, ease: 0.4, ...extra,
});

const pose = (m: SimMotion, t: number, D: number) => { const o = new Array(7).fill(0); evalMotion(m, t, D, o); return o; };
const same = (a: number[], b: number[]) => {
  // positions equal, quaternions equal up to sign
  for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i], 9);
  const d = Math.abs(a[3] * b[3] + a[4] * b[4] + a[5] * b[5] + a[6] * b[6]);
  expect(d).toBeCloseTo(1, 9);
};

describe('kinematic motions', () => {
  const D = 10;
  for (const kind of [MOTION_SPIN, MOTION_SWING, MOTION_SLIDE]) {
    it(`kind ${kind} is periodic over the loop`, () => {
      const m = base(kind);
      for (const t of [0, 1.3, 4.9]) same(pose(m, t, D), pose(m, t + D, D));
    });
  }

  it('gate is closed at both ends of the loop and open in between', () => {
    const m = base(MOTION_GATE);
    same(pose(m, 0, D), pose(m, D, D));
    expect(pose(m, 0, D)[1]).toBeCloseTo(2, 9);
    expect(pose(m, 5, D)[1]).toBeCloseTo(0, 9);
  });

  it('keeps quaternions unit', () => {
    const m = base(MOTION_SPIN, { baseQuat: [0.5, 0.5, 0.5, 0.5] });
    for (let t = 0; t < D; t += 0.37) {
      const p = pose(m, t, D);
      expect(Math.hypot(p[3], p[4], p[5], p[6])).toBeCloseTo(1, 9);
    }
  });
});
