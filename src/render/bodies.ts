// GPU-driven body rendering. One instanced draw per (shape, material class).
// The vertex stage fetches poses straight from the baked history buffer (or
// the edit-pose buffer), interpolates between recorded frames, applies the
// loop transitions (reassemble / shrink / grow-in) and rebuilds rounded boxes
// with a constant bevel radius regardless of their half extents.

import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
// TSL typings are too strict for this generated-shader code; use it untyped.
const TSL: any = TSLTyped;
const {
  float, instancedBufferAttribute, normalLocal, positionLocal, positionWorld, storage, transformNormalToView,
  uniform, uint, varying, vec3, vec4, wgsl, wgslFn, select, mrt, output, normalize, cameraPosition, reflect, dot, abs,
  pow, clamp, pmremTexture, mix,
} = TSL;
import { studioLights } from './studioLights';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { BuiltScene } from '../scene/build';
import { KIND_DYNAMIC } from '../scene/build';
import type { Finish, SceneDoc } from '../scene/doc';
import type { BakeResult } from '../sim/baker';

const helpers = wgsl(/* wgsl */`
  fn hxDecodeQuat(p: u32) -> vec4f {
    let idx = p >> 30u;
    let c = (vec3f(f32(p & 1023u), f32((p >> 10u) & 1023u), f32((p >> 20u) & 1023u)) / 1023.0 - 0.5) * 1.41421356;
    let w = sqrt(max(0.0, 1.0 - dot(c, c)));
    if (idx == 0u) { return vec4f(w, c.x, c.y, c.z); }
    if (idx == 1u) { return vec4f(c.x, w, c.y, c.z); }
    if (idx == 2u) { return vec4f(c.x, c.y, w, c.z); }
    return vec4f(c.x, c.y, c.z, w);
  }
  fn hxPos(r: vec4u) -> vec3f { return vec3f(bitcast<f32>(r.x), bitcast<f32>(r.y), bitcast<f32>(r.z)); }
  fn hxNlerp(a: vec4f, b: vec4f, t: f32) -> vec4f {
    var bb = b;
    if (dot(a, b) < 0.0) { bb = -b; }
    return normalize(mix(a, bb, t));
  }
  fn hxQMul(a: vec4f, b: vec4f) -> vec4f {
    return vec4f(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
  }
  fn hxRot(q: vec4f, v: vec3f) -> vec3f {
    let t = 2.0 * cross(q.xyz, v);
    return v + q.w * t + cross(q.xyz, t);
  }
  fn hxOutBack(x: f32) -> f32 {
    let c1 = 1.70158; let c3 = c1 + 1.0; let y = x - 1.0;
    return 1.0 + c3 * y * y * y + c1 * y * y;
  }
  fn hxInBack(x: f32) -> f32 {
    let c1 = 1.70158; let c3 = c1 + 1.0;
    return c3 * x * x * x - c1 * x * x;
  }
  fn hxInOut(x: f32) -> f32 {
    if (x < 0.5) { return 4.0 * x * x * x; }
    let y = -2.0 * x + 2.0;
    return 1.0 - y * y * y * 0.5;
  }
  // anim = (spawnFrame, stagger, initialDynamic, kind)
  // f    = (frameMix, simFrame, videoTime, isSphere)
  // l0   = (duration, outro, staggerFrac, arc)
  // l1   = (mode, intro, fps, editMode)
  // returns (reassembleBlend, scale, lift, 0)
  // hop: continuous loops only - the twin is too far to glide to without
  // cutting through things, so the body shrinks away and pops up there instead
  fn hxLoop(anim: vec4f, f: vec4f, l0: vec4f, l1: vec4f, hop: bool) -> vec4f {
    var blend = 0.0;
    var scale = 1.0;
    var lift = 0.0;
    if (l1.w > 0.5) { return vec4f(0.0, 1.0, 0.0, 0.0); }
    let fps = l1.z;
    let mode = u32(l1.x + 0.5);
    if (f.y < anim.x - 0.001) {
      // continuous loops recycle spawned bodies: until its spawn comes round
      // again a body is still out from the previous cycle, and it shrinks
      // away just before it is teleported back to the emitter
      // (its pop-in started at the end of the previous cycle: age wraps)
      if (mode != 5u) { return vec4f(0.0, 0.0, 0.0, 0.0); }
      let wrapAge = (f.y + l0.x * fps - anim.x) / fps;
      scale = hxOutBack(clamp(wrapAge / 0.22, 0.0, 1.0));
      scale *= 1.0 - hxInBack(clamp(1.0 - (anim.x - f.y) / (0.2 * fps), 0.0, 1.0));
    } else if (anim.x > 0.5) {
      let age = (f.y - anim.x) / fps;
      scale = hxOutBack(clamp(age / 0.22, 0.0, 1.0));
    }
    if (anim.w > 0.5) { return vec4f(0.0, scale, 0.0, 0.0); }
    let duration = l0.x;
    let outro = max(l0.y, 1e-3);
    let sf = clamp(l0.z, 0.0, 0.95);
    let t = f.z;
    let u = clamp((t - (duration - outro) - anim.y * outro * sf) / (outro * (1.0 - sf)), 0.0, 1.0);
    let intro = max(l1.y, 1e-3);
    let ui = clamp((t - anim.y * intro * sf) / (intro * (1.0 - sf)), 0.0, 1.0);
    let initialDyn = anim.z > 0.5;
    if (mode == 0u || mode == 5u) {
      if (initialDyn && hop) {
        blend = select(0.0, 1.0, u >= 0.5);
        scale *= select(1.0 - hxInBack(u * 2.0), hxOutBack(u * 2.0 - 1.0), u >= 0.5);
      } else if (initialDyn) {
        blend = hxInOut(u);
        lift = sin(3.14159265 * blend) * l0.w;
      } else {
        scale *= 1.0 - hxInBack(u);
      }
    } else if (mode == 1u) {
      scale *= 1.0 - hxInBack(u);
      if (initialDyn) { scale *= hxOutBack(ui); }
    } else if (mode == 2u) {
      let tail = clamp((t - (duration - 0.3)) / 0.3, 0.0, 1.0);
      scale *= 1.0 - hxInBack(tail);
      if (initialDyn) { scale *= hxOutBack(ui); }
    }
    return vec4f(blend, max(scale, 0.0), lift, 0.0);
  }
  // ta/tb: the reassemble target, sampled like ra/rb. Frame 0 of the body
  // itself for reassemble; for continuous loops, the warm-up trajectory of
  // the interchangeable body it was matched with, turned by the symmetry tg.y
  // of its shape that lines the two up best.
  fn hxPose(ra: vec4u, rb: vec4u, ta: vec4u, tb: vec4u, tg: vec4u, lf: vec4f, mixT: f32) -> mat2x4f {
    var p = mix(hxPos(ra), hxPos(rb), mixT);
    var q = hxNlerp(hxDecodeQuat(ra.w), hxDecodeQuat(rb.w), mixT);
    if (lf.x > 0.0) {
      let p0 = mix(hxPos(ta), hxPos(tb), mixT);
      let q0 = hxQMul(hxNlerp(hxDecodeQuat(ta.w), hxDecodeQuat(tb.w), mixT), hxDecodeQuat(tg.y));
      p = mix(p, p0, lf.x) + vec3f(0.0, lf.z, 0.0);
      q = hxNlerp(q, q0, lf.x);
    }
    return mat2x4f(vec4f(p, lf.y), q);
  }
`);

const positionFn = wgslFn(/* wgsl */`
  fn bodyPosition(local: vec3f, ra: vec4u, rb: vec4u, ta: vec4u, tb: vec4u, tg: vec4u, he: vec4f, anim: vec4f, f: vec4f, l0: vec4f, l1: vec4f) -> vec3f {
    let lf = hxLoop(anim, f, l0, l1, tg.z != 0u);
    let pose = hxPose(ra, rb, ta, tb, tg, lf, f.x);
    let p = pose[0].xyz;
    var s = pose[0].w;
    if (p.y < -8.0) { s = 0.0; }
    var lp = local * he.x;
    if (f.w < 0.5) {
      let inner = clamp(local, vec3f(-0.4), vec3f(0.4));
      let bev = local - inner;
      lp = inner * ((he.xyz - vec3f(he.w)) / 0.4) + bev * (he.w / 0.1);
    }
    return p + hxRot(pose[1], lp * s);
  }
`, [helpers]);

// The rounded-box rebuild in bodyPosition scales the three axes by very
// different factors (a 6 cm pane keeps a 3 cm bevel: its "flat" face is really
// the bevel ring squashed almost flat). Rotating the source normal alone then
// leaves the curved bevel normals on what is now a plane, which reads as a
// woven/hatched pattern over the whole face - glaring on glass, where
// Fresnel^5 and roughness 0.03 amplify any normal wobble. The correct normal
// for an axis scaling S is n / S, renormalised, and S is piecewise constant:
// the inner block scales by (he - R) / 0.4, the bevel by R / 0.1.
const normalFn = wgslFn(/* wgsl */`
  fn bodyNormal(n: vec3f, local: vec3f, he: vec4f, ra: vec4u, rb: vec4u, ta: vec4u, tb: vec4u, tg: vec4u, anim: vec4f, f: vec4f, l0: vec4f, l1: vec4f) -> vec3f {
    let lf = hxLoop(anim, f, l0, l1, tg.z != 0u);
    let pose = hxPose(ra, rb, ta, tb, tg, lf, f.x);
    var nn = n;
    if (f.w < 0.5) {
      let onBevel = abs(local) - vec3f(0.4);
      let s = select(vec3f((he.w) / 0.1), (he.xyz - vec3f(he.w)) / 0.4, onBevel < vec3f(0.0));
      nn = normalize(n / max(s, vec3f(1e-5)));
    }
    return hxRot(pose[1], nn);
  }
`, [helpers]);

// Continuous loops may pair a body with a twin of another colour: the colour
// cross-fades with the loop blend. tg.w = 10:10:10 sqrt-encoded colour, bit 30
// set when there is one.
const loopColorFn = wgslFn(/* wgsl */`
  fn bodyLoopColor(own: vec3f, tg: vec4u, anim: vec4f, f: vec4f, l0: vec4f, l1: vec4f) -> vec3f {
    if (((tg.w >> 30u) & 1u) == 0u) { return own; }
    let c = vec3f(f32(tg.w & 1023u), f32((tg.w >> 10u) & 1023u), f32((tg.w >> 20u) & 1023u)) / 1023.0;
    return mix(own, c * c, hxLoop(anim, f, l0, l1, tg.z != 0u).x);
  }
`, [helpers]);

// ---------------------------------------------------------------------------

export interface FinishParams { roughness: number; metalness: number; clearcoat: number; emissive: number; iridescence: number; sheen: number }

export const FINISH_PARAMS: Record<Finish, FinishParams> = {
  gloss: { roughness: 0.32, metalness: 0, clearcoat: 1, emissive: 0, iridescence: 0, sheen: 0 },
  satin: { roughness: 0.5, metalness: 0, clearcoat: 0.25, emissive: 0, iridescence: 0, sheen: 0.3 },
  matte: { roughness: 0.85, metalness: 0, clearcoat: 0, emissive: 0, iridescence: 0, sheen: 0.6 },
  metal: { roughness: 0.32, metalness: 1, clearcoat: 0, emissive: 0, iridescence: 0, sheen: 0 },
  chrome: { roughness: 0.06, metalness: 1, clearcoat: 0, emissive: 0, iridescence: 0, sheen: 0 },
  pearl: { roughness: 0.28, metalness: 0.1, clearcoat: 1, emissive: 0, iridescence: 1, sheen: 0 },
  neon: { roughness: 0.4, metalness: 0, clearcoat: 0.5, emissive: 2.2, iridescence: 0, sheen: 0 },
  glass: { roughness: 0.04, metalness: 0, clearcoat: 1, emissive: 0, iridescence: 0, sheen: 0 },
  hidden: { roughness: 1, metalness: 0, clearcoat: 0, emissive: 0, iridescence: 0, sheen: 0 },
};

type Group = 'opaque' | 'glass' | 'ghost';

interface MeshSlot {
  mesh: THREE.Mesh;
  geometry: THREE.InstancedBufferGeometry;
  attrs: Record<string, THREE.InstancedBufferAttribute>;
  bodies: Int32Array; // instance -> built body index
  group: Group;
  sphere: boolean;
}

export interface PlaybackState {
  frameA: number; // recorded frame index
  frameB: number;
  mix: number;
  simFrame: number; // continuous simulated frame (for spawn visibility)
  time: number; // video time (s)
}

export class BodyRenderer {
  readonly root = new THREE.Group();
  private slots: MeshSlot[] = [];
  private layoutKey = '';
  private editData: Uint32Array | null = null;
  private editAttr: THREE.StorageBufferAttribute | null = null;
  /** Per body: (engine index of the loop target, packed symmetry quat, 0, 0). */
  private targetData: Uint32Array | null = null;
  private targetAttr: THREE.StorageBufferAttribute | null = null;
  private continuous = false;
  private history: BakeResult | null = null;
  private built: BuiltScene | null = null;
  private editMode = true;

  // uniforms
  private uBaseA = uniform(0, 'uint');
  private uBaseB = uniform(0, 'uint');
  private uTailA = uniform(0, 'uint');
  private uTailB = uniform(0, 'uint');
  private uF = uniform(new THREE.Vector4(0, 0, 0, 0));
  private uL0 = uniform(new THREE.Vector4(10, 2, 0.5, 0.5));
  private uL1 = uniform(new THREE.Vector4(0, 0.6, 60, 1));
  private uClipY = uniform(-1e9);
  /** Studio environment, so glass can reflect back what Fresnel takes away. */
  private env: THREE.Texture | null = null;
  readonly uEnvIntensity = uniform(1);
  /** Milkiness of the panes: what makes an otherwise invisible sheet readable. */
  readonly uGlassHaze = uniform(0.055);

  constructor(private renderer: THREE.WebGPURenderer) {
    this.root.name = 'bodies';
  }

  get bodyCount(): number { return this.built?.bodies.length ?? 0; }

  /** The glass shading samples this directly, so changing it rebuilds materials. */
  setEnvironment(tex: THREE.Texture | null): void {
    if (this.env === tex) return;
    this.env = tex;
    if (this.built) this.rebuildMaterials();
  }

  /** Updates the scene layout (edit mode poses come from `built`). */
  setScene(built: BuiltScene, doc: SceneDoc): void {
    this.built = built;
    const N = built.bodies.length + 1;
    const key = this.computeLayoutKey(built, doc);
    // edit buffer: frame-0 poses in history format
    if (!this.editData || this.editData.length !== N * 4) {
      if (this.editAttr) this.releaseAttr(this.editAttr);
      this.editData = new Uint32Array(N * 4);
      this.editAttr = new THREE.StorageBufferAttribute(this.editData, 4);
      if (this.targetAttr) this.releaseAttr(this.targetAttr);
      this.targetData = new Uint32Array(N * 4);
      this.targetAttr = new THREE.StorageBufferAttribute(this.targetData, 4);
      this.resetLoopTargets();
      this.layoutKey = '';
    }
    writePoses(this.editData, built);
    this.editAttr!.needsUpdate = true;

    if (key !== this.layoutKey) {
      this.rebuild(built, doc);
      this.layoutKey = key;
    } else {
      this.updateInstanceAttributes(built, doc);
    }
  }

  /** Continuous loops: body -> matched twin (see sim/loopMatch). */
  setLoopTargets(data: Uint32Array): void {
    if (!this.targetData || data.length !== this.targetData.length) return;
    this.targetData.set(data);
    this.targetAttr!.needsUpdate = true;
  }

  private resetLoopTargets(): void {
    const d = this.targetData;
    if (!d) return;
    const id = packQuat([0, 0, 0, 1]);
    for (let i = 0; i < d.length / 4; i++) { d[i * 4] = i; d[i * 4 + 1] = id; d[i * 4 + 2] = 0; d[i * 4 + 3] = 0; }
    this.targetAttr!.needsUpdate = true;
  }

  setHistory(h: BakeResult | null): void {
    if (this.history === h) return;
    this.history = h;
    if (!h) this.resetLoopTargets();
    if (this.built) this.rebuildMaterials();
  }

  setEditMode(edit: boolean): void {
    if (this.editMode === edit) return;
    this.editMode = edit;
    // edit mode shows the rest poses being edited, not the bake's frame 0
    // (a continuous loop's frame 0 is the end of its warm-up)
    if (this.history && this.built) this.rebuildMaterials();
    this.uL1.value.w = edit ? 1 : 0;
    for (const s of this.slots) if (s.group === 'ghost') s.mesh.visible = edit;
  }

  setLoop(doc: SceneDoc): void {
    const modes = ['reassemble', 'shrink', 'sink', 'boomerang', 'none', 'continuous'];
    this.continuous = doc.loop.mode === 'continuous';
    this.uL0.value.set(doc.duration, doc.loop.outro, doc.loop.stagger, doc.loop.arc);
    this.uL1.value.set(Math.max(0, modes.indexOf(doc.loop.mode)), doc.loop.intro, doc.fps, this.editMode ? 1 : 0);
    this.uClipY.value = doc.loop.mode === 'sink' && doc.physics.ground && doc.render.floor !== 'none' ? -0.002 : -1e9;
  }

  setPlayback(p: PlaybackState): void {
    const stride = this.history?.stride ?? 0;
    this.uBaseA.value = this.editMode || !this.history ? 0 : p.frameA * stride;
    this.uBaseB.value = this.editMode || !this.history ? 0 : p.frameB * stride;
    const tail = this.history?.tail;
    if (!this.editMode && tail && this.continuous) {
      const slot = (f: number) => (tail.base + Math.max(0, Math.min(tail.count - 1, f - tail.start))) * stride;
      this.uTailA.value = slot(p.frameA);
      this.uTailB.value = slot(p.frameB);
    } else {
      this.uTailA.value = 0;
      this.uTailB.value = 0;
    }
    this.uF.value.x = p.mix;
    this.uF.value.y = this.editMode ? 1e9 : p.simFrame;
    this.uF.value.z = p.time;
  }

  /**
   * Instances for CPU picking: every built body under the ray, nearest first.
   * `poses` (the recorded history frame at `simFrame`, engine-indexed)
   * replaces the rest pose.
   */
  pick(ray: THREE.Ray, includeHidden: boolean, poses?: Uint32Array, simFrame = 0): { index: number; t: number; glass: boolean }[] {
    const b = this.built;
    if (!b) return [];
    const hits: { index: number; t: number; glass: boolean }[] = [];
    const q = new THREE.Quaternion(), inv = new THREE.Quaternion();
    const o = new THREE.Vector3(), d = new THREE.Vector3(), c = new THREE.Vector3();
    const pf = poses ? new Float32Array(poses.buffer, poses.byteOffset, poses.length) : null;
    const pq: number[] = [0, 0, 0, 1];
    for (let i = 0; i < b.bodies.length; i++) {
      const body = b.bodies[i];
      if (body.spawnFrame > simFrame) continue; // not spawned yet
      if (!includeHidden && body.finish === 'hidden') continue;
      if (pf && poses) {
        const k = (i + 1) * 4; // slot 0 is the ground
        c.set(pf[k], pf[k + 1], pf[k + 2]);
        unpackQuat(poses[k + 3], pq);
        q.set(pq[0], pq[1], pq[2], pq[3]);
      } else {
        c.set(...body.pos);
        q.set(...body.quat);
      }
      inv.copy(q).invert();
      o.copy(ray.origin).sub(c).applyQuaternion(inv);
      d.copy(ray.direction).applyQuaternion(inv);
      const t = body.shape === 1 ? raySphere(o, d, body.he[0]) : rayBox(o, d, body.he);
      if (t >= 0) hits.push({ index: i, t, glass: groupOf(body.finish) !== 'opaque' });
    }
    return hits.sort((x, y) => x.t - y.t);
  }

  dispose(): void {
    for (const s of this.slots) this.disposeSlot(s);
    this.slots = [];
  }

  // -------------------------------------------------------------------------

  private computeLayoutKey(built: BuiltScene, doc: SceneDoc): string {
    let h = 2166136261;
    const mixIn = (n: number) => { h ^= n; h = Math.imul(h, 16777619); };
    for (const b of built.bodies) {
      mixIn(b.shape);
      mixIn(groupOf(b.finish) === 'opaque' ? 0 : groupOf(b.finish) === 'glass' ? 1 : 2);
    }
    return `${built.bodies.length}:${h >>> 0}:${doc.render.bevel}`;
  }

  private rebuild(built: BuiltScene, doc: SceneDoc): void {
    for (const s of this.slots) this.disposeSlot(s);
    this.slots = [];
    const lists: Record<string, number[]> = {};
    built.bodies.forEach((b, i) => {
      const key = `${b.shape === 1 ? 'sphere' : 'box'}:${groupOf(b.finish)}`;
      (lists[key] ??= []).push(i);
    });
    const boxCount = built.bodies.filter((b) => b.shape === 0).length;
    const sphereCount = built.bodies.length - boxCount;
    const boxGeo = new RoundedBoxGeometry(1, 1, 1, boxCount > 15000 ? 2 : boxCount > 4000 ? 3 : 4, 0.1);
    const sphereGeo = new THREE.SphereGeometry(1, sphereCount > 8000 ? 20 : sphereCount > 2000 ? 32 : 56, sphereCount > 8000 ? 14 : sphereCount > 2000 ? 22 : 36);

    for (const [key, list] of Object.entries(lists)) {
      const [shape, group] = key.split(':') as ['box' | 'sphere', Group];
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.copy((shape === 'sphere' ? sphereGeo : boxGeo) as any);
      geometry.instanceCount = list.length;
      const n = list.length;
      const attrs: Record<string, THREE.InstancedBufferAttribute> = {
        aBody: new THREE.InstancedBufferAttribute(new Float32Array(n), 1),
        aHe: new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4),
        aAnim: new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4),
        aColor: new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3),
        aMat: new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4),
        aFx: new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4),
      };
      for (const [name, a] of Object.entries(attrs)) geometry.setAttribute(name, a);
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicNodeMaterial());
      mesh.frustumCulled = false;
      mesh.castShadow = group === 'opaque';
      mesh.receiveShadow = group !== 'ghost';
      mesh.renderOrder = group === 'opaque' ? 0 : group === 'glass' ? 2 : 3;
      mesh.visible = group !== 'ghost' || this.editMode;
      const slot: MeshSlot = { mesh, geometry, attrs, bodies: Int32Array.from(list), group, sphere: shape === 'sphere' };
      this.slots.push(slot);
      this.root.add(mesh);
    }
    boxGeo.dispose();
    sphereGeo.dispose();
    this.updateInstanceAttributes(built, doc);
    this.rebuildMaterials();
  }

  private updateInstanceAttributes(built: BuiltScene, doc: SceneDoc): void {
    const bevel = doc.render.bevel;
    for (const s of this.slots) {
      const { aBody, aHe, aAnim, aColor, aMat, aFx } = s.attrs;
      for (let k = 0; k < s.bodies.length; k++) {
        const i = s.bodies[k];
        const b = built.bodies[i];
        (aBody.array as Float32Array)[k] = i + 1;
        const minHe = Math.min(b.he[0], b.he[1], b.he[2]);
        // bevel scales with small parts but is capped so big slabs keep crisp edges
        const R = Math.min(minHe * 0.98, minHe * bevel * 2, 0.012 + bevel * 0.25);
        (aHe.array as Float32Array).set([b.he[0], b.he[1], b.he[2], b.shape === 1 ? 0 : R], k * 4);
        // continuous loops blend recycled (spawned) bodies like initial ones
        const blended = b.kind === KIND_DYNAMIC && (b.spawnFrame === 0 || doc.loop.mode === 'continuous');
        (aAnim.array as Float32Array).set([b.spawnFrame, b.stagger, blended ? 1 : 0, b.kind], k * 4);
        (aColor.array as Float32Array).set(b.color, k * 3);
        const fp = FINISH_PARAMS[b.finish];
        (aMat.array as Float32Array).set([fp.roughness, fp.metalness, fp.clearcoat, fp.emissive], k * 4);
        (aFx.array as Float32Array).set([fp.iridescence, fp.sheen, 0, 0], k * 4);
      }
      for (const a of Object.values(s.attrs)) a.needsUpdate = true;
    }
  }

  private rebuildMaterials(): void {
    if (!this.editAttr || !this.built) return;
    const N = this.built.bodies.length + 1;
    const edit = storage(this.editAttr, 'uvec4', N).toReadOnly();
    const played = this.editMode ? null : this.history;
    const hist = played ? storage(played.history, 'uvec4', played.history.count).toReadOnly() : edit;
    const targ = storage(this.targetAttr!, 'uvec4', N).toReadOnly();
    for (const s of this.slots) {
      const old = s.mesh.material as THREE.Material;
      const aBody = instancedBufferAttribute(s.attrs.aBody);
      const aHe = instancedBufferAttribute(s.attrs.aHe);
      const aAnim = instancedBufferAttribute(s.attrs.aAnim);
      const aColor = instancedBufferAttribute(s.attrs.aColor);
      const aMat = instancedBufferAttribute(s.attrs.aMat);
      const aFx = instancedBufferAttribute(s.attrs.aFx);
      const body = uint(aBody);
      const ra = hist.element(this.uBaseA.add(body));
      const rb = hist.element(this.uBaseB.add(body));
      const tg = targ.element(body);
      const ta = hist.element(this.uTailA.add(tg.x));
      const tb = hist.element(this.uTailB.add(tg.x));
      const fvec = vec4(this.uF.x, this.uF.y, this.uF.z, float(s.sphere ? 1 : 0));
      const pos = positionFn({ local: positionLocal, ra, rb, ta, tb, tg, he: aHe, anim: aAnim, f: fvec, l0: this.uL0, l1: this.uL1 });
      const nrm = normalFn({ n: normalLocal, local: positionLocal, he: aHe, ra, rb, ta, tb, tg, anim: aAnim, f: fvec, l0: this.uL0, l1: this.uL1 });

      let m: THREE.MeshPhysicalNodeMaterial;
      if (s.group === 'opaque') {
        m = new THREE.MeshPhysicalNodeMaterial();
        const col = varying(loopColorFn({ own: aColor, tg, anim: aAnim, f: fvec, l0: this.uL0, l1: this.uL1 }), 'vBodyColor');
        m.colorNode = col;
        m.roughnessNode = varying(aMat.x);
        m.metalnessNode = varying(aMat.y);
        m.clearcoatNode = varying(aMat.z);
        m.clearcoatRoughnessNode = float(0.06);
        m.emissiveNode = col.mul(varying(aMat.w));
        m.iridescenceNode = varying(aFx.x);
        m.iridescenceIORNode = float(1.6);
        m.sheenNode = varying(vec3(aFx.y).mul(0.6));
        m.sheenRoughnessNode = float(0.6);
        m.specularIntensityNode = float(0.7);
        // sink loops: everything below the floor plane is clipped away
        m.alphaTest = 0.5;
        m.opacityNode = select(positionWorld.y.lessThan(this.uClipY), float(0), float(1));
      } else if (s.group === 'glass') {
        // Physical glass without a transmission pass: no diffuse at all, the
        // lit colour is the (Fresnel-weighted) reflection and alpha is only
        // what the pane takes away from the light behind it. Blended
        // "additive-over" (ONE, ONE_MINUS_SRC_ALPHA), so a pane is nearly
        // invisible face-on and bright at grazing angles and on its bevels.
        //
        // The reflection has to be the WHOLE environment, not just the
        // analytic panels: alpha removes (1 - F) of everything behind the
        // pane, and if only the few directions that happen to hit a softbox
        // put energy back, every other angle turns the sheet into a grey card.
        // That is what read as hard shadows cast by the walls - it was the
        // panes themselves subtracting light they never returned.
        m = new THREE.MeshPhysicalNodeMaterial();
        m.colorNode = vec3(0);
        m.roughness = 0.03;
        m.metalness = 0;
        m.ior = 1.5;
        m.specularIntensityNode = float(1.0);
        m.envMapIntensity = 0; // the reflection below replaces the built-in IBL
        const nW = normalize(varying(nrm, 'vGlassNormalW'));
        const vW = normalize(positionWorld.sub(cameraPosition));
        const cosT = abs(dot(nW, vW));
        const fres = float(0.04).add(float(0.96).mul(pow(float(1).sub(cosT), 5)));
        const tint = varying(aColor.mul(0.5).add(0.5));
        const refl = reflect(vW, nW);
        const envRefl = this.env
          ? pmremTexture(this.env, refl, float(0.04)).rgb.mul(this.uEnvIntensity)
          : vec3(0.55);
        const mirror = envRefl.add(studioLights(refl).mul(0.9));
        // A pane also carries a little body: a touch of milkiness plus its own
        // colour, so a sheet of glass is readable face-on instead of vanishing.
        const haze = this.uGlassHaze;
        m.emissiveNode = mirror.mul(fres).add(tint.mul(haze).mul(0.75));
        m.opacityNode = clamp(fres.mul(0.9).add(haze), 0, 1);
        m.transparent = true;
        m.depthWrite = false;
        m.blending = THREE.CustomBlending;
        m.blendSrc = THREE.OneFactor;
        m.blendDst = THREE.OneMinusSrcAlphaFactor;
        m.blendSrcAlpha = THREE.OneFactor;
        m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
        // The same layer is accumulated alone in the 'glass' target, so the
        // liquid can be composited between the scenery and the glass in front.
        // The `normal` entry exists only to stop the panes writing into the
        // G-buffer: three.js MERGES a material's MRT with the pass's, so by
        // default a pane overwrites the normal of whatever stands behind it
        // while the depth buffer still holds that object's depth. GTAO then
        // reads a normal and a depth that disagree and paints its sampling
        // pattern onto the glass - the grey hatching on the panes. A
        // keep-destination blend leaves the target untouched instead.
        m.mrtNode = mrt({ glass: output, normal: vec4(0) });
      } else {
        m = new THREE.MeshPhysicalNodeMaterial();
        m.colorNode = vec3(0.55, 0.65, 1.0);
        m.transparent = true;
        m.opacity = 0.18;
        m.depthWrite = false;
        m.wireframe = false;
        m.mrtNode = mrt({ normal: vec4(0) });
      }
      m.positionNode = pos;
      // three.js caches node programs (and their bindings) by graph structure
      // only: without the buffer identities in the key, a material built for a
      // new bake reuses the bindings of the previous one and keeps playing the
      // old simulation.
      const programKey = m.customProgramCacheKey.bind(m);
      const bufferKey = `|e${attrId(this.editAttr)}|t${attrId(this.targetAttr!)}|h${played ? attrId(played.history) : 0}`;
      m.customProgramCacheKey = () => programKey() + bufferKey;
      const viewNormal = varying(transformNormalToView(nrm).normalize(), 'vBodyNormalView');
      m.normalNode = viewNormal;
      // clearcoat would otherwise shade with the unrotated geometry normal
      (m as any).clearcoatNormalNode = viewNormal;
      s.mesh.material = m;
      old.dispose();
    }
  }

  private disposeSlot(s: MeshSlot): void {
    s.mesh.removeFromParent();
    s.geometry.dispose();
    (s.mesh.material as THREE.Material).dispose();
  }

  private releaseAttr(a: THREE.StorageBufferAttribute): void {
    try { (this.renderer as any)._attributes?.delete(a); } catch { /* noop */ }
  }
}

const attrIds = new WeakMap<object, number>();
let nextAttrId = 1;
function attrId(a: object): number {
  let id = attrIds.get(a);
  if (id === undefined) { id = nextAttrId++; attrIds.set(a, id); }
  return id;
}

function groupOf(f: Finish): Group {
  return f === 'glass' ? 'glass' : f === 'hidden' ? 'ghost' : 'opaque';
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function fbits(x: number): number { f32[0] = x; return u32[0]; }

export function packQuat(q: ArrayLike<number>): number {
  const a = [Math.abs(q[0]), Math.abs(q[1]), Math.abs(q[2]), Math.abs(q[3])];
  let idx = 0;
  for (let i = 1; i < 4; i++) if (a[i] > a[idx]) idx = i;
  const s = q[idx] < 0 ? -1 : 1;
  const c: number[] = [];
  for (let i = 0; i < 4; i++) if (i !== idx) c.push(q[i] * s);
  const enc = (v: number) => Math.max(0, Math.min(1023, Math.round((v * 0.70710678 + 0.5) * 1023)));
  return (enc(c[0]) | (enc(c[1]) << 10) | (enc(c[2]) << 20) | (idx << 30)) >>> 0;
}

/** Inverse of packQuat (smallest-three, 10 bits each). */
export function unpackQuat(v: number, out: number[]): number[] {
  const idx = v >>> 30;
  const dec = (x: number) => ((x & 1023) / 1023 - 0.5) / 0.70710678;
  const c = [dec(v), dec(v >>> 10), dec(v >>> 20)];
  const w = Math.sqrt(Math.max(0, 1 - c[0] * c[0] - c[1] * c[1] - c[2] * c[2]));
  for (let i = 0, j = 0; i < 4; i++) out[i] = i === idx ? w : c[j++];
  return out;
}

function writePoses(out: Uint32Array, built: BuiltScene): void {
  out[0] = fbits(0); out[1] = fbits(-0.5); out[2] = fbits(0); out[3] = packQuat([0, 0, 0, 1]);
  for (let i = 0; i < built.bodies.length; i++) {
    const b = built.bodies[i];
    const o = (i + 1) * 4;
    out[o] = fbits(b.pos[0]); out[o + 1] = fbits(b.pos[1]); out[o + 2] = fbits(b.pos[2]);
    out[o + 3] = packQuat(b.quat);
  }
}

function raySphere(o: THREE.Vector3, d: THREE.Vector3, r: number): number {
  const b = o.dot(d), c = o.dot(o) - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : (-b + Math.sqrt(disc) >= 0 ? 0 : -1);
}

function rayBox(o: THREE.Vector3, d: THREE.Vector3, he: [number, number, number]): number {
  let tmin = -Infinity, tmax = Infinity;
  const oo = [o.x, o.y, o.z], dd = [d.x, d.y, d.z];
  for (let k = 0; k < 3; k++) {
    if (Math.abs(dd[k]) < 1e-12) {
      if (oo[k] < -he[k] || oo[k] > he[k]) return -1;
      continue;
    }
    let t1 = (-he[k] - oo[k]) / dd[k], t2 = (he[k] - oo[k]) / dd[k];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  if (tmax < 0) return -1;
  return Math.max(tmin, 0);
}
