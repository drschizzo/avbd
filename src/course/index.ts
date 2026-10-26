// Mounts the course over Loop Lab: it takes the viewport, drives the scene and
// the solver settings, and runs its own narration clock.

import type { App } from '../app';
import { MODULES, Progress } from './course';
import { HomeUI } from './home';
import { SCENES, sceneDoc, type SceneKey } from './scenes';
import { DOC_KEYS, Tour, type Stop, type Vals } from './tour';
import { TourUI } from './tourUI';
import { openLab, type Challenge } from './lab';
import './style.css';

export interface Course {
  open(): void;
  close(): void;
  readonly active: boolean;
}

export function mountCourse(app: App): Course {
  const tour = new Tour(MODULES);
  const prog = new Progress();
  let active = false;
  let mode: 'home' | 'tour' = 'home';
  let rafId = 0;
  let last = performance.now();
  let curScene: SceneKey | null = null;
  let rebakeTimer = 0;
  let labOpen = false;
  let menuWasPlaying = true;

  const challenges: Challenge[] = [];

  const ui = new TourUI(tour, {
    onSeek: (t) => seek(t),
    onStop: (st) => { seek(st.t - 0.01); tour.t = st.t; tour.enterStop(st); },
    onToggle: () => { if (tour.stop) tour.resume(); else tour.playing = !tour.playing; },
    onResume: () => tour.resume(),
    onPauses: (on) => { tour.pauses = on; ui.setPauses(on); if (!on) tour.resume(); },
    onLive: (key, v, until) => liveEdit(key, v, until),
    onCard: (st) => { home.showCard(st); },
    onQuiz: (id, ok) => prog.quiz(id, ok),
    onMission: (id) => { prog.mission(id); toast('Mission accomplie ✓'); },
    onMenu: () => openMenu(),
    onLab: () => showLab(),
    onQuit: () => close(),
    onCamReset: () => { app.freeCamera = false; ui.setCamFree(false); },
  });

  const home = new HomeUI(tour, prog, {
    onStart: (t) => { home.closeHome(); home.hideCard(); startTour(t); },
    onClose: () => { home.closeHome(); home.hideCard(); if (mode === 'tour') { tour.resume(); tour.playing = menuWasPlaying; } else startTour(prog.d.lastT || 0); },
    onQuit: () => close(),
    onLab: () => showLab(),
    challenges,
  });

  const toastEl = document.createElement('div');
  toastEl.className = 'c-toast hidden';
  let toastTimer = 0;
  function toast(msg: string): void {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.add('hidden'), 2000);
  }

  const root = document.createElement('div');
  root.className = 'course-root hidden';
  root.append(ui.root, home.root, home.card, toastEl);
  document.body.append(root);

  // ----------------------------------------------------------------- scene

  /** Loads the scene a given time calls for, and applies the solver settings. */
  function syncScene(force = false): void {
    const ev = tour.sceneAt(tour.t);
    const key = ev?.key ?? 'intro';
    const vals = tour.docVals(tour.t);
    if (force || key !== curScene) {
      curScene = key;
      const doc = sceneDoc(key);
      applyVals(doc, vals);
      lastDocVals = { ...vals };
      app.autoBake = true;
      app.setDoc(doc);
      app.loopPlayback = true;
      app.freeCamera = false;
      ui.setCamFree(false);
      ui.setBadge(SCENES[key].label);
      return;
    }
    // same scene: only re-bake when a solver setting actually changed
    let changed = false;
    for (const k of Object.keys(vals)) if (lastDocVals[k] !== vals[k]) changed = true;
    if (changed) {
      lastDocVals = { ...vals };
      clearTimeout(rebakeTimer);
      rebakeTimer = window.setTimeout(() => {
        applyVals(app.doc, vals);
        app.commit('physics');
      }, 140);
    }
  }

  let lastDocVals: Vals = {};

  function applyVals(doc: Parameters<typeof DOC_KEYS['substeps']>[0], vals: Vals): void {
    for (const [k, fn] of Object.entries(DOC_KEYS)) if (k in vals) fn(doc, vals[k]);
  }

  // ------------------------------------------------------------ navigation

  function seek(t: number): void {
    t = Math.min(tour.duration - 0.01, Math.max(0, t));
    tour.resetStops(t);
    tour.t = t;
    tour.playing = true;
    home.hideCard();
    syncScene(true);
  }

  function startTour(t: number): void {
    mode = 'tour';
    ui.show(true);
    ui.setPauses(tour.pauses);
    seek(t);
  }

  function openMenu(): void {
    menuWasPlaying = tour.playing;
    tour.playing = false;
    home.openHome(mode === 'tour');
  }

  function showLab(): void {
    labOpen = true;
    menuWasPlaying = tour.playing;
    tour.playing = false;
    openLab(root, prog, challenges, () => {
      labOpen = false;
      if (mode === 'tour' && !tour.stop && !home.open) tour.playing = menuWasPlaying;
    });
  }

  /** A value edited straight in the displayed code pauses the tour on it. */
  function liveEdit(key: string, v: number, until: number): void {
    let st = tour.stop;
    if (!st) {
      st = {
        t: tour.t, until: Math.max(until, tour.t + 0.5), kind: 'try', id: `live-${key}-${tour.t.toFixed(1)}`,
        title: 'Modifiez la valeur',
        prompt: 'La visite attend pendant que vous expérimentez. Glissez les valeurs soulignées, et regardez la scène et le schéma réagir. Vos réglages tiennent jusqu’à l’explication suivante.',
        controls: [], ov: {}, visited: true,
      };
      const base = tour.eval(tour.t);
      st.ov[key] = base[key] ?? v;
      tour.stops.push(st);
      tour.stops.sort((a, b) => a.t - b.t);
      tour.stop = st;
      tour.playing = false;
      tour.ptr = null;
    }
    st.ov[key] = v;
  }

  // ------------------------------------------------------------- the clock

  function frame(): void {
    rafId = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!active) return;
    if (home.open || labOpen) { ui.update(tour.t, tour.eval(tour.t), false); return; }

    if (mode === 'tour') {
      if (tour.playing) {
        const t0 = tour.t;
        tour.t += dt;
        const st = tour.stopBetween(t0, tour.t);
        if (st) { tour.t = st.t; tour.enterStop(st); }
        trackProgress(t0, tour.t);
        if (!st && tour.t >= tour.duration) {
          prog.seen(tour.chapters[tour.chapters.length - 1].title);
          tour.t = tour.duration - 0.01;
          tour.playing = false;
          openMenu();
        }
      } else if (tour.stop) tour.extra += dt;
      prog.setT(tour.t);
      syncScene();
      ui.update(tour.t, tour.eval(tour.t), tour.playing);
      // tell the learner when the scene is being recomputed
      const key = curScene ? SCENES[curScene].label : '';
      ui.setBadge(app.baking ? `${key} · recalcul ${Math.round((app.bakeProgress.frame / Math.max(1, app.bakeProgress.total)) * 100)} %` : key, app.baking ? 'baking' : '');
    }
  }

  function trackProgress(t0: number, t1: number): void {
    const c0 = tour.chapterAt(t0), c1 = tour.chapterAt(t1);
    if (c1 !== c0) prog.seen(tour.chapters[c0].title);
  }

  // ---------------------------------------------------------------- keys

  function onKey(ev: KeyboardEvent): void {
    if (!active) return;
    const tgt = ev.target as HTMLElement | null;
    if (tgt && (tgt.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(tgt.tagName))) return;
    if (labOpen) return;
    if (ev.key === 'Escape') {
      if (home.open) { if (mode === 'tour') { home.closeHome(); tour.playing = menuWasPlaying; } else close(); } else close();
      ev.preventDefault();
      return;
    }
    if (home.open) return;
    if (ev.key === 'm' || ev.key === 'M') { openMenu(); return; }
    if (ev.key === 'l' || ev.key === 'L') { showLab(); return; }
    const qi = ['1', '2', '3', '4'].indexOf(ev.key);
    if (qi >= 0 && tour.stop?.kind === 'quiz') { ui.answer(qi); return; }
    if (ev.code === 'Space') {
      if (tour.stop?.kind === 'card') { home.hideCard(); tour.resume(); } else if (tour.stop) tour.resume();
      else tour.playing = !tour.playing;
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Enter' && tour.stop?.kind === 'card') { home.hideCard(); tour.resume(); ev.preventDefault(); return; }
    if (ev.key === 'ArrowRight') { seek(tour.t + 5); ev.preventDefault(); }
    if (ev.key === 'ArrowLeft') { seek(tour.t - 5); ev.preventDefault(); }
  }

  // --------------------------------------------------------------- toggle

  // The scene camera is the scene's own animated shot. The first drag or wheel
  // on the 3D view hands it to the learner: the orbit starts from the current
  // view, around the shot's target. Capture phase, so that OrbitControls —
  // disabled until now — already sees this very pointerdown.
  const viewEl = app.orbit.domElement as HTMLElement;
  function grabCamera(): void {
    if (!active || app.freeCamera) return;
    app.orbit.target.set(...app.doc.camera.target);
    app.freeCamera = true;
    app.orbit.enabled = true;
    app.orbit.update();
    ui.setCamFree(true);
  }

  let savedDoc: string | null = null;
  let savedAuto = true;
  let savedPaced = true;

  function open(): void {
    if (active) return;
    active = true;
    savedDoc = JSON.stringify(app.doc);
    savedAuto = app.autoBake;
    // the course re-bakes on every solver tweak: throughput beats a fluid
    // preview here, a paced bake would take seconds per slider move
    savedPaced = app.baker.paced;
    app.baker.paced = false;
    // the course's scenes must not replace the user's saved document, nor
    // show up in their undo history
    app.persist = false;
    document.body.classList.add('course-on');
    root.classList.remove('hidden');
    mode = 'home';
    ui.show(false);
    home.hideCard();
    home.openHome(false);
    window.addEventListener('keydown', onKey, true);
    viewEl.addEventListener('pointerdown', grabCamera, true);
    viewEl.addEventListener('wheel', grabCamera, { capture: true, passive: true });
    last = performance.now();
    rafId = requestAnimationFrame(frame);
    window.dispatchEvent(new Event('resize'));
  }

  function close(): void {
    if (!active) return;
    active = false;
    cancelAnimationFrame(rafId);
    clearTimeout(rebakeTimer);
    window.removeEventListener('keydown', onKey, true);
    viewEl.removeEventListener('pointerdown', grabCamera, true);
    viewEl.removeEventListener('wheel', grabCamera, true);
    app.freeCamera = false;
    document.body.classList.remove('course-on');
    root.classList.add('hidden');
    home.closeHome();
    home.hideCard();
    ui.show(false);
    prog.save();
    app.autoBake = savedAuto;
    app.baker.paced = savedPaced;
    if (savedDoc) app.setDoc(JSON.parse(savedDoc), { resetHistory: false });
    app.persist = true;
    app.saveNow();
    curScene = null;
    window.dispatchEvent(new Event('resize'));
  }

  const api = { open, close, get active() { return active; } };
  if (import.meta.env.DEV) {
    // dev helper: course.go(t) jumps the narration anywhere
    (window as any).course = Object.assign(api, {
      tour, prog, ui, home,
      go: (t: number) => { if (!active) open(); mode = 'tour'; ui.show(true); home.closeHome(); home.hideCard(); seek(t); },
      chapter: (i: number) => (window as any).course.go(tour.chapters[i].t + 0.2),
      list: () => tour.chapters.map((c, i) => `${i}  ${c.t.toFixed(0)}s  ${c.part} · ${c.title}`).join('\n'),
    });
  }
  return api;
}

export type { Stop };
