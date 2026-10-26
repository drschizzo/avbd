// What the app announces to its panels (UI, tutorial). A closed list: a
// misspelt event name is a compile error, not a listener that never fires.

/** What a `commit` changed (and the event it emits). */
export type ChangeKind = 'physics' | 'visual' | 'camera' | 'loop' | 'meta';

export type AppEvent =
  | ChangeKind
  | 'doc' // a whole new document
  | 'select'
  | 'mode' // edit / play
  | 'time' // playback time or state
  | 'tool' // edit tool, placement, workplane
  | 'gizmo' // gizmo mode
  | 'transform' // live drag of the selection (not committed yet)
  | 'library' // saved gadgets
  | 'solo'
  | 'bake' // bake started, finished, failed or invalidated
  | 'bake-progress'
  | 'report' // machine check
  | 'trials';

export type Listener<E> = (what: E) => void;

export class Emitter<E> {
  private listeners: Listener<E>[] = [];

  /** Returns the unsubscribe function. */
  on(fn: Listener<E>): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((l) => l !== fn); };
  }

  emit(what: E): void {
    for (const l of this.listeners) l(what);
  }
}
