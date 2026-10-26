// Scene tab: clip length, loop transition, solver and liquid settings.

import { LOOP_MODES } from '../../scene/doc';
import { ENTITY_DEFS } from '../../scene/entities';
import { h } from '../../util/dom';
import { opts } from '../paneKit';
import type { TabCtx, TabView } from './tab';

export function renderSceneTab(ctx: TabCtx): TabView {
  const { app, body } = ctx;
  const d = app.doc;
  body.append(h('div', { class: 'hint' }, 'Physics changes trigger a re-bake. The loop transition hides the seam so the clip repeats perfectly.'));
  const host = h('div');
  body.append(host);
  const p = ctx.pane(host);
  const g = p.addFolder({ title: 'Clip' });
  g.addBinding(d, 'duration', { label: 'Duration (s)', min: 2, max: 30, step: 0.5 }).on('change', () => app.commit('physics'));
  g.addBinding(d, 'fps', { label: 'Sim / video fps', options: { '60': 60, '30': 30 } }).on('change', () => app.commit('physics'));
  g.addBinding(d, 'seed', { label: 'Random seed', min: 1, max: 9999, step: 1 }).on('change', () => app.commit('physics'));

  const lp = p.addFolder({ title: 'Loop' });
  lp.addBinding(d.loop, 'mode', { label: 'Transition', options: opts(LOOP_MODES) }).on('change', () => app.commit('loop'));
  lp.addBinding(d.loop, 'outro', { label: 'Outro (s)', min: 0.2, max: 6, step: 0.05 }).on('change', () => app.commit('loop'));
  lp.addBinding(d.loop, 'stagger', { label: 'Stagger', min: 0, max: 0.95, step: 0.01 }).on('change', () => app.commit('loop'));
  lp.addBinding(d.loop, 'order', { label: 'Order', options: opts(['height', 'distance', 'index', 'random']) }).on('change', () => app.commit('visual'));
  lp.addBinding(d.loop, 'arc', { label: 'Reassemble arc', min: 0, max: 4, step: 0.01 }).on('change', () => app.commit('loop'));
  lp.addBinding(d.loop, 'intro', { label: 'Grow-in (s)', min: 0.05, max: 3, step: 0.05 }).on('change', () => app.commit('loop'));
  lp.addBinding(d.loop, 'rewind', { label: 'Rewind speed ×', min: 0.5, max: 6, step: 0.05 }).on('change', () => app.commit('loop'));
  lp.addBinding(d.loop, 'apex', { label: 'Apex slow-down (s)', min: 0, max: 3, step: 0.05 }).on('change', () => app.commit('loop'));

  const ph = p.addFolder({ title: 'AVBD solver' });
  ph.addBinding(d.physics, 'gravity', { label: 'Gravity', min: 0, max: 40, step: 0.01 }).on('change', () => app.commit('physics'));
  ph.addBinding(d.physics, 'timeScale', { label: 'Time scale', min: 0.1, max: 2, step: 0.01 }).on('change', () => app.commit('physics'));
  ph.addBinding(d.physics, 'substeps', { label: 'Substeps', min: 1, max: 8, step: 1 }).on('change', () => app.commit('physics'));
  ph.addBinding(d.physics, 'iterations', { label: 'Iterations', min: 1, max: 40, step: 1 }).on('change', () => app.commit('physics'));
  ph.addBinding(d.physics, 'colors', { label: 'GPU colours', min: 2, max: 16, step: 1 }).on('change', () => app.commit('physics'));
  ph.addBinding(d.physics, 'friction', { label: 'Friction (global)', min: 0, max: 2, step: 0.01 }).on('change', () => app.commit('physics'));
  ph.addBinding(d.physics, 'alpha', { label: 'α stabilisation', min: 0, max: 1, step: 0.005 }).on('change', () => app.commit('physics'));
  ph.addBinding(d.physics, 'beta', { label: 'β contacts', min: 10, max: 1e6, step: 10 }).on('change', () => app.commit('physics'));
  ph.addBinding(d.physics, 'jointBeta', { label: 'β joints', min: 100, max: 3e5, step: 100 }).on('change', () => app.commit('physics'));
  ph.addBinding(d.physics, 'gamma', { label: 'γ warm-start', min: 0.5, max: 1, step: 0.001 }).on('change', () => app.commit('physics'));
  ph.addBinding(d.physics, 'settle', { label: 'Settle pre-roll (s)', min: 0, max: 3, step: 0.05 }).on('change', () => app.commit('physics'));
  ph.addBinding(d.physics, 'drag', { label: 'Air drag (1/s)', min: 0, max: 10, step: 0.05 }).on('change', () => app.commit('physics'));
  ph.addBinding(d.physics, 'ground', { label: 'Ground collider' }).on('change', () => app.commit('physics'));

  const lq = p.addFolder({ title: 'Liquid (MLS-MPM)', expanded: d.entities.some((e) => !!ENTITY_DEFS[e.type]?.liquid) });
  const lqPhys = () => app.commit('physics');
  lq.addBinding(d.fluid, 'cell', { label: 'Grid cell (m)', min: 0.02, max: 0.3, step: 0.005 }).on('change', lqPhys);
  lq.addBinding(d.fluid, 'soundSpeed', { label: 'Stiffness (m/s)', min: 2, max: 30, step: 0.5 }).on('change', lqPhys);
  lq.addBinding(d.fluid, 'viscosity', { label: 'Viscosity', min: 0, max: 1, step: 0.01 }).on('change', lqPhys);
  lq.addBinding(d.fluid, 'density', { label: 'Density', min: 0.1, max: 10, step: 0.05 }).on('change', lqPhys);
  lq.addBinding(d.fluid, 'settle', { label: 'Settle pre-roll (s)', min: 0, max: 3, step: 0.05 }).on('change', lqPhys);
  lq.addBinding(d.fluid, 'maxParticles', { label: 'Max particles', min: 1000, max: 250000, step: 1000 }).on('change', lqPhys);
  const lqLook = () => app.commit('visual');
  const wc = { c: d.fluid.color };
  lq.addBinding(wc, 'c', { label: 'Colour', view: 'color' }).on('change', (ev: any) => { d.fluid.color = ev.value; lqLook(); });
  lq.addBinding(d.fluid, 'clarity', { label: 'Clarity (m)', min: 0.02, max: 5, step: 0.01 }).on('change', lqLook);
  lq.addBinding(d.fluid, 'refraction', { label: 'Refraction', min: 0, max: 2, step: 0.01 }).on('change', lqLook);
  lq.addBinding(d.fluid, 'smoothing', { label: 'Surface smoothing', min: 0, max: 1, step: 0.01 }).on('change', lqLook);
  lq.addBinding(d.fluid, 'foam', { label: 'Foam', min: 0, max: 1, step: 0.01 }).on('change', lqLook);
  return {};
}
