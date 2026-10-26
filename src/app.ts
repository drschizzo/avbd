// Application core: owns the document, the GPU stage, baking and playback.

import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { Stage, createDevice } from './render/stage';
import { BodyRenderer } from './render/bodies';
import { FluidRenderer } from './fluid/fluidRender';
import { Baker, type BakeResult } from './sim/baker';
import { buildScene, entityQuat, type BuiltScene } from './scene/build';
import { defaultDoc, type Entity, type SceneDoc } from './scene/doc';
import { ENTITY_DEFS, createEntity } from './scene/entities';
import { PRESETS } from './scene/presets';
import { boomerangSimTime, boomerangSpans } from './sim/loopTime';
import { matchLoop, readFrames } from './sim/loopMatch';
import { EditTools } from './edit/tools';
import { analyzeBake, analyzeSamples, stepResults, type MachineReport } from './sim/analysis';
import { unpackQuat } from './render/bodies';
import { followAt, followDistance, followRaw, followTrack, type FollowRaw, type FollowTrack } from './sim/follow';

export interface TrialState {
  running: boolean;
  total: number;
  done: number;
  okRuns: number;
  /** per run: step id -> passed */
  results: Map<string, boolean>[];
  untilSuccess: boolean;
  /** run that succeeded and is kept on screen (untilSuccess) */
  kept: number;
  cancelled: boolean;
}

export type Mode = 'edit' | 'play';
export type GizmoMode = 'all' | 'translate' | 'rotate';
export type ChangeKind = 'physics' | 'visual' | 'camera' | 'loop' | 'meta';
type Listener = (what: string) => void;

const STORAGE_KEY = 'looplab.doc.v1';

export class App {
  stage!: Stage;
  bodies!: BodyRenderer;
  fluid!: FluidRenderer;
  baker!: Baker;
  device!: GPUDevice;
  doc: SceneDoc = defaultDoc();
  built!: BuiltScene;
  orbit!: OrbitControls;
  /** Move handles; `gizmoRot` holds the rotation rings around them. */
  gizmo!: TransformControls;
  gizmoRot!: TransformControls;
  gizmoMode: GizmoMode = 'all';
  private gizmoProxy = new THREE.Object3D();
  private helpers = new THREE.Group();
  /** one box per selected entity */
  private selectionBoxes: THREE.Box3Helper[] = [];
  private selectionRoot = new THREE.Group();
  /** placement, drawing, workplane, path handles, ports */
  tools!: EditTools;
  /** gizmo drag start: proxy pose and the poses of everything it moves */
  private dragStart: { pos: THREE.Vector3; quat: THREE.Quaternion; items: { e: Entity; pos: THREE.Vector3; quat: THREE.Quaternion }[] } | null = null;

  mode: Mode = 'edit';
  /** primary selection (the one the Object tab edits) */
  selection: string | null = null;
  /** every selected entity id (includes `selection`) */
  selectedIds: string[] = [];
  playing = false;
  time = 0;
  loopPlayback = true;
  freeCamera = false;
  autoBake = true;
  baking = false;
  bakeProgress = { frame: 0, total: 1, recorded: 0, msPerFrame: 0 };
  bakeError: string | null = null;
  result: BakeResult | null = null;
  stale = true; // physics changed since the last bake
  fpsMeter = { last: performance.now(), frames: 0, fps: 0, gpuMs: 0 };
  exporting = false;
  /** machine check of the last bake (see sim/analysis) */
  report: MachineReport | null = null;
  /** follow camera: activity read from the last report, and its smoothed path */
  private follow: { raw: FollowRaw | null; track: FollowTrack | null; smooth: number } = { raw: null, track: null, smooth: -1 };
  /** where the shot camera looks this frame (focus distance) */
  readonly shotTarget = new THREE.Vector3();
  /** the report describes an older version of the scene */
  reportStale = false;
  analyzing = false;
  private reportPromise: Promise<MachineReport | null> | null = null;
  trials: TrialState | null = null;
  /** trajectories of the selected objects, drawn from the report */
  showTraces = true;
  private analysisRoot = new THREE.Group();
  /**
   * When false, document changes are neither written to local storage nor
   * pushed onto the undo stack. The course swaps the document behind the
   * user's back; its scenes must not replace the one they were working on.
   */
  persist = true;
  /**
   * When true, a finished bake leaves the editor in edit mode instead of
   * starting playback (the tutorial keeps the learner in the editor while
   * they place parts).
   */
  holdEdit = false;

  private listeners: Listener[] = [];
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private snapshotTimer = 0;
  private bakeTimer = 0;
  private lastSnapshot = '';
  private lastFrameTime = performance.now();

  on(fn: Listener): void { this.listeners.push(fn); }
  emit(what: string): void { for (const l of this.listeners) l(what); }

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this.device = await createDevice();
    this.stage = new Stage(canvas, this.device);
    await this.stage.init();
    this.bodies = new BodyRenderer(this.stage.renderer);
    this.bodies.setEnvironment(this.stage.environmentTexture);
    this.fluid = new FluidRenderer(this.stage.renderer);
    this.stage.fluid = this.fluid;
    this.stage.scene.add(this.bodies.root, this.fluid.shadowRoot, this.helpers, this.selectionRoot, this.analysisRoot);
    this.baker = new Baker(this.stage.renderer, this.device);
    // Pace the bake on rendered frames so the streamed preview stays fluid.
    this.baker.paced = true;

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

    this.installGizmos(canvas);
    this.tools = new EditTools(this, canvas);
    this.stage.scene.add(this.tools.root);

    this.installPicking(canvas);

    const saved = this.loadLocal();
    this.setDoc(saved ?? PRESETS[0].make(), { resetHistory: true });
  }

  // ------------------------------------------------------------------ doc

  setDoc(doc: SceneDoc, opts: { resetHistory?: boolean } = {}): void {
    this.doc = doc;
    this.selection = null;
    this.selectedIds = [];
    this.report = null;
    this.refreshFollow();
    this.trials = null;
    this.updateAnalysisVisuals?.();
    this.tools?.reset();
    if (opts.resetHistory) { this.undoStack = []; this.redoStack = []; }
    this.lastSnapshot = JSON.stringify(doc);
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
      this.rebuild(true);
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
  /** Robustness trials: tiny per-run perturbation of the dynamic bodies. */
  private jitter: { seed: number; amount: number } | null = null;

  buildOptions(): { only?: Set<string>; jitter?: { seed: number; amount: number } } {
    return { only: this.solo ?? undefined, jitter: this.jitter ?? undefined };
  }

  setSolo(ids: string[] | null): void {
    this.solo = ids && ids.length ? new Set(ids) : null;
    this.rebuild();
    this.markStale();
    this.emit('solo');
  }

  private rebuild(visualOnly = false): void {
    this.built = buildScene(this.doc, this.buildOptions());
    this.bodies.setScene(this.built, this.doc);
    this.bodies.setLoop(this.doc);
    this.fluid.setScene(this.built.fluid, this.doc);
    this.fluid.setLoop(this.doc);
    this.stage.applyRender(this.doc, this.built.bounds);
    this.bodies.uEnvIntensity.value = this.doc.render.envIntensity;
    this.updateHelpers();
    this.updateSelectionVisuals();
    this.tools?.refresh();
    void visualOnly;
  }

  private markStale(): void {
    if (this.report) this.reportStale = true;
    this.lastLoopKey = this.loopSimKey();
    this.stale = true;
    this.baker.cancel();
    this.baking = false;
    this.result = null;
    this.bodies.setHistory(null);
    this.fluid.setHistory(null);
    this.setMode('edit');
    if (this.autoBake) {
      clearTimeout(this.bakeTimer);
      this.bakeTimer = window.setTimeout(() => { void this.bake(); }, 450);
    }
    this.emit('bake');
  }

  // ---------------------------------------------------------------- bake

  async bake(): Promise<void> {
    clearTimeout(this.bakeTimer);
    if (this.built.bodies.length === 0 && !this.built.fluid) { this.bakeError = 'Add something to the scene first.'; this.emit('bake'); return; }
    this.bakeError = null;
    this.baking = true;
    this.stale = false;
    this.bakeProgress = { frame: 0, total: this.built.simFrames, recorded: 0, msPerFrame: 0 };
    this.emit('bake');
    const built = this.built;
    let started = false;
    try {
      const res = await this.baker.bake(built, this.doc, (p) => {
        this.bakeProgress = p;
        // stream: start playback as soon as frames exist
        if (!started && p.recorded > 2) {
          started = true;
          this.result = null;
          this.bodies.setHistory(this.baker.currentPartial ?? null);
          this.fluid.setHistory(this.baker.currentPartial?.fluid ?? null);
          // while an object is selected the user is editing: bake in the
          // background and keep the gizmo (Space plays the result)
          if (!this.selection && !this.holdEdit) {
            this.setMode('play');
            this.time = 0;
            this.playing = true;
          }
        }
        this.emit('bake-progress');
      });
      if (!res) return; // cancelled
      this.result = res;
      this.bodies.setHistory(res);
      if (res.tail) {
        const targets = await matchLoop(this.device, this.stage.renderer, res, built, this.doc);
        if (this.result !== res) return; // re-baked meanwhile
        if (targets) this.bodies.setLoopTargets(targets);
      }
      this.fluid.setHistory(res.fluid);
      this.baking = false;
      if (!this.exporting) this.reportPromise = this.analyze(res, built);
      if (this.mode !== 'play' && !this.selection && !this.holdEdit) { this.setMode('play'); this.time = 0; this.playing = true; }
      this.emit('bake');
    } catch (err: any) {
      console.error(err);
      this.bakeError = String(err?.message ?? err);
      this.baking = false;
      this.stale = true;
      this.emit('bake');
    }
  }

  private async analyze(res: BakeResult, built: BuiltScene): Promise<MachineReport | null> {
    this.analyzing = true;
    this.emit('report');
    try {
      const r = await analyzeBake(this.device, this.stage.renderer, res, built, this.doc);
      if (this.result !== res) return null; // re-baked meanwhile
      this.report = r;
      this.reportStale = false;
      this.refreshFollow();
      return r;
    } catch (err) {
      console.error('machine check failed', err);
      return null;
    } finally {
      this.analyzing = false;
      this.updateAnalysisVisuals();
      this.emit('report');
    }
  }

  /**
   * Bakes the machine `n` times, each run nudged by a fraction of a
   * millimetre (and the GPU's own run-to-run differences), and counts which
   * steps hold. `untilSuccess` stops at the first run where every step
   * works and keeps that bake on screen.
   */
  async runTrials(n: number, untilSuccess: boolean): Promise<void> {
    if (this.trials?.running) { this.trials.cancelled = true; this.baker.cancel(); return; }
    const t: TrialState = { running: true, total: n, done: 0, okRuns: 0, results: [], untilSuccess, kept: -1, cancelled: false };
    this.trials = t;
    this.emit('trials');
    try {
      for (let i = 0; i < n && !t.cancelled; i++) {
        this.jitter = i === 0 ? null : { seed: i * 7919 + 13, amount: 0.0008 };
        this.rebuild();
        await this.bake();
        if (!this.result || t.cancelled) break;
        const r = await (this.reportPromise ?? Promise.resolve(null));
        if (!r) break;
        t.results.push(stepResults(r));
        t.done++;
        if (r.ok) t.okRuns++;
        this.emit('trials');
        if (untilSuccess && r.ok) { t.kept = i; break; }
      }
    } finally {
      // the bake on screen keeps its own (nudged) layout until the next edit
      this.jitter = null;
      t.running = false;
      this.emit('trials');
    }
  }

  /** Re-judges the last check (e.g. an object marked as decor) without baking. */
  rejudge(): void {
    const r = this.report;
    if (!r || this.reportStale) { this.emit('report'); return; }
    this.report = analyzeSamples(r.samples, r.sampleTimes, this.built, this.doc);
    this.updateAnalysisVisuals();
    this.emit('report');
  }

  /** Red rings where rows stopped, and trajectories of the selection. */
  updateAnalysisVisuals(): void {
    for (const c of [...this.analysisRoot.children]) { c.removeFromParent(); (c as THREE.Mesh).geometry?.dispose(); }
    const r = this.report;
    if (!r) return;
    const cam = this.stage.camera.position;
    const ring = new THREE.TorusGeometry(1, 0.12, 8, 32).rotateX(Math.PI / 2);
    for (const e of r.entities) {
      if (!e.breakAt) continue;
      const p = new THREE.Vector3(...e.breakAt.pos);
      const m = new THREE.Mesh(ring, new THREE.MeshBasicNodeMaterial({ color: 0xff5b6e, transparent: true, depthTest: false }));
      m.position.set(p.x, 0.02 + Math.max(0, p.y - 0.25), p.z);
      m.scale.setScalar(Math.max(0.12, p.distanceTo(cam) * 0.02));
      m.renderOrder = 12;
      this.analysisRoot.add(m);
    }
    if (!this.showTraces || this.reportStale) return;
    const sel = this.selectedIndices();
    if (sel.size === 0) return;
    const bodies: number[] = [];
    this.built.bodies.forEach((b, i) => { if (sel.has(b.entity) && b.kind === 0) bodies.push(i); });
    if (bodies.length === 0) return;
    // a long row draws one line through every k-th piece
    const step = Math.max(1, Math.ceil(bodies.length / 120));
    const mat = new THREE.LineBasicNodeMaterial({ color: 0xffc36b, transparent: true, opacity: 0.75, depthTest: false });
    for (let n = 0; n < bodies.length; n += step) {
      const k = (bodies[n] + 1) * 4;
      const pts: THREE.Vector3[] = [];
      for (const smp of r.samples) {
        const f = new Float32Array(smp.buffer, smp.byteOffset, smp.length);
        const p = new THREE.Vector3(f[k], f[k + 1], f[k + 2]);
        if (p.y < -3) break;
        if (pts.length === 0 || p.distanceToSquared(pts[pts.length - 1]) > 1e-6) pts.push(p);
      }
      if (pts.length < 2) continue;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
      line.renderOrder = 7;
      line.frustumCulled = false;
      this.analysisRoot.add(line);
    }
    void unpackQuat;
  }

  setMode(m: Mode, opts: { keepCamera?: boolean } = {}): void {
    if (this.mode === m) return;
    this.mode = m;
    this.bodies.setEditMode(m === 'edit');
    this.fluid.setEditMode(m === 'edit');
    this.helpers.visible = m === 'edit';
    this.tools.root.visible = m === 'edit';
    if (m === 'edit') {
      this.playing = false;
      this.time = 0;
      // the free camera is the user's own view: never snap it back
      if (!opts.keepCamera && !this.freeCamera) this.applyCameraFromDoc();
    }
    this.updateSelectionVisuals();
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
  get availableFrames(): number {
    if (this.result) return this.result.frames;
    if (this.baking) return this.bakeProgress.recorded;
    return 0;
  }

  /** Maps video time to the playback uniforms. */
  playbackAt(t: number): { frameA: number; frameB: number; mix: number; simFrame: number; time: number } {
    const fps = this.doc.fps;
    const D = this.doc.duration;
    let simT = t;
    if (this.doc.loop.mode === 'boomerang') simT = boomerangSimTime(boomerangSpans(this.doc), t, D);
    const res = this.result ?? this.baker.currentPartial;
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
  refreshFollow(): void {
    this.follow = { raw: this.report ? followRaw(this.report, this.built, this.doc) : null, track: null, smooth: -1 };
  }

  private followTrack(): FollowTrack | null {
    const f = this.follow;
    if (!f.raw) return null;
    const smooth = this.doc.camera.followSmooth ?? 0.8;
    if (!f.track || f.smooth !== smooth) { f.track = followTrack(f.raw, smooth); f.smooth = smooth; }
    return f.track;
  }

  /** Animated shot camera at time t (periodic over the loop). */
  shotCamera(t: number, cam: THREE.PerspectiveCamera): void {
    const c = this.doc.camera;
    const target = new THREE.Vector3(...c.target);
    const off = new THREE.Vector3(...c.position).sub(target);
    const track = c.motion === 'follow' ? this.followTrack() : null;
    if (track) {
      // the shot's angle, closer, aimed at the action of the simulated moment
      // (so a boomerang's rewind brings the camera back along its path)
      const lead = c.followLead ?? 0.3;
      const simT = this.playbackAt(t).simFrame / this.doc.fps;
      let f = followAt(track, simT + lead);
      if (this.doc.loop.mode !== 'boomerang') {
        // other loops restart from the first shot: glide back to it
        const D = this.doc.duration, blend = Math.min(2, D * 0.15);
        const u = Math.min(1, Math.max(0, (t - (D - blend)) / blend));
        if (u > 0) {
          const s = u * u * (3 - 2 * u), g = followAt(track, lead);
          f = {
            target: [0, 1, 2].map((i) => f.target[i] + (g.target[i] - f.target[i]) * s) as [number, number, number],
            radius: f.radius + (g.radius - f.radius) * s,
          };
        }
      }
      const d = followDistance(c, f.radius, off.length());
      off.normalize().multiplyScalar(d);
      target.set(...f.target);
    }
    // Whole cycles only: anything else would jump at the loop point.
    const cycles = Math.max(1, Math.round(c.cycles));
    const u = (t / this.doc.duration) * cycles;
    const TAU = Math.PI * 2;
    switch (c.motion) {
      // full turns (a partial orbit cannot loop); `amount` adds a gentle
      // vertical bob, in degrees of elevation
      case 'orbit': {
        off.applyAxisAngle(new THREE.Vector3(0, 1, 0), TAU * u);
        const bob = Math.min(c.amount, 30) * Math.PI / 180 * Math.sin(TAU * u * 2);
        if (bob !== 0) {
          const side = new THREE.Vector3(0, 1, 0).cross(off).normalize();
          off.applyAxisAngle(side, -bob * 0.5);
        }
        break;
      }
      case 'follow':
      case 'sway': off.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.sin(TAU * u) * c.amount * Math.PI / 180); break;
      case 'dolly': off.multiplyScalar(1 - (c.amount / 100) * 0.5 * (1 - Math.cos(TAU * u))); break;
      case 'crane': {
        const s = Math.sin(TAU * u);
        off.applyAxisAngle(new THREE.Vector3(0, 1, 0), s * c.amount * 0.4 * Math.PI / 180);
        off.y += s * off.length() * c.amount / 200;
        break;
      }
      default: break;
    }
    cam.fov = c.fov;
    cam.position.copy(target).add(off);
    cam.lookAt(target);
    this.shotTarget.copy(target);
    cam.updateProjectionMatrix();
  }

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
      this.orbit.enabled = !this.gizmo.dragging && !this.gizmoRot.dragging && !this.tools.blockOrbit;
      this.orbit.update();
    }
    const shot = this.mode === 'play' && !this.freeCamera;
    const focus = this.doc.render.focus > 0 ? this.doc.render.focus : cam.position.distanceTo(shot ? this.shotTarget : new THREE.Vector3(...this.doc.camera.target));
    this.stage.setFocus(focus);
    this.stage.render();
  }

  // ------------------------------------------------------------ editing

  get selectedEntity(): Entity | null {
    return this.doc.entities.find((e) => e.id === this.selection) ?? null;
  }

  get selectedEntities(): Entity[] {
    const ids = new Set(this.selectedIds);
    return this.doc.entities.filter((e) => ids.has(e.id));
  }

  /** Entity indices (in doc.entities) of the selection. */
  selectedIndices(): Set<number> {
    const ids = new Set(this.selectedIds);
    const out = new Set<number>();
    this.doc.entities.forEach((e, i) => { if (ids.has(e.id)) out.add(i); });
    return out;
  }

  /**
   * Selects an entity. Clicking a member of a group selects the whole group
   * unless `single`; `toggle` adds or removes (Shift-click).
   */
  select(id: string | null, opts: { toggle?: boolean; single?: boolean; add?: boolean } = {}): void {
    if (id === null) {
      this.selection = null;
      this.selectedIds = [];
    } else {
      const e = this.doc.entities.find((x) => x.id === id);
      const ids = e?.group && !opts.single ? this.doc.entities.filter((x) => x.group === e.group).map((x) => x.id) : [id];
      if (opts.toggle) {
        const all = ids.every((x) => this.selectedIds.includes(x));
        this.selectedIds = all ? this.selectedIds.filter((x) => !ids.includes(x)) : [...new Set([...this.selectedIds, ...ids])];
        this.selection = all ? (this.selectedIds[this.selectedIds.length - 1] ?? null) : id;
      } else if (opts.add) {
        this.selectedIds = [...new Set([...this.selectedIds, ...ids])];
        this.selection = id;
      } else {
        this.selectedIds = ids;
        this.selection = id;
      }
    }
    this.tools?.onSelect();
    // the gizmo edits the initial state: leave playback, keep the view
    if (this.selection && this.mode === 'play') this.setMode('edit', { keepCamera: true });
    this.updateSelectionVisuals();
    this.updateAnalysisVisuals();
    this.emit('select');
  }

  selectMany(ids: string[], primary?: string): void {
    const known = new Set(this.doc.entities.map((e) => e.id));
    this.selectedIds = ids.filter((x) => known.has(x));
    this.selection = primary && this.selectedIds.includes(primary) ? primary : (this.selectedIds[this.selectedIds.length - 1] ?? null);
    this.tools?.onSelect();
    if (this.selection && this.mode === 'play') this.setMode('edit', { keepCamera: true });
    this.updateSelectionVisuals();
    this.updateAnalysisVisuals();
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
    e.position = [round(target.x), e.position[1], round(target.z)];
    if (type === 'emitter') e.position[1] = 5;
    if (type === 'wreckingBall') e.position[1] = 6;
    if (type === 'chain') e.position[1] = 4;
    if (type === 'fluidSource') e.position[1] = 2;
    e.name = this.uniqueName(e.name);
    this.doc.entities.push(e);
    // hanging and flying things keep their height; the rest follows the
    // cursor over the scene until a click drops it
    const hangs = ['emitter', 'wreckingBall', 'chain', 'fluidSource', 'sensor'].includes(type);
    if (!hangs) {
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
    this.selectedIds = this.selectedIds.filter((x) => !gone.has(x));
    if (this.selection && gone.has(this.selection)) this.selection = this.selectedIds[this.selectedIds.length - 1] ?? null;
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
  setGizmoMode(m: GizmoMode): void {
    this.gizmoMode = m;
    this.updateSelectionVisuals();
    this.emit('gizmo');
  }

  /**
   * Two TransformControls share one proxy: arrows + planes inside, rotation
   * rings outside (sized so their pick zones do not overlap). Where a ray
   * still crosses both, the move handles win.
   */
  private installGizmos(canvas: HTMLCanvasElement): void {
    const make = (mode: 'translate' | 'rotate', size: number) => {
      const g = new TransformControls(this.stage.camera, canvas);
      g.setMode(mode);
      g.setSize(size);
      g.addEventListener('dragging-changed', (ev: any) => {
        this.orbit.enabled = !ev.value;
        const other = g === this.gizmo ? this.gizmoRot : this.gizmo;
        if (other) { other.enabled = !ev.value; if (ev.value) (other as any).axis = null; }
        if (ev.value) this.beginGizmoDrag();
        else {
          this.dragStart = null;
          this.tools.endHandleDrag();
          this.commit('physics');
        }
      });
      g.addEventListener('objectChange', () => this.onGizmoChange());
      this.stage.scene.add(g.getHelper());
      return g;
    };
    this.gizmo = make('translate', 0.85);
    this.gizmoRot = make('rotate', 1.45);
    // the centre trackball sphere would swallow the move handles
    const gz = (this.gizmoRot as any)._gizmo;
    for (const group of [gz.picker.rotate, gz.gizmo.rotate]) {
      for (const c of [...group.children]) if (c.name === 'XYZE') c.removeFromParent();
    }
    this.stage.scene.add(this.gizmoProxy);

    // Shift snaps: 0.25 m steps, 15° turns.
    const snap = (on: boolean) => {
      this.gizmo.setTranslationSnap(on ? 0.25 : null);
      this.gizmoRot.setRotationSnap(on ? Math.PI / 12 : null);
    };
    window.addEventListener('keydown', (ev) => { if (ev.key === 'Shift') snap(true); });
    window.addEventListener('keyup', (ev) => { if (ev.key === 'Shift') snap(false); });
    window.addEventListener('blur', () => snap(false));

    // Runs before the controls' own canvas listeners (capture on window).
    const arbitrate = (ev: PointerEvent) => {
      if (ev.target !== canvas || this.gizmoMode !== 'all') return;
      const t = this.gizmo as any, r = this.gizmoRot as any;
      if (t.dragging || r.dragging || !t.object) return;
      t.pointerHover(t._getPointer(ev));
      r.enabled = t.axis === null;
      if (!r.enabled) r.axis = null;
    };
    window.addEventListener('pointermove', arbitrate, true);
    window.addEventListener('pointerdown', arbitrate, true);
  }

  /** True while the pointer is over (or dragging) a gizmo handle. */
  get gizmoBusy(): boolean {
    const t = this.gizmo as any, r = this.gizmoRot as any;
    return t.dragging || r.dragging || (t.object && t.axis !== null) || (r.object && r.enabled && r.axis !== null);
  }

  private beginGizmoDrag(): void {
    this.dragStart = {
      pos: this.gizmoProxy.position.clone(),
      quat: this.gizmoProxy.quaternion.clone(),
      items: this.selectedEntities.map((e) => ({ e, pos: new THREE.Vector3(...e.position), quat: entityQuat(e) })),
    };
  }

  private onGizmoChange(): void {
    if (this.tools.onHandleMoved(this.gizmoProxy)) return;
    if (this.selectedIds.length === 0) return;
    if (!this.dragStart) this.beginGizmoDrag();
    const st = this.dragStart!;
    // the proxy's motion since the drag began, applied to everything selected
    const dq = this.gizmoProxy.quaternion.clone().multiply(st.quat.clone().invert());
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), r = new THREE.Euler();
    for (const it of st.items) {
      p.copy(it.pos).sub(st.pos).applyQuaternion(dq).add(this.gizmoProxy.position);
      q.copy(dq).multiply(it.quat);
      it.e.position = [round(p.x), round(p.y), round(p.z)];
      r.setFromQuaternion(q, 'XYZ');
      it.e.rotation = [round(r.x * 180 / Math.PI, 2), round(r.y * 180 / Math.PI, 2), round(r.z * 180 / Math.PI, 2)];
    }
    // connection ports pull the moved parts end to end (Alt: free move)
    if (this.gizmo.dragging && !this.tools.altDown) this.tools.snapPorts(st.items.map((x) => x.e));
    this.previewRebuild();
    if (this.mode !== 'edit') this.setMode('edit');
    this.emit('transform');
  }

  /** Live preview of an edit without baking (gizmo drags, placement, drawing). */
  previewRebuild(): void {
    this.built = buildScene(this.doc, this.buildOptions());
    this.bodies.setScene(this.built, this.doc);
    this.fluid.setScene(this.built.fluid, this.doc);
    this.updateHelpers();
    this.updateSelectionBox();
    this.tools.refresh();
  }

  updateSelectionVisuals(): void {
    const e = this.selectedEntity;
    const handle = this.tools?.activeHandle ?? null;
    if (!e || this.mode !== 'edit' || this.tools?.placing) {
      this.gizmo.detach();
      this.gizmoRot.detach();
      this.updateSelectionBox();
      return;
    }
    // mid-drag rebuilds must not reset the proxy under the pointer
    if (!this.gizmo.dragging && !this.gizmoRot.dragging) {
      if (handle) {
        this.gizmoProxy.position.copy(handle);
        this.gizmoProxy.quaternion.identity();
      } else if (this.selectedIds.length === 1) {
        this.gizmoProxy.position.set(...e.position);
        this.gizmoProxy.quaternion.copy(entityQuat(e));
      } else {
        // a group turns about its centre, in world axes
        const c = new THREE.Vector3();
        const sel = this.selectedEntities;
        for (const x of sel) c.add(new THREE.Vector3(...x.position));
        this.gizmoProxy.position.copy(c.multiplyScalar(1 / Math.max(1, sel.length)));
        this.gizmoProxy.quaternion.identity();
      }
      this.gizmoProxy.updateMatrixWorld();
    }
    const showMove = this.gizmoMode !== 'rotate' || !!handle;
    const showRot = this.gizmoMode !== 'translate' && !handle;
    if (showMove) this.gizmo.attach(this.gizmoProxy); else this.gizmo.detach();
    if (showRot) { this.gizmoRot.enabled = true; this.gizmoRot.attach(this.gizmoProxy); } else this.gizmoRot.detach();
    this.gizmo.setSize(handle ? 0.6 : 0.85);
    this.tools?.constrainGizmos(this.gizmo, this.gizmoRot);
    this.updateSelectionBox();
  }

  private updateSelectionBox(): void {
    const sel = this.mode === 'edit' ? this.selectedIndices() : new Set<number>();
    const boxes: THREE.Box3[] = [];
    for (const ei of sel) {
      const box = new THREE.Box3();
      const v = new THREE.Vector3();
      for (const b of this.built.bodies) {
        if (b.entity !== ei || b.spawnFrame > 0) continue;
        const r = b.shape === 1 ? b.he[0] : Math.hypot(b.he[0], b.he[1], b.he[2]);
        box.expandByPoint(v.set(b.pos[0] - r, b.pos[1] - r, b.pos[2] - r));
        box.expandByPoint(v.set(b.pos[0] + r, b.pos[1] + r, b.pos[2] + r));
      }
      if (!box.isEmpty()) boxes.push(box);
    }
    while (this.selectionBoxes.length < boxes.length) {
      const h = new THREE.Box3Helper(new THREE.Box3(), 0x5b8cff);
      this.selectionBoxes.push(h);
      this.selectionRoot.add(h);
    }
    this.selectionBoxes.forEach((h, i) => {
      h.visible = i < boxes.length;
      if (h.visible) h.box.copy(boxes[i]);
      (h.material as THREE.LineBasicMaterial).color.set(boxes.length > 1 && this.doc.entities[[...sel][i]]?.id !== this.selection ? 0x3d5bb3 : 0x5b8cff);
    });
  }
  private updateHelpers(): void {
    for (const c of [...this.helpers.children]) {
      c.removeFromParent();
      (c as THREE.Mesh).geometry?.dispose();
    }
    const mat = new THREE.MeshBasicNodeMaterial({ color: 0x5b8cff, wireframe: true, transparent: true, opacity: 0.8 });
    const sensorMat = new THREE.MeshBasicNodeMaterial({ color: 0x5fd08a, wireframe: true, transparent: true, opacity: 0.9 });
    for (const e of this.doc.entities) {
      if (!e.enabled) continue;
      if (e.type === 'emitter') {
        const r = Math.max(0.15, e.params.area);
        const g = new THREE.ConeGeometry(r, 0.5, 24, 1, true).rotateX(Math.PI);
        const m = new THREE.Mesh(g, mat);
        m.position.set(...e.position);
        m.quaternion.copy(entityQuat(e));
        m.userData.entityId = e.id;
        this.helpers.add(m);
      } else if (e.type === 'sensor') {
        const [sx, sy, sz] = e.params.size;
        const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), sensorMat);
        m.position.set(...e.position);
        m.quaternion.copy(entityQuat(e));
        m.userData.entityId = e.id;
        this.helpers.add(m);
      } else if (e.type === 'chain' || e.type === 'wreckingBall') {
        const g = new THREE.OctahedronGeometry(0.08);
        const m = new THREE.Mesh(g, mat);
        m.position.set(...e.position);
        m.userData.entityId = e.id;
        this.helpers.add(m);
      }
    }
  }

  private installPicking(canvas: HTMLCanvasElement): void {
    let down: { x: number; y: number; onGizmo: boolean } | null = null;
    let pickSeq = 0;
    let lastClick = { x: -1e9, y: -1e9 };
    // capture: decide before the gizmo reacts to the same press
    canvas.addEventListener('pointerdown', (ev) => {
      down = ev.button === 0 && !this.tools.capturing ? { x: ev.clientX, y: ev.clientY, onGizmo: this.gizmoBusy } : null;
    }, true);
    canvas.addEventListener('pointerup', async (ev) => {
      if (!down || this.tools.capturing) { down = null; return; }
      const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
      const onGizmo = down.onGizmo;
      down = null;
      if (moved > 5 || onGizmo) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      const rc = new THREE.Raycaster();
      rc.setFromCamera(ndc, this.stage.camera);
      const seq = ++pickSeq;
      const again = Math.hypot(ev.clientX - lastClick.x, ev.clientY - lastClick.y) < 6;
      lastClick = { x: ev.clientX, y: ev.clientY };

      // candidate entities under the cursor, best first
      const ids: string[] = [];
      const push = (id: string | undefined | null) => { if (id && !ids.includes(id)) ids.push(id); };
      let hits: ReturnType<BodyRenderer['pick']>;
      if (this.mode === 'edit') {
        // control points of the selected path come first
        if (this.tools.pickHandle(rc.ray)) { this.updateSelectionVisuals(); this.emit('select'); return; }
        for (const hit of rc.intersectObjects(this.helpers.children, false)) push(hit.object.userData.entityId);
        hits = this.bodies.pick(rc.ray, true);
      } else {
        // in playback the bodies are where the bake put them, not at rest
        const simFrame = this.playbackAt(this.time).simFrame;
        const poses = await this.displayedPoses().catch(() => null);
        if (seq !== pickSeq) return;
        hits = poses ? this.bodies.pick(rc.ray, false, poses, simFrame) : [];
      }
      // see through glass containers: what is inside is what you aim at
      const entityId = (bi: number) => this.doc.entities[this.built.bodies[bi].entity]?.id;
      for (const hit of hits) if (!hit.glass) push(entityId(hit.index));
      for (const hit of hits) push(entityId(hit.index));

      // a miss in playback is just a click on the video: keep playing
      if (ids.length === 0) { if (this.mode === 'edit' && !ev.shiftKey) this.select(null); return; }
      // clicking the same spot again cycles through what lies under it;
      // Shift adds / removes, Alt picks one member of a group
      const cur = again && this.selection && !ev.shiftKey ? ids.indexOf(this.selection) : -1;
      this.select(ids[(cur + 1) % ids.length], { toggle: ev.shiftKey, single: ev.altKey });
    });
  }

  /** Engine-indexed poses (uvec4 per body) of the frame on screen. */
  private async displayedPoses(): Promise<Uint32Array | null> {
    const res = this.result ?? this.baker.currentPartial;
    if (!res) return null;
    const pb = this.playbackAt(this.time);
    const slot = pb.mix < 0.5 ? pb.frameA : pb.frameB;
    const [frame] = await readFrames(this.device, this.stage.renderer, res, [slot]);
    return frame;
  }

  // ------------------------------------------------------------ history

  private scheduleSnapshot(): void {
    if (!this.persist) return;
    clearTimeout(this.snapshotTimer);
    this.snapshotTimer = window.setTimeout(() => this.pushUndo(), 350);
  }

  pushUndo(): void {
    const s = JSON.stringify(this.doc);
    if (s === this.lastSnapshot) return;
    this.undoStack.push(this.lastSnapshot);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.lastSnapshot = s;
  }

  undo(): void {
    this.pushUndo();
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(JSON.stringify(this.doc));
    const sel = this.selection, ids = this.selectedIds;
    this.setDoc(JSON.parse(prev));
    this.lastSnapshot = prev;
    this.selectMany(ids, sel ?? undefined);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(JSON.stringify(this.doc));
    const sel = this.selection, ids = this.selectedIds;
    this.setDoc(JSON.parse(next));
    this.lastSnapshot = next;
    this.selectMany(ids, sel ?? undefined);
  }

  // ------------------------------------------------------------ storage

  private saveTimer = 0;
  private saveLocalSoon(): void {
    if (!this.persist) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.doc)); } catch { /* ignore */ }
    }, 600);
  }

  private loadLocal(): SceneDoc | null {
    try {
      const hash = location.hash.startsWith('#scene=') ? location.hash.slice(7) : '';
      if (hash) return migrate(JSON.parse(decodeURIComponent(escape(atob(hash)))));
      const s = localStorage.getItem(STORAGE_KEY);
      return s ? migrate(JSON.parse(s)) : null;
    } catch {
      return null;
    }
  }

  /** Writes the current document to local storage immediately. */
  saveNow(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.doc)); } catch { /* ignore */ }
  }

  shareUrl(): string {
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(this.doc))));
    return `${location.origin}${location.pathname}#scene=${b64}`;
  }
}

function migrate(d: any): SceneDoc | null {
  if (!d || d.version !== 1 || !Array.isArray(d.entities)) return null;
  const base = defaultDoc();
  // entity params gain new keys over time: fill them from the current defaults
  const entities = d.entities
    .filter((e: any) => ENTITY_DEFS[e.type as keyof typeof ENTITY_DEFS])
    .map((e: any) => ({ ...e, params: { ...structuredClone(ENTITY_DEFS[e.type as keyof typeof ENTITY_DEFS].defaults), ...e.params } }));
  return { ...base, ...d, entities, physics: { ...base.physics, ...d.physics }, loop: { ...base.loop, ...d.loop }, camera: { ...base.camera, ...d.camera }, render: { ...base.render, ...d.render }, fluid: { ...base.fluid, ...(d.fluid ?? {}) } };
}

function round(x: number, digits = 3): number {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
}
