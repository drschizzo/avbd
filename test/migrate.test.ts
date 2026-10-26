import { describe, expect, it } from 'vitest';
import { defaultDoc } from '../src/scene/doc';
import { ENTITY_DEFS, createEntity } from '../src/scene/entities';
import { migrateDoc } from '../src/scene/migrate';

describe('migrateDoc', () => {
  it('leaves a current document unchanged', () => {
    const d = defaultDoc();
    d.entities.push(createEntity('wall'), createEntity('dominoes'));
    expect(migrateDoc(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });

  it('rejects what is not a document', () => {
    expect(migrateDoc(null)).toBeNull();
    expect(migrateDoc({ version: 2, entities: [] })).toBeNull();
    expect(migrateDoc({ version: 1 })).toBeNull();
  });

  it('fills settings and entity params added since the save', () => {
    const d: any = JSON.parse(JSON.stringify(defaultDoc()));
    delete d.fluid;
    delete d.render.bloom;
    const wall: any = createEntity('wall');
    delete wall.params.glue;
    d.entities.push(wall);
    const m = migrateDoc(d)!;
    expect(m.fluid).toEqual(defaultDoc().fluid);
    expect(m.render.bloom).toBe(defaultDoc().render.bloom);
    expect(m.entities[0].params.glue).toBe(ENTITY_DEFS.wall.defaults.glue);
  });

  it('drops entity types that no longer exist', () => {
    const d: any = defaultDoc();
    d.entities.push({ ...createEntity('box'), type: 'teleporter' }, createEntity('sphere'));
    expect(migrateDoc(d)!.entities.map((e) => e.type)).toEqual(['sphere']);
  });
});
