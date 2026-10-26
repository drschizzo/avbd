import { describe, expect, it } from 'vitest';
import { planFluidHistory, planHistory } from '../src/sim/bakePlan';

const MB = 1024 * 1024;

describe('bake memory plan', () => {
  it('records every frame when it fits', () => {
    const p = planHistory(501, 601, 60, { mode: 'reassemble', outro: 2 }, 1024 * MB);
    expect(p).toEqual({ recordEvery: 1, frames: 601, tailCount: 0, tailStart: 601, warm: false });
  });

  it('keeps the warm-up tail of continuous loops after the main frames', () => {
    const p = planHistory(101, 601, 60, { mode: 'continuous', outro: 2 }, 1024 * MB);
    expect(p.warm).toBe(true);
    expect(p.tailCount).toBe(122); // 2 s at 60 fps, plus 2 frames of margin
    expect(p.tailStart).toBe(601 - 122);
  });

  it('records sparser when the history would not fit, then gives up', () => {
    const bodies = 20000, F = 1801;
    const p = planHistory(bodies, F, 60, { mode: 'none', outro: 0 }, 256 * MB);
    expect(p.recordEvery).toBeGreaterThan(1);
    expect(p.frames * bodies * 16).toBeLessThanOrEqual(256 * MB);
    expect((Math.ceil(F / (p.recordEvery - 1))) * bodies * 16).toBeGreaterThan(256 * MB);
    expect(() => planHistory(200000, F, 60, { mode: 'none', outro: 0 }, 256 * MB)).toThrow(/too large/);
  });

  it('liquid history is never denser than the bodies\'', () => {
    expect(planFluidHistory(1000, 601, 2, 1024 * MB, 1024 * MB)).toEqual({ recordEvery: 2, frames: 301 });
    expect(planFluidHistory(90000, 1801, 1, 256 * MB, 1024 * MB).recordEvery).toBeGreaterThan(1);
  });
});
