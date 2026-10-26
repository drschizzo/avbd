// The editor's view of the scene: move / rotate gizmos and how they drag the
// selection, click picking (at rest in edit mode, on the frame shown in
// playback), selection boxes, markers of parts without visible bodies, and
// the machine check drawn in the scene (stopped rows, trajectories).

import * as THREE from 'three/webgpu';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { App } from '../app';
import type { BodyRenderer } from '../render/bodies';
import { hoverGizmo, removeTrackball } from '../render/threeInternals';
import { entityQuat } from '../scene/build';
import type { Entity } from '../scene/doc';
import { ENTITY_DEFS } from '../scene/entities';
import { readFrames } from '../sim/loopMatch';
import { round } from '../util/num';

export type GizmoMode = 'all' | 'translate' | 'rotate';

export class EditorViewport {
  /** Move handles; `gizmoRot` holds the rotation rings around them. */
  gizmo!: TransformControls;
  gizmoRot!: TransformControls;
  gizmoMode: GizmoMode = 'all';
  /** trajectories of the selected objects, drawn from the report */
  showTraces = true;
  private gizmoProxy = new THREE.Object3D();
  /** markers of parts with no visible body (emitters, sensors, pivots) */
  private helpers = new THREE.Group();
  /** one box per selected entity */
  private selectionBoxes: THREE.Box3Helper[] = [];
  private selectionRoot = new THREE.Group();
  private analysisRoot = new THREE.Group();
  /** gizmo drag start: proxy pose and the poses of everything it moves */
  private dragStart: { pos: THREE.Vector3; quat: THREE.Quaternion; items: { e: Entity; pos: THREE.Vector3; quat: THREE.Quaternion }[] } | null = null;

  constructor(private app: App, canvas: HTMLCanvasElement) {
    app.stage.scene.add(this.helpers, this.selectionRoot, this.analysisRoot);
    this.installGizmos(canvas);
  }

  /** Markers and gizmos show in edit mode only. */
  setEditMode(edit: boolean): void {
    this.helpers.visible = edit;
  }

  /** Red rings where rows stopped, and trajectories of the selection. */
  updateAnalysisVisuals(): void {
    for (const c of [...this.analysisRoot.children]) { c.removeFromParent(); (c as THREE.Mesh).geometry?.dispose(); }
    const r = this.app.report;
    if (!r) return;
    const cam = this.app.stage.camera.position;
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
    if (!this.showTraces || this.app.reportStale) return;
    const sel = this.app.selectedIndices();
    if (sel.size === 0) return;
    const bodies: number[] = [];
    this.app.built.bodies.forEach((b, i) => { if (sel.has(b.entity) && b.kind === 0) bodies.push(i); });
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
  }

  setGizmoMode(m: GizmoMode): void {
    this.gizmoMode = m;
    this.updateSelectionVisuals();
    this.app.emit('gizmo');
  }

  /**
   * Two TransformControls share one proxy: arrows + planes inside, rotation
   * rings outside (sized so their pick zones do not overlap). Where a ray
   * still crosses both, the move handles win.
   */
  private installGizmos(canvas: HTMLCanvasElement): void {
    const make = (mode: 'translate' | 'rotate', size: number) => {
      const g = new TransformControls(this.app.stage.camera, canvas);
      g.setMode(mode);
      g.setSize(size);
      g.addEventListener('dragging-changed', (ev: any) => {
        this.app.orbit.enabled = !ev.value;
        const other = g === this.gizmo ? this.gizmoRot : this.gizmo;
        if (other) { other.enabled = !ev.value; if (ev.value) (other as any).axis = null; }
        if (ev.value) this.beginGizmoDrag();
        else {
          this.dragStart = null;
          this.app.tools.endHandleDrag();
          this.app.commit('physics');
        }
      });
      g.addEventListener('objectChange', () => this.onGizmoChange());
      this.app.stage.scene.add(g.getHelper());
      return g;
    };
    this.gizmo = make('translate', 0.85);
    this.gizmoRot = make('rotate', 1.45);
    // the centre trackball sphere would swallow the move handles
    removeTrackball(this.gizmoRot);
    this.app.stage.scene.add(this.gizmoProxy);

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
      hoverGizmo(this.gizmo, ev);
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
      items: this.app.selectedEntities.map((e) => ({ e, pos: new THREE.Vector3(...e.position), quat: entityQuat(e) })),
    };
  }

  private onGizmoChange(): void {
    if (this.app.tools.onHandleMoved(this.gizmoProxy)) return;
    if (this.app.selectedIds.length === 0) return;
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
    if (this.gizmo.dragging && !this.app.tools.altDown) this.app.tools.snapPorts(st.items.map((x) => x.e));
    this.app.previewRebuild();
    if (this.app.mode !== 'edit') this.app.setMode('edit');
    this.app.emit('transform');
  }

  updateSelectionVisuals(): void {
    const e = this.app.selectedEntity;
    const handle = this.app.tools?.activeHandle ?? null;
    if (!e || this.app.mode !== 'edit' || this.app.tools?.placing) {
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
      } else if (this.app.selectedIds.length === 1) {
        this.gizmoProxy.position.set(...e.position);
        this.gizmoProxy.quaternion.copy(entityQuat(e));
      } else {
        // a group turns about its centre, in world axes
        const c = new THREE.Vector3();
        const sel = this.app.selectedEntities;
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
    this.app.tools?.constrainGizmos(this.gizmo, this.gizmoRot);
    this.updateSelectionBox();
  }

  updateSelectionBox(): void {
    const sel = this.app.mode === 'edit' ? this.app.selectedIndices() : new Set<number>();
    const boxes: THREE.Box3[] = [];
    for (const ei of sel) {
      const box = new THREE.Box3();
      const v = new THREE.Vector3();
      for (const b of this.app.built.bodies) {
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
      (h.material as THREE.LineBasicMaterial).color.set(boxes.length > 1 && this.app.doc.entities[[...sel][i]]?.id !== this.app.selection ? 0x3d5bb3 : 0x5b8cff);
    });
  }
  updateHelpers(): void {
    for (const c of [...this.helpers.children]) {
      c.removeFromParent();
      (c as THREE.Mesh).geometry?.dispose();
    }
    const mat = new THREE.MeshBasicNodeMaterial({ color: 0x5b8cff, wireframe: true, transparent: true, opacity: 0.8 });
    const sensorMat = new THREE.MeshBasicNodeMaterial({ color: 0x5fd08a, wireframe: true, transparent: true, opacity: 0.9 });
    for (const e of this.app.doc.entities) {
      const marker = e.enabled ? ENTITY_DEFS[e.type]?.marker?.(e.params) : undefined;
      if (!marker) continue;
      let m: THREE.Mesh;
      if (marker.kind === 'cone') {
        m = new THREE.Mesh(new THREE.ConeGeometry(marker.radius, marker.height, 24, 1, true).rotateX(Math.PI), mat);
        m.quaternion.copy(entityQuat(e));
      } else if (marker.kind === 'box') {
        m = new THREE.Mesh(new THREE.BoxGeometry(...marker.size), sensorMat);
        m.quaternion.copy(entityQuat(e));
      } else {
        m = new THREE.Mesh(new THREE.OctahedronGeometry(0.08), mat);
      }
      m.position.set(...e.position);
      m.userData.entityId = e.id;
      this.helpers.add(m);
    }
  }

  installPicking(canvas: HTMLCanvasElement): void {
    let down: { x: number; y: number; onGizmo: boolean } | null = null;
    let pickSeq = 0;
    let lastClick = { x: -1e9, y: -1e9 };
    // capture: decide before the gizmo reacts to the same press
    canvas.addEventListener('pointerdown', (ev) => {
      down = ev.button === 0 && !this.app.tools.capturing ? { x: ev.clientX, y: ev.clientY, onGizmo: this.gizmoBusy } : null;
    }, true);
    canvas.addEventListener('pointerup', async (ev) => {
      if (!down || this.app.tools.capturing) { down = null; return; }
      const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
      const onGizmo = down.onGizmo;
      down = null;
      if (moved > 5 || onGizmo) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
      const rc = new THREE.Raycaster();
      rc.setFromCamera(ndc, this.app.stage.camera);
      const seq = ++pickSeq;
      const again = Math.hypot(ev.clientX - lastClick.x, ev.clientY - lastClick.y) < 6;
      lastClick = { x: ev.clientX, y: ev.clientY };

      // candidate entities under the cursor, best first
      const ids: string[] = [];
      const push = (id: string | undefined | null) => { if (id && !ids.includes(id)) ids.push(id); };
      let hits: ReturnType<BodyRenderer['pick']>;
      if (this.app.mode === 'edit') {
        // control points of the selected path come first
        if (this.app.tools.pickHandle(rc.ray)) { this.updateSelectionVisuals(); this.app.emit('select'); return; }
        for (const hit of rc.intersectObjects(this.helpers.children, false)) push(hit.object.userData.entityId);
        hits = this.app.bodies.pick(rc.ray, true);
      } else {
        // in playback the bodies are where the bake put them, not at rest
        const simFrame = this.app.playbackAt(this.app.time).simFrame;
        const poses = await this.displayedPoses().catch(() => null);
        if (seq !== pickSeq) return;
        hits = poses ? this.app.bodies.pick(rc.ray, false, poses, simFrame) : [];
      }
      // see through glass containers: what is inside is what you aim at
      const entityId = (bi: number) => this.app.doc.entities[this.app.built.bodies[bi].entity]?.id;
      for (const hit of hits) if (!hit.glass) push(entityId(hit.index));
      for (const hit of hits) push(entityId(hit.index));

      // a miss in playback is just a click on the video: keep playing
      if (ids.length === 0) { if (this.app.mode === 'edit' && !ev.shiftKey) this.app.select(null); return; }
      // clicking the same spot again cycles through what lies under it;
      // Shift adds / removes, Alt picks one member of a group
      const cur = again && this.app.selection && !ev.shiftKey ? ids.indexOf(this.app.selection) : -1;
      this.app.select(ids[(cur + 1) % ids.length], { toggle: ev.shiftKey, single: ev.altKey });
    });
  }

  /** Engine-indexed poses (uvec4 per body) of the frame on screen. */
  private async displayedPoses(): Promise<Uint32Array | null> {
    const res = this.app.result ?? this.app.baker.currentPartial;
    if (!res) return null;
    const pb = this.app.playbackAt(this.app.time);
    const slot = pb.mix < 0.5 ? pb.frameA : pb.frameB;
    const [frame] = await readFrames(this.app.device, this.app.stage.renderer, res, [slot]);
    return frame;
  }
}
