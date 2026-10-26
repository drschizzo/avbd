import { describe, expect, it } from 'vitest';
import { Selection } from '../src/edit/selection';
import { defaultDoc } from '../src/scene/doc';
import { createEntity } from '../src/scene/entities';

function scene() {
  const doc = defaultDoc();
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => createEntity('box', { id, name: id }));
  b.group = 'G'; c.group = 'G';
  doc.entities.push(a, b, c, d);
  return doc;
}

describe('Selection', () => {
  it('selects a whole group, or one member with `single`', () => {
    const doc = scene(), s = new Selection();
    s.select(doc, 'b');
    expect(s.ids).toEqual(['b', 'c']);
    expect(s.primary).toBe('b');
    s.select(doc, 'c', { single: true });
    expect(s.ids).toEqual(['c']);
  });

  it('toggles in and out, keeping a primary', () => {
    const doc = scene(), s = new Selection();
    s.select(doc, 'a');
    s.select(doc, 'd', { toggle: true });
    expect(s.ids).toEqual(['a', 'd']);
    expect(s.primary).toBe('d');
    s.select(doc, 'd', { toggle: true });
    expect(s.ids).toEqual(['a']);
    expect(s.primary).toBe('a');
  });

  it('drops unknown and removed ids', () => {
    const doc = scene(), s = new Selection();
    s.set(doc, ['a', 'zz', 'd'], 'zz');
    expect(s.ids).toEqual(['a', 'd']);
    expect(s.primary).toBe('d');
    s.drop(new Set(['d']));
    expect(s.primary).toBe('a');
    expect([...s.indices(doc)]).toEqual([0]);
  });
});
