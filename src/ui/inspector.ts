// The right-hand inspector: a tab bar and the active tab, rendered again
// from the document whenever its structure changes.

import { Pane } from 'tweakpane';
import type { App } from '../app';
import { h } from '../util/dom';
import { annotate } from './paneKit';
import { renderCameraTab } from './tabs/cameraTab';
import { renderLookTab } from './tabs/lookTab';
import { renderMachineTab } from './tabs/machineTab';
import { renderObjectTab } from './tabs/objectTab';
import { renderSceneTab } from './tabs/sceneTab';
import { TAB_NAMES, type TabCtx, type TabName, type TabView } from './tabs/tab';

const RENDER: Record<TabName, (ctx: TabCtx) => TabView> = {
  Object: renderObjectTab,
  Machine: renderMachineTab,
  Scene: renderSceneTab,
  Look: renderLookTab,
  Camera: renderCameraTab,
};

export class Inspector {
  readonly el: HTMLElement;
  private tabBar = h('div', { class: 'tabs', 'data-tut': 'tabs' });
  private body = h('div', { class: 'tabbody', 'data-tut': 'tabbody' });
  private active: TabName = 'Object';
  private panes: Pane[] = [];
  private view: TabView = {};

  constructor(private app: App, private hooks: { refit(): void; hideTip(): void }) {
    this.el = h('div', { class: 'right' }, this.tabBar, this.body);
  }

  get tab(): TabName { return this.active; }

  /** Shows tab `t` (rendering it again even if it is already shown). */
  show(t: TabName): void {
    this.active = t;
    this.render();
  }

  /** True if `t` names a tab. */
  static isTab(t: string): t is TabName { return (TAB_NAMES as readonly string[]).includes(t); }

  render(): void {
    for (const p of this.panes.splice(0)) p.dispose();
    this.body.replaceChildren();
    const app = this.app;
    const alert = app.report && !app.reportStale && !app.report.ok;
    this.tabBar.replaceChildren(...TAB_NAMES.map((t) => h('button', {
      class: `tab${t === this.active ? ' on' : ''}${t === 'Machine' && alert ? ' alert' : ''}`, 'data-tut': `tab-${t}`,
      onclick: () => this.show(t),
    }, t)));
    this.hooks.hideTip();
    this.view = RENDER[this.active]({
      app,
      body: this.body,
      pane: (container) => { const p = new Pane({ container }); this.panes.push(p); return p; },
      // after the control's own change handling: re-rendering disposes the
      // pane, which Tweakpane must not be in the middle of updating
      rerender: () => this.renderSoon(),
      refit: () => this.hooks.refit(),
    });
    annotate(this.body, this.active);
  }

  private pending = false;
  private renderSoon(): void {
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => { this.pending = false; this.render(); });
  }

  /** Values of the shown tab changed elsewhere (gizmo drag, orbit). */
  sync(): void { this.view.sync?.(); }

  /** Flags the Machine tab when a check fails while another tab is shown. */
  flagMachine(): void {
    this.tabBar.querySelector('.tab:nth-child(2)')?.classList.add('alert');
  }
}
