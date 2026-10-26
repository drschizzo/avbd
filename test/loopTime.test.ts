import { describe, expect, it } from 'vitest';
import { defaultDoc } from '../src/scene/doc';
import { boomerangSimTime, boomerangSpans } from '../src/sim/loopTime';

describe('boomerang time map', () => {
  for (const [rewind, apex] of [[1.5, 0.6], [1, 0], [3, 1.2], [0.5, 2]]) {
    it(`rewind ${rewind}, apex ${apex}: starts and ends on frame 0, continuous, forward then back`, () => {
      const doc = defaultDoc();
      doc.loop.rewind = rewind;
      doc.loop.apex = apex;
      const D = doc.duration;
      const s = boomerangSpans(doc);
      expect(s.forward + s.rewind).toBeCloseTo(D, 9);
      const at = (t: number) => boomerangSimTime(s, t, D);
      expect(at(0)).toBe(0);
      expect(at(D - 1e-6)).toBeCloseTo(0, 3);
      expect(at(s.forward)).toBeCloseTo(s.sim, 3);
      const dt = 1e-3;
      let prev = at(0);
      for (let t = dt; t < D; t += dt) {
        const v = at(t);
        expect(Math.abs(v - prev)).toBeLessThan(dt * Math.max(1, s.peak) * 1.01 + 1e-9); // no jumps: forward at 1x, rewind up to peak
        if (t < s.forward - dt) expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
        if (t > s.forward + dt) expect(v).toBeLessThanOrEqual(prev + 1e-12);
        prev = v;
      }
    });
  }

  it('wraps video time around the loop', () => {
    const doc = defaultDoc();
    const s = boomerangSpans(doc);
    expect(boomerangSimTime(s, 2.5 + doc.duration, doc.duration)).toBeCloseTo(boomerangSimTime(s, 2.5, doc.duration), 9);
    expect(boomerangSimTime(s, -1, doc.duration)).toBeCloseTo(boomerangSimTime(s, doc.duration - 1, doc.duration), 9);
  });
});
