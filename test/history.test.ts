import { describe, expect, it } from 'vitest';
import { History } from '../src/core/history';
import { defaultDoc, type SceneDoc } from '../src/scene/doc';

function setup() {
  let doc: SceneDoc = defaultDoc();
  const h = new History(() => doc);
  h.reset(doc, true);
  return { h, get: () => doc, set: (d: SceneDoc) => { doc = d; } };
}

describe('History', () => {
  it('undoes and redoes whole-document steps', () => {
    const { h, get, set } = setup();
    get().name = 'one'; h.push();
    get().name = 'two'; h.push();
    set(h.undo()!); expect(get().name).toBe('one');
    set(h.undo()!); expect(get().name).toBe('Untitled loop');
    expect(h.undo()).toBeNull();
    set(h.redo()!); expect(get().name).toBe('one');
    set(h.redo()!); expect(get().name).toBe('two');
    expect(h.redo()).toBeNull();
  });

  it('records an unsaved edit before undoing it', () => {
    const { h, get, set } = setup();
    get().duration = 20; // edited, not pushed yet
    set(h.undo()!);
    expect(get().duration).toBe(10);
    set(h.redo()!);
    expect(get().duration).toBe(20);
  });

  it('a new edit clears the redo branch, an unchanged push records nothing', () => {
    const { h, get, set } = setup();
    get().fps = 30; h.push();
    set(h.undo()!);
    h.push(); // no change
    get().fps = 24; h.push();
    expect(h.redo()).toBeNull();
    set(h.undo()!);
    expect(get().fps).toBe(60);
  });
});
