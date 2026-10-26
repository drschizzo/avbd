// Which entities are selected: a primary one (the one the Object tab edits)
// and every selected id. Groups select together unless asked for one member.

import type { Entity, SceneDoc } from '../scene/doc';

export interface SelectOpts {
  /** add or remove (Shift-click) */
  toggle?: boolean;
  /** one member of a group, not the whole group (Alt-click) */
  single?: boolean;
  /** add to the selection */
  add?: boolean;
}

export class Selection {
  /** primary selection */
  primary: string | null = null;
  /** every selected entity id (includes `primary`) */
  ids: string[] = [];

  clear(): void {
    this.primary = null;
    this.ids = [];
  }

  select(doc: SceneDoc, id: string | null, opts: SelectOpts = {}): void {
    if (id === null) { this.clear(); return; }
    const e = doc.entities.find((x) => x.id === id);
    const ids = e?.group && !opts.single ? doc.entities.filter((x) => x.group === e.group).map((x) => x.id) : [id];
    if (opts.toggle) {
      const all = ids.every((x) => this.ids.includes(x));
      this.ids = all ? this.ids.filter((x) => !ids.includes(x)) : [...new Set([...this.ids, ...ids])];
      this.primary = all ? (this.ids[this.ids.length - 1] ?? null) : id;
    } else if (opts.add) {
      this.ids = [...new Set([...this.ids, ...ids])];
      this.primary = id;
    } else {
      this.ids = ids;
      this.primary = id;
    }
  }

  /** Exactly these ids (unknown ones dropped); the primary defaults to the last. */
  set(doc: SceneDoc, ids: string[], primary?: string): void {
    const known = new Set(doc.entities.map((e) => e.id));
    this.ids = ids.filter((x) => known.has(x));
    this.primary = primary && this.ids.includes(primary) ? primary : (this.ids[this.ids.length - 1] ?? null);
  }

  /** Forgets removed entities. */
  drop(gone: Set<string>): void {
    this.ids = this.ids.filter((x) => !gone.has(x));
    if (this.primary && gone.has(this.primary)) this.primary = this.ids[this.ids.length - 1] ?? null;
  }

  entity(doc: SceneDoc): Entity | null {
    return doc.entities.find((e) => e.id === this.primary) ?? null;
  }

  entities(doc: SceneDoc): Entity[] {
    const ids = new Set(this.ids);
    return doc.entities.filter((e) => ids.has(e.id));
  }

  /** Indices in doc.entities. */
  indices(doc: SceneDoc): Set<number> {
    const ids = new Set(this.ids);
    const out = new Set<number>();
    doc.entities.forEach((e, i) => { if (ids.has(e.id)) out.add(i); });
    return out;
  }
}
