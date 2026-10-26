// Camera tab: the exported shot and its periodic motion.

import { FOLLOW_DEFAULTS } from '../../scene/doc';
import { h } from '../../util/dom';
import { bindVec, opts } from '../paneKit';
import type { TabCtx, TabView } from './tab';

export function renderCameraTab(ctx: TabCtx): TabView {
  const { app, body } = ctx;
  const c = app.doc.camera;
  body.append(h('div', { class: 'hint' }, 'In “Shot” mode, orbiting the viewport directs the exported camera. All motions are periodic so the loop stays seamless. Orbit always makes whole turns (Amount adds a vertical bob); sway, dolly and crane use Amount as their range. Follow keeps the shot’s angle but comes close and tracks where things move, from the last bake (Amount adds a sway).'));
  const host = h('div');
  body.append(host);
  const p = ctx.pane(host);
  const k = () => app.commit('camera');
  p.addBinding(c, 'motion', { label: 'Motion', options: opts(['static', 'orbit', 'sway', 'dolly', 'crane', 'follow']) }).on('change', () => { k(); ctx.rerender(); });
  if (c.motion === 'follow') {
    Object.assign(c, { ...FOLLOW_DEFAULTS, ...c });
    const fo = p.addFolder({ title: 'Follow' });
    fo.addBinding(c, 'followSize', { label: 'Closeness (m)', min: 0.3, max: 6, step: 0.05 }).on('change', k);
    fo.addBinding(c, 'followSmooth', { label: 'Smoothing (s)', min: 0.1, max: 3, step: 0.05 }).on('change', k);
    fo.addBinding(c, 'followLead', { label: 'Look ahead (s)', min: 0, max: 1.5, step: 0.05 }).on('change', k);
    if (!app.report) fo.addBlade({ view: 'text', label: '', parse: (v: string) => v, value: 'bake first', disabled: true });
  }
  p.addBinding(c, 'amount', { label: 'Amount', min: 0, max: 90, step: 0.5 }).on('change', k);
  p.addBinding(c, 'cycles', { label: 'Cycles / loop', min: 1, max: 6, step: 1 }).on('change', k);
  p.addBinding(c, 'fov', { label: 'Field of view', min: 8, max: 90, step: 0.5 }).on('change', k);
  const pos = bindVec(app, p, c, 'position', 'Position', { step: 0.05 }, 'camera');
  const tgt = bindVec(app, p, c, 'target', 'Target', { step: 0.05 }, 'camera');
  const sync = () => {
    pos.v = { x: c.position[0], y: c.position[1], z: c.position[2] };
    tgt.v = { x: c.target[0], y: c.target[1], z: c.target[2] };
    p.refresh();
  };
  p.addButton({ title: 'Frame the scene' }).on('click', () => {
    const b = app.built.bounds;
    const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = (b.min[2] + b.max[2]) / 2;
    const ext = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    const dist = (ext * 0.75) / Math.tan((c.fov * Math.PI) / 360) + 1;
    c.target = [cx, cy * 0.85, cz];
    c.position = [cx + dist * 0.62, cy + dist * 0.45, cz + dist * 0.65];
    k();
    sync();
  });
  return { sync };
}
