// What every inspector tab gets, and gives back.

import type { App } from '../../app';

export const TAB_NAMES = ['Object', 'Machine', 'Scene', 'Look', 'Camera'] as const;
export type TabName = typeof TAB_NAMES[number];

export interface TabCtx {
  app: App;
  /** where the tab renders (emptied before each render) */
  body: HTMLElement;
  /** A Tweakpane in `container`, disposed when the tab renders again. */
  pane(container: HTMLElement): any;
  /** renders the active tab again (after a change that reshapes it) */
  rerender(): void;
  /** re-fits the viewport (after an aspect change) */
  refit(): void;
}

export interface TabView {
  /** shows values changed from elsewhere (a gizmo drag, an orbit) without rebuilding */
  sync?(): void;
}
