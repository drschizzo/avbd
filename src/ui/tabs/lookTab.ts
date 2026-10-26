// Look tab: palette, light, post-processing and bevels.

import { PALETTES, PALETTE_KEYS } from '../../scene/palettes';
import { h } from '../../util/dom';
import { opts } from '../paneKit';
import type { TabCtx, TabView } from './tab';

export function renderLookTab(ctx: TabCtx): TabView {
  const { app, body } = ctx;
  const r = app.doc.render;
  const pal = PALETTES[r.palette];
  if (pal) body.append(h('div', { class: 'hint', style: 'display:flex;gap:4px' }, ...pal.colors.map((c) => h('span', { class: 'swatch', style: `background:${c};width:28px;height:18px;border-radius:5px` }))));
  const host = h('div');
  body.append(host);
  const p = ctx.pane(host);
  const v = () => app.commit('visual');
  const col = p.addFolder({ title: 'Colour' });
  col.addBinding(r, 'palette', { label: 'Palette', options: Object.fromEntries(PALETTE_KEYS.map((k) => [PALETTES[k].name, k])) }).on('change', () => { v(); ctx.rerender(); });
  const bg = { c: r.background || pal?.background || '#000000' };
  col.addBinding(bg, 'c', { label: 'Background', view: 'color' }).on('change', (ev: any) => { r.background = ev.value; v(); });
  const fl = { c: r.floorColor || pal?.floor || '#000000' };
  col.addBinding(fl, 'c', { label: 'Floor colour', view: 'color' }).on('change', (ev: any) => { r.floorColor = ev.value; v(); });
  col.addButton({ title: 'Use palette background' }).on('click', () => { r.background = ''; r.floorColor = ''; v(); ctx.rerender(); });
  col.addBinding(r, 'floor', { label: 'Floor', options: opts(['plain', 'grid', 'mirror', 'none']) }).on('change', v);
  col.addBinding(r, 'aspect', { label: 'Aspect', options: opts(['1:1', '9:16', '4:5', '16:9']) }).on('change', () => { v(); ctx.refit(); });

  const li = p.addFolder({ title: 'Light' });
  li.addBinding(r, 'lightAzimuth', { label: 'Azimuth', min: -180, max: 180, step: 1 }).on('change', v);
  li.addBinding(r, 'lightElevation', { label: 'Elevation', min: 5, max: 89, step: 1 }).on('change', v);
  li.addBinding(r, 'lightIntensity', { label: 'Intensity', min: 0, max: 10, step: 0.05 }).on('change', v);
  li.addBinding(r, 'shadowSoftness', { label: 'Shadow softness', min: 0, max: 1, step: 0.01 }).on('change', v);
  li.addBinding(r, 'envIntensity', { label: 'Environment', min: 0, max: 3, step: 0.01 }).on('change', v);
  li.addBinding(r, 'exposure', { label: 'Exposure', min: 0.2, max: 3, step: 0.01 }).on('change', v);

  const fx = p.addFolder({ title: 'Post' });
  fx.addBinding(r, 'ao', { label: 'Ambient occlusion', min: 0, max: 1, step: 0.01 }).on('change', v);
  fx.addBinding(r, 'bloom', { label: 'Bloom', min: 0, max: 2, step: 0.01 }).on('change', v);
  fx.addBinding(r, 'bloomThreshold', { label: 'Bloom threshold', min: 0, max: 2, step: 0.01 }).on('change', v);
  fx.addBinding(r, 'dof', { label: 'Depth of field', min: 0, max: 1, step: 0.01 }).on('change', v);
  fx.addBinding(r, 'focus', { label: 'Focus dist. (0=auto)', min: 0, max: 60, step: 0.05 }).on('change', v);
  fx.addBinding(r, 'vignette', { label: 'Vignette', min: 0, max: 1, step: 0.01 }).on('change', v);
  fx.addBinding(r, 'grain', { label: 'Grain', min: 0, max: 0.2, step: 0.002 }).on('change', v);
  fx.addBinding(r, 'aa', { label: 'Anti-aliasing', options: opts(['msaa', 'smaa', 'fxaa', 'none']) }).on('change', v);
  const geo = p.addFolder({ title: 'Geometry' });
  geo.addBinding(r, 'bevel', { label: 'Bevel', min: 0, max: 0.5, step: 0.005 }).on('change', v);
  return {};
}
