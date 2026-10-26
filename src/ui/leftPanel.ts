// The left column: the palette of parts (plus the user's saved gadgets) and
// the scene list.

import type { App } from '../app';
import type { Entity, EntityType } from '../scene/doc';
import { ENTITY_DEFS } from '../scene/entities';
import { PALETTES } from '../scene/palettes';
import { h } from '../util/dom';
import { KEYS, readText, writeText } from '../util/storage';

export class LeftPanel {
  readonly el: HTMLElement;
  private palette = h('div', { class: 'palette' });
  private libBox = h('div');
  private outliner = h('div', { class: 'outliner', 'data-tut': 'outliner' });

  constructor(private app: App) {
    const addTitle = h('div', { class: 'section-title fold', title: 'Show / hide the object palette' }, h('span', {}, h('span', { class: 'chev' }, '▾'), 'Add'));
    const collapsed = readText(KEYS.addCollapsed) === '1';
    this.el = h('div', { class: `left${collapsed ? ' add-collapsed' : ''}` },
      addTitle, this.palette,
      h('div', { class: 'section-title' }, 'Scene', h('span', { class: 'kbd' }, 'Del · ⌘D')), this.outliner);
    addTitle.onclick = () => {
      const now = this.el.classList.toggle('add-collapsed');
      writeText(KEYS.addCollapsed, now ? '1' : '0');
    };
    this.renderPalette();
  }

  renderPalette(): void {
    const cats: Record<string, EntityType[]> = {};
    (Object.keys(ENTITY_DEFS) as EntityType[]).forEach((t) => { (cats[ENTITY_DEFS[t].category] ??= []).push(t); });
    this.palette.replaceChildren();
    for (const [cat, types] of Object.entries(cats)) {
      this.palette.append(h('div', { class: 'cat' }, cat));
      const grid = h('div', { class: 'grid' });
      for (const t of types) {
        grid.append(h('button', { class: 'tile', 'data-tut': `add-${t}`, title: `Add ${ENTITY_DEFS[t].label} — it follows the cursor, click to drop it`, onclick: () => this.app.addEntity(t) },
          h('span', { class: 'ic' }, ENTITY_DEFS[t].icon), ENTITY_DEFS[t].label));
      }
      this.palette.append(grid);
    }
    this.palette.append(this.libBox);
    this.renderLibrary();
  }

  /** "My gadgets": parts saved from earlier machines. */
  renderLibrary(): void {
    const app = this.app, libBox = this.libBox;
    libBox.replaceChildren();
    const lib = app.tools?.gadgets() ?? [];
    libBox.append(h('div', { class: 'cat' }, 'My gadgets'));
    if (lib.length === 0) {
      libBox.append(h('div', { class: 'lib-empty' }, 'Select parts of a machine, then “Save as gadget” to reuse them here.'));
      return;
    }
    const grid = h('div', { class: 'grid' });
    lib.forEach((g, i) => {
      grid.append(h('button', { class: 'tile lib', title: `${g.name} (${g.entities.length} parts) — click to place`, onclick: () => app.tools.insertGadget(i) },
        h('span', { class: 'ic' }, '✦'), g.name,
        h('span', { class: 'del', title: 'Remove from the library', onclick: (ev: Event) => { ev.stopPropagation(); if (confirm(`Remove “${g.name}” from your gadgets?`)) app.tools.deleteGadget(i); } }, '✕')));
    });
    libBox.append(grid);
  }

  /** The scene list: entities, groups, selection, quick actions. */
  renderOutliner(): void {
    const app = this.app, outliner = this.outliner;
    outliner.replaceChildren();
    if (app.doc.entities.length === 0) {
      outliner.append(h('div', { class: 'tabbody' }, h('div', { class: 'empty' }, 'Empty scene. Add objects above, draw a path (D) or load a preset.')));
    }
    const counts = new Map<number, number>();
    for (const b of app.built?.bodies ?? []) counts.set(b.entity, (counts.get(b.entity) ?? 0) + 1);
    const sel = new Set(app.selectedIds);
    const pal = PALETTES[app.doc.render.palette] ?? PALETTES.sorbet;
    const entityRow = (e: Entity, i: number, member: boolean) => {
      const def = ENTITY_DEFS[e.type];
      const sw = e.look.colorMode === 'single' ? (e.look.color || pal.statics) : `linear-gradient(135deg, ${pal.colors.slice(0, 4).join(',')})`;
      const solo = app.solo && !app.solo.has(e.id);
      return h('div', {
        class: `row${sel.has(e.id) ? ' sel' : ''}${e.id === app.selection ? ' primary' : ''}${e.enabled ? '' : ' off'}${member ? ' member' : ''}${solo ? ' muted' : ''}`,
        title: member ? 'Click: the group · ⌥-click: this part only · ⇧-click: add / remove' : '⇧-click to add to the selection',
        onclick: (ev: MouseEvent) => app.select(e.id, { toggle: ev.shiftKey || ev.metaKey, single: ev.altKey }),
      },
        h('span', { class: 'ic' }, def.icon),
        h('span', { class: 'swatch', style: `background:${sw}` }),
        h('span', { class: 'nm' }, e.name),
        h('span', { class: 'meta' }, String(counts.get(i) ?? 0)),
        h('span', { class: 'act' },
          h('button', { title: e.enabled ? 'Disable' : 'Enable', onclick: (ev: Event) => { ev.stopPropagation(); e.enabled = !e.enabled; app.commit('physics'); } }, e.enabled ? '◉' : '○'),
          h('button', { title: 'Duplicate', onclick: (ev: Event) => { ev.stopPropagation(); app.duplicateEntities([e.id]); } }, '⧉'),
          h('button', { title: 'Delete', onclick: (ev: Event) => { ev.stopPropagation(); app.removeEntity(e.id); } }, '✕')),
      );
    };
    const done = new Set<string>();
    app.doc.entities.forEach((e, i) => {
      if (!e.group) { outliner.append(entityRow(e, i, false)); return; }
      if (done.has(e.group)) return;
      done.add(e.group);
      const g = e.group;
      const members = app.doc.entities.map((x, k) => [x, k] as const).filter(([x]) => x.group === g);
      const allSel = members.every(([x]) => sel.has(x.id));
      outliner.append(h('div', { class: `row group${allSel ? ' sel' : ''}`, title: 'Select the whole group', onclick: (ev: MouseEvent) => app.select(members[0][0].id, { toggle: ev.shiftKey || ev.metaKey }) },
        h('span', { class: 'ic' }, '▤'),
        h('span', { class: 'nm' }, g),
        h('span', { class: 'meta' }, `${members.length} parts`),
        h('span', { class: 'act' },
          h('button', { title: 'Ungroup', onclick: (ev: Event) => { ev.stopPropagation(); app.selectMany(members.map(([x]) => x.id)); app.groupSelection(null); } }, '⊟'))));
      for (const [x, k] of members) outliner.append(entityRow(x, k, true));
    });
  }
}
