// Object tab: the selected entity's parameters, look, physics and motion,
// and the actions on the selection (one object or several).

import { COLOR_MODES, FINISHES } from '../../scene/doc';
import { ENTITY_DEFS } from '../../scene/entities';
import { shapePoints } from '../../scene/path';
import { h } from '../../util/dom';
import { PARAM_HELP } from '../help';
import { modal, toast } from '../kit';
import { addParam, bindVec, opts } from '../paneKit';
import type { TabCtx, TabView } from './tab';

export function renderObjectTab(ctx: TabCtx): TabView {
  const { app, body } = ctx;
  const e = app.selectedEntity;
  if (!e) {
    body.append(h('div', { class: 'empty' }, 'Select an object in the viewport or the scene list.', h('br'), h('br'),
      h('span', { class: 'kbd' }, 'Q'), ' move + rotate  ', h('span', { class: 'kbd' }, 'W'), ' move  ', h('span', { class: 'kbd' }, 'E'), ' rotate  ', h('span', { class: 'kbd' }, '⇧'), ' snap  ', h('span', { class: 'kbd' }, 'Space'), ' play'));
    return {};
  }
  if (app.selectedIds.length > 1) renderMultiHead(ctx);
  const def = ENTITY_DEFS[e.type];
  const name = h('input', { class: 'name-input', value: e.name, spellcheck: 'false' }) as HTMLInputElement;
  name.onchange = () => { e.name = name.value; app.commit('meta'); };
  body.append(h('div', { class: 'entity-head' }, h('span', { class: 'big' }, def.icon), name));
  const host = h('div');
  body.append(host);
  const p = ctx.pane(host);
  p.addBinding(e, 'enabled', { label: 'Enabled' }).on('change', () => app.commit('physics'));
  const cf = { v: e.camera !== false };
  p.addBinding(cf, 'v', { label: 'Camera follows' }).on('change', (ev: any) => { e.camera = ev.value ? undefined : false; app.refreshFollow(); app.commit('meta'); });
  const tf = p.addFolder({ title: 'Transform' });
  const posProxy = bindVec(app, tf, e, 'position', 'Position', { step: 0.01 }, 'physics');
  const rotProxy = bindVec(app, tf, e, 'rotation', 'Rotation°', { step: 0.5, min: -360, max: 360 }, 'physics');
  const pf = p.addFolder({ title: def.label });
  const conditional = def.params.some((x) => x.show);
  for (const spec of def.params) {
    if (spec.show && !spec.show(e.params)) continue;
    const blade = addParam(app, pf, e.params, spec, 'physics', e.id);
    const reshapes = conditional && spec.kind === 'select';
    if (def.onParamChange || reshapes) {
      blade.on('change', () => {
        if (def.onParamChange?.(e, spec.key)) app.commit('physics');
        else if (!reshapes) return;
        ctx.rerender();
      });
    }
    const text = PARAM_HELP[`${e.type}.${spec.key}`] ?? spec.help;
    const el = blade?.element as HTMLElement | undefined;
    if (text && el) el.dataset.tip = text;
  }
  // drawn paths: reshape and refine the control points
  if (e.type === 'path') {
    const pts = e.params.points?.length ?? 0;
    const shape = { s: '' };
    pf.addBinding(shape, 's', { label: 'Reshape', options: { '—': '', line: 'line', arc: 'arc', 'S-curve': 's-curve', zigzag: 'zigzag', circle: 'circle', helix: 'helix' } }).on('change', (ev: any) => {
      if (!ev.value) return;
      app.pushUndo();
      e.params.points = shapePoints(ev.value, 3);
      e.params.closed = ev.value === 'circle';
      if (ev.value === 'helix') e.params.drop = 0;
      app.commit('physics');
      ctx.rerender();
    });
    pf.addButton({ title: `Subdivide (${pts} points)` }).on('click', () => { app.tools.subdivide(e); ctx.rerender(); });
    body.insertBefore(h('div', { class: 'hint' }, 'Click a blue dot in the viewport to move that control point; Del removes it. The green dot is the start (the first domino is pushed there).'), host);
  }

  const lf = p.addFolder({ title: 'Look' });
  lf.addBinding(e.look, 'colorMode', { label: 'Colour mode', options: opts(COLOR_MODES) }).on('change', () => app.commit('visual'));
  const colorProxy = { c: e.look.color || '#cccccc' };
  lf.addBinding(colorProxy, 'c', { label: 'Colour', view: 'color' }).on('change', (ev: any) => { e.look.color = ev.value; app.commit('visual'); });
  lf.addBinding(e.look, 'paletteOffset', { label: 'Palette shift', min: 0, max: 12, step: 1 }).on('change', () => app.commit('visual'));
  lf.addBinding(e.look, 'finish', { label: 'Finish', options: opts(FINISHES) }).on('change', () => app.commit('visual'));

  const phf = p.addFolder({ title: 'Physics' });
  phf.addBinding(e.phys, 'body', { label: 'Body', options: opts(['dynamic', 'static', 'kinematic']) }).on('change', () => { app.commit('physics'); ctx.rerender(); });
  phf.addBinding(e.phys, 'density', { label: 'Density', min: 0.01, max: 500, step: 0.01 }).on('change', () => app.commit('physics'));
  phf.addBinding(e.phys, 'friction', { label: 'Friction', min: 0, max: 2, step: 0.01 }).on('change', () => app.commit('physics'));
  bindVec(app, phf, e.phys, 'velocity', 'Velocity', { step: 0.1, min: -100, max: 100 }, 'physics');
  bindVec(app, phf, e.phys, 'angularVelocity', 'Spin', { step: 0.1, min: -100, max: 100 }, 'physics');
  phf.addBinding(e.phys, 'spawnAt', { label: 'Appear at (s)', min: 0, max: app.doc.duration, step: 0.05 }).on('change', () => app.commit('physics'));

  if (e.phys.body !== 'dynamic') {
    const mf = p.addFolder({ title: 'Motion (kinematic, loops)' });
    mf.addBinding(e.motion, 'kind', { label: 'Motion', options: opts(['none', 'spin', 'swing', 'slide', 'gate']) }).on('change', () => { app.commit('physics'); ctx.rerender(); });
    if (e.motion.kind !== 'none') {
      bindVec(app, mf, e.motion, 'axis', 'Axis', { step: 0.05, min: -1, max: 1 }, 'physics');
      if (e.motion.kind !== 'gate') mf.addBinding(e.motion, 'cycles', { label: 'Cycles / loop', min: 1, max: 20, step: 1 }).on('change', () => app.commit('physics'));
      if (e.motion.kind !== 'spin') mf.addBinding(e.motion, 'amplitude', { label: e.motion.kind === 'slide' ? 'Amplitude (m)' : 'Angle (°)', min: -360, max: 360, step: 0.1 }).on('change', () => app.commit('physics'));
      if (e.motion.kind === 'spin') {
        const dir = { reverse: e.motion.amplitude < 0 };
        mf.addBinding(dir, 'reverse', { label: 'Reverse' }).on('change', (ev: any) => { e.motion.amplitude = Math.abs(e.motion.amplitude) * (ev.value ? -1 : 1); app.commit('physics'); });
      }
      mf.addBinding(e.motion, 'phase', { label: 'Phase', min: 0, max: 1, step: 0.01 }).on('change', () => app.commit('physics'));
      if (e.motion.kind === 'gate') {
        bindVec(app, mf, e.motion, 'offset', 'Offset', { step: 0.05 }, 'physics');
        mf.addBinding(e.motion, 'open', { label: 'Open at', min: 0, max: app.doc.duration, step: 0.05 }).on('change', () => app.commit('physics'));
        mf.addBinding(e.motion, 'close', { label: 'Close at', min: 0, max: app.doc.duration, step: 0.05 }).on('change', () => app.commit('physics'));
        mf.addBinding(e.motion, 'ease', { label: 'Ease (s)', min: 0.02, max: 3, step: 0.01 }).on('change', () => app.commit('physics'));
      }
    }
  }
  const actions = p.addFolder({ title: 'Actions', expanded: true });
  addSelectionActions(ctx, actions);
  actions.addButton({ title: 'Move up in list' }).on('click', () => app.moveEntity(e.id, -1));

  return {
    sync() {
      posProxy.v = { x: e.position[0], y: e.position[1], z: e.position[2] };
      rotProxy.v = { x: e.rotation[0], y: e.rotation[1], z: e.rotation[2] };
      p.refresh();
    },
  };
}

/** Buttons shared by single and multiple selections. */
function addSelectionActions(ctx: TabCtx, folder: any): void {
  const { app } = ctx;
  const n = app.selectedIds.length;
  folder.addButton({ title: n > 1 ? `Duplicate ${n} objects (⌘D)` : 'Duplicate (⌘D)' }).on('click', () => app.duplicateEntities([...app.selectedIds]));
  folder.addButton({ title: 'Copy (⌘C) — paste with ⌘V, even in another scene' }).on('click', () => toast(`${app.tools.copySelection()} object(s) copied`));
  folder.addButton({ title: 'Drop onto the surface below (End)' }).on('click', () => app.tools.dropSelection());
  folder.addButton({ title: 'Repeat…' }).on('click', () => openArray(ctx));
  folder.addButton({ title: 'Save as gadget…' }).on('click', () => {
    const first = app.selectedEntities[0];
    const name = prompt('Name of the gadget', first?.group ?? first?.name ?? 'Gadget');
    if (name && app.tools.saveGadget(name.trim() || 'Gadget')) toast(`“${name}” saved in My gadgets`);
  });
  const soloOn = !!app.solo && app.selectedIds.every((x) => app.solo!.has(x)) && app.solo.size === app.selectedIds.length;
  folder.addButton({ title: soloOn ? 'Leave solo (bake everything)' : 'Solo: bake only this' }).on('click', () => app.setSolo(soloOn ? null : [...app.selectedIds]));
  folder.addButton({ title: n > 1 ? `Delete ${n} objects` : 'Delete' }).on('click', () => app.removeEntities([...app.selectedIds]));
}

/** Header of a multiple selection: count, grouping, shared actions. */
function renderMultiHead(ctx: TabCtx): void {
  const { app } = ctx;
  const sel = app.selectedEntities;
  const groups = new Set(sel.map((x) => x.group ?? ''));
  const one = groups.size === 1 && !groups.has('') ? [...groups][0] : null;
  const box = h('div', { class: 'multi-head' });
  const nameIn = h('input', { class: 'name-input', value: one ?? '', placeholder: 'Group name', spellcheck: 'false' }) as HTMLInputElement;
  nameIn.onchange = () => app.groupSelection(nameIn.value.trim() || '');
  box.append(
    h('div', { class: 'multi-title' }, h('b', {}, `${sel.length} objects`), one ? h('span', {}, ` · group`) : h('span', {}, ' · not grouped')),
    h('div', { class: 'multi-row' }, nameIn,
      one ? h('button', { class: 'btn', title: 'Ungroup (⇧⌘G)', onclick: () => app.groupSelection(null) }, 'Ungroup')
        : h('button', { class: 'btn', title: 'Group (⌘G): clicking one part then selects them all', onclick: () => app.groupSelection(nameIn.value.trim() || '') }, 'Group')),
    h('div', { class: 'hint' }, 'The gizmo moves and turns them together. Below: the last one clicked.'),
  );
  const host = h('div');
  box.append(host);
  ctx.body.append(box);
  addSelectionActions(ctx, ctx.pane(host).addFolder({ title: 'Selection', expanded: true }));
}

/** Dialog: copies of the selection in a row or a ring. */
function openArray(ctx: TabCtx): void {
  const f = { count: 5, dx: 1, dy: 0, dz: 0, yaw: 0 };
  const inputs: Record<string, HTMLInputElement> = {};
  const field = (k: keyof typeof f, label: string, step: string) => {
    const i = h('input', { type: 'number', class: 'sel', value: String(f[k]), step }) as HTMLInputElement;
    inputs[k] = i;
    return h('div', { class: 'field' }, h('label', {}, label), i);
  };
  let close = () => {};
  close = modal(h('div', { class: 'modal' },
    h('h3', {}, 'Repeat the selection'),
    h('p', {}, 'Copies in a row (or a ring, with a turn per copy). They form one group with the original.'),
    field('count', 'Total count', '1'), field('dx', 'Step X (m)', '0.05'), field('dy', 'Step Y (m)', '0.05'), field('dz', 'Step Z (m)', '0.05'), field('yaw', 'Turn per copy (°)', '1'),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => {
        const v = (k: string) => Number(inputs[k].value) || 0;
        close();
        ctx.app.tools.arraySelection(Math.max(2, Math.round(v('count'))), [v('dx'), v('dy'), v('dz')], v('yaw'));
      } }, 'Repeat'))));
}
