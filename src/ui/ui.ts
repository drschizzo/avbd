import { Pane } from 'tweakpane';
import type { App } from '../app';
import { COLOR_MODES, FINISHES, FOLLOW_DEFAULTS, LOOP_MODES, type Entity, type EntityType, type Vec3 } from '../scene/doc';
import { ENTITY_DEFS, type ParamSpec } from '../scene/entities';
import { PALETTES, PALETTE_KEYS } from '../scene/palettes';
import { PRESETS } from '../scene/presets';
import { boomerangSpans } from '../sim/loopTime';
import { exportVideo, snapshotPNG } from '../export/video';
import { mountCourse, type Course } from '../course';
import { mountTutorial, tutorialNeverOpened, type Tutorial } from '../tutorial';
import { PARAM_HELP } from './help';
import { FILL_DEFAULTS, PATH_FILLS, isTrack, shapePoints, type PathFill } from '../scene/path';
import { FILL_LABEL, type PlaneAxis } from '../edit/tools';

export interface UI {
  canvas: HTMLCanvasElement;
  ready(): void;
  fatal(msg: string): void;
  frame(): void;
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...children: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) (el as any)[k.toLowerCase()] = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) el.append(c);
  return el;
};

function toast(msg: string): void {
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'loop';

const ASPECTS: Record<string, [number, number]> = { '1:1': [1, 1], '9:16': [9, 16], '4:5': [4, 5], '16:9': [16, 9] };

export function mountUI(root: HTMLElement, app: App): UI {
  // the interactive course, mounted on first use (it takes over the viewport)
  let courseRef: Course | null = null;
  const course = () => (courseRef ??= mountCourse(app));
  // the guided tour of the editor, mounted on first use (the editor stays live)
  let tutorialRef: Tutorial | null = null;
  const tutorial = () => (tutorialRef ??= mountTutorial(app, {
    tab: () => activeTab,
    setTab: (t) => { if ((tabNames as readonly string[]).includes(t) && activeTab !== t) { activeTab = t as TabName; rerender(); } },
    openPresets: () => openPresets(),
    openCourse: () => openCourse(),
  }));
  // the tutorial stays open underneath the course (hidden by body.course-on)
  const openCourse = () => course().open();

  // ---------------------------------------------------------------- layout
  const canvas = h('canvas', { tabindex: '0' });
  const frame = h('div', { class: 'frame' }, canvas);
  const modePill = h('div', { class: 'pill edit', 'data-tut': 'mode' }, h('span', { class: 'dot' }), h('span', {}, 'EDIT'));
  const gizmoSeg = h('div', { class: 'seg', 'data-tut': 'gizmo' });
  const camSeg = h('div', { class: 'seg', 'data-tut': 'cam' });
  const stats = h('div', { class: 'stats' });
  const toolBar = h('div', { class: 'overlay ov-tl2' });
  const toolHint = h('div', { class: 'overlay ov-hint' });
  const view = h('div', { class: 'view', 'data-tut': 'view' },
    frame,
    h('div', { class: 'overlay ov-tl' }, modePill, gizmoSeg),
    toolBar, toolHint,
    h('div', { class: 'overlay ov-tr' }, camSeg),
    h('div', { class: 'overlay ov-bl' }, stats),
    h('div', { class: 'loading' }, h('div', { class: 'spinner' }), 'Starting WebGPU…'),
  );

  const nameInput = h('input', { class: 'name-input', spellcheck: 'false' }) as HTMLInputElement;
  const undoBtn = h('button', { class: 'btn icon ghost', title: 'Undo (⌘Z)', onclick: () => app.undo() }, '↶');
  const redoBtn = h('button', { class: 'btn icon ghost', title: 'Redo (⇧⌘Z)', onclick: () => app.redo() }, '↷');
  const top = h('div', { class: 'top' },
    h('div', { class: 'brand' }, h('div', { class: 'logo' }), h('div', {}, 'Loop Lab', h('br'), h('small', {}, 'AVBD · WEBGPU'))),
    h('div', { class: 'sep' }),
    nameInput,
    h('button', { class: 'btn', 'data-tut': 'presets', onclick: () => openPresets() }, '✦ Presets'),
    h('button', { class: 'btn tuto', 'data-tut': 'tutorial', title: 'Tutoriel guidé : les fonctions principales, puis construire une petite machine', onclick: () => { invite?.remove(); tutorial().open(); } }, '▶ Tutoriel'),
    h('button', { class: 'btn how', title: 'Cours interactif : comment fonctionne un moteur physique', onclick: () => openCourse() }, '? Comment ça marche'),
    undoBtn, redoBtn,
    h('div', { class: 'grow' }),
    h('button', { class: 'btn ghost', title: 'Open scene JSON', onclick: () => openFile() }, 'Open'),
    h('button', { class: 'btn ghost', title: 'Save scene JSON', onclick: () => download(new Blob([JSON.stringify(app.doc, null, 2)], { type: 'application/json' }), `${slug(app.doc.name)}.json`) }, 'Save'),
    h('button', { class: 'btn ghost', title: 'Copy a link containing the scene', onclick: () => { void navigator.clipboard.writeText(app.shareUrl()).then(() => toast('Share link copied')); } }, 'Share'),
    h('button', { class: 'btn ghost', title: 'Snapshot PNG', onclick: async () => { const [w, hh] = exportDims(1080); download(await snapshotPNG(app, w, hh), `${slug(app.doc.name)}.png`); } }, 'PNG'),
    h('div', { class: 'sep' }),
    h('button', { class: 'btn primary', 'data-tut': 'export', onclick: () => openExport() }, '⬇ Export MP4'),
  );

  // left: palette + outliner
  const palette = h('div', { class: 'palette' });
  const cats: Record<string, EntityType[]> = {};
  (Object.keys(ENTITY_DEFS) as EntityType[]).forEach((t) => { (cats[ENTITY_DEFS[t].category] ??= []).push(t); });
  const libBox = h('div');
  const renderPalette = () => {
    palette.replaceChildren();
    for (const [cat, types] of Object.entries(cats)) {
      palette.append(h('div', { class: 'cat' }, cat));
      const grid = h('div', { class: 'grid' });
      for (const t of types) {
        grid.append(h('button', { class: 'tile', 'data-tut': `add-${t}`, title: `Add ${ENTITY_DEFS[t].label} — it follows the cursor, click to drop it`, onclick: () => app.addEntity(t) },
          h('span', { class: 'ic' }, ENTITY_DEFS[t].icon), ENTITY_DEFS[t].label));
      }
      palette.append(grid);
    }
    palette.append(libBox);
    renderLibrary();
  };
  const renderLibrary = () => {
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
  };
  renderPalette();
  const outliner = h('div', { class: 'outliner', 'data-tut': 'outliner' });
  let addCollapsed = false;
  try { addCollapsed = localStorage.getItem('looplab.addCollapsed') === '1'; } catch { /* ignore */ }
  const addTitle = h('div', { class: 'section-title fold', title: 'Show / hide the object palette' }, h('span', {}, h('span', { class: 'chev' }, '▾'), 'Add'));
  const left = h('div', { class: `left${addCollapsed ? ' add-collapsed' : ''}` },
    addTitle, palette,
    h('div', { class: 'section-title' }, 'Scene', h('span', { class: 'kbd' }, 'Del · ⌘D')), outliner);

  addTitle.onclick = () => {
    addCollapsed = left.classList.toggle('add-collapsed');
    try { localStorage.setItem('looplab.addCollapsed', addCollapsed ? '1' : '0'); } catch { /* ignore */ }
  };

  // right: tabs
  const tabNames = ['Object', 'Machine', 'Scene', 'Look', 'Camera'] as const;
  type TabName = typeof tabNames[number];
  let activeTab: TabName = 'Object';
  const tabBar = h('div', { class: 'tabs', 'data-tut': 'tabs' });
  const tabBody = h('div', { class: 'tabbody', 'data-tut': 'tabbody' });
  const right = h('div', { class: 'right' }, tabBar, tabBody);

  // timeline
  const playBtn = h('button', { class: 'playbtn', title: 'Play / pause (Space)', onclick: () => app.togglePlay() }, '▶');
  const tc = h('div', { class: 'tc' });
  const trackCanvas = h('canvas');
  const track = h('div', { class: 'track', 'data-tut': 'track' }, trackCanvas);
  const bakeBtn = h('button', { class: 'btn', onclick: () => { if (app.baking) { app.baker.cancel(); app.baking = false; app.stale = true; app.emit('bake'); } else void app.bake(); } }, 'Bake');
  const autoToggle = h('input', { type: 'checkbox' }) as HTMLInputElement;
  autoToggle.checked = app.autoBake;
  autoToggle.onchange = () => { app.autoBake = autoToggle.checked; };
  const bakeStatus = h('div', { class: 'bakestatus' });
  const time = h('div', { class: 'time', 'data-tut': 'timeline' }, playBtn, tc, track,
    h('div', { class: 'bakebox' }, h('div', { class: 'row2' }, bakeBtn, h('label', { class: 'toggle' }, autoToggle, 'auto-bake')), bakeStatus));

  const shell = h('div', { class: 'shell' }, top, left, view, right, time);
  root.append(shell);

  // ---------------------------------------------------------------- viewport sizing
  const fit = () => {
    const r = view.getBoundingClientRect();
    // the course takes the whole window: no aspect letterboxing, the lesson
    // panels float over the render the way they do over a full-screen shader
    if (document.body.classList.contains('course-on')) {
      const w = Math.max(64, Math.floor(r.width)), hh = Math.max(64, Math.floor(r.height));
      frame.style.width = `${w}px`;
      frame.style.height = `${hh}px`;
      if (app.stage && !app.exporting) app.stage.resize(w, hh);
      return;
    }
    const [aw, ah] = ASPECTS[app.doc?.render.aspect ?? '1:1'] ?? [1, 1];
    const pad = 28;
    const maxW = r.width - pad * 2, maxH = r.height - pad * 2;
    let w = maxW, hh = (w * ah) / aw;
    if (hh > maxH) { hh = maxH; w = (hh * aw) / ah; }
    w = Math.max(64, Math.floor(w)); hh = Math.max(64, Math.floor(hh));
    frame.style.width = `${w}px`;
    frame.style.height = `${hh}px`;
    if (app.stage && !app.exporting) app.stage.resize(w, hh);
  };
  new ResizeObserver(fit).observe(view);

  const exportDims = (short: number): [number, number] => {
    const [aw, ah] = ASPECTS[app.doc.render.aspect] ?? [1, 1];
    return aw >= ah ? [Math.round((short * aw) / ah / 2) * 2, short] : [short, Math.round((short * ah) / aw / 2) * 2];
  };

  // ---------------------------------------------------------------- overlays
  const renderGizmoSeg = () => {
    gizmoSeg.replaceChildren(
      h('button', { class: app.gizmoMode === 'all' ? 'on' : '', title: 'Move + rotate (Q) — hold Shift to snap', onclick: () => app.setGizmoMode('all') }, '✥⟳'),
      h('button', { class: app.gizmoMode === 'translate' ? 'on' : '', title: 'Move only (W) — hold Shift to snap 0.25 m', onclick: () => app.setGizmoMode('translate') }, '✥'),
      h('button', { class: app.gizmoMode === 'rotate' ? 'on' : '', title: 'Rotate only (E) — hold Shift to snap 15°', onclick: () => app.setGizmoMode('rotate') }, '⟳'),
    );
    camSeg.replaceChildren(
      h('button', { class: !app.freeCamera ? 'on' : '', title: 'Shot camera (exported view)', onclick: () => { app.freeCamera = false; app.applyCameraFromDoc(); renderGizmoSeg(); } }, '🎬 Shot'),
      h('button', { class: app.freeCamera ? 'on' : '', title: 'Free camera (does not change the shot)', onclick: () => { app.freeCamera = true; renderGizmoSeg(); } }, 'Free'),
    );
  };

  const renderToolBar = () => {
    const t = app.tools;
    if (!t) return;
    const edit = app.mode === 'edit';
    toolBar.style.display = edit ? '' : 'none';
    const fillSel = h('select', { class: 'mini-sel', title: 'What the drawn path is filled with' },
      ...PATH_FILLS.map((f) => h('option', { value: f, selected: f === t.drawFill }, FILL_LABEL[f]))) as HTMLSelectElement;
    fillSel.onchange = () => { t.drawFill = fillSel.value as PathFill; if (t.tool !== 'draw') t.setTool('draw'); else renderToolBar(); };
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
  };

  const updateModePill = () => {
    const baking = app.baking;
    modePill.className = `pill ${baking ? 'bake' : app.mode === 'play' ? 'play' : 'edit'}`;
    modePill.lastChild!.textContent = baking
      ? `BAKING ${Math.round((app.bakeProgress.frame / Math.max(1, app.bakeProgress.total)) * 100)}%`
      : app.mode === 'play' ? 'PLAYBACK' : 'EDIT';
    gizmoSeg.style.display = app.mode === 'edit' ? '' : 'none';
    toolBar.style.display = app.mode === 'edit' ? '' : 'none';
  };

  // ---------------------------------------------------------------- outliner
  const renderOutliner = () => {
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
  };

  // ---------------------------------------------------------------- panes
  let pane: Pane | null = null;
  const disposePane = () => { pane?.dispose(); pane = null; };

  const vecProxy = (arr: Vec3) => ({ v: { x: arr[0], y: arr[1], z: arr[2] } });
  const bindVec = (folder: any, target: any, key: string, label: string, opts: any, kind: Parameters<App['commit']>[0]) => {
    const proxy = vecProxy(target[key]);
    const o: any = { label };
    for (const c of ['x', 'y', 'z']) o[c] = { ...opts };
    folder.addBinding(proxy, 'v', o).on('change', (ev: any) => {
      target[key] = [ev.value.x, ev.value.y, ev.value.z];
      app.commit(kind);
    });
    return proxy;
  };

  const addParam = (folder: any, params: Record<string, any>, spec: ParamSpec, kind: Parameters<App['commit']>[0], selfId = '') => {
    switch (spec.kind) {
      case 'entity': {
        const options: Record<string, string> = { '(any moving body)': '' };
        for (const x of app.doc.entities) if (x.id !== selfId && x.type !== 'sensor') options[x.name] = x.id;
        if (!Object.values(options).includes(params[spec.key])) params[spec.key] = '';
        return folder.addBinding(params, spec.key, { label: spec.label, options }).on('change', () => app.commit(kind));
      }
      case 'vec3': bindVec(folder, params, spec.key, spec.label, { min: spec.min, max: spec.max, step: spec.step }, kind); return folder.children[folder.children.length - 1];
      case 'bool': return folder.addBinding(params, spec.key, { label: spec.label }).on('change', () => app.commit(kind));
      case 'select': return folder.addBinding(params, spec.key, { label: spec.label, options: Object.fromEntries(spec.options!.map((o) => [o, o])) }).on('change', () => app.commit(kind));
      case 'int': return folder.addBinding(params, spec.key, { label: spec.label, min: spec.min, max: spec.max, step: 1 }).on('change', () => app.commit(kind));
      default: return folder.addBinding(params, spec.key, { label: spec.label, min: spec.min, max: spec.max, step: spec.step }).on('change', () => app.commit(kind));
    }
  };

  const opts = (list: readonly string[]) => Object.fromEntries(list.map((o) => [o, o]));

  // ---------------------------------------------------------------- tooltips
  /** Tags every labelled row of a pane with its help text (see help.ts). */
  const annotate = (host: HTMLElement, tab: string) => {
    for (const row of host.querySelectorAll<HTMLElement>('.tp-lblv')) {
      if (row.dataset.tip) continue;
      const label = row.querySelector('.tp-lblv_l')?.textContent?.trim() ?? '';
      const folder = row.parentElement?.closest('.tp-fldv')?.querySelector('.tp-fldv_t')?.textContent?.trim() ?? '';
      const text = PARAM_HELP[`${folder}/${label}`] ?? PARAM_HELP[`${tab}/${label}`] ?? PARAM_HELP[label];
      if (text) row.dataset.tip = text;
    }
  };
  const tipPop = h('div', { class: 'tip-pop' });
  document.body.append(tipPop);
  let tipTimer = 0;
  let tipFor: HTMLElement | null = null;
  const hideTip = () => { clearTimeout(tipTimer); tipFor = null; tipPop.classList.remove('on'); };
  document.addEventListener('pointerover', (ev) => {
    const el = (ev.target as HTMLElement)?.closest?.<HTMLElement>('[data-tip]') ?? null;
    if (el === tipFor) return;
    hideTip();
    if (!el || ev.pointerType === 'touch') return;
    tipFor = el;
    tipTimer = window.setTimeout(() => {
      if (tipFor !== el || !el.isConnected) return;
      tipPop.textContent = el.dataset.tip!;
      tipPop.classList.add('on');
      // beside the row, on the side with room (the panel sits at the edge)
      const r = el.getBoundingClientRect(), t = tipPop.getBoundingClientRect();
      const left = r.left - t.width - 10 >= 8 ? r.left - t.width - 10 : Math.min(window.innerWidth - t.width - 8, r.right + 10);
      const top = Math.max(8, Math.min(window.innerHeight - t.height - 8, r.top + r.height / 2 - t.height / 2));
      tipPop.style.left = `${left}px`;
      tipPop.style.top = `${top}px`;
    }, 280);
  });
  document.addEventListener('pointerdown', hideTip, true);
  document.addEventListener('wheel', hideTip, { capture: true, passive: true });

  const renderObjectTab = () => {
    const e = app.selectedEntity;
    if (!e) {
      tabBody.append(h('div', { class: 'empty' }, 'Select an object in the viewport or the scene list.', h('br'), h('br'),
        h('span', { class: 'kbd' }, 'Q'), ' move + rotate  ', h('span', { class: 'kbd' }, 'W'), ' move  ', h('span', { class: 'kbd' }, 'E'), ' rotate  ', h('span', { class: 'kbd' }, '⇧'), ' snap  ', h('span', { class: 'kbd' }, 'Space'), ' play'));
      return;
    }
    if (app.selectedIds.length > 1) renderMultiHead();
    const def = ENTITY_DEFS[e.type];
    const name = h('input', { class: 'name-input', value: e.name, spellcheck: 'false' }) as HTMLInputElement;
    name.onchange = () => { e.name = name.value; app.commit('meta'); };
    tabBody.append(h('div', { class: 'entity-head' }, h('span', { class: 'big' }, def.icon), name));
    const host = h('div');
    tabBody.append(host);
    pane = new Pane({ container: host });
    const p: any = pane;
    p.addBinding(e, 'enabled', { label: 'Enabled' }).on('change', () => app.commit('physics'));
    const cf = { v: e.camera !== false };
    p.addBinding(cf, 'v', { label: 'Camera follows' }).on('change', (ev: any) => { e.camera = ev.value ? undefined : false; app.refreshFollow(); app.commit('meta'); });
    const tf = p.addFolder({ title: 'Transform' });
    const posProxy = bindVec(tf, e, 'position', 'Position', { step: 0.01 }, 'physics');
    const rotProxy = bindVec(tf, e, 'rotation', 'Rotation°', { step: 0.5, min: -360, max: 360 }, 'physics');
    (renderObjectTab as any).sync = () => {
      posProxy.v = { x: e.position[0], y: e.position[1], z: e.position[2] };
      rotProxy.v = { x: e.rotation[0], y: e.rotation[1], z: e.rotation[2] };
      (pane as any)?.refresh();
    };
    const pf = p.addFolder({ title: def.label });
    const conditional = def.params.some((x) => x.show);
    for (const spec of def.params) {
      if (spec.show && !spec.show(e.params)) continue;
      const blade = addParam(pf, e.params, spec, 'physics', e.id);
      if (e.type === 'path' && spec.key === 'fill') {
        // a new fill brings its own sizes, body kind and look
        blade.on('change', () => {
          const f = e.params.fill as PathFill;
          e.params.size = [...FILL_DEFAULTS[f].size];
          e.params.spacing = FILL_DEFAULTS[f].spacing;
          e.phys.body = isTrack(f) ? 'static' : 'dynamic';
          if (isTrack(f)) e.look = { ...e.look, colorMode: 'single', color: '', finish: 'satin' };
          else if (e.look.colorMode === 'single' && !e.look.color) e.look = { ...e.look, colorMode: 'gradient', finish: 'gloss' };
          app.commit('physics');
          rerender();
        });
      } else if (conditional && spec.kind === 'select') blade.on('change', () => rerender());
      const text = PARAM_HELP[`${e.type}.${spec.key}`] ?? spec.help;
      const el = blade?.element as HTMLElement | undefined;
      if (text && el) el.dataset.tip = text;
    }
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
        rerender();
      });
      pf.addButton({ title: `Subdivide (${pts} points)` }).on('click', () => { app.tools.subdivide(e); rerender(); });
      tabBody.insertBefore(h('div', { class: 'hint' }, 'Click a blue dot in the viewport to move that control point; Del removes it. The green dot is the start (the first domino is pushed there).'), host);
    }

    const lf = p.addFolder({ title: 'Look' });
    lf.addBinding(e.look, 'colorMode', { label: 'Colour mode', options: opts(COLOR_MODES) }).on('change', () => app.commit('visual'));
    const colorProxy = { c: e.look.color || '#cccccc' };
    lf.addBinding(colorProxy, 'c', { label: 'Colour', view: 'color' }).on('change', (ev: any) => { e.look.color = ev.value; app.commit('visual'); });
    lf.addBinding(e.look, 'paletteOffset', { label: 'Palette shift', min: 0, max: 12, step: 1 }).on('change', () => app.commit('visual'));
    lf.addBinding(e.look, 'finish', { label: 'Finish', options: opts(FINISHES) }).on('change', () => app.commit('visual'));

    const phf = p.addFolder({ title: 'Physics' });
    phf.addBinding(e.phys, 'body', { label: 'Body', options: opts(['dynamic', 'static', 'kinematic']) }).on('change', () => { app.commit('physics'); rerender(); });
    phf.addBinding(e.phys, 'density', { label: 'Density', min: 0.01, max: 500, step: 0.01 }).on('change', () => app.commit('physics'));
    phf.addBinding(e.phys, 'friction', { label: 'Friction', min: 0, max: 2, step: 0.01 }).on('change', () => app.commit('physics'));
    bindVec(phf, e.phys, 'velocity', 'Velocity', { step: 0.1, min: -100, max: 100 }, 'physics');
    bindVec(phf, e.phys, 'angularVelocity', 'Spin', { step: 0.1, min: -100, max: 100 }, 'physics');
    phf.addBinding(e.phys, 'spawnAt', { label: 'Appear at (s)', min: 0, max: app.doc.duration, step: 0.05 }).on('change', () => app.commit('physics'));

    if (e.phys.body !== 'dynamic') {
      const mf = p.addFolder({ title: 'Motion (kinematic, loops)' });
      mf.addBinding(e.motion, 'kind', { label: 'Motion', options: opts(['none', 'spin', 'swing', 'slide', 'gate']) }).on('change', () => { app.commit('physics'); rerender(); });
      if (e.motion.kind !== 'none') {
        bindVec(mf, e.motion, 'axis', 'Axis', { step: 0.05, min: -1, max: 1 }, 'physics');
        if (e.motion.kind !== 'gate') mf.addBinding(e.motion, 'cycles', { label: 'Cycles / loop', min: 1, max: 20, step: 1 }).on('change', () => app.commit('physics'));
        if (e.motion.kind !== 'spin') mf.addBinding(e.motion, 'amplitude', { label: e.motion.kind === 'slide' ? 'Amplitude (m)' : 'Angle (°)', min: -360, max: 360, step: 0.1 }).on('change', () => app.commit('physics'));
        if (e.motion.kind === 'spin') {
          const dir = { reverse: e.motion.amplitude < 0 };
          mf.addBinding(dir, 'reverse', { label: 'Reverse' }).on('change', (ev: any) => { e.motion.amplitude = Math.abs(e.motion.amplitude) * (ev.value ? -1 : 1); app.commit('physics'); });
        }
        mf.addBinding(e.motion, 'phase', { label: 'Phase', min: 0, max: 1, step: 0.01 }).on('change', () => app.commit('physics'));
        if (e.motion.kind === 'gate') {
          bindVec(mf, e.motion, 'offset', 'Offset', { step: 0.05 }, 'physics');
          mf.addBinding(e.motion, 'open', { label: 'Open at', min: 0, max: app.doc.duration, step: 0.05 }).on('change', () => app.commit('physics'));
          mf.addBinding(e.motion, 'close', { label: 'Close at', min: 0, max: app.doc.duration, step: 0.05 }).on('change', () => app.commit('physics'));
          mf.addBinding(e.motion, 'ease', { label: 'Ease (s)', min: 0.02, max: 3, step: 0.01 }).on('change', () => app.commit('physics'));
        }
      }
    }
    const actions = p.addFolder({ title: 'Actions', expanded: true });
    addSelectionActions(actions);
    actions.addButton({ title: 'Move up in list' }).on('click', () => app.moveEntity(e.id, -1));
  };

  /** Buttons shared by single and multiple selections. */
  const addSelectionActions = (folder: any) => {
    const n = app.selectedIds.length;
    folder.addButton({ title: n > 1 ? `Duplicate ${n} objects (⌘D)` : 'Duplicate (⌘D)' }).on('click', () => app.duplicateEntities([...app.selectedIds]));
    folder.addButton({ title: 'Copy (⌘C) — paste with ⌘V, even in another scene' }).on('click', () => toast(`${app.tools.copySelection()} object(s) copied`));
    folder.addButton({ title: 'Drop onto the surface below (End)' }).on('click', () => app.tools.dropSelection());
    folder.addButton({ title: 'Repeat…' }).on('click', () => openArray());
    folder.addButton({ title: 'Save as gadget…' }).on('click', () => {
      const def = app.selectedEntities[0];
      const name = prompt('Name of the gadget', def?.group ?? def?.name ?? 'Gadget');
      if (name && app.tools.saveGadget(name.trim() || 'Gadget')) toast(`“${name}” saved in My gadgets`);
    });
    const soloOn = !!app.solo && app.selectedIds.every((x) => app.solo!.has(x)) && app.solo.size === app.selectedIds.length;
    folder.addButton({ title: soloOn ? 'Leave solo (bake everything)' : 'Solo: bake only this' }).on('click', () => app.setSolo(soloOn ? null : [...app.selectedIds]));
    folder.addButton({ title: n > 1 ? `Delete ${n} objects` : 'Delete' }).on('click', () => app.removeEntities([...app.selectedIds]));
  };

  const renderMultiHead = () => {
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
    tabBody.append(box);
    const mp: any = new Pane({ container: host });
    multiPanes.push(mp);
    addSelectionActions(mp.addFolder({ title: 'Selection', expanded: true }));
  };
  const multiPanes: any[] = [];

  const openArray = () => {
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
          app.tools.arraySelection(Math.max(2, Math.round(v('count'))), [v('dx'), v('dy'), v('dz')], v('yaw'));
        } }, 'Repeat'))));
  };

  // ---------------------------------------------------------------- machine check
  const fmtT = (t: number | null) => (t === null ? '—' : `${t.toFixed(2)} s`);
  const renderMachineTab = () => {
    const r = app.report;
    const box = h('div', { class: 'machine' });
    tabBody.append(box);
    const t = app.trials;
    if (!r) {
      box.append(h('div', { class: 'empty' }, app.analyzing ? 'Checking the machine…' : app.baking ? 'Baking… the check runs when the bake ends.' : 'Bake the scene: every object that is set in motion, when, and where a chain breaks will show up here.'));
      if (!app.baking && !app.analyzing) box.append(h('div', { class: 'mrow-actions' }, h('button', { class: 'btn primary', onclick: () => void app.bake() }, 'Bake & check')));
      return;
    }
    const bad = r.issues.filter((x) => x.level === 'bad').length;
    const warn = r.issues.filter((x) => x.level === 'warn').length;
    box.append(h('div', { class: `verdict ${r.ok && !warn ? 'good' : r.ok ? 'warn' : 'bad'}` },
      h('b', {}, r.entities.every((x) => !x.expected) && r.sensors.length === 0 ? 'No step to check' : r.ok ? (warn ? 'The machine runs — with warnings' : 'The machine runs end to end') : bad ? `${bad} step${bad > 1 ? 's' : ''} failed` : 'Check'),
      h('span', {}, app.reportStale ? 'from the previous bake — the scene changed since' : `chain ends ${fmtT(r.chainEnd)} · still at ${fmtT(r.motionEnd)}${r.outroStart !== null ? ` · loop transition ${fmtT(r.outroStart)}` : ''}`)));

    for (const is of r.issues) {
      const row = h('div', { class: `issue ${is.level}` }, h('span', {}, is.text));
      if (is.fix === 'duration' && is.value) row.append(h('button', { class: 'btn', onclick: () => { app.doc.duration = is.value!; app.commit('physics'); toast(`Duration ${is.value} s`); } }, `Use ${is.value} s`));
      if (is.fix === 'boomerang') row.append(h('button', { class: 'btn', onclick: () => { app.doc.loop.mode = 'boomerang'; app.commit('loop'); } }, 'Boomerang'));
      box.append(row);
    }

    // the chain, in the order things were set in motion
    box.append(h('div', { class: 'section-title' }, 'Chain of events', h('span', { class: 'kbd' }, 'click = see it')));
    const D = Math.max(r.simEnd, 1e-3);
    const list = h('div', { class: 'chain' });
    const trialRate = (id: string) => {
      if (!t || t.done === 0) return null;
      const n = t.results.filter((m) => m.get(id)).length;
      return n / t.done;
    };
    for (const e of r.entities) {
      const ent = app.doc.entities.find((x) => x.id === e.id);
      const icon = ent ? ENTITY_DEFS[ent.type].icon : '•';
      const st = e.status;
      const rate = trialRate(e.id);
      const bar = h('div', { class: 'cbar' });
      if (e.first !== null) {
        const a = (e.first / D) * 100, b = (Math.max(e.last ?? e.first, e.first) / D) * 100;
        bar.append(h('i', { class: st, style: `left:${a}%;width:${Math.max(1.2, b - a)}%` }));
      }
      const row = h('div', { class: `crow ${st}${ent && app.selectedIds.includes(ent.id) ? ' sel' : ''}`, onclick: () => {
        if (!ent) return;
        app.select(ent.id, { single: true });
        const at = e.breakAt?.t ?? e.first;
        if (at !== null && app.result) { app.seek(Math.max(0, at - 0.3)); app.playing = false; }
      } },
        h('span', { class: 'ct' }, e.first === null ? '—' : e.first.toFixed(2)),
        h('span', { class: 'ic' }, icon),
        h('span', { class: 'cn' }, e.name, h('small', {}, st === 'idle' ? 'never moved' : st === 'decor' ? (e.activated ? `decor · moved` : 'decor') : e.chain || st === 'partial' ? `${e.activated}/${e.bodies}` : `${e.activated}/${e.bodies} moved`)),
        rate !== null ? h('span', { class: `rate ${rate === 1 ? 'good' : rate >= 0.6 ? 'warn' : 'bad'}`, title: `Worked in ${Math.round(rate * 100)} % of the ${t!.done} trial runs` }, `${Math.round(rate * 100)}%`) : null,
        h('button', { class: 'cx', title: e.expected ? 'Expected to move — click if it is only decor' : 'Decor — click if it must move', onclick: (ev: Event) => {
          ev.stopPropagation();
          if (!ent) return;
          ent.expect = ent.expect === false ? undefined : false;
          app.commit('meta');
          // re-judge without baking again
          app.rejudge();
        } }, e.expected ? '⚑' : '○'),
        bar,
      );
      list.append(row);
    }
    for (const sn of r.sensors) {
      const rate = trialRate(sn.id);
      const ent = app.doc.entities.find((x) => x.id === sn.id);
      list.append(h('div', { class: `crow sensor ${sn.triggered !== null ? 'ok' : 'idle'}`, onclick: () => { if (ent) app.select(ent.id); if (sn.triggered !== null) { app.seek(Math.max(0, sn.triggered - 0.3)); app.playing = false; } } },
        h('span', { class: 'ct' }, sn.triggered === null ? '—' : sn.triggered.toFixed(2)),
        h('span', { class: 'ic' }, '◫'),
        h('span', { class: 'cn' }, sn.name, h('small', {}, `${sn.watch} · ${sn.reached}/${sn.needed}`)),
        rate !== null ? h('span', { class: `rate ${rate === 1 ? 'good' : rate >= 0.6 ? 'warn' : 'bad'}` }, `${Math.round(rate * 100)}%`) : null,
        h('span', { class: 'cx' }),
        h('div', { class: 'cbar' }, sn.triggered !== null ? h('i', { class: 'ok', style: `left:${(sn.triggered / D) * 100}%;width:1.2%` }) : null)));
    }
    if (r.entities.length === 0 && r.sensors.length === 0) list.append(h('div', { class: 'hint' }, 'No moving parts in this scene.'));
    box.append(list);
    box.append(h('div', { class: 'hint' }, '⚑ = must move. Rows (dominoes, drawn rows) must fall to the last piece; a red ring marks where one stopped. Add a Sensor (Testing) to check that a ball reaches its target.'));

    // robustness
    box.append(h('div', { class: 'section-title' }, 'Reliability'));
    const runs = h('div', { class: 'trials' });
    if (t) {
      const pct = t.done ? Math.round((t.okRuns / t.done) * 100) : 0;
      runs.append(h('div', { class: `verdict small ${t.done === 0 ? '' : pct === 100 ? 'good' : pct >= 60 ? 'warn' : 'bad'}` },
        h('b', {}, t.running ? `Run ${Math.min(t.done + 1, t.total)} of ${t.total}…` : t.untilSuccess ? (t.kept >= 0 ? `Worked on run ${t.kept + 1} — that bake is kept` : `No run worked out of ${t.done}`) : `${t.okRuns} / ${t.done} runs worked (${pct} %)`),
        h('span', {}, t.untilSuccess ? 'each run nudges the parts by < 1 mm' : 'each run nudges the parts by < 1 mm: a machine that only works for one exact layout will break')));
    }
    runs.append(h('div', { class: 'mrow-actions' },
      h('button', { class: 'btn', title: 'Bake 5 times with tiny differences and count which steps hold', onclick: () => void app.runTrials(5, false) }, t?.running && !t.untilSuccess ? 'Stop' : 'Test ×5'),
      h('button', { class: 'btn', title: 'Re-bake (nudged) until every step works, up to 8 runs, and keep that bake for export', onclick: () => void app.runTrials(8, true) }, t?.running && t.untilSuccess ? 'Stop' : 'Bake until it works'),
      h('label', { class: 'toggle', title: 'Trajectories of the selected objects (from the check)' }, (() => { const c = h('input', { type: 'checkbox' }) as HTMLInputElement; c.checked = app.showTraces; c.onchange = () => { app.showTraces = c.checked; app.updateAnalysisVisuals(); }; return c; })(), 'paths')));
    box.append(runs);
    if (app.solo) box.append(h('div', { class: 'issue warn' }, h('span', {}, `Solo: only ${app.solo.size} object(s) are baked.`), h('button', { class: 'btn', onclick: () => app.setSolo(null) }, 'Leave solo')));
  };

  const renderSceneTab = () => {
    const d = app.doc;
    tabBody.append(h('div', { class: 'hint' }, 'Physics changes trigger a re-bake. The loop transition hides the seam so the clip repeats perfectly.'));
    const host = h('div');
    tabBody.append(host);
    pane = new Pane({ container: host });
    const p: any = pane;
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

    const lq = p.addFolder({ title: 'Liquid (MLS-MPM)', expanded: d.entities.some((e) => e.type === 'fluidBlock' || e.type === 'fluidSource') });
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
  };

  const renderLookTab = () => {
    const r = app.doc.render;
    const pal = PALETTES[r.palette];
    if (pal) tabBody.append(h('div', { class: 'hint', style: 'display:flex;gap:4px' }, ...pal.colors.map((c) => h('span', { class: 'swatch', style: `background:${c};width:28px;height:18px;border-radius:5px` }))));
    const host = h('div');
    tabBody.append(host);
    pane = new Pane({ container: host });
    const p: any = pane;
    const v = () => app.commit('visual');
    const col = p.addFolder({ title: 'Colour' });
    col.addBinding(r, 'palette', { label: 'Palette', options: Object.fromEntries(PALETTE_KEYS.map((k) => [PALETTES[k].name, k])) }).on('change', () => { v(); rerender(); });
    const bg = { c: r.background || pal?.background || '#000000' };
    col.addBinding(bg, 'c', { label: 'Background', view: 'color' }).on('change', (ev: any) => { r.background = ev.value; v(); });
    const fl = { c: r.floorColor || pal?.floor || '#000000' };
    col.addBinding(fl, 'c', { label: 'Floor colour', view: 'color' }).on('change', (ev: any) => { r.floorColor = ev.value; v(); });
    col.addButton({ title: 'Use palette background' }).on('click', () => { r.background = ''; r.floorColor = ''; v(); rerender(); });
    col.addBinding(r, 'floor', { label: 'Floor', options: opts(['plain', 'grid', 'mirror', 'none']) }).on('change', v);
    col.addBinding(r, 'aspect', { label: 'Aspect', options: opts(['1:1', '9:16', '4:5', '16:9']) }).on('change', () => { v(); fit(); });

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
  };

  const renderCameraTab = () => {
    const c = app.doc.camera;
    tabBody.append(h('div', { class: 'hint' }, 'In “Shot” mode, orbiting the viewport directs the exported camera. All motions are periodic so the loop stays seamless. Orbit always makes whole turns (Amount adds a vertical bob); sway, dolly and crane use Amount as their range. Follow keeps the shot’s angle but comes close and tracks where things move, from the last bake (Amount adds a sway).'));
    const host = h('div');
    tabBody.append(host);
    pane = new Pane({ container: host });
    const p: any = pane;
    const k = () => app.commit('camera');
    p.addBinding(c, 'motion', { label: 'Motion', options: opts(['static', 'orbit', 'sway', 'dolly', 'crane', 'follow']) }).on('change', () => { k(); rerender(); });
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
    const pos = bindVec(p, c, 'position', 'Position', { step: 0.05 }, 'camera');
    const tgt = bindVec(p, c, 'target', 'Target', { step: 0.05 }, 'camera');
    (renderCameraTab as any).sync = () => {
      pos.v = { x: c.position[0], y: c.position[1], z: c.position[2] };
      tgt.v = { x: c.target[0], y: c.target[1], z: c.target[2] };
      (pane as any)?.refresh();
    };
    p.addButton({ title: 'Frame the scene' }).on('click', () => {
      const b = app.built.bounds;
      const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = (b.min[2] + b.max[2]) / 2;
      const ext = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
      const dist = (ext * 0.75) / Math.tan((c.fov * Math.PI) / 360) + 1;
      c.target = [cx, cy * 0.85, cz];
      c.position = [cx + dist * 0.62, cy + dist * 0.45, cz + dist * 0.65];
      k();
      (renderCameraTab as any).sync?.();
    });
  };

  const rerender = () => {
    disposePane();
    for (const mp of multiPanes.splice(0)) mp.dispose();
    tabBody.replaceChildren();
    const alert = app.report && !app.reportStale && !app.report.ok;
    tabBar.replaceChildren(...tabNames.map((t) => h('button', { class: `tab${t === activeTab ? ' on' : ''}${t === 'Machine' && alert ? ' alert' : ''}`, 'data-tut': `tab-${t}`, onclick: () => { activeTab = t; rerender(); } }, t)));
    hideTip();
    if (activeTab === 'Object') renderObjectTab();
    else if (activeTab === 'Machine') renderMachineTab();
    else if (activeTab === 'Scene') renderSceneTab();
    else if (activeTab === 'Look') renderLookTab();
    else renderCameraTab();
    annotate(tabBody, activeTab);
  };

  // ---------------------------------------------------------------- timeline
  const drawTrack = () => {
    const dpr = window.devicePixelRatio;
    const r = track.getBoundingClientRect();
    if (trackCanvas.width !== Math.round(r.width * dpr) || trackCanvas.height !== Math.round(r.height * dpr)) {
      trackCanvas.width = Math.round(r.width * dpr);
      trackCanvas.height = Math.round(r.height * dpr);
    }
    const ctx = trackCanvas.getContext('2d')!;
    const W = trackCanvas.width, H = trackCanvas.height;
    ctx.clearRect(0, 0, W, H);
    const D = app.doc.duration;
    const y0 = H * 0.32, bh = H * 0.36;
    ctx.fillStyle = '#20242d';
    roundRect(ctx, 0, y0, W, bh, 6 * dpr); ctx.fill();
    // baked portion
    const every = (app.result ?? app.baker.currentPartial)?.recordEvery ?? 1;
    const boom = app.doc.loop.mode === 'boomerang' ? boomerangSpans(app.doc) : null;
    const bakedSim = ((app.availableFrames - 1) * every) / app.doc.fps;
    const bakedT = app.result ? D : app.baking ? Math.min(D, boom ? (bakedSim / Math.max(boom.sim, 1e-3)) * D : bakedSim) : 0;
    if (bakedT > 0) {
      const grad = ctx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, '#3a4a8a'); grad.addColorStop(1, '#5a3f8f');
      ctx.fillStyle = grad;
      roundRect(ctx, 0, y0, (bakedT / D) * W, bh, 6 * dpr); ctx.fill();
    }
    // outro zone (boomerang: the rewind)
    if (app.doc.loop.mode !== 'none') {
      const x = ((D - (boom ? boom.rewind : app.doc.loop.outro)) / D) * W;
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y0, W - x, bh); ctx.clip();
      ctx.strokeStyle = '#ffffff22'; ctx.lineWidth = 2 * dpr;
      for (let i = -H; i < W; i += 8 * dpr) { ctx.beginPath(); ctx.moveTo(x + i, y0 + bh); ctx.lineTo(x + i + bh, y0); ctx.stroke(); }
      ctx.restore();
      ctx.fillStyle = '#ffffff55'; ctx.font = `${9 * dpr}px JetBrains Mono`;
      ctx.fillText(boom ? `REWIND ×${app.doc.loop.rewind}` : app.doc.loop.mode.toUpperCase(), x + 5 * dpr, y0 - 4 * dpr);
    }
    // machine check: when each object was set in motion (red: a broken row)
    const rep = app.report;
    if (rep && !app.reportStale) {
      for (const e of rep.entities) {
        if (e.first === null || !e.expected) continue;
        const x = (e.first / D) * W;
        ctx.fillStyle = e.status === 'partial' ? '#ff6b7a' : '#ffffffaa';
        ctx.fillRect(x - dpr * 0.5, y0 + bh * 0.2, dpr * 1.5, bh * 0.6);
        if (e.breakAt) {
          const xb = (e.breakAt.t / D) * W;
          ctx.fillStyle = '#ff6b7a';
          ctx.beginPath(); ctx.moveTo(xb, y0 - 1 * dpr); ctx.lineTo(xb - 4 * dpr, y0 - 7 * dpr); ctx.lineTo(xb + 4 * dpr, y0 - 7 * dpr); ctx.fill();
        }
      }
      for (const sn of rep.sensors) {
        if (sn.triggered === null) continue;
        const x = (sn.triggered / D) * W;
        ctx.fillStyle = '#5ee0a0';
        ctx.beginPath(); ctx.arc(x, y0 + bh / 2, 2.6 * dpr, 0, Math.PI * 2); ctx.fill();
      }
      if (rep.motionEnd !== null) {
        const x = Math.min(W - dpr, (rep.motionEnd / D) * W);
        ctx.strokeStyle = rep.outroStart !== null && app.doc.loop.mode !== 'boomerang' && rep.motionEnd > rep.outroStart ? '#ffb35c' : '#5ee0a088';
        ctx.lineWidth = 1.5 * dpr;
        ctx.setLineDash([3 * dpr, 3 * dpr]);
        ctx.beginPath(); ctx.moveTo(x, y0 - 2 * dpr); ctx.lineTo(x, y0 + bh + 2 * dpr); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // ticks
    ctx.fillStyle = '#5b6172'; ctx.font = `${9 * dpr}px JetBrains Mono`;
    for (let s = 0; s <= D; s++) {
      const x = (s / D) * W;
      ctx.fillRect(Math.min(W - dpr, x), y0 + bh + 3 * dpr, dpr, (s % 5 === 0 ? 6 : 3) * dpr);
      if (s % (D > 15 ? 5 : 1) === 0 && s < D) ctx.fillText(`${s}s`, x + 3 * dpr, H - 1 * dpr);
    }
    // playhead
    const px = (app.time / D) * W;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(px - dpr, y0 - 6 * dpr, 2 * dpr, bh + 12 * dpr);
    ctx.beginPath(); ctx.arc(px, y0 - 6 * dpr, 4 * dpr, 0, Math.PI * 2); ctx.fill();
  };
  let scrubbing = false;
  const scrubAt = (ev: PointerEvent) => {
    const r = track.getBoundingClientRect();
    app.seek(((ev.clientX - r.left) / r.width) * app.doc.duration);
  };
  track.addEventListener('pointerdown', (ev) => { scrubbing = true; track.setPointerCapture(ev.pointerId); app.playing = false; scrubAt(ev); });
  track.addEventListener('pointermove', (ev) => { if (scrubbing) scrubAt(ev); });
  track.addEventListener('pointerup', () => { scrubbing = false; });

  const updateTimeline = () => {
    playBtn.textContent = app.mode === 'play' && app.playing ? '❚❚' : '▶';
    const f = Math.floor(app.time * app.doc.fps);
    tc.innerHTML = `${app.time.toFixed(2)}s<br><small>frame ${f}</small>`;
    bakeBtn.textContent = app.baking ? 'Cancel' : app.stale ? 'Bake' : 'Re-bake';
    bakeBtn.classList.toggle('primary', app.stale && !app.baking);
    bakeStatus.classList.toggle('err', !!app.bakeError);
    if (app.bakeError) bakeStatus.textContent = app.bakeError;
    else if (app.baking) {
      const p = app.bakeProgress;
      bakeStatus.textContent = `frame ${p.frame}/${p.total} · ${p.msPerFrame.toFixed(1)} ms/frame`;
    } else if (app.result) {
      const s = app.baker.lastStats;
      bakeStatus.textContent = `${s.bodies} bodies · ${(s.totalMs / 1000).toFixed(1)}s bake`;
    } else bakeStatus.textContent = app.stale ? 'needs bake' : '';
    updateModePill();
  };

  let lastStats = 0;
  const updateStats = () => {
    const now = performance.now();
    if (now - lastStats < 250) return;
    lastStats = now;
    const b = app.built;
    const dyn = b ? b.bodies.filter((x) => x.kind === 0).length : 0;
    const res = app.result ?? app.baker.currentPartial;
    const mem = res ? (res.history.array.byteLength / 1048576).toFixed(0) : '0';
    stats.innerHTML = `<b>${b?.bodies.length ?? 0}</b> bodies · <b>${dyn}</b> dynamic · <b>${b?.joints.length ?? 0}</b> joints<br>`
      + `render <b>${app.fpsMeter.fps.toFixed(0)}</b> fps · history <b>${mem}</b> MB`
      + (app.baker.lastStats.msPerFrame && !app.baking ? ` · sim <b>${app.baker.lastStats.msPerFrame.toFixed(1)}</b> ms/f` : '');
  };

  // ---------------------------------------------------------------- modals
  const modal = (content: HTMLElement, onClose?: () => void) => {
    const bg = h('div', { class: 'modal-bg' }, content);
    bg.addEventListener('pointerdown', (ev) => { if (ev.target === bg) { bg.remove(); onClose?.(); } });
    document.body.append(bg);
    return () => bg.remove();
  };

  const openPresets = () => {
    const list = h('div', { class: 'presets' });
    let close = () => {};
    for (const p of PRESETS) {
      list.append(h('button', { class: 'preset', onclick: () => { close(); app.loadPreset(p.key); } }, h('b', {}, p.name), h('span', {}, p.blurb), ...(p.warn ? [h('em', {}, `⚠ ${p.warn}`)] : [])));
    }
    close = modal(h('div', { class: 'modal', style: 'width:560px' },
      h('h3', {}, 'Presets'), h('p', {}, 'Curated loops — load one, then tweak everything.'), list,
      h('div', { class: 'actions' },
        h('button', { class: 'btn', onclick: () => { close(); app.pushUndo(); const d = PRESETS[0].make(); d.entities = []; d.name = 'Empty scene'; app.setDoc(d); } }, 'Empty scene'),
        h('button', { class: 'btn', onclick: () => close() }, 'Close'))));
  };

  const openFile = () => {
    const input = h('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement;
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try { app.pushUndo(); app.setDoc(JSON.parse(await f.text())); toast(`Loaded ${f.name}`); } catch { toast('Invalid scene file'); }
    };
    input.click();
  };

  const openExport = () => {
    const [aw, ah] = ASPECTS[app.doc.render.aspect] ?? [1, 1];
    const resSel = h('select', { class: 'sel' }, ...[720, 1080, 1440, 2160].map((s) => {
      const [w, hh] = exportDims(s);
      return h('option', { value: String(s), selected: s === 1080 }, `${w} × ${hh}`);
    })) as HTMLSelectElement;
    const fpsSel = h('select', { class: 'sel' }, h('option', { value: '60', selected: true }, '60 fps'), h('option', { value: '30' }, '30 fps')) as HTMLSelectElement;
    const ssSel = h('select', { class: 'sel' }, h('option', { value: '2', selected: true }, '2× supersampling'), h('option', { value: '1' }, 'Off (faster)')) as HTMLSelectElement;
    const loopsSel = h('select', { class: 'sel' }, ...[1, 2, 3, 6].map((n) => h('option', { value: String(n) }, `${n}× (${(n * app.doc.duration).toFixed(0)} s)`))) as HTMLSelectElement;
    const brSel = h('select', { class: 'sel' }, ...[12, 24, 40, 60].map((n) => h('option', { value: String(n), selected: n === 24 }, `${n} Mbps`))) as HTMLSelectElement;
    const bar = h('div');
    const status = h('p', { style: 'margin:10px 0 0' });
    let cancelled = false;
    const go = h('button', { class: 'btn primary' }, 'Render');
    const close = modal(h('div', { class: 'modal' },
      h('h3', {}, 'Export seamless loop'),
      h('p', {}, `Offline, frame-exact render of the baked simulation (${aw}:${ah}). Loops perfectly when played on repeat.`),
      h('div', { class: 'field' }, h('label', {}, 'Resolution'), resSel),
      h('div', { class: 'field' }, h('label', {}, 'Frame rate'), fpsSel),
      h('div', { class: 'field' }, h('label', {}, 'Quality'), ssSel),
      h('div', { class: 'field' }, h('label', {}, 'Bitrate'), brSel),
      h('div', { class: 'field' }, h('label', {}, 'Length'), loopsSel),
      h('div', { class: 'progress' }, bar), status,
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => { cancelled = true; close(); } }, 'Close'), go)), () => { cancelled = true; });
    go.onclick = async () => {
      if (!app.result) { status.textContent = app.baking ? 'Wait for the bake to finish…' : 'Bake the scene first.'; return; }
      go.setAttribute('disabled', '');
      const [w, hh] = exportDims(Number(resSel.value));
      const t0 = performance.now();
      try {
        const blob = await exportVideo(app, {
          width: w, height: hh, fps: Number(fpsSel.value) as 30 | 60, supersample: Number(ssSel.value) as 1 | 2,
          bitrateMbps: Number(brSel.value), loops: Number(loopsSel.value),
        }, (p) => {
          bar.style.width = `${(p.frame / p.total) * 100}%`;
          status.textContent = p.phase === 'finalize' ? 'Finalizing MP4…' : `Rendering frame ${p.frame} / ${p.total}`;
        }, () => cancelled);
        fit();
        if (blob) {
          download(blob, `${slug(app.doc.name)}-${w}x${hh}.mp4`);
          status.textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s · ${(blob.size / 1048576).toFixed(1)} MB`;
        }
      } catch (err: any) {
        fit();
        status.textContent = `Export failed: ${err?.message ?? err}`;
      }
      go.removeAttribute('disabled');
    };
  };

  // ---------------------------------------------------------------- first visit
  let invite: HTMLElement | null = null;
  const showInvite = () => {
    const btn = top.querySelector<HTMLElement>('[data-tut="tutorial"]');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const later = h('button', { class: 'btn ghost', onclick: () => { invite?.remove(); invite = null; } }, 'Plus tard');
    const go = h('button', { class: 'btn primary', onclick: () => { invite?.remove(); invite = null; tutorial().open(); } }, 'Commencer');
    invite = h('div', { class: 'tut-invite', style: `left:${Math.max(8, r.left - 14)}px;top:${r.bottom + 12}px` },
      h('b', {}, 'Première visite ?'),
      'Le tutoriel fait le tour des fonctions principales, puis vous guide pour construire une petite machine en chaîne. Une quinzaine de minutes.',
      h('div', { class: 'row' }, later, go));
    document.body.append(invite);
  };

  // ---------------------------------------------------------------- keyboard
  window.addEventListener('keydown', (ev) => {
    const tag = (ev.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && ev.key.toLowerCase() === 'z') { ev.preventDefault(); if (ev.shiftKey) app.redo(); else app.undo(); return; }
    if (mod && ev.key.toLowerCase() === 'y') { ev.preventDefault(); app.redo(); return; }
    if (mod && ev.key.toLowerCase() === 'd') { ev.preventDefault(); if (app.selectedIds.length) app.duplicateEntities([...app.selectedIds]); return; }
    if (mod && ev.key.toLowerCase() === 'c') { if (app.selectedIds.length) { ev.preventDefault(); toast(`${app.tools.copySelection()} object(s) copied`); } return; }
    if (mod && ev.key.toLowerCase() === 'x') { if (app.selectedIds.length) { ev.preventDefault(); toast(`${app.tools.cutSelection()} object(s) cut`); } return; }
    if (mod && ev.key.toLowerCase() === 'v') { ev.preventDefault(); if (!app.tools.paste()) toast('Nothing to paste'); return; }
    if (mod && ev.key.toLowerCase() === 'a') { ev.preventDefault(); app.selectAll(); return; }
    if (mod && ev.key.toLowerCase() === 'g') { ev.preventDefault(); app.groupSelection(ev.shiftKey ? null : ''); return; }
    if (mod) return;
    switch (ev.key) {
      case 'v': case 'V': app.tools.setTool('select'); return;
      case 'd': case 'D': app.tools.setTool(app.tools.tool === 'draw' ? 'select' : 'draw'); return;
      case 'p': case 'P': {
        const order: PlaneAxis[] = ['off', 'xy', 'zy', 'xz'];
        app.tools.setPlane(order[(order.indexOf(app.tools.plane.axis) + 1) % order.length]);
        return;
      }
      case '[': app.tools.nudgePlane(-0.25); return;
      case ']': app.tools.nudgePlane(0.25); return;
      case 'End': ev.preventDefault(); app.tools.dropSelection(); return;
      case 'f': case 'F': app.tools.frameSelection(); renderGizmoSeg(); return;
    }
    switch (ev.key) {
      case ' ': ev.preventDefault(); app.togglePlay(); break;
      case 'q': case 'Q': app.setGizmoMode('all'); break;
      case 'w': case 'W': app.setGizmoMode('translate'); break;
      case 'e': case 'E': app.setGizmoMode('rotate'); break;
      case 'Escape': app.select(null); if (app.mode === 'play') app.setMode('edit'); break;
      case 'Delete': case 'Backspace':
        if (app.tools.deleteHandle()) break;
        if (app.selectedIds.length) app.removeEntities([...app.selectedIds]);
        break;
      case 'b': case 'B': void app.bake(); break;
      case 'Home': app.seek(0); break;
      case 'ArrowRight': app.seek(app.time + 1 / app.doc.fps); app.playing = false; break;
      case 'ArrowLeft': app.seek(app.time - 1 / app.doc.fps); app.playing = false; break;
    }
  });

  // ---------------------------------------------------------------- events
  let structureDirty = true;
  app.on((what) => {
    switch (what) {
      case 'doc':
        nameInput.value = app.doc.name;
        structureDirty = true;
        fit();
        rerender();
        renderOutliner();
        break;
      case 'select':
        if (activeTab !== 'Machine') activeTab = 'Object';
        rerender();
        renderOutliner();
        renderToolBar();
        break;
      case 'tool': case 'mode':
        renderToolBar();
        break;
      case 'library':
        renderLibrary();
        break;
      case 'report': case 'trials':
        if (activeTab === 'Machine') rerender();
        else if (what === 'report' && app.report && !app.report.ok && !app.reportStale) tabBar.querySelector('.tab:nth-child(2)')?.classList.add('alert');
        break;
      case 'solo':
        renderOutliner();
        if (activeTab === 'Object') rerender();
        break;
      case 'physics': case 'meta':
        renderOutliner();
        break;
      case 'visual':
        renderOutliner();
        break;
      case 'transform':
        (renderObjectTab as any).sync?.();
        break;
      case 'camera':
        if (activeTab === 'Camera') (renderCameraTab as any).sync?.();
        break;
      case 'gizmo':
        renderGizmoSeg();
        renderToolBar();
        break;
    }
    void structureDirty;
  });
  nameInput.onchange = () => { app.doc.name = nameInput.value; app.commit('meta'); };

  return {
    canvas,
    ready() {
      view.querySelector('.loading')?.remove();
      renderGizmoSeg();
      renderPalette();
      renderToolBar();
      fit();
      rerender();
      renderOutliner();
      nameInput.value = app.doc.name;
      // first visit: point at the tutorial once
      if (tutorialNeverOpened() && !location.hash.startsWith('#scene=')) showInvite();
    },
    fatal(msg: string) {
      view.querySelector('.loading')?.remove();
      root.append(h('div', { class: 'fatal' }, h('div', {}, h('h2', {}, 'WebGPU required'),
        msg, h('br'), h('br'), 'Loop Lab runs the AVBD solver entirely in GPU compute shaders. Please use a recent Chrome or Edge on desktop with hardware acceleration enabled.')));
    },
    frame() {
      updateTimeline();
      drawTrack();
      updateStats();
    },
  };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(0, w), h, Math.min(r, w / 2));
}
