// Editor tools around the gizmo: drop-in placement that follows the cursor
// over the scene, freehand path drawing, the work plane, control points of
// drawn paths, connection ports, "drop to surface", clipboard and the user's
// gadget library.

import * as THREE from 'three/webgpu';
import type { App } from '../app';
import type { Entity, Vec3 } from '../scene/doc';
import { ENTITY_DEFS, createEntity, type Port } from '../scene/entities';
import { entityQuat } from '../scene/build';
import { FILL_DEFAULTS, densePath, isTrack, simplify, type PathFill } from '../scene/path';
import { castScene, entityBounds } from './raycast';

export type Tool = 'select' | 'draw';
export type PlaneAxis = 'off' | 'xy' | 'zy' | 'xz';

export const FILL_LABEL: Record<PathFill, string> = {
  dominoes: 'Domino run', marbles: 'Marble row', blocks: 'Block row', rail: 'Rail', track: 'Track', wall: 'Guide wall',
};

const CLIP_KEY = 'looplab.clipboard.v1';
const LIB_KEY = 'looplab.gadgets.v1';
const SNAP_DIST = 0.3;

export interface SavedGadget { name: string; entities: Entity[] }

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export class EditTools {
  readonly root = new THREE.Group();
  tool: Tool = 'select';
  drawFill: PathFill = 'dominoes';
  plane: { axis: PlaneAxis; offset: number } = { axis: 'off', offset: 0 };
  altDown = false;
  shiftDown = false;

  /** entities following the cursor until a click drops them */
  placing: { ids: string[]; offsets: Map<string, THREE.Vector3>; half: THREE.Vector3; removeOnCancel: boolean; moved: boolean } | null = null;
  /** selected control point of the selected path (index, world position) */
  handleIndex: number | null = null;
  activeHandle: THREE.Vector3 | null = null;

  private stroke: THREE.Vector3[] | null = null;
  private strokeLine: THREE.Line;
  private grid: THREE.GridHelper;
  private handleRoot = new THREE.Group();
  private portRoot = new THREE.Group();
  private curveLine: THREE.Line;
  private snapped: Vec3 | null = null;
  private lastPointer: PointerEvent | null = null;
  private clipboard: Entity[] = [];

  constructor(private app: App, private canvas: HTMLCanvasElement) {
    this.root.name = 'edit-tools';
    const lineMat = new THREE.LineBasicNodeMaterial({ color: 0xffc36b, transparent: true, depthTest: false });
    this.strokeLine = new THREE.Line(new THREE.BufferGeometry(), lineMat);
    this.strokeLine.renderOrder = 10;
    this.strokeLine.frustumCulled = false;
    const curveMat = new THREE.LineBasicNodeMaterial({ color: 0x7c9cff, transparent: true, opacity: 0.9, depthTest: false });
    this.curveLine = new THREE.Line(new THREE.BufferGeometry(), curveMat);
    this.curveLine.renderOrder = 9;
    this.curveLine.frustumCulled = false;
    this.grid = new THREE.GridHelper(24, 96, 0x7c9cff, 0x6a7186);
    const gm = this.grid.material as THREE.LineBasicMaterial;
    gm.transparent = true; gm.opacity = 0.28; gm.depthWrite = false;
    this.grid.visible = false;
    this.root.add(this.strokeLine, this.curveLine, this.grid, this.handleRoot, this.portRoot);
    try { this.clipboard = JSON.parse(localStorage.getItem(CLIP_KEY) ?? '[]'); } catch { this.clipboard = []; }
    this.install();
  }

  get capturing(): boolean { return this.tool === 'draw' || !!this.placing; }
  get blockOrbit(): boolean { return !!this.stroke || !!this.placing; }

  reset(): void {
    if (this.placing) this.placing = null;
    this.stroke = null;
    this.handleIndex = null;
    this.activeHandle = null;
    this.strokeLine.visible = false;
  }

  // ------------------------------------------------------------ pointer

  private ray(ev: { clientX: number; clientY: number }): THREE.Ray {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.app.stage.camera);
    return rc.ray;
  }

  private planeNormal(): THREE.Vector3 | null {
    switch (this.plane.axis) {
      case 'xy': return new THREE.Vector3(0, 0, 1);
      case 'zy': return new THREE.Vector3(1, 0, 0);
      case 'xz': return new THREE.Vector3(0, 1, 0);
      default: return null;
    }
  }

  /** Where the pointer lands: on the work plane when it is on, else on the scene. */
  private hitAt(ev: { clientX: number; clientY: number }, opts: { exclude?: Set<number>; staticOnly?: boolean } = {}): { point: THREE.Vector3; normal: THREE.Vector3; onPlane: boolean } | null {
    const ray = this.ray(ev);
    const n = this.planeNormal();
    if (n) {
      const pl = new THREE.Plane(n, -this.plane.offset);
      const p = ray.intersectPlane(pl, new THREE.Vector3());
      if (!p) return null;
      return { point: p, normal: n.clone(), onPlane: true };
    }
    const hit = castScene(this.app.built, ray, { exclude: opts.exclude, staticOnly: opts.staticOnly, ground: true });
    return hit ? { point: hit.point, normal: hit.normal, onPlane: false } : null;
  }

  private install(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (ev) => {
      if (this.placing) {
        ev.stopImmediatePropagation();
        ev.preventDefault();
        if (ev.button === 2) this.cancelPlacement();
        else if (ev.button === 0) { this.movePlacement(ev); this.confirmPlacement(); }
        return;
      }
      if (this.tool === 'draw' && ev.button === 0 && this.app.mode === 'edit') {
        ev.stopImmediatePropagation();
        ev.preventDefault();
        const hit = this.hitAt(ev, { staticOnly: true });
        if (!hit) return;
        c.setPointerCapture(ev.pointerId);
        this.stroke = [hit.point.clone()];
        this.updateStroke();
      }
    }, true);
    c.addEventListener('pointermove', (ev) => {
      this.lastPointer = ev;
      if (this.placing) { this.movePlacement(ev); return; }
      if (this.stroke) {
        const hit = this.hitAt(ev, { staticOnly: true });
        if (!hit) return;
        const last = this.stroke[this.stroke.length - 1];
        if (hit.point.distanceTo(last) > 0.025) { this.stroke.push(hit.point.clone()); this.updateStroke(); }
      }
    }, true);
    c.addEventListener('pointerup', (ev) => {
      if (this.stroke) {
        ev.stopImmediatePropagation();
        const s = this.stroke;
        this.stroke = null;
        this.strokeLine.visible = false;
        this.finishStroke(s);
      }
    }, true);
    c.addEventListener('contextmenu', (ev) => { if (this.placing || this.tool === 'draw') ev.preventDefault(); });
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Alt') this.altDown = true;
      if (ev.key === 'Shift') this.shiftDown = true;
      if (ev.key !== 'Escape') return;
      if (this.placing) { this.cancelPlacement(); ev.stopImmediatePropagation(); return; }
      if (this.stroke) { this.stroke = null; this.strokeLine.visible = false; ev.stopImmediatePropagation(); return; }
      if (this.tool === 'draw') { this.setTool('select'); ev.stopImmediatePropagation(); return; }
      if (this.handleIndex !== null) { this.clearHandle(); ev.stopImmediatePropagation(); }
    }, true);
    window.addEventListener('keyup', (ev) => {
      if (ev.key === 'Alt') this.altDown = false;
      if (ev.key === 'Shift') this.shiftDown = false;
    });
    window.addEventListener('blur', () => { this.altDown = false; this.shiftDown = false; });
  }

  setTool(t: Tool): void {
    if (this.placing) this.confirmPlacement();
    this.tool = t;
    this.canvas.style.cursor = t === 'draw' ? 'crosshair' : '';
    this.app.emit('tool');
  }

  // ------------------------------------------------------------ placement

  beginPlacement(ids: string[], opts: { removeOnCancel: boolean }): void {
    if (this.placing) this.confirmPlacement();
    if (this.tool === 'draw') this.setTool('select');
    const idx = new Set<number>();
    this.app.doc.entities.forEach((e, i) => { if (ids.includes(e.id)) idx.add(i); });
    const box = entityBounds(this.app.built, idx);
    const ents = this.app.doc.entities.filter((e) => ids.includes(e.id));
    if (box.isEmpty()) for (const e of ents) box.expandByPoint(new THREE.Vector3(...e.position));
    const center = box.getCenter(new THREE.Vector3());
    const anchor = new THREE.Vector3(center.x, box.min.y, center.z);
    const offsets = new Map<string, THREE.Vector3>();
    for (const e of ents) offsets.set(e.id, new THREE.Vector3(...e.position).sub(anchor));
    this.placing = { ids, offsets, half: box.getSize(new THREE.Vector3()).multiplyScalar(0.5), removeOnCancel: opts.removeOnCancel, moved: false };
    this.canvas.style.cursor = 'copy';
    this.app.updateSelectionVisuals();
    // already over the viewport: jump under the cursor right away
    if (this.lastPointer && document.elementFromPoint(this.lastPointer.clientX, this.lastPointer.clientY) === this.canvas) this.movePlacement(this.lastPointer);
    this.app.emit('tool');
  }

  private movePlacement(ev: { clientX: number; clientY: number }): void {
    const pl = this.placing;
    if (!pl) return;
    const exclude = new Set<number>();
    this.app.doc.entities.forEach((e, i) => { if (pl.ids.includes(e.id)) exclude.add(i); });
    const hit = this.hitAt(ev, { exclude });
    if (!hit) return;
    const a = hit.point.clone();
    const h = pl.half;
    if (hit.onPlane) {
      if (this.plane.axis !== 'xz') {
        // vertical plane: the part is centred on it, its middle under the cursor
        a.y = hit.point.y - h.y;
        if (this.plane.axis === 'xy') a.z = this.plane.offset; else a.x = this.plane.offset;
      }
    } else if (hit.normal.y < 0.5) {
      // against a wall: push out by the half size along the face normal
      const nx = Math.abs(hit.normal.x) > Math.abs(hit.normal.z);
      if (nx) a.x += Math.sign(hit.normal.x) * h.x; else a.z += Math.sign(hit.normal.z) * h.z;
      a.y = hit.point.y - h.y;
    }
    if (this.app.doc.physics.ground) a.y = Math.max(0, a.y);
    if (this.shiftDown) {
      const g = 0.25;
      a.x = Math.round(a.x / g) * g; a.z = Math.round(a.z / g) * g;
      if (hit.onPlane && this.plane.axis !== 'xz') a.y = Math.round(a.y / g) * g;
    }
    const moving: Entity[] = [];
    for (const e of this.app.doc.entities) {
      const off = pl.offsets.get(e.id);
      if (!off) continue;
      e.position = [r3(a.x + off.x), r3(a.y + off.y), r3(a.z + off.z)];
      moving.push(e);
    }
    if (!this.altDown) this.snapPorts(moving);
    pl.moved = true;
    this.app.previewRebuild();
  }

  confirmPlacement(): void {
    const pl = this.placing;
    if (!pl) return;
    this.placing = null;
    this.canvas.style.cursor = this.tool === 'draw' ? 'crosshair' : '';
    this.app.selectMany(pl.ids);
    this.app.commit('physics');
    this.app.emit('tool');
  }

  cancelPlacement(): void {
    const pl = this.placing;
    if (!pl) return;
    this.placing = null;
    this.canvas.style.cursor = '';
    if (pl.removeOnCancel) {
      const gone = new Set(pl.ids);
      this.app.doc.entities = this.app.doc.entities.filter((e) => !gone.has(e.id));
      this.app.selectMany([]);
    }
    this.app.commit('physics');
    this.app.emit('tool');
  }

  // ------------------------------------------------------------ drawing

  private updateStroke(): void {
    const s = this.stroke;
    if (!s) return;
    const g = new THREE.BufferGeometry().setFromPoints(s.map((p) => p.clone().add(new THREE.Vector3(0, 0.01, 0))));
    this.strokeLine.geometry.dispose();
    this.strokeLine.geometry = g;
    this.strokeLine.visible = true;
  }

  private finishStroke(raw: THREE.Vector3[]): void {
    let len = 0;
    for (let i = 1; i < raw.length; i++) len += raw[i].distanceTo(raw[i - 1]);
    if (raw.length < 2 || len < 0.15) return;
    const fill = this.drawFill;
    const d = FILL_DEFAULTS[fill];
    const onPlane = this.plane.axis !== 'off';
    let pts = simplify(raw, Math.min(0.04, Math.max(0.01, len * 0.006)));
    if (pts.length < 2) pts = [raw[0], raw[raw.length - 1]];
    // a stroke on a vertical plane can dip under the floor: keep it above
    const floorY = this.app.doc.physics.ground ? (isTrack(fill) ? d.size[2] + 0.002 : 0) : -Infinity;
    for (const p of pts) p.y = Math.max(p.y, floorY);
    let drop = 0;
    if (isTrack(fill)) {
      // the drawn line is the running surface: lift the floor plank onto what
      // was drawn on, and give a track drawn on the floor a gentle descent
      const thick = d.size[2];
      if (!onPlane) for (const p of pts) p.y += thick + 0.001;
      // ends pull onto nearby ports (the exit of a ramp, a cup's mouth...)
      const ports = this.allPorts(new Set());
      for (const k of [0, pts.length - 1]) {
        let best: THREE.Vector3 | null = null, bd = 0.45;
        for (const pt of ports) { const dd = pt.p.distanceTo(pts[k]); if (dd < bd) { bd = dd; best = pt.p; } }
        if (best) pts[k] = best.clone();
      }
      const flat = Math.abs(pts[0].y - pts[pts.length - 1].y) < 0.02 && pts.every((p) => Math.abs(p.y - pts[0].y) < 0.03);
      if (!onPlane && flat && fill !== 'wall') drop = r3(len * Math.tan(6 * Math.PI / 180));
    }
    const origin = pts[0].clone();
    const e = createEntity('path', {
      name: FILL_LABEL[fill],
      position: [r3(origin.x), r3(origin.y), r3(origin.z)],
      params: {
        fill, points: pts.map((p) => [r3(p.x - origin.x), r3(p.y - origin.y), r3(p.z - origin.z)]),
        size: [...d.size], spacing: d.spacing, drop,
      },
      look: isTrack(fill)
        ? { colorMode: 'single', color: '', paletteOffset: 0, finish: 'satin' }
        : { colorMode: fill === 'blocks' ? 'random' : fill === 'marbles' ? 'cycle' : 'gradient', color: '#ff6b6b', paletteOffset: 0, finish: fill === 'marbles' ? 'pearl' : 'gloss' },
    });
    if (isTrack(fill)) e.phys.body = 'static';
    e.name = this.app.uniqueName(e.name);
    this.app.insertEntities([e]);
    this.setTool('select');
  }

  // ------------------------------------------------------------ path handles

  private selectedPath(): Entity | null {
    if (this.app.selectedIds.length !== 1 || this.app.mode !== 'edit') return null;
    const e = this.app.selectedEntity;
    return e && e.type === 'path' ? e : null;
  }

  private toWorld(e: Entity, p: Vec3): THREE.Vector3 {
    return new THREE.Vector3(...p).applyQuaternion(entityQuat(e)).add(new THREE.Vector3(...e.position));
  }

  private toLocal(e: Entity, p: THREE.Vector3): Vec3 {
    const l = p.clone().sub(new THREE.Vector3(...e.position)).applyQuaternion(entityQuat(e).invert());
    return [r3(l.x), r3(l.y), r3(l.z)];
  }

  pickHandle(ray: THREE.Ray): boolean {
    const e = this.selectedPath();
    if (!e) { this.clearHandle(false); return false; }
    const pts: Vec3[] = e.params.points ?? [];
    let best = -1, bd = Infinity;
    pts.forEach((p, i) => {
      const w = this.toWorld(e, p);
      const dist = ray.distanceToPoint(w);
      const tol = Math.max(0.05, w.distanceTo(ray.origin) * 0.014);
      if (dist < tol && dist < bd) { bd = dist; best = i; }
    });
    if (best < 0) { this.clearHandle(false); return false; }
    this.handleIndex = best;
    this.activeHandle = this.toWorld(e, pts[best]);
    this.refreshHandles();
    return true;
  }

  clearHandle(update = true): void {
    if (this.handleIndex === null) return;
    this.handleIndex = null;
    this.activeHandle = null;
    this.refreshHandles();
    if (update) { this.app.updateSelectionVisuals(); this.app.emit('select'); }
  }

  /** Gizmo moved while a control point is active. */
  onHandleMoved(proxy: THREE.Object3D): boolean {
    const e = this.selectedPath();
    if (!e || this.handleIndex === null) return false;
    const pts: Vec3[] = e.params.points;
    pts[this.handleIndex] = this.toLocal(e, proxy.position);
    this.activeHandle = proxy.position.clone();
    this.app.previewRebuild();
    this.app.emit('transform');
    return true;
  }

  endHandleDrag(): void { /* the app commits */ }

  deleteHandle(): boolean {
    const e = this.selectedPath();
    if (!e || this.handleIndex === null) return false;
    const pts: Vec3[] = e.params.points;
    if (pts.length <= 2) return true;
    this.app.pushUndo();
    pts.splice(this.handleIndex, 1);
    this.handleIndex = null;
    this.activeHandle = null;
    this.app.commit('physics');
    this.app.updateSelectionVisuals();
    return true;
  }

  /** Inserts a point halfway between each pair (finer control). */
  subdivide(e: Entity): void {
    const pts: Vec3[] = e.params.points;
    const out: Vec3[] = [];
    for (let i = 0; i < pts.length; i++) {
      out.push(pts[i]);
      if (i + 1 < pts.length) out.push([r3((pts[i][0] + pts[i + 1][0]) / 2), r3((pts[i][1] + pts[i + 1][1]) / 2), r3((pts[i][2] + pts[i + 1][2]) / 2)]);
    }
    this.app.pushUndo();
    e.params.points = out;
    this.app.commit('physics');
  }

  private refreshHandles(): void {
    for (const c of [...this.handleRoot.children]) { c.removeFromParent(); (c as THREE.Mesh).geometry?.dispose(); }
    const e = this.selectedPath();
    this.curveLine.visible = false;
    if (!e) return;
    const pts: Vec3[] = e.params.points ?? [];
    const geo = new THREE.SphereGeometry(1, 12, 8);
    const camPos = this.app.stage.camera.position;
    pts.forEach((p, i) => {
      const w = this.toWorld(e, p);
      const on = i === this.handleIndex;
      const m = new THREE.Mesh(geo, new THREE.MeshBasicNodeMaterial({ color: on ? 0xffc36b : i === 0 ? 0x3fcf86 : 0x5b8cff, transparent: true, depthTest: false }));
      m.renderOrder = 11;
      m.position.copy(w);
      m.scale.setScalar(Math.max(0.035, w.distanceTo(camPos) * 0.011) * (on ? 1.35 : 1));
      this.handleRoot.add(m);
    });
    // the curve itself, so the line of a track or a row reads at a glance
    const d = densePath(pts, e.params.smooth !== false, !!e.params.closed && pts.length > 2);
    const drop = Number(e.params.drop) || 0;
    const L = d.cum[d.cum.length - 1] || 1;
    const world = d.pts.map((p, i) => this.toWorld(e, [p.x, p.y + drop * (1 - d.cum[i] / L) + 0.005, p.z]));
    this.curveLine.geometry.dispose();
    this.curveLine.geometry = new THREE.BufferGeometry().setFromPoints(world);
    this.curveLine.visible = true;
  }

  // ------------------------------------------------------------ ports

  worldPorts(e: Entity): { p: THREE.Vector3; dir: THREE.Vector3 }[] {
    const def = ENTITY_DEFS[e.type];
    if (!def?.ports || !e.enabled) return [];
    let list: Port[] = [];
    try { list = def.ports(e.params); } catch { return []; }
    const q = entityQuat(e);
    return list.map((pt) => ({ p: this.toWorld(e, pt.p), dir: new THREE.Vector3(...pt.dir).applyQuaternion(q) }));
  }

  private allPorts(excludeIds: Set<string>): { p: THREE.Vector3; dir: THREE.Vector3; id: string }[] {
    const out: { p: THREE.Vector3; dir: THREE.Vector3; id: string }[] = [];
    for (const e of this.app.doc.entities) if (!excludeIds.has(e.id)) for (const pt of this.worldPorts(e)) out.push({ ...pt, id: e.id });
    return out;
  }

  /** Moves `moving` so its nearest port lands on a port of another part. */
  snapPorts(moving: Entity[]): boolean {
    const ids = new Set(moving.map((e) => e.id));
    const mine = moving.flatMap((e) => this.worldPorts(e));
    this.snapped = null;
    if (mine.length === 0) return false;
    const others = this.allPorts(ids);
    let best: THREE.Vector3 | null = null, bd = SNAP_DIST, at: THREE.Vector3 | null = null;
    for (const a of mine) for (const b of others) {
      // ends meet head to tail: their outward directions must roughly oppose
      if (a.dir.dot(b.dir) > 0.3) continue;
      const d = a.p.distanceTo(b.p);
      if (d < bd) { bd = d; best = b.p.clone().sub(a.p); at = b.p; }
    }
    if (!best || !at) return false;
    for (const e of moving) e.position = [r3(e.position[0] + best.x), r3(e.position[1] + best.y), r3(e.position[2] + best.z)];
    this.snapped = [at.x, at.y, at.z];
    return true;
  }

  private refreshPorts(): void {
    for (const c of [...this.portRoot.children]) { c.removeFromParent(); (c as THREE.Mesh).geometry?.dispose(); }
    const geo = new THREE.TorusGeometry(1, 0.18, 6, 20);
    const camPos = this.app.stage.camera.position;
    for (const e of this.app.doc.entities) {
      for (const pt of this.worldPorts(e)) {
        const hot = this.snapped && pt.p.distanceTo(new THREE.Vector3(...this.snapped)) < 1e-3;
        const m = new THREE.Mesh(geo, new THREE.MeshBasicNodeMaterial({ color: hot ? 0x7ce0a0 : 0xffb35c, transparent: true, opacity: 0.85, depthTest: false }));
        m.renderOrder = 8;
        m.position.copy(pt.p);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), pt.dir.clone().normalize());
        m.scale.setScalar(Math.max(0.03, pt.p.distanceTo(camPos) * 0.008));
        this.portRoot.add(m);
      }
    }
  }

  // ------------------------------------------------------------ plane

  setPlane(axis: PlaneAxis): void {
    if (axis !== 'off' && axis !== this.plane.axis) {
      // start on the selection (or the shot target)
      const sel = this.app.selectedIndices();
      const box = sel.size ? entityBounds(this.app.built, sel) : null;
      const c = box && !box.isEmpty() ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3(...this.app.doc.camera.target);
      this.plane.offset = r3(axis === 'xy' ? c.z : axis === 'zy' ? c.x : (box && !box.isEmpty() ? box.max.y : 0));
    }
    this.plane.axis = axis;
    this.refresh();
    this.app.updateSelectionVisuals();
    this.app.emit('tool');
  }

  nudgePlane(d: number): void {
    if (this.plane.axis === 'off') return;
    this.plane.offset = r3(this.plane.offset + d);
    this.refresh();
    this.app.emit('tool');
  }

  /** Free camera square on to the plane (the shot camera is left alone). */
  facePlane(): void {
    const n = this.planeNormal();
    if (!n) return;
    const app = this.app;
    app.freeCamera = true;
    const t = app.orbit.target.clone();
    if (this.plane.axis === 'xy') t.z = this.plane.offset;
    else if (this.plane.axis === 'zy') t.x = this.plane.offset;
    else t.y = this.plane.offset;
    const dist = app.stage.camera.position.distanceTo(app.orbit.target);
    const dir = this.plane.axis === 'xz' ? new THREE.Vector3(0, 1, 0.001) : n.clone().multiplyScalar(app.stage.camera.position.clone().sub(t).dot(n) < 0 ? -1 : 1);
    app.orbit.target.copy(t);
    app.stage.camera.position.copy(t).addScaledVector(dir.normalize(), dist);
    app.stage.camera.lookAt(t);
    app.emit('gizmo');
  }

  constrainGizmos(t: any, r: any): void {
    const a = this.plane.axis;
    const n = a === 'xy' ? 'z' : a === 'zy' ? 'x' : a === 'xz' ? 'y' : null;
    t.showX = n !== 'x'; t.showY = n !== 'y'; t.showZ = n !== 'z';
    r.showX = !n || n === 'x'; r.showY = !n || n === 'y'; r.showZ = !n || n === 'z';
  }

  private refreshGrid(): void {
    const a = this.plane.axis;
    this.grid.visible = a !== 'off' && this.app.mode === 'edit';
    if (!this.grid.visible) return;
    const t = this.app.orbit?.target ?? new THREE.Vector3();
    const snap = (x: number) => Math.round(x / 0.25) * 0.25;
    this.grid.rotation.set(0, 0, 0);
    if (a === 'xy') { this.grid.rotation.x = Math.PI / 2; this.grid.position.set(snap(t.x), 12, this.plane.offset); }
    else if (a === 'zy') { this.grid.rotation.z = Math.PI / 2; this.grid.position.set(this.plane.offset, 12, snap(t.z)); }
    else this.grid.position.set(snap(t.x), this.plane.offset + 0.002, snap(t.z));
  }

  // ------------------------------------------------------------ refresh

  onSelect(): void {
    const e = this.selectedPath();
    if (!e) { this.handleIndex = null; this.activeHandle = null; }
    this.refresh();
  }

  refresh(): void {
    this.refreshHandles();
    this.refreshPorts();
    this.refreshGrid();
  }

  // ------------------------------------------------------------ drop

  /** Lowers the selection onto whatever is below it (a path: each point). */
  dropSelection(): void {
    const app = this.app;
    const sel = app.selectedIndices();
    if (sel.size === 0) return;
    app.pushUndo();
    const down = new THREE.Vector3(0, -1, 0);
    const path = this.selectedPath();
    if (path) {
      const self = new Set([app.doc.entities.indexOf(path)]);
      const lift = isTrack(path.params.fill) ? (path.params.size?.[2] ?? 0.04) + 0.001 : 0;
      path.params.points = (path.params.points as Vec3[]).map((p) => {
        const w = this.toWorld(path, p);
        const hit = castScene(app.built, new THREE.Ray(w.clone().add(new THREE.Vector3(0, 0.05, 0)), down), { exclude: self, staticOnly: true, ground: true });
        if (hit) w.y = hit.point.y + lift;
        return this.toLocal(path, w);
      });
      app.commit('physics');
      return;
    }
    const box = entityBounds(app.built, sel);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3()).multiplyScalar(0.4);
    let top = -Infinity;
    for (const [dx, dz] of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const o = new THREE.Vector3(c.x + dx * s.x, box.min.y + 0.01, c.z + dz * s.z);
      const hit = castScene(app.built, new THREE.Ray(o, down), { exclude: sel, ground: app.doc.physics.ground });
      if (hit) top = Math.max(top, hit.point.y);
    }
    if (!isFinite(top)) return;
    const dy = top - box.min.y + 0.0005;
    for (const e of app.selectedEntities) e.position = [e.position[0], r3(e.position[1] + dy), e.position[2]];
    app.commit('physics');
  }

  frameSelection(): void {
    const app = this.app;
    const sel = app.selectedIndices();
    const box = sel.size ? entityBounds(app.built, sel) : new THREE.Box3(new THREE.Vector3(...app.built.bounds.min), new THREE.Vector3(...app.built.bounds.max));
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(0.5, box.getSize(new THREE.Vector3()).length() / 2);
    const cam = app.stage.camera;
    const dir = cam.position.clone().sub(app.orbit.target).normalize();
    const dist = r / Math.sin((cam.fov * Math.PI) / 360) * 1.1;
    app.freeCamera = true;
    app.orbit.target.copy(c);
    cam.position.copy(c).addScaledVector(dir, dist);
    cam.lookAt(c);
    app.emit('gizmo');
  }

  // ------------------------------------------------------------ clipboard

  copySelection(): number {
    const list = this.app.selectedEntities;
    if (list.length === 0) return 0;
    this.clipboard = structuredClone(list);
    try { localStorage.setItem(CLIP_KEY, JSON.stringify(this.clipboard)); } catch { /* ignore */ }
    try { void navigator.clipboard?.writeText(JSON.stringify({ looplab: 'entities', entities: this.clipboard })); } catch { /* ignore */ }
    return list.length;
  }

  cutSelection(): number {
    const n = this.copySelection();
    if (n) this.app.removeEntities([...this.app.selectedIds]);
    return n;
  }

  hasClipboard(): boolean { return this.clipboard.length > 0; }

  paste(): number {
    if (this.clipboard.length === 0) return 0;
    const list = this.app.cloneEntities(this.clipboard);
    this.app.insertEntities(list, { place: true });
    return list.length;
  }

  // ------------------------------------------------------------ library

  gadgets(): SavedGadget[] {
    try { return JSON.parse(localStorage.getItem(LIB_KEY) ?? '[]'); } catch { return []; }
  }

  saveGadget(name: string): boolean {
    const list = this.app.selectedEntities;
    if (list.length === 0) return false;
    const lib = this.gadgets();
    lib.push({ name, entities: structuredClone(list) });
    try { localStorage.setItem(LIB_KEY, JSON.stringify(lib)); } catch { return false; }
    this.app.emit('library');
    return true;
  }

  deleteGadget(i: number): void {
    const lib = this.gadgets();
    lib.splice(i, 1);
    try { localStorage.setItem(LIB_KEY, JSON.stringify(lib)); } catch { /* ignore */ }
    this.app.emit('library');
  }

  insertGadget(i: number): void {
    const g = this.gadgets()[i];
    if (!g) return;
    // one placed gadget = one group, named after it
    const list = this.app.cloneEntities(g.entities);
    const used = new Set(this.app.doc.entities.map((e) => e.group));
    let name = g.name, n = 2;
    while (used.has(name)) name = `${g.name} ${n++}`;
    for (const e of list) e.group = name;
    this.app.insertEntities(list, { place: true });
  }

  // ------------------------------------------------------------ array

  /** Repeats the selection `count` times, each copy offset and turned about Y. */
  arraySelection(count: number, offset: Vec3, yawDeg: number): void {
    const src = this.app.selectedEntities;
    if (src.length === 0 || count < 2) return;
    const box = entityBounds(this.app.built, this.app.selectedIndices());
    const pivot = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const used = new Set(this.app.doc.entities.map((e) => e.group));
    let g = 'Array 1', n = 1;
    while (used.has(g)) g = `Array ${++n}`;
    const out: Entity[] = [];
    for (let k = 1; k < count; k++) {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (yawDeg * k * Math.PI) / 180);
      for (const c of this.app.cloneEntities(src)) {
        const p = new THREE.Vector3(...c.position).sub(pivot).applyQuaternion(q).add(pivot).add(new THREE.Vector3(...offset).multiplyScalar(k));
        c.position = [r3(p.x), r3(p.y), r3(p.z)];
        const rq = q.clone().multiply(entityQuat(c));
        const eu = new THREE.Euler().setFromQuaternion(rq, 'XYZ');
        c.rotation = [r3(eu.x * 180 / Math.PI), r3(eu.y * 180 / Math.PI), r3(eu.z * 180 / Math.PI)];
        c.group = g;
        out.push(c);
      }
    }
    for (const e of src) e.group = g;
    this.app.insertEntities(out);
  }
}
