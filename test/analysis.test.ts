import { describe, expect, it } from 'vitest';
import { defaultDoc } from '../src/scene/doc';
import { createEntity } from '../src/scene/entities';
import { buildScene } from '../src/scene/build';
import { analyzeSamples } from '../src/sim/analysis';
import { writeRestPoses } from '../src/sim/poseCodec';

describe('machine check', () => {
  it('tells a part that moved from one that stayed idle', () => {
    const doc = defaultDoc();
    doc.loop.mode = 'none';
    doc.entities.push(
      createEntity('box', { name: 'Mover', position: [0, 0.5, 0] }),
      createEntity('box', { name: 'Sleeper', position: [3, 0.5, 0] }),
      createEntity('box', { name: 'Decor', position: [6, 0.5, 0], expect: false }),
    );
    const built = buildScene(doc);
    const times: number[] = [];
    const samples: Uint32Array[] = [];
    for (let s = 0; s < 40; s++) {
      const t = s * 0.1;
      times.push(t);
      // the mover slides 1 m between 1 s and 2 s
      const shift = Math.min(1, Math.max(0, t - 1));
      const bodies = built.bodies.map((b, i) => ({ pos: i === 0 ? [b.pos[0] + shift, b.pos[1], b.pos[2]] : b.pos, quat: b.quat }));
      const out = new Uint32Array((built.bodies.length + 1) * 4);
      writeRestPoses(out, bodies);
      samples.push(out);
    }
    const r = analyzeSamples(samples, times, built, doc);
    const by = Object.fromEntries(r.entities.map((e) => [e.name, e]));
    expect(by.Mover.status).toBe('ok');
    expect(by.Mover.first).toBeGreaterThan(1);
    expect(by.Mover.first).toBeLessThan(1.5);
    expect(by.Sleeper.status).toBe('idle');
    expect(by.Decor.status).toBe('decor');
    expect(r.ok).toBe(false);
  });
});
