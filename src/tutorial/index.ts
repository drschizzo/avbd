// Guided tour of Loop Lab: a card that floats next to the part of the
// interface it talks about, a spotlight on that part, markers in the 3D view,
// and steps that notice by themselves when the learner has done what they ask.
// Unlike the course, the editor stays fully usable underneath.

import * as THREE from 'three';
import type { App } from '../app';
import { PARTS, STEPS, type Step, type TutCtx, type TutHooks } from './steps';
import './style.css';
import type { SceneDoc } from '../scene/doc';
import type { SettingsLayer } from '../core/context';
import { el } from '../util/dom';
import { KEYS, readJSON, readText, removeKey, writeJSON } from '../util/storage';

export interface Tutorial {
  open(): void;
  close(): void;
  readonly active: boolean;
}

interface Saved { step: number; finished?: boolean }

const load = (): Saved | null => readJSON<Saved | null>(KEYS.tutorial, null);
const save = (s: Saved) => { writeJSON(KEYS.tutorial, s); };

/** True until the learner has opened the tutorial once. */
export function tutorialNeverOpened(): boolean {
  return load() === null;
}

/** Index of the first step of each part. */
const partStart = (p: number) => STEPS.findIndex((s) => s.part === p);

export function mountTutorial(app: App, ui: TutHooks): Tutorial {
  let active = false;
  /** keeps the editor in edit mode during building steps */
  let settings: SettingsLayer | null = null;
  let index = 0;
  let raf = 0;
  let ctx: TutCtx = { app, ui, mem: {}, seen: new Set() };
  let wasDone = false;
  let minimized = false;

  // ------------------------------------------------------------- DOM
  const root = el('div', 'tut-root hidden');
  const spot = el('div', 'tut-spot hidden');
  const marks = el('div', 'tut-marks');
  const card = el('div', 'tut-card');
  root.append(spot, marks, card);
  document.body.append(root);

  const head = el('div', 'tut-head');
  const crumb = el('div', 'tut-crumb');
  const minBtn = el('button', 'tut-x', '–');
  minBtn.title = 'Réduire';
  const closeBtn = el('button', 'tut-x', '✕');
  closeBtn.title = 'Quitter le tutoriel';
  head.append(crumb, minBtn, closeBtn);
  const bar = el('div', 'tut-bar');
  const barFill = el('i');
  bar.append(barFill);
  const title = el('h3', 'tut-title');
  const body = el('div', 'tut-body');
  const task = el('div', 'tut-task');
  const hint = el('div', 'tut-hint');
  const success = el('div', 'tut-success');
  const nav = el('div', 'tut-nav');
  const prevBtn = el('button', 'btn ghost', '← Retour');
  const doBtn = el('button', 'btn tut-do');
  const fixBtn = el('button', 'btn tut-do');
  const nextBtn = el('button', 'btn primary', 'Suivant →');
  nav.append(prevBtn, el('div', 'grow'), fixBtn, doBtn, nextBtn);
  card.append(head, bar, title, body, task, hint, success, nav);

  // the reduced card: one pill, click to bring the step back
  const pill = el('button', 'tut-pill hidden');
  root.append(pill);

  // --------------------------------------------------------- targets
  const step = (): Step => STEPS[index];
  const targetEl = (): HTMLElement | null => {
    const s = step();
    const t = typeof s.target === 'function' ? s.target(ctx) : s.target;
    if (!t) return null;
    const sel = /^[\w-]+$/.test(t) ? `[data-tut="${t}"]` : t;
    const e = document.querySelector<HTMLElement>(sel);
    return e && e.offsetParent !== null ? e : null;
  };

  // ------------------------------------------------------------ render
  const html = (s: Step) => (typeof s.html === 'function' ? s.html(ctx) : s.html);
  let lastHtml = '';

  const renderCard = () => {
    const s = step();
    const inPart = STEPS.filter((x) => x.part === s.part);
    const k = inPart.indexOf(s);
    crumb.innerHTML = `<b>Tutoriel</b> · Partie ${s.part + 1} — ${PARTS[s.part]} <span>${k + 1} / ${inPart.length}</span>`;
    barFill.style.width = `${((index + 1) / STEPS.length) * 100}%`;
    title.textContent = s.title;
    lastHtml = html(s);
    body.innerHTML = lastHtml;
    task.innerHTML = s.task ? `<span class="tut-check"></span><span>${s.task}</span>` : '';
    task.style.display = s.task ? '' : 'none';
    prevBtn.style.visibility = index > 0 ? '' : 'hidden';
    nextBtn.textContent = index === STEPS.length - 1 ? 'Terminer ✓' : index === 0 ? 'Commencer →' : 'Suivant →';
    card.classList.toggle('center', s.side === 'center');
    pill.textContent = `▸ Tutoriel · ${s.title}`;
    wasDone = false;
    refreshState(true);
  };

  /** Task state, hint, buttons: cheap, run several times a second. */
  const refreshState = (force = false) => {
    const s = step();
    const done = s.done ? safe(() => s.done!(ctx), false) : true;
    if (done !== wasDone || force) {
      wasDone = done;
      card.classList.toggle('is-done', !!s.task && done);
      task.classList.toggle('ok', done);
      const sc = done && s.success ? (typeof s.success === 'function' ? s.success(ctx) : s.success) : '';
      success.innerHTML = sc;
      success.style.display = sc ? '' : 'none';
      nextBtn.classList.toggle('pulse', !!s.task && done);
    }
    const hn = done ? null : s.edit && app.mode === 'play' ? 'Échap repasse en mode édition.' : s.hint ? safe(() => s.hint!(ctx), null) : null;
    hint.textContent = hn ?? '';
    hint.style.display = hn ? '' : 'none';
    doBtn.style.display = !done && s.doIt && safe(() => (s.doIt!.show ? s.doIt!.show(ctx) : true), false) ? '' : 'none';
    if (s.doIt) doBtn.textContent = `Faire pour moi : ${s.doIt.label.toLowerCase()}`;
    const showFix = done && !!s.fix && safe(() => (s.fix!.show ? s.fix!.show(ctx) : true), false);
    fixBtn.style.display = showFix ? '' : 'none';
    if (s.fix) fixBtn.textContent = s.fix.label;
    // the text may depend on the app (the diagnosis step)
    if (typeof s.html === 'function') {
      const h = html(s);
      if (h !== lastHtml) { lastHtml = h; body.innerHTML = h; }
    }
  };

  const safe = <T,>(f: () => T, fallback: T): T => {
    try { return f(); } catch (err) { console.warn('[tutorial]', err); return fallback; }
  };

  // ---------------------------------------------------------- layout
  interface Rect { l: number; t: number; r: number; b: number }
  const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
  let lastPick = -1, lastStep = -1;
  /** where the learner dragged the card; kept until the next step */
  let manual: [number, number] | null = null;
  const place = () => {
    const s = step();
    const modalOpen = !!document.querySelector('.modal-bg');
    const t = minimized ? null : targetEl();
    if (t && !modalOpen) {
      const r = t.getBoundingClientRect();
      const pad = 6;
      spot.classList.remove('hidden');
      spot.style.left = `${r.left - pad}px`;
      spot.style.top = `${r.top - pad}px`;
      spot.style.width = `${r.width + pad * 2}px`;
      spot.style.height = `${r.height + pad * 2}px`;
      // the viewport is big: only outline it, no dimming around it
      spot.classList.toggle('soft', r.width * r.height > window.innerWidth * window.innerHeight * 0.25);
    } else spot.classList.add('hidden');

    if (minimized) return;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    const W = window.innerWidth, H = window.innerHeight, m = 14, gap = 16;
    const clamp = ([x, y]: number[]): [number, number] => [Math.max(m, Math.min(W - cw - m, x)), Math.max(m, Math.min(H - ch - m, y))];
    let cands: [number, number][];
    // what the card must not hide: the target and the scene markers
    const keep: Rect[] = markPts.map(([px, py]) => ({ l: px - 26, t: py - 42, r: px + 90, b: py + 22 }));
    // and the object being edited
    const sel = app.mode === 'edit' ? app.selectedEntity : null;
    const rc = sel ? document.querySelector<HTMLCanvasElement>('.frame canvas')?.getBoundingClientRect() : null;
    if (sel && rc) {
      v.set(...sel.position).project(app.stage.camera);
      if (v.z < 1) {
        const px = rc.left + ((v.x + 1) / 2) * rc.width, py = rc.top + ((1 - v.y) / 2) * rc.height;
        keep.push({ l: px - 70, t: py - 80, r: px + 70, b: py + 50 });
      }
    }
    if (modalOpen) cands = [[m, H - ch - m]];
    else if (s.side === 'center' || !t) cands = [[(W - cw) / 2, (H - ch) / 2]];
    else {
      const r = t.getBoundingClientRect();
      const big = r.width * r.height > W * H * 0.25;
      if (!big) keep.push({ l: r.left - 8, t: r.top - 8, r: r.right + 8, b: r.bottom + 8 });
      const sides: Record<string, [number, number]> = {
        right: [r.right + gap, r.top], left: [r.left - gap - cw, r.top],
        bottom: [r.left, r.bottom + gap], top: [r.left, r.top - gap - ch],
      };
      const pref = s.side && sides[s.side] ? s.side : 'right';
      // then the corners of the viewport, clear of its own overlays
      const vr = (document.querySelector('[data-tut="view"]') ?? document.body).getBoundingClientRect();
      cands = [
        sides[pref], sides.right, sides.left, sides.bottom, sides.top,
        [r.right + gap, r.bottom - ch], [r.left - gap - cw, r.bottom - ch],
        [vr.right - cw - m, vr.bottom - ch - 60], [vr.left + m, vr.bottom - ch - 60],
        [vr.right - cw - m, vr.top + 60], [vr.left + m, vr.top + 60],
      ];
    }
    if (manual) {
      const [x, y] = clamp(manual);
      card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      return;
    }
    const placed = cands.map(clamp);
    const score = ([x, y]: [number, number]) => keep.reduce((a, k) => a + overlap({ l: x, t: y, r: x + cw, b: y + ch }, k), 0);
    const scores = placed.map(score);
    // keep the previous spot while it stays clear, so the card does not hop
    let pick = lastPick >= 0 && lastPick < placed.length && scores[lastPick] === 0 && lastStep === index ? lastPick : scores.indexOf(0);
    if (pick < 0) pick = scores.indexOf(Math.min(...scores));
    lastPick = pick; lastStep = index;
    const [x, y] = placed[pick];
    card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };

  // --------------------------------------------------- scene markers
  const markEls: HTMLElement[] = [];
  /** screen positions of the markers drawn this frame */
  let markPts: [number, number][] = [];
  const v = new THREE.Vector3();
  const drawMarks = () => {
    const s = step();
    const list = !minimized && s.marks && app.mode === 'edit' && !document.querySelector('.modal-bg') ? safe(() => s.marks!(ctx), []) : [];
    const canvas = document.querySelector<HTMLCanvasElement>('.frame canvas');
    const rc = canvas?.getBoundingClientRect();
    markPts = [];
    while (markEls.length < list.length) { const m = el('div', 'tut-mark', '<i></i><span></span>'); marks.append(m); markEls.push(m); }
    markEls.forEach((m, i) => {
      const mk = list[i];
      if (!mk || !rc) { m.style.display = 'none'; return; }
      v.set(...mk.p).project(app.stage.camera);
      if (v.z > 1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) { m.style.display = 'none'; return; }
      m.style.display = '';
      const px = rc.left + ((v.x + 1) / 2) * rc.width, py = rc.top + ((1 - v.y) / 2) * rc.height;
      markPts.push([px, py]);
      m.style.transform = `translate(${px}px, ${py}px)`;
      m.querySelector('span')!.textContent = mk.label;
    });
  };

  // ------------------------------------------------------------- loop
  let lastState = 0;
  const frame = () => {
    if (!active) return;
    raf = requestAnimationFrame(frame);
    const s = step();
    // the course borrows the viewport and plays its own scenes: stand aside
    const course = document.body.classList.contains('course-on');
    settings?.set({ holdEdit: !course && !!s.edit });
    if (course) return;
    if (s.tick) safe(() => s.tick!(ctx), undefined);
    const now = performance.now();
    if (now - lastState > 120) { lastState = now; refreshState(); }
    drawMarks();
    place();
  };

  app.on((what) => {
    if (!active || document.body.classList.contains('course-on')) return;
    ctx.seen.add(what);
    const s = step();
    if (s.on) safe(() => s.on!(ctx, what), undefined);
    refreshState();
  });

  // ------------------------------------------------------- navigation
  const go = (i: number) => {
    index = Math.max(0, Math.min(STEPS.length - 1, i));
    manual = null;
    card.classList.remove('moved');
    ctx = { app, ui, mem: {}, seen: new Set() };
    save({ step: index });
    const s = step();
    settings?.set({ holdEdit: !!s.edit });
    if (s.edit && app.mode === 'play') app.setMode('edit');
    if (s.enter) safe(() => s.enter!(ctx), undefined);
    renderCard();
    // a palette tile or a pane row may be scrolled out of sight
    requestAnimationFrame(() => targetEl()?.scrollIntoView({ block: 'nearest' }));
    card.classList.remove('enter');
    void card.offsetWidth;
    card.classList.add('enter');
  };

  prevBtn.onclick = () => go(index - 1);
  nextBtn.onclick = () => {
    if (index === STEPS.length - 1) { save({ step: 0, finished: true }); finish(); return; }
    go(index + 1);
  };
  doBtn.onclick = () => { const s = step(); if (s.doIt) safe(() => s.doIt!.run(ctx), undefined); refreshState(true); };
  fixBtn.onclick = () => { const s = step(); if (s.fix) safe(() => s.fix!.run(ctx), undefined); refreshState(true); };
  minBtn.onclick = () => setMin(true);

  // drag the card by its header to see what it hides; double-click puts it back
  head.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || (ev.target as HTMLElement).closest('button')) return;
    ev.preventDefault();
    const r = card.getBoundingClientRect();
    const dx = ev.clientX - r.left, dy = ev.clientY - r.top;
    head.setPointerCapture(ev.pointerId);
    card.classList.add('dragging', 'moved');
    const move = (e: PointerEvent) => { manual = [e.clientX - dx, e.clientY - dy]; place(); };
    const up = () => {
      card.classList.remove('dragging');
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  });
  head.addEventListener('dblclick', (ev) => {
    if ((ev.target as HTMLElement).closest('button')) return;
    manual = null;
    card.classList.remove('moved');
  });
  head.title = 'Glisser pour déplacer · double-clic pour replacer';
  pill.onclick = () => setMin(false);
  closeBtn.onclick = () => finish();

  const setMin = (m: boolean) => {
    minimized = m;
    card.classList.toggle('hidden', m);
    pill.classList.toggle('hidden', !m);
  };

  // Enter moves on once a step is done (never while typing in a field)
  window.addEventListener('keydown', (ev) => {
    if (!active || minimized || ev.key !== 'Enter') return;
    const tag = (ev.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
    if (wasDone) { ev.preventDefault(); nextBtn.click(); }
  });

  // ------------------------------------------------------ open / close
  /** Start screen: resume or restart, and the scene the learner had. */
  const welcome = (saved: Saved | null) => {
    const resumeAt = saved && !saved.finished && saved.step > 0 ? saved.step : 0;
    if (!resumeAt) { go(0); return; }
    // resume at the start of the part: its first steps set up the scene
    const p = STEPS[resumeAt].part;
    const at = Math.max(partStart(p), p === 1 ? partStart(1) : 0);
    go(at);
  };

  const finish = () => {
    if (!active) return;
    const changed = readText(KEYS.tutorialBackup) !== JSON.stringify(app.doc);
    if (!changed) { teardown(); return; }
    // offer to bring back the scene they had before the tour
    const bg = el('div', 'modal-bg');
    const box = el('div', 'modal');
    box.innerHTML = '<h3>Quitter le tutoriel</h3><p>Garder la scène du tutoriel, ou revenir à celle que vous aviez avant de commencer ?</p>';
    const acts = el('div', 'actions');
    const keep = el('button', 'btn', 'Garder cette scène');
    const back = el('button', 'btn primary', 'Revenir à ma scène');
    acts.append(keep, back);
    box.append(acts);
    bg.append(box);
    document.body.append(bg);
    keep.onclick = () => { bg.remove(); teardown(); };
    back.onclick = () => {
      bg.remove();
      const s = readJSON<SceneDoc | null>(KEYS.tutorialBackup, null);
      if (s) { app.pushUndo(); app.setDoc(s); app.saveNow(); }
      teardown();
    };
  };

  const teardown = () => {
    active = false;
    settings?.pop();
    settings = null;
    cancelAnimationFrame(raf);
    root.classList.add('hidden');
    document.body.classList.remove('tut-on');
    removeKey(KEYS.tutorialBackup);
  };

  // dev console: tutorial.go(i), tutorial.list()
  if (import.meta.env.DEV) (window as any).tutorial = { go: (i: number) => { if (!active) api.open(); go(i); }, list: () => STEPS.map((s, i) => `${i} ${s.title}`).join('\n'), get index() { return index; }, ctx: () => ctx };

  const api: Tutorial = {
    get active() { return active; },
    open() {
      if (active) { setMin(false); return; }
      active = true;
      settings = app.pushSettings();
      if (readText(KEYS.tutorialBackup) === null) writeJSON(KEYS.tutorialBackup, app.doc);
      root.classList.remove('hidden');
      document.body.classList.add('tut-on');
      setMin(false);
      welcome(load());
      raf = requestAnimationFrame(frame);
    },
    close: () => finish(),
  };
  return api;
}
