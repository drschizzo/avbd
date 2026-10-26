import { describe, expect, it } from 'vitest';
import { fbits, packQuat, unpackQuat, writeRestPoses } from '../src/sim/poseCodec';

function randomQuat(r: () => number): number[] {
  const q = [r() - 0.5, r() - 0.5, r() - 0.5, r() - 0.5];
  const n = Math.hypot(...q);
  return q.map((x) => x / n);
}

/** Rotation angle between two unit quaternions (q and -q are the same rotation). */
const angle = (a: number[], b: number[]) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));

describe('pose codec', () => {
  it('round-trips quaternions within 10-bit precision', () => {
    let s = 7;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    let worst = 0;
    for (let i = 0; i < 5000; i++) {
      const q = randomQuat(r);
      const back = unpackQuat(packQuat(q), [0, 0, 0, 0]);
      expect(Math.hypot(...back)).toBeCloseTo(1, 2);
      worst = Math.max(worst, angle(q, back));
    }
    expect(worst).toBeLessThan(0.005); // < 0.3°
  });

  it('keeps identity and axis rotations exact enough', () => {
    for (const q of [[0, 0, 0, 1], [0, 0, 0, -1], [1, 0, 0, 0], [0, Math.SQRT1_2, 0, Math.SQRT1_2]]) {
      expect(angle(q, unpackQuat(packQuat(q), [0, 0, 0, 0]))).toBeLessThan(0.003);
    }
  });

  it('writes the ground in slot 0 and bodies after it', () => {
    const out = new Uint32Array(3 * 4);
    writeRestPoses(out, [{ pos: [1, 2, 3], quat: [0, 0, 0, 1] }, { pos: [-4, 5, 6], quat: [1, 0, 0, 0] }]);
    const f = new Float32Array(out.buffer);
    expect([f[0], f[1], f[2]]).toEqual([0, -0.5, 0]);
    expect([f[4], f[5], f[6]]).toEqual([1, 2, 3]);
    expect([f[8], f[9], f[10]]).toEqual([-4, 5, 6]);
    expect(out[4]).toBe(fbits(1));
  });
});
