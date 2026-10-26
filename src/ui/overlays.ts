// What floats over the viewport: mode pill, gizmo and camera switches, the
// edit toolbar (select / draw / work plane) with its hint, and live stats.

import type { App } from '../app';
import { FILL_LABEL, type PlaneAxis } from '../edit/tools';
import { PATH_FILLS, type PathFill } from '../scene/path';
import { h } from '../util/dom';

export class ViewportOverlays {
  readonly modePill = h('div', { class: 'pill edit', 'data-tut': 'mode' }, h('span', { class: 'dot' }), h('span', {}, 'EDIT'));
  readonly gizmoSeg = h('div', { class: 'seg', 'data-tut': 'gizmo' });
  readonly camSeg = h('div', { class: 'seg', 'data-tut': 'cam' });
  readonly stats = h('div', { class: 'stats' });
  readonly toolBar = h('div', { class: 'overlay ov-tl2' });
  readonly toolHint = h('div', { class: 'overlay ov-hint' });
  private lastStats = 0;

  constructor(private app: App) {}

  /** Gizmo mode and shot / free camera switches. */
  renderSwitches(): void {
    const app = this.app;
    this.gizmoSeg.replaceChildren(
      h('button', { class: app.view.gizmoMode === 'all' ? 'on' : '', title: 'Move + rotate (Q) — hold Shift to snap', onclick: () => app.view.setGizmoMode('all') }, '✥⟳'),
      h('button', { class: app.view.gizmoMode === 'translate' ? 'on' : '', title: 'Move only (W) — hold Shift to snap 0.25 m', onclick: () => app.view.setGizmoMode('translate') }, '✥'),
      h('button', { class: app.view.gizmoMode === 'rotate' ? 'on' : '', title: 'Rotate only (E) — hold Shift to snap 15°', onclick: () => app.view.setGizmoMode('rotate') }, '⟳'),
    );
    this.camSeg.replaceChildren(
      h('button', { class: !app.freeCamera ? 'on' : '', title: 'Shot camera (exported view)', onclick: () => { app.freeCamera = false; app.applyCameraFromDoc(); this.renderSwitches(); } }, '🎬 Shot'),
      h('button', { class: app.freeCamera ? 'on' : '', title: 'Free camera (does not change the shot)', onclick: () => { app.freeCamera = true; this.renderSwitches(); } }, 'Free'),
    );
  }

  renderToolBar(): void {
    const app = this.app;
    const t = app.tools;
    if (!t) return;
    const toolBar = this.toolBar, toolHint = this.toolHint;
    toolBar.style.display = app.mode === 'edit' ? '' : 'none';
    const fillSel = h('select', { class: 'mini-sel', title: 'What the drawn path is filled with' },
      ...PATH_FILLS.map((f) => h('option', { value: f, selected: f === t.drawFill }, FILL_LABEL[f]))) as HTMLSelectElement;
    fillSel.onchange = () => { t.drawFill = fillSel.value as PathFill; if (t.tool !== 'draw') t.setTool('draw'); else this.renderToolBar(); };
    const planeBtn = (a: PlaneAxis, label: string, tip: string) =>
      h('button', { class: t.plane.axis === a ? 'on' : '', title: tip, onclick: () => t.setPlane(t.plane.axis === a ? 'off' : a) }, label);
    const planeOn = t.plane.axis !== 'off';
    toolBar.replaceChildren(
      h('div', { class: 'seg', 'data-tut': 'draw' },
        h('button', { class: t.tool === 'select' ? 'on' : '', title: 'Select & move (V)', onclick: () => t.setTool('select') }, '↖'),
        h('button', { class: t.tool === 'draw' ? 'on' : '', title: 'Draw a path (D): drag in the viewport — dominoes, marbles, blocks, rails, ramps, walls', onclick: () => t.setTool(t.tool === 'draw' ? 'select' : 'draw') }, '✎ Draw'),
        fillSel),
      h('div', { class: 'seg', 'data-tut': 'plane' },
        h('span', { class: 'seg-label', title: 'Work plane (P): drawing and placing land on it, the gizmo keeps to it' }, 'Plane'),
        planeBtn('xy', 'XY', 'Front plane (XY): build a machine in a vertical slice facing the camera'),
        planeBtn('zy', 'ZY', 'Side plane (ZY)'),
        planeBtn('xz', 'XZ', 'Horizontal plane (XZ) at a chosen height: lay out a level'),
        planeOn ? h('button', { title: 'Move the plane back (−0.25 m, [)', onclick: () => t.nudgePlane(-0.25) }, '−') : null,
        planeOn ? h('span', { class: 'seg-val', title: 'Plane position (m)' }, t.plane.offset.toFixed(2)) : null,
        planeOn ? h('button', { title: 'Move the plane forward (+0.25 m, ])', onclick: () => t.nudgePlane(0.25) }, '+') : null,
        planeOn ? h('button', { title: 'Look at the plane square on (free camera)', onclick: () => t.facePlane() }, '⊡') : null),
      h('div', { class: 'seg' },
        h('button', { title: 'Drop the selection onto what is below it (End). A drawn path: every point', onclick: () => t.dropSelection(), disabled: app.selectedIds.length === 0 }, '⤓'),
        h('button', { title: 'Frame the selection (F) — free camera, the shot is untouched', onclick: () => t.frameSelection() }, '⌖')),
    );
    let hint = '';
    if (t.placing) hint = 'Click to drop · ⇧ grid snap · ⌥ no port snapping · right-click / Esc cancels';
    else if (t.tool === 'draw') hint = `Drag to draw a ${FILL_LABEL[t.drawFill].toLowerCase()}${planeOn ? ' on the plane' : ' on the scene'} · Esc to stop`;
    else if (t.handleIndex !== null) hint = 'Control point: drag the arrows · Del removes it · Esc releases it';
    toolHint.textContent = hint;
    toolHint.style.display = hint ? '' : 'none';
  }

  /** Per frame: mode pill (with bake progress) and stats. */
  frame(): void {
    const app = this.app;
    const baking = app.baking;
    this.modePill.className = `pill ${baking ? 'bake' : app.mode === 'play' ? 'play' : 'edit'}`;
    this.modePill.lastChild!.textContent = baking
      ? `BAKING ${Math.round((app.bakeProgress.frame / Math.max(1, app.bakeProgress.total)) * 100)}%`
      : app.mode === 'play' ? 'PLAYBACK' : 'EDIT';
    this.gizmoSeg.style.display = app.mode === 'edit' ? '' : 'none';
    this.toolBar.style.display = app.mode === 'edit' ? '' : 'none';
    this.updateStats();
  }

  private updateStats(): void {
    const now = performance.now();
    if (now - this.lastStats < 250) return;
    this.lastStats = now;
    const app = this.app;
    const b = app.built;
    const dyn = b ? b.bodies.filter((x) => x.kind === 0).length : 0;
    const res = app.bakes.current;
    const mem = res ? (res.history.array.byteLength / 1048576).toFixed(0) : '0';
    this.stats.innerHTML = `<b>${b?.bodies.length ?? 0}</b> bodies · <b>${dyn}</b> dynamic · <b>${b?.joints.length ?? 0}</b> joints<br>`
      + `render <b>${app.fpsMeter.fps.toFixed(0)}</b> fps · history <b>${mem}</b> MB`
      + (app.baker.lastStats.msPerFrame && !app.baking ? ` · sim <b>${app.baker.lastStats.msPerFrame.toFixed(1)}</b> ms/f` : '');
  }
}
