// Contract of the entity catalogue: every type, built alone with its
// defaults, gives finite bodies and joints that point at real bodies.

import { describe, expect, it } from 'vitest';
import { defaultDoc, type EntityType } from '../src/scene/doc';
import { ENTITY_DEFS, createEntity } from '../src/scene/entities';
import { buildScene } from '../src/scene/build';

const finite = (v: ArrayLike<number>) => Array.from(v).every(Number.isFinite);

describe('entity catalogue', () => {
  for (const type of Object.keys(ENTITY_DEFS) as EntityType[]) {
    it(type, () => {
      const def = ENTITY_DEFS[type];
      for (const spec of def.params) {
        if (spec.kind !== 'entity') expect(def.defaults, `default for ${spec.key}`).toHaveProperty(spec.key);
      }
      const doc = defaultDoc();
      doc.entities.push(createEntity(type, { position: [0, 2, 0] }));
      const built = buildScene(doc);
      for (const b of built.bodies) {
        expect(finite(b.pos) && finite(b.quat) && finite(b.he)).toBe(true);
        expect(b.he.every((x) => x > 0)).toBe(true);
      }
      for (const j of built.joints) {
        expect(j.b).toBeLessThan(built.bodies.length);
        if (j.a !== null) expect(j.a).toBeLessThan(built.bodies.length);
      }
      for (const p of def.ports?.(def.defaults) ?? []) expect(finite(p.p) && finite(p.dir)).toBe(true);
    });
  }
});

describe('entity behaviours', () => {
  it('rows that must fall entirely', () => {
    expect(ENTITY_DEFS.dominoes.chain?.(ENTITY_DEFS.dominoes.defaults)).toBe(true);
    expect(ENTITY_DEFS.path.chain?.({ fill: 'dominoes' })).toBe(true);
    expect(ENTITY_DEFS.path.chain?.({ fill: 'rail' })).toBe(false);
    expect(ENTITY_DEFS.wall.chain).toBeUndefined();
  });

  it('a new path fill brings its own body kind', () => {
    const e = createEntity('path');
    e.params.fill = 'rail';
    expect(ENTITY_DEFS.path.onParamChange?.(e, 'fill')).toBe(true);
    expect(e.phys.body).toBe('static');
    expect(ENTITY_DEFS.path.onParamChange?.(e, 'spacing')).toBe(false);
  });

  it('spawners are built after everything else', () => {
    const doc = defaultDoc();
    doc.entities.push(createEntity('emitter'), createEntity('box', { position: [3, 0.5, 0] }));
    const built = buildScene(doc);
    expect(built.bodies[0].entity).toBe(1);
  });
});
