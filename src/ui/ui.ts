// The editor's page: lays out the panels, keeps the viewport at the clip's
// aspect, and routes app events to the panels that show what changed.

import type { App } from '../app';
import { mountCourse, type Course } from '../course';
import { snapshotPNG } from '../export/video';
import { mountTutorial, tutorialNeverOpened, type Tutorial } from '../tutorial';
import { h } from '../util/dom';
import { openExport, openFile, openPresets, showInvite } from './dialogs';
import { Inspector } from './inspector';
import { ASPECTS, download, exportDims, slug, toast } from './kit';
import { LeftPanel } from './leftPanel';
import { ViewportOverlays } from './overlays';
import { installTooltips } from './paneKit';
import { installShortcuts } from './shortcuts';
import { Timeline } from './timeline';

export interface UI {
  canvas: HTMLCanvasElement;
  ready(): void;
  fatal(msg: string): void;
  frame(): void;
}

export function mountUI(root: HTMLElement, app: App): UI {
  // the interactive course, mounted on first use (it takes over the viewport)
  let courseRef: Course | null = null;
  const course = () => (courseRef ??= mountCourse(app));
  // the guided tour of the editor, mounted on first use (the editor stays live)
  let tutorialRef: Tutorial | null = null;
  const tutorial = () => (tutorialRef ??= mountTutorial(app, {
    tab: () => inspector.tab,
    setTab: (t) => { if (Inspector.isTab(t) && inspector.tab !== t) inspector.show(t); },
    openPresets: () => openPresets(app),
    openCourse: () => openCourse(),
  }));
  // the tutorial stays open underneath the course (hidden by body.course-on)
  const openCourse = () => course().open();
  let removeInvite: (() => void) | null = null;

  // ---------------------------------------------------------------- layout
  const canvas = h('canvas', { tabindex: '0' });
  const frame = h('div', { class: 'frame' }, canvas);
  const overlays = new ViewportOverlays(app);
  const view = h('div', { class: 'view', 'data-tut': 'view' },
    frame,
    h('div', { class: 'overlay ov-tl' }, overlays.modePill, overlays.gizmoSeg),
    overlays.toolBar, overlays.toolHint,
    h('div', { class: 'overlay ov-tr' }, overlays.camSeg),
    h('div', { class: 'overlay ov-bl' }, overlays.stats),
    h('div', { class: 'loading' }, h('div', { class: 'spinner' }), 'Starting WebGPU…'),
  );

  const nameInput = h('input', { class: 'name-input', spellcheck: 'false' }) as HTMLInputElement;
  nameInput.onchange = () => { app.doc.name = nameInput.value; app.commit('meta'); };
  const top = h('div', { class: 'top' },
    h('div', { class: 'brand' }, h('div', { class: 'logo' }), h('div', {}, 'Loop Lab', h('br'), h('small', {}, 'AVBD · WEBGPU'))),
    h('div', { class: 'sep' }),
    nameInput,
    h('button', { class: 'btn', 'data-tut': 'presets', onclick: () => openPresets(app) }, '✦ Presets'),
    h('button', { class: 'btn tuto', 'data-tut': 'tutorial', title: 'Tutoriel guidé : les fonctions principales, puis construire une petite machine', onclick: () => { removeInvite?.(); tutorial().open(); } }, '▶ Tutoriel'),
    h('button', { class: 'btn how', title: 'Cours interactif : comment fonctionne un moteur physique', onclick: () => openCourse() }, '? Comment ça marche'),
    h('button', { class: 'btn icon ghost', title: 'Undo (⌘Z)', onclick: () => app.undo() }, '↶'),
    h('button', { class: 'btn icon ghost', title: 'Redo (⇧⌘Z)', onclick: () => app.redo() }, '↷'),
    h('div', { class: 'grow' }),
    h('button', { class: 'btn ghost', title: 'Open scene JSON', onclick: () => openFile(app) }, 'Open'),
    h('button', { class: 'btn ghost', title: 'Save scene JSON', onclick: () => download(new Blob([JSON.stringify(app.doc, null, 2)], { type: 'application/json' }), `${slug(app.doc.name)}.json`) }, 'Save'),
    h('button', { class: 'btn ghost', title: 'Copy a link containing the scene', onclick: () => { void navigator.clipboard.writeText(app.shareUrl()).then(() => toast('Share link copied')); } }, 'Share'),
    h('button', { class: 'btn ghost', title: 'Snapshot PNG', onclick: async () => { const [w, hh] = exportDims(app.doc, 1080); download(await snapshotPNG(app, w, hh), `${slug(app.doc.name)}.png`); } }, 'PNG'),
    h('div', { class: 'sep' }),
    h('button', { class: 'btn primary', 'data-tut': 'export', onclick: () => openExport(app, fit) }, '⬇ Export MP4'),
  );

  const left = new LeftPanel(app);
  const hideTip = installTooltips();
  const inspector = new Inspector(app, { refit: () => fit(), hideTip });
  const timeline = new Timeline(app);
  root.append(h('div', { class: 'shell' }, top, left.el, view, inspector.el, timeline.el));

  // ---------------------------------------------------------------- viewport sizing
  function fit(): void {
    const r = view.getBoundingClientRect();
    // the course takes the whole window: no aspect letterboxing, the lesson
    // panels float over the render the way they do over a full-screen shader
    let w: number, hh: number;
    if (document.body.classList.contains('course-on')) {
      w = Math.max(64, Math.floor(r.width)); hh = Math.max(64, Math.floor(r.height));
    } else {
      const [aw, ah] = ASPECTS[app.doc?.render.aspect ?? '1:1'] ?? [1, 1];
      const pad = 28;
      const maxW = r.width - pad * 2, maxH = r.height - pad * 2;
      w = maxW; hh = (w * ah) / aw;
      if (hh > maxH) { hh = maxH; w = (hh * aw) / ah; }
      w = Math.max(64, Math.floor(w)); hh = Math.max(64, Math.floor(hh));
    }
    frame.style.width = `${w}px`;
    frame.style.height = `${hh}px`;
    if (app.stage && !app.exporting) app.stage.resize(w, hh);
  }
  new ResizeObserver(fit).observe(view);

  installShortcuts(app, () => overlays.renderSwitches());

  // ---------------------------------------------------------------- events
  app.on((what) => {
    switch (what) {
      case 'doc':
        nameInput.value = app.doc.name;
        fit();
        inspector.render();
        left.renderOutliner();
        break;
      case 'select':
        if (inspector.tab !== 'Machine') inspector.show('Object');
        else inspector.render();
        left.renderOutliner();
        overlays.renderToolBar();
        break;
      case 'tool': case 'mode':
        overlays.renderToolBar();
        break;
      case 'library':
        left.renderLibrary();
        break;
      case 'report': case 'trials':
        if (inspector.tab === 'Machine') inspector.render();
        else if (what === 'report' && app.report && !app.report.ok && !app.reportStale) inspector.flagMachine();
        break;
      case 'solo':
        left.renderOutliner();
        if (inspector.tab === 'Object') inspector.render();
        break;
      case 'physics': case 'meta': case 'visual':
        left.renderOutliner();
        break;
      case 'transform':
        if (inspector.tab === 'Object') inspector.sync();
        break;
      case 'camera':
        if (inspector.tab === 'Camera') inspector.sync();
        break;
      case 'gizmo':
        overlays.renderSwitches();
        overlays.renderToolBar();
        break;
    }
  });

  return {
    canvas,
    ready() {
      view.querySelector('.loading')?.remove();
      overlays.renderSwitches();
      left.renderPalette();
      overlays.renderToolBar();
      fit();
      inspector.render();
      left.renderOutliner();
      nameInput.value = app.doc.name;
      // first visit: point at the tutorial once
      const anchor = top.querySelector<HTMLElement>('[data-tut="tutorial"]');
      if (anchor && tutorialNeverOpened() && !location.hash.startsWith('#scene=')) removeInvite = showInvite(anchor, () => tutorial().open());
    },
    fatal(msg: string) {
      view.querySelector('.loading')?.remove();
      root.append(h('div', { class: 'fatal' }, h('div', {}, h('h2', {}, 'WebGPU required'),
        msg, h('br'), h('br'), 'Loop Lab runs the AVBD solver entirely in GPU compute shaders. Please use a recent Chrome or Edge on desktop with hardware acceleration enabled.')));
    },
    frame() {
      timeline.frame();
      overlays.frame();
    },
  };
}
