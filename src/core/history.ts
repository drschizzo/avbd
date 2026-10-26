// Undo / redo by whole-document snapshots: simple, and exact for every kind
// of edit. Small edits in quick succession (a slider drag) settle into one
// step after a short pause.

import type { SceneDoc } from '../scene/doc';

const DEPTH = 200;
const SETTLE_MS = 350;

export class History {
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  /** the document as of the last recorded step */
  private last = '';
  private timer = 0;

  constructor(private current: () => SceneDoc) {}

  /** Starts over from `doc` (`clear`: forget every step). */
  reset(doc: SceneDoc, clear: boolean): void {
    if (clear) { this.undoStack = []; this.redoStack = []; }
    this.last = JSON.stringify(doc);
  }

  /** Records the current document as a step, if it changed. */
  push(): void {
    const s = JSON.stringify(this.current());
    if (s === this.last) return;
    this.undoStack.push(this.last);
    if (this.undoStack.length > DEPTH) this.undoStack.shift();
    this.redoStack = [];
    this.last = s;
  }

  /** Records a step once edits pause. */
  schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.push(), SETTLE_MS);
  }

  /** The document to go back to, or null. */
  undo(): SceneDoc | null {
    this.push();
    const prev = this.undoStack.pop();
    if (!prev) return null;
    this.redoStack.push(JSON.stringify(this.current()));
    return this.restore(prev);
  }

  redo(): SceneDoc | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(JSON.stringify(this.current()));
    return this.restore(next);
  }

  private restore(s: string): SceneDoc {
    this.last = s;
    return JSON.parse(s);
  }
}
