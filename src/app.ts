// Application core: owns the document, the GPU stage, baking and playback.

import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Stage, createDevice } from './render/stage';
import { BodyRenderer } from './render/bodies';
import { FluidRenderer } from './fluid/fluidRender';
import { Baker, type BakeProgress, type BakeResult } from './sim/baker';
import { BakeController, type TrialState } from './sim/bakeController';
import { buildScene, type BuildOptions, type BuiltScene } from './scene/build';
import { defaultDoc, type Entity, type SceneDoc } from './scene/doc';
import { ENTITY_DEFS, createEntity } from './scene/entities';
import { PRESETS } from './scene/presets';
import { boomerangSimTime, boomerangSpans } from './sim/loopTime';
import { EditTools } from './edit/tools';
import type { MachineReport } from './sim/analysis';
import { Emitter, type AppEvent, type ChangeKind, type Listener } from './core/events';
import { SettingsStack, type AppSettings, type SettingsLayer } from './core/context';
import { History } from './core/history';
import { loadSavedDoc, saveDoc, saveDocSoon, shareUrl } from './core/persistence';
import { round } from './util/num';
import { ShotCamera } from './render/shotCamera';
import { Selection, type SelectOpts } from './edit/selection';
import { EditorViewport } from './edit/viewport';

export type Mode = 'edit' | 'play';
export type { ChangeKind } from './core/events';

export class App {
  stage!: Stage;
  bodies!: BodyRenderer;
  fluid!: FluidRenderer;
  baker!: Baker;
  device!: GPUDevice;
  doc: SceneDoc = defaultDoc();
  built!: BuiltScene;
  orbit!: OrbitControls;
  /** gizmos, picking, selection boxes, markers, machine-check overlays */
  view!: EditorViewport;
  /** placement, drawing, workplane, path handles, ports */
  tools!: EditTools;

  mode: Mode = 'edit';
  private sel = new Selection();
  /** primary selection (the one the Object tab edits) */
  get selection(): string | null { return this.sel.primary; }
  /** every selected entity id (includes `selection`) */
  get selectedIds(): string[] { return this.sel.ids; }
  playing = false;
  time = 0;
  loopPlayback = true;
  freeCamera = false;
  /** baking, streaming, machine check, trials */
  readonly bakes = new BakeController(this);
  /**
   * Settings the course and the tutorial override while they run
   * (`pushSettings`); `autoBake` and the rest read the result.
   */
  readonly settings = new SettingsStack(
    { persist: true, holdEdit: false, autoBake: true, pacedBake: true },
    (s) => { if (this.baker) this.baker.paced = s.pacedBake; },
  );
  pushSettings(patch: Partial<AppSettings> = {}): SettingsLayer { return this.settings.push(patch); }
  /** the user's auto-bake toggle (a layer may override it) */
  get autoBake(): boolean { return this.settings.value.autoBake; }
  set autoBake(on: boolean) { this.settings.setBase({ autoBake: on }); }
  get persist(): boolean { return this.settings.value.persist; }
  get holdEdit(): boolean { return this.settings.value.holdEdit; }
  get baking(): boolean { return this.bakes.baking; }
  get bakeProgress(): BakeProgress { return this.bakes.progress; }
  get bakeError(): string | null { return this.bakes.error; }
  get result(): BakeResult | null { return this.bakes.result; }
  /** physics changed since the last bake */
  get stale(): boolean { return this.bakes.stale; }
  /** machine check of the last bake (see sim/analysis) */
  get report(): MachineReport | null { return this.bakes.report; }
  /** the report describes an older version of the scene */
  get reportStale(): boolean { return this.bakes.reportStale; }
  get analyzing(): boolean { return this.bakes.analyzing; }
  get trials(): TrialState | null { return this.bakes.trials; }
  fpsMeter = { last: performance.now(), frames: 0, fps: 0, gpuMs: 0 };
  exporting = false;
  private shot = new ShotCamera();

  private events = new Emitter<AppEvent>();
  private history = new History(() => this.doc);
  private lastFrameTime = performance.now();

  /** Subscribes to app events; returns the unsubscribe function. */
  on(fn: Listener<AppEvent>): () => void { return this.events.on(fn); }
  emit(what: AppEvent): void { this.events.emit(what); }

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this.device = await createDevice();
    this.stage = new Stage(canvas, this.device);
    await this.stage.init();
    this.bodies = new BodyRenderer(this.stage.renderer);
    this.bodies.setEnvironment(this.stage.environmentTexture);
    this.fluid = new FluidRenderer(this.stage.renderer);
    this.stage.fluid = this.fluid;
    this.stage.scene.add(this.bodies.root, this.fluid.shadowRoot);
    this.baker = new Baker(this.stage.renderer, this.device);
    this.settings.update();

    this.orbit = new OrbitControls(this.stage.camera, canvas);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.addEventListener('change', () => {
      if (!this.freeCamera && !this.playing) {
        const c = this.stage.camera.position, t = this.orbit.target;
        this.doc.camera.position = [round(c.x), round(c.y), round(c.z)];
        this.doc.camera.target = [round(t.x), round(t.y), round(t.z)];
        this.scheduleSnapshot();
        this.emit('camera');
      }
    });

    this.view = new EditorViewport(this, canvas);
    this.tools = new EditTools(this, canvas);
    this.stage.scene.add(this.tools.root);
    this.view.installPicking(canvas);

    const saved = loadSavedDoc();
    this.setDoc(saved ?? PRESETS[0].make(), { resetHistory: true });
  }

  // ------------------------------------------------------------------ doc

  setDoc(doc: SceneDoc, opts: { resetHistory?: boolean } = {}): void {
    this.doc = doc;
    this.sel.clear();
    this.bakes.forgetReport();
    this.refreshFollow();
    this.view?.updateAnalysisVisuals();
    this.tools?.reset();
    this.history.reset(doc, !!opts.resetHistory);
    this.applyCameraFromDoc();
    this.rebuild();
    this.markStale();
    this.emit('doc');
  }

  loadPreset(key: string): void {
    const p = PRESETS.find((x) => x.key === key);
    if (!p) return;
    this.pushUndo();
    this.setDoc(p.make());
  }

  /** Called by the UI after mutating `doc`. */
  commit(kind: ChangeKind): void {
    if (kind === 'physics') {
      this.rebuild();
      this.markStale();
    } else if (kind === 'loop') {
      // boomerang changes the simulated length, sink toggles the ground mid-clip:
      // only those require a new bake, the other transitions are pure rendering.
      const key = this.loopSimKey();
      this.rebuild();
      if (key !== this.lastLoopKey) this.markStale();
    } else if (kind === 'visual') {
      this.rebuild();
    } else if (kind === 'camera') {
      this.applyCameraFromDoc();
    }
    this.scheduleSnapshot();
    this.saveLocalSoon();
    this.emit(kind);
  }

  private lastLoopKey = '';
  private loopSimKey(): string {
    const l = this.doc.loop;
    // boomerang: the rewind speed and apex set the simulated span;
    // continuous: the outro sets how much of the warm-up tail is kept
    return `${l.mode === 'boomerang' ? `${l.rewind}|${l.apex}` : false}|${l.mode === 'sink' || l.mode === 'continuous' ? l.outro : -1}|${l.mode === 'continuous'}`;
  }

  /** Solo: only these entities are built and baked (test a part alone). */
  solo: Set<string> | null = null;

  buildOptions(): BuildOptions {
    return { only: this.solo ?? undefined, jitter: this.bakes.jitter ?? undefined };
  }

  setSolo(ids: string[] | null): void {
    this.solo = ids && ids.length ? new Set(ids) : null;
    this.rebuild();
    this.markStale();
    this.emit('solo');
  }

  /** Rebuilds the bodies from the document and shows them at rest. */
  rebuild(): void {
    this.built = buildScene(this.doc, this.buildOptions());
    this.bodies.setScene(this.built, this.doc);
    this.bodies.setLoop(this.doc);
    this.fluid.setScene(this.built.fluid, this.doc);
    this.fluid.setLoop(this.doc);
    this.stage.applyRender(this.doc, this.built.bounds);
    this.bodies.uEnvIntensity.value = this.doc.render.envIntensity;
    this.view.updateHelpers();
    this.view.updateSelectionVisuals();
    this.tools?.refresh();
  }

  private markStale(): void {
    this.lastLoopKey = this.loopSimKey();
    this.bakes.invalidate();
    this.setMode('edit');
    this.bakes.scheduleAuto();
    this.emit('bake');
  }

  // ---------------------------------------------------------------- bake

  bake(): Promise<void> { return this.bakes.bake(); }

  /** Stops the running bake (the scene stays stale). */
  cancelBake(): void {
    this.bakes.cancel();
    this.bakes.stale = true;
    this.emit('bake');
  }

  runTrials(n: number, untilSuccess: boolean): Promise<void> { return this.bakes.runTrials(n, untilSuccess); }

  /** Re-judges the last check (e.g. an object marked as decor) without baking. */
  rejudge(): void { this.bakes.rejudge(); }

  /**
   * Starts playback from the top unless the user is editing (something is
   * selected) or a tutorial step holds the editor. `streaming`: the first
   * frames of a bake just arrived (else the bake finished).
   */
  playIfIdle(streaming: boolean): void {
    // while an object is selected the user is editing: bake in the
    // background and keep the gizmo (Space plays the result)
    if (this.selection || this.holdEdit) return;
    if (!streaming && this.mode === 'play') return;
    this.setMode('play');
    this.time = 0;
    this.playing = true;
  }

  setMode(m: Mode, opts: { keepCamera?: boolean } = {}): void {
    if (this.mode === m) return;
    this.mode = m;
    this.bodies.setEditMode(m === 'edit');
    this.fluid.setEditMode(m === 'edit');
    this.view.setEditMode(m === 'edit');
    this.tools.root.visible = m === 'edit';
    if (m === 'edit') {
      this.playing = false;
      this.time = 0;
      // the free camera is the user's own view: never snap it back
      if (!opts.keepCamera && !this.freeCamera) this.applyCameraFromDoc();
    }
    this.view.updateSelectionVisuals();
    this.emit('mode');
  }

  togglePlay(): void {
    if (this.mode === 'edit') {
      if (this.result || this.baking) { this.setMode('play'); this.playing = true; }
      else void this.bake();
    } else {
      this.playing = !this.playing;
    }
    this.emit('time');
  }

  seek(t: number): void {
    if (this.mode === 'edit' && (this.result || this.baking)) this.setMode('play');
    this.time = Math.max(0, Math.min(this.doc.duration - 1e-4, t));
    this.emit('time');
  }

  /** Recorded frames currently available for playback. */
  get availableFrames(): number { return this.bakes.availableFrames; }

  /** Maps video time to the playback uniforms. */
  playbackAt(t: number): { frameA: number; frameB: number; mix: number; simFrame: number; time: number } {
    const fps = this.doc.fps;
    const D = this.doc.duration;
    let simT = t;
    if (this.doc.loop.mode === 'boomerang') simT = boomerangSimTime(boomerangSpans(this.doc), t, D);
    const res = this.bakes.current;
    const every = res?.recordEvery ?? 1;
    const avail = Math.max(1, this.availableFrames);
    const simFrame = simT * fps;
    const fr = Math.min(simFrame / every, avail - 1);
    const a = Math.floor(fr);
    const b = Math.min(a + 1, avail - 1);
    return { frameA: a, frameB: b, mix: fr - a, simFrame, time: t };
  }

  // -------------------------------------------------------------- camera

  applyCameraFromDoc(): void {
    const c = this.doc.camera;
    this.stage.camera.fov = c.fov;
    this.stage.camera.position.set(...c.position);
    this.orbit?.target.set(...c.target);
    this.stage.camera.lookAt(...c.target);
    this.stage.camera.updateProjectionMatrix();
  }

  /** Re-reads where the action is (after a bake, or when objects stop or start drawing the camera). */
  refreshFollow(): void { this.shot.refresh(this.report, this.built, this.doc); }

  /** Animated shot camera at time t (periodic over the loop). */
  shotCamera(t: number, cam: THREE.PerspectiveCamera): void {
    this.shot.apply(this.doc, t, this.playbackAt(t).simFrame / this.doc.fps, cam);
  }

  /** where the shot camera looks this frame (focus distance) */
  get shotTarget(): THREE.Vector3 { return this.shot.target; }

  // ------------------------------------------------------------- frame

  update(): void {
    const now = performance.now();
    // While baking, cap the preview at 60 fps: on high-refresh displays every
    // extra render is GPU time taken from the bake. The bake is paced on the
    // rendered frames only.
    if (this.baking && now - this.lastFrameTime < 1000 / 60 - 2) return;
    this.baker.onDisplayFrame(now);
    const dt = Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    this.fpsMeter.frames++;
    if (now - this.fpsMeter.last > 500) {
      this.fpsMeter.fps = (this.fpsMeter.frames * 1000) / (now - this.fpsMeter.last);
      this.fpsMeter.frames = 0;
      this.fpsMeter.last = now;
    }
    if (this.exporting) return;

    if (this.mode === 'play' && this.playing) {
      let t = this.time + dt;
      // while streaming, never run ahead of the baked frames
      if (this.baking && !this.result) {
        const every = this.baker.currentPartial?.recordEvery ?? 1;
        const maxT = Math.max(0, ((this.availableFrames - 1) * every) / this.doc.fps);
        const limit = this.doc.loop.mode === 'boomerang' ? 0 : maxT;
        if (this.doc.loop.mode !== 'boomerang' && t > limit) t = limit;
      }
      if (t >= this.doc.duration) t = this.loopPlayback ? t % this.doc.duration : this.doc.duration - 1e-4;
      this.time = t;
      this.emit('time');
    }

    const pb = this.mode === 'play' ? this.playbackAt(this.time) : { frameA: 0, frameB: 0, mix: 0, simFrame: 0, time: 0 };
    this.bodies.setPlayback(pb);
    this.fluid.setPlayback(pb);

    const cam = this.stage.camera;
    if (this.mode === 'play' && !this.freeCamera) {
      this.orbit.enabled = false;
      this.shotCamera(this.time, cam);
    } else {
      this.orbit.enabled = !this.view.gizmo.dragging && !this.view.gizmoRot.dragging && !this.tools.blockOrbit;
      this.orbit.update();
    }
    const shot = this.mode === 'play' && !this.freeCamera;
    const focus = this.doc.render.focus > 0 ? this.doc.render.focus : cam.position.distanceTo(shot ? this.shotTarget : new THREE.Vector3(...this.doc.camera.target));
    this.stage.setFocus(focus);
    this.stage.render();
  }

  // ------------------------------------------------------------ editing

  get selectedEntity(): Entity | null { return this.sel.entity(this.doc); }

  get selectedEntities(): Entity[] { return this.sel.entities(this.doc); }

  /** Entity indices (in doc.entities) of the selection. */
  selectedIndices(): Set<number> { return this.sel.indices(this.doc); }

  /**
   * Selects an entity. Clicking a member of a group selects the whole group
   * unless `single`; `toggle` adds or removes (Shift-click).
   */
  select(id: string | null, opts: SelectOpts = {}): void {
    this.sel.select(this.doc, id, opts);
    this.selectionChanged();
  }

  selectMany(ids: string[], primary?: string): void {
    this.sel.set(this.doc, ids, primary);
    this.selectionChanged();
  }

  private selectionChanged(): void {
    this.tools?.onSelect();
    // the gizmo edits the initial state: leave playback, keep the view
    if (this.selection && this.mode === 'play') this.setMode('edit', { keepCamera: true });
    this.view.updateSelectionVisuals();
    this.view.updateAnalysisVisuals();
    this.emit('select');
  }

  selectAll(): void { this.selectMany(this.doc.entities.map((e) => e.id)); }

  /** A unique "Name", "Name 2", ... */
  uniqueName(base: string): string {
    let n = 1;
    while (this.doc.entities.some((x) => x.name === base + (n > 1 ? ` ${n}` : ''))) n++;
    return n > 1 ? `${base} ${n}` : base;
  }

  addEntity(type: keyof typeof ENTITY_DEFS): void {
    this.pushUndo();
    const target = new THREE.Vector3(...this.doc.camera.target);
    const e = createEntity(type);
    const hang = ENTITY_DEFS[type].hang;
    e.position = [round(target.x), hang?.y ?? e.position[1], round(target.z)];
    e.name = this.uniqueName(e.name);
    this.doc.entities.push(e);
    // hanging and flying things keep their height; the rest follows the
    // cursor over the scene until a click drops it
    if (!hang) {
      this.selectMany([e.id]);
      this.rebuild();
      this.tools.beginPlacement([e.id], { removeOnCancel: true });
      return;
    }
    this.selectMany([e.id]);
    this.commit('physics');
  }

  /** Inserts entities (already cloned, fresh ids) and lets the user place them. */
  insertEntities(list: Entity[], opts: { place?: boolean; offset?: [number, number, number] } = {}): void {
    this.pushUndo();
    for (const e of list) {
      if (opts.offset) e.position = [round(e.position[0] + opts.offset[0]), round(e.position[1] + opts.offset[1]), round(e.position[2] + opts.offset[2])];
      e.name = this.uniqueName(e.name);
      this.doc.entities.push(e);
    }
    this.selectMany(list.map((e) => e.id));
    if (opts.place) {
      this.rebuild();
      this.tools.beginPlacement(list.map((e) => e.id), { removeOnCancel: true });
      return;
    }
    this.commit('physics');
  }

  removeEntity(id: string): void { this.removeEntities([id]); }

  removeEntities(ids: string[]): void {
    if (ids.length === 0) return;
    this.pushUndo();
    const gone = new Set(ids);
    this.doc.entities = this.doc.entities.filter((e) => !gone.has(e.id));
    this.sel.drop(gone);
    this.tools.onSelect();
    this.commit('physics');
    this.emit('select');
  }

  /** Deep copies with fresh ids; groups are renamed so copies form their own groups. */
  cloneEntities(list: Entity[]): Entity[] {
    const groups = new Map<string, string>();
    const taken = new Set(this.doc.entities.map((e) => e.group).filter(Boolean) as string[]);
    return list.map((e) => {
      const c: Entity = structuredClone(e);
      c.id = Math.random().toString(36).slice(2, 10);
      if (e.group) {
        if (!groups.has(e.group)) {
          const base = e.group.replace(/ \d+$/, '');
          let n = 2;
          while (taken.has(`${base} ${n}`)) n++;
          taken.add(`${base} ${n}`);
          groups.set(e.group, `${base} ${n}`);
        }
        c.group = groups.get(e.group);
      }
      return c;
    });
  }

  duplicateEntity(id: string): void {
    const ids = this.selectedIds.includes(id) ? this.selectedIds : [id];
    this.duplicateEntities(ids);
  }

  duplicateEntities(ids: string[]): void {
    const set = new Set(ids);
    const src = this.doc.entities.filter((e) => set.has(e.id));
    if (src.length === 0) return;
    const copies = this.cloneEntities(src);
    for (const c of copies) if (src.length === 1) c.name = src[0].name + ' copy';
    this.insertEntities(copies, { offset: [1, 0, 1] });
  }

  /** Groups the selection under one name (⌘G); `null` ungroups it. */
  groupSelection(name: string | null): void {
    const sel = this.selectedEntities;
    if (sel.length === 0) return;
    this.pushUndo();
    let g = name ?? undefined;
    if (name === '') {
      let n = 1;
      const used = new Set(this.doc.entities.map((e) => e.group));
      while (used.has(`Group ${n}`)) n++;
      g = `Group ${n}`;
    }
    for (const e of sel) e.group = g;
    this.commit('meta');
    this.emit('select');
  }

  moveEntity(id: string, dir: -1 | 1): void {
    const i = this.doc.entities.findIndex((e) => e.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.doc.entities.length) return;
    const arr = this.doc.entities;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    this.commit('meta');
  }
  /** Live preview of an edit without baking (gizmo drags, placement, drawing). */
  previewRebuild(): void {
    this.built = buildScene(this.doc, this.buildOptions());
    this.bodies.setScene(this.built, this.doc);
    this.fluid.setScene(this.built.fluid, this.doc);
    this.view.updateHelpers();
    this.view.updateSelectionBox();
    this.tools.refresh();
  }

  // ------------------------------------------------------------ history

  private scheduleSnapshot(): void {
    if (this.persist) this.history.schedule();
  }

  pushUndo(): void { this.history.push(); }

  undo(): void { this.restore(this.history.undo()); }

  redo(): void { this.restore(this.history.redo()); }

  /** Shows a document from the history, keeping the selection. */
  private restore(doc: SceneDoc | null): void {
    if (!doc) return;
    const sel = this.selection, ids = this.selectedIds;
    this.setDoc(doc);
    this.selectMany(ids, sel ?? undefined);
    this.saveLocalSoon();
  }

  // ------------------------------------------------------------ storage

  private saveLocalSoon(): void {
    if (this.persist) saveDocSoon(() => this.doc);
  }

  /** Writes the current document to local storage immediately. */
  saveNow(): void { saveDoc(this.doc); }

  shareUrl(): string { return shareUrl(this.doc); }
}
