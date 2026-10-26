// Golden master: every preset, built into the flat body / joint / motion list
// the baker consumes, must stay identical across refactors.

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESETS } from '../src/scene/presets';
import { buildScene } from '../src/scene/build';

// entity ids seed each entity's Rng: pin the id generator's inputs
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (_k: string, v: unknown) => (typeof v === 'number' ? Math.round(v * 1e5) / 1e5 : v);

beforeEach(() => {
  vi.spyOn(Math, 'random').mockImplementation(seeded(42));
  vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
});
afterEach(() => vi.restoreAllMocks());

describe('buildScene golden master', () => {
  for (const p of PRESETS) {
    it(p.key, () => {
      const doc = p.make();
      const built = buildScene(doc);
      const json = JSON.stringify({ doc, built }, round);
      expect({
        bodies: built.bodies.length,
        joints: built.joints.length,
        motions: built.motions.length,
        simFrames: built.simFrames,
        fluid: built.fluid ? built.fluid.count ?? true : null,
        hash: createHash('sha1').update(json).digest('hex'),
      }).toMatchSnapshot();
    });
  }
});
