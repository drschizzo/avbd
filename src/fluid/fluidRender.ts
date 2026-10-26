// Screen-space liquid rendering (no meshing):
//   1. particles are drawn as sphere impostors into a depth target (view Z);
//   2. a second pass accumulates their thickness additively;
//   3. view Z is smoothed with a depth-aware (bilateral) filter, so the
//      spheres merge into one continuous surface;
//   4. the composite reconstructs normals from the smoothed depth and shades
//      the liquid: refraction of the scene behind it, Beer-Lambert absorption
//      over the thickness, Fresnel reflection of the studio environment and a
//      sun highlight. A hidden sphere proxy casts the liquid's shadow.
// Particle positions come from the baked fluid history (8 bytes/particle/frame).

import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import type { FluidBuilt } from './fluidBuild';
import type { FluidBakeResult } from '../sim/baker';
import type { SceneDoc } from '../scene/doc';
import { hexToLinear } from '../scene/palettes';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import { studioLights } from '../render/studioLights';
import { releaseAttribute } from '../render/threeInternals';

const TSL: any = TSLTyped;
const {
  Fn, If, Discard, float, vec2, vec3, vec4, uniform, varying, storage, instanceIndex, positionGeometry, positionLocal,
  cameraViewMatrix, cameraProjectionMatrix, cameraProjectionMatrixInverse, cameraWorldMatrix, cameraNear, cameraFar,
  wgslFn, sqrt, dot, exp, max, abs, smoothstep, normalize, cross, reflect, pow, mix, select, screenUV, uv,
  pmremTexture, getViewPosition, viewZToPerspectiveDepth, passTexture, convertToTexture, Loop, uint, clamp,
} = TSL;

export const FLUID_LAYER_SHADOW = 1;

const decode = wgslFn(/* wgsl */`
  fn fluidCenter(ra: vec2u, rb: vec2u, r0: vec2u, anim: vec4f, f: vec4f, l0: vec4f, l1: vec4f, origin: vec3f, ext: vec3f) -> vec4f {
    let pa = origin + vec3f(f32(ra.x & 0xFFFFu), f32(ra.x >> 16u), f32(ra.y & 0xFFFFu)) / 65535.0 * ext;
    let pb = origin + vec3f(f32(rb.x & 0xFFFFu), f32(rb.x >> 16u), f32(rb.y & 0xFFFFu)) / 65535.0 * ext;
    let p0 = origin + vec3f(f32(r0.x & 0xFFFFu), f32(r0.x >> 16u), f32(r0.y & 0xFFFFu)) / 65535.0 * ext;
    let aliveA = (ra.y >> 31u) == 1u;
    let aliveB = (rb.y >> 31u) == 1u;
    if (l1.w > 0.5) {
      // edit mode: initial liquid only
      return vec4f(p0, select(0.0, 1.0, anim.z > 0.5));
    }
    if (f.y < anim.x - 0.001) { return vec4f(0.0); }
    if (!aliveA || !aliveB) {
      if (aliveA && f.x < 0.5) { return vec4f(pa, 1.0); }
      if (aliveB && f.x >= 0.5) { return vec4f(pb, 1.0); }
      return vec4f(0.0);
    }
    var p = mix(pa, pb, f.x);
    var scale = 1.0;
    let mode = u32(l1.x + 0.5);
    let duration = l0.x;
    let outro = max(l0.y, 1e-3);
    let sf = clamp(l0.z, 0.0, 0.95);
    let t = f.z;
    let u = clamp((t - (duration - outro) - anim.y * outro * sf) / (outro * (1.0 - sf)), 0.0, 1.0);
    let intro = max(l1.y, 1e-3);
    let ui = clamp((t - anim.y * intro * sf) / (intro * (1.0 - sf)), 0.0, 1.0);
    let initial = anim.z > 0.5;
    let e = select(4.0 * u * u * u, 1.0 - pow(-2.0 * u + 2.0, 3.0) * 0.5, u >= 0.5);
    if (mode == 0u) {
      if (initial) {
        p = mix(p, p0, e) + vec3f(0.0, sin(3.14159265 * e) * l0.w, 0.0);
      } else {
        scale = 1.0 - e;
      }
    } else if (mode == 1u) {
      scale = (1.0 - e) * select(1.0, smoothstep(0.0, 1.0, ui), initial);
    } else if (mode == 2u) {
      let tail = clamp((t - (duration - 0.3)) / 0.3, 0.0, 1.0);
      scale = (1.0 - tail) * select(1.0, smoothstep(0.0, 1.0, ui), initial);
    }
    return vec4f(p, scale);
  }
`);

const speedOf = wgslFn(/* wgsl */`
  fn fluidSpeed(ra: vec2u, rb: vec2u, f: vec4f) -> f32 {
    let sa = f32((ra.y >> 16u) & 0x7FFFu) / 100.0;
    let sb = f32((rb.y >> 16u) & 0x7FFFu) / 100.0;
    return mix(sa, sb, f.x);
  }
`);

class FluidSmoothNode extends (THREE as any).TempNode {
  static get type() { return 'FluidSmoothNode'; }
  zNode: any;
  rtA: THREE.RenderTarget;
  rtB: THREE.RenderTarget;
  private quad: any;
  private material: any = null;
  private out: any;
  readonly invSize = uniform(new THREE.Vector2(1, 1));
  private dir = uniform(new THREE.Vector2(1, 0));
  readonly pixelsPerUnit = uniform(500);
  readonly worldRadius = uniform(0.06);
  readonly depthFalloff = uniform(0.05);
  iterations = 2;

  constructor(zNode: any, private camera: THREE.PerspectiveCamera) {
    super('vec4');
    this.zNode = zNode;
    const opts = { depthBuffer: false, type: THREE.FloatType } as any;
    this.rtA = new THREE.RenderTarget(1, 1, opts);
    this.rtB = new THREE.RenderTarget(1, 1, opts);
    this.rtA.texture.minFilter = this.rtA.texture.magFilter = THREE.NearestFilter;
    this.rtB.texture.minFilter = this.rtB.texture.magFilter = THREE.NearestFilter;
    this.out = passTexture(this, this.rtB.texture);
    this.updateBeforeType = 'frame';
    this.quad = new (THREE as any).QuadMesh();
  }

  getTextureNode(): any { return this.out; }

  updateBefore(frame: any): void {
    const renderer = frame.renderer;
    const src = this.zNode.value as THREE.Texture;
    const w = Math.max(1, (src.image as any).width), h = Math.max(1, (src.image as any).height);
    if (this.rtA.width !== w || this.rtA.height !== h) { this.rtA.setSize(w, h); this.rtB.setSize(w, h); }
    this.invSize.value.set(1 / w, 1 / h);
    this.pixelsPerUnit.value = this.camera.projectionMatrix.elements[5] * h * 0.5;
    const prevRT = renderer.getRenderTarget();
    this.quad.material = this.material;
    // like GaussianBlurNode: the input node is the pass texture itself (so the
    // pass is part of the graph and renders), its value swapped per iteration
    let cur: THREE.Texture = src;
    for (let it = 0; it < this.iterations; it++) {
      this.zNode.value = cur;
      this.dir.value.set(1, 0);
      renderer.setRenderTarget(this.rtA);
      this.quad.render(renderer);
      this.zNode.value = this.rtA.texture;
      this.dir.value.set(0, 1);
      renderer.setRenderTarget(this.rtB);
      this.quad.render(renderer);
      cur = this.rtB.texture;
    }
    this.zNode.value = src;
    renderer.setRenderTarget(prevRT);
  }

  setup(builder: any): any {
    const input = this.zNode;
    builder.getNodeProperties(this).textureNode = input;
    const filter = Fn(() => {
      const c = uv();
      const z0 = input.sample(c).r.toVar();
      const result = vec4(0).toVar();
      If(z0.lessThan(-1e-4), () => {
        // the kernel spans about one particle radius on screen
        const radiusPx = clamp(this.worldRadius.mul(this.pixelsPerUnit).div(z0.negate()), 1, 48);
        const stepPx = radiusPx.div(9);
        const sum = float(0).toVar(), wsum = float(0).toVar();
        Loop({ start: -9, end: 10, type: 'int', condition: '<' }, ({ i }: any) => {
          const fi = float(i);
          const o = c.add(this.dir.mul(this.invSize).mul(fi.mul(stepPx)));
          const z = input.sample(o).r;
          // narrow-range filter: nearby depths are clamped to a band around
          // the centre instead of being down-weighted, which smooths the
          // particle bumps without eroding silhouettes; true discontinuities
          // (another sheet of liquid far behind or in front) are ignored
          const ws = exp(fi.mul(fi).div(-40));
          const dz = z.sub(z0);
          const keep = z.lessThan(-1e-4).and(abs(dz).lessThan(this.depthFalloff.mul(3)));
          const zc = clamp(z, z0.sub(this.depthFalloff), z0.add(this.depthFalloff));
          const wgt = select(keep, ws, float(0));
          sum.addAssign(zc.mul(wgt));
          wsum.addAssign(wgt);
        });
        result.assign(vec4(sum.div(max(wsum, 1e-5)), 0, 0, 1));
      });
      return result;
    });
    const mat = this.material ?? (this.material = new (THREE as any).NodeMaterial());
    mat.fragmentNode = filter().context(builder.getSharedContext());
    mat.needsUpdate = true;
    return this.out;
  }

  dispose(): void { this.rtA.dispose(); this.rtB.dispose(); }
}

export class FluidRenderer {
  readonly depthScene = new THREE.Scene();
  readonly thickScene = new THREE.Scene();
  readonly shadowRoot = new THREE.Group();
  private built: FluidBuilt | null = null;
  private history: FluidBakeResult | null = null;
  private editAttr: THREE.StorageBufferAttribute | null = null;
  private meshes: THREE.Mesh[] = [];
  private editMode = true;
  private count = 0;
  private generation = 0;

  readonly uBaseA = uniform(0, 'uint');
  readonly uBaseB = uniform(0, 'uint');
  readonly uF = uniform(new THREE.Vector4(0, 0, 0, 0));
  readonly uL0 = uniform(new THREE.Vector4(10, 2, 0.5, 0.5));
  readonly uL1 = uniform(new THREE.Vector4(0, 0.6, 60, 1));
  readonly uOrigin = uniform(new THREE.Vector3());
  readonly uExt = uniform(new THREE.Vector3(1, 1, 1));
  readonly uRadius = uniform(0.03);
  /** spheres overlap: scales summed chords back to a path length through liquid */
  readonly uThickScale = uniform(1);
  // look
  readonly uColor = uniform(new THREE.Color(0x1b8fd6));
  readonly uClarity = uniform(0.6);
  readonly uRefraction = uniform(0.6);
  readonly uSunDir = uniform(new THREE.Vector3(0, 1, 0));
  readonly uSunColor = uniform(new THREE.Color(1, 1, 1));
  readonly uEnvIntensity = uniform(1);
  readonly uFoam = uniform(0.5);
  /** speed (m/s) above which liquid turns to foam */
  readonly uFoamSpeed = uniform(2.5);
  smoothing = 0.6;
  debug: any = null;

  constructor(private renderer: THREE.WebGPURenderer) {
    this.shadowRoot.name = 'fluid-shadow';
  }

  get active(): boolean { return this.built !== null; }

  setScene(built: FluidBuilt | null, doc: SceneDoc): void {
    const sameLayout = built && this.built && built.count === this.count;
    this.built = built;
    this.applyLook(doc);
    if (!built) { this.clear(); this.count = 0; return; }
    this.uOrigin.value.set(...built.origin);
    this.uExt.value.set(built.dims[0] * built.h, built.dims[1] * built.h, built.dims[2] * built.h);
    const r = built.spacing * 1.3;
    this.uRadius.value = r;
    this.uThickScale.value = (built.spacing ** 3) / ((4 / 3) * Math.PI * r ** 3);
    // edit poses: frame 0 encoded like the history
    const data = new Uint32Array(built.count * 2);
    for (let i = 0; i < built.count; i++) {
      const q = (k: number) => Math.round(Math.min(1, Math.max(0, (built.pos[i * 4 + k] - built.origin[k]) / (built.dims[k] * built.h))) * 65535);
      data[i * 2] = q(0) | (q(1) << 16);
      data[i * 2 + 1] = (q(2) | ((i < built.initialCount ? 1 : 0) << 31)) >>> 0;
    }
    if (this.editAttr) releaseAttribute(this.renderer, this.editAttr);
    this.editAttr = new THREE.StorageBufferAttribute(data, 2);
    if (!sameLayout || this.meshes.length === 0) this.count = built.count;
    this.rebuild();
  }

  setHistory(h: FluidBakeResult | null): void {
    if (this.history === h) return;
    this.history = h;
    if (this.built) this.rebuild();
  }

  setEditMode(edit: boolean): void {
    this.editMode = edit;
    this.uL1.value.w = edit ? 1 : 0;
  }

  setLoop(doc: SceneDoc): void {
    // continuous loops re-match rigid bodies only; the liquid reassembles
    const modes = ['reassemble', 'shrink', 'sink', 'boomerang', 'none', 'reassemble'];
    this.uL0.value.set(doc.duration, doc.loop.outro, doc.loop.stagger, doc.loop.arc);
    this.uL1.value.set(Math.max(0, modes.indexOf(doc.loop.mode === 'continuous' ? 'reassemble' : doc.loop.mode)), doc.loop.intro, doc.fps, this.editMode ? 1 : 0);
  }

  applyLook(doc: SceneDoc): void {
    const f = doc.fluid;
    const c = hexToLinear(f.color || '#1b8fd6');
    this.uColor.value.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
    this.uClarity.value = Math.max(0.02, f.clarity);
    this.uRefraction.value = f.refraction;
    this.smoothing = f.smoothing;
    this.uFoam.value = f.foam;
    this.uFoamSpeed.value = 1.6 + (1 - f.foam) * 3;
  }

  setPlayback(p: { simFrame: number; time: number }): void {
    const h = this.history;
    if (this.editMode || !h || !this.built) {
      this.uBaseA.value = 0; this.uBaseB.value = 0;
      this.uF.value.set(0, this.editMode ? 1e9 : p.simFrame, p.time, 0);
      return;
    }
    const fr = Math.min(p.simFrame / h.recordEvery, h.frames - 1);
    const a = Math.max(0, Math.floor(fr)), b = Math.min(a + 1, h.frames - 1);
    this.uBaseA.value = a * h.count;
    this.uBaseB.value = b * h.count;
    this.uF.value.set(fr - a, p.simFrame, p.time, 0);
  }

  /** Builds the screen-space surface nodes for the post pipeline. */
  composite(baseColor: any, sceneColor: any, glassTex: any, sceneViewZ: any, sceneDepth: any, camera: THREE.PerspectiveCamera, scene: THREE.Scene): any {
    const depthPass = TSL.pass(this.depthScene, camera, { samples: 0 });
    depthPass.getTexture('output').type = THREE.FloatType;
    const thickPass = TSL.pass(this.thickScene, camera, { samples: 0 });
    // thickness drives the tint and the foam mask; it is noisy per particle,
    // so it is accumulated at half size and blurred generously - the detail
    // that matters (the surface shape) comes from the depth pass instead
    thickPass.setResolutionScale(0.5);
    const zTex = depthPass.getTextureNode('output');
    const smooth = new FluidSmoothNode(convertToTexture(zTex), camera);
    // Kernel width: wide enough to erase the sphere bumps, narrow enough that
    // waves and the crest of a splash survive as shape rather than as jelly.
    smooth.worldRadius.value = this.uRadius.value * (1.4 + this.smoothing * 2.6);
    // the clamp band is what flattens the sphere bumps: keeping it near one
    // particle radius removes the lumps while a true step (another sheet of
    // liquid) still falls outside the band and keeps its silhouette
    smooth.depthFalloff.value = this.uRadius.value * 0.9;
    smooth.iterations = this.smoothing > 0.5 ? 3 : 2;
    const zs = smooth.getTextureNode();
    this.debug = { depthPass, thickPass, smooth };
    // thickness (r) and foam (g) vary with the particle arrangement: blur them
    const thick = (gaussianBlur(thickPass.getTextureNode('output'), null, 5) as any).getTextureNode();
    const env = scene.environment;

    // scenery behind the liquid without the glass panes: the scene colour is
    // glass + (1 - glass.a) * scenery (premultiplied), so it can be undone
    const scenery = (u: any) => {
      const g = glassTex.sample(u);
      return sceneColor.sample(u).rgb.sub(g.rgb).div(max(float(1).sub(g.a), 0.08));
    };

    return Fn(() => {
      const base = vec4(baseColor).toVar();
      const c = screenUV;
      const z = zs.sample(c).r;
      const sz = sceneViewZ;
      const out = base.toVar();
      If(z.lessThan(-1e-4).and(z.greaterThan(sz.sub(this.uRadius.mul(0.5)))), () => {
        const P = (q: any, zz: any) => getViewPosition(q, viewZToPerspectiveDepth(zz, cameraNear, cameraFar), cameraProjectionMatrixInverse);
        const p0 = P(c, z);
        const tx = vec2(smooth.invSize.x, 0), ty = vec2(0, smooth.invSize.y);
        const zr = zs.sample(c.add(tx)).r, zl = zs.sample(c.sub(tx)).r;
        const zu = zs.sample(c.add(ty)).r, zd = zs.sample(c.sub(ty)).r;
        const useR = abs(zr.sub(z)).lessThan(abs(z.sub(zl))).and(zr.lessThan(-1e-4));
        const useU = abs(zu.sub(z)).lessThan(abs(z.sub(zd))).and(zu.lessThan(-1e-4));
        const ddx = select(useR, P(c.add(tx), zr).sub(p0), p0.sub(P(c.sub(tx), zl)));
        const ddy = select(useU, P(c.add(ty), zu).sub(p0), p0.sub(P(c.sub(ty), zd)));
        const nv = normalize(cross(ddx, ddy)).toVar();
        If(nv.z.lessThan(0), () => { nv.assign(nv.negate()); });
        const tf = thick.sample(c);
        const t = max(tf.r, 0);
        const foamAmt = clamp(tf.g.div(max(t, 1e-4)), 0, 1).mul(smoothstep(0.0, this.uRadius, t)).mul(this.uFoam);

        // Refraction with a touch of dispersion (red bends least). The offset
        // is rejected where it would sample something standing in FRONT of the
        // surface: without that test the liquid smears whatever is between it
        // and the camera over its own silhouette (the classic refraction halo).
        const off = nv.xy.mul(vec2(1, -1)).mul(this.uRefraction.mul(0.05)).mul(clamp(t, 0, 0.8).add(0.15)).toVar();
        const probe = c.sub(off);
        const zProbe = TSL.perspectiveDepthToViewZ(sceneDepth.sample(probe).r, cameraNear, cameraFar);
        If(zProbe.greaterThan(z.add(this.uRadius)), () => { off.assign(vec2(0)); });
        const behind = vec3(
          scenery(c.sub(off.mul(0.94))).r,
          scenery(c.sub(off)).g,
          scenery(c.sub(off.mul(1.07))).b,
        );
        // Beer-Lambert with the user colour as the transmittance after
        // `clarity` metres: thin water is clear, deep water takes the tint
        const col = max(vec3(this.uColor), vec3(0.002));
        const k = TSL.log(col).negate().div(this.uClarity);
        const T = exp(k.mul(t).negate());
        const ambient = this.uEnvIntensity.mul(0.5).add(0.25);
        // Volumetric in-scattering: most of what makes water read as water
        // rather than tinted glass. It saturates with depth like the
        // absorption it complements, so shallows stay clear.
        const inscatter = col.mul(0.26).mul(ambient).mul(vec3(1).sub(T));
        const transmitted = behind.mul(T).add(inscatter);

        // world space reflection
        const nW = normalize(cameraWorldMatrix.mul(vec4(nv, 0)).xyz);
        const vW = normalize(cameraWorldMatrix.mul(vec4(normalize(p0), 0)).xyz);
        const r = reflect(vW, nW);
        const cosT = clamp(dot(nW, vW.negate()), 0, 1);
        // The screen-space normal swings wildly on a one-particle-thin rim, so
        // a raw Fresnel turns every silhouette into a bright halo. Fading the
        // grazing term in with thickness keeps the rim as liquid, not neon.
        const thin = smoothstep(0.0, this.uRadius.mul(2.5), t);
        const fres = float(0.02).add(float(0.98).mul(pow(float(1).sub(cosT), 5)).mul(thin));
        // foam is a rough, scattering surface: it blurs the reflection too
        const rough = float(0.02).add(foamAmt.mul(0.35));
        const envRefl = env ? pmremTexture(env, r, rough).rgb.mul(this.uEnvIntensity) : vec3(0.6);
        // (the studio environment now carries a pale lower hemisphere, so
        // downward reflections no longer need to be dimmed by hand)
        const refl = envRefl.add(studioLights(r).mul(this.uEnvIntensity.add(0.35)));
        // GGX sun highlight (roughness ~0.08): small, intense, energy-correct
        const L = this.uSunDir;
        const H = normalize(L.sub(vW));
        const nh = clamp(dot(nW, H), 0, 1);
        // A mirror-sharp lobe only ever lights a couple of pixels: widening it
        // to roughness ~0.14 is what lets ripples and wave crests catch the sun.
        const a2 = max(rough.mul(rough), float(0.02));
        const dd = nh.mul(nh).mul(a2.sub(1)).add(1);
        const D = a2.div(dd.mul(dd).mul(3.14159));
        const spec = D.mul(fres).mul(clamp(dot(nW, L), 0, 1)).mul(vec3(this.uSunColor)).mul(1.1);
        // Whitewater is bubbles scattering light inside the liquid, not white
        // paint on top of it: it replaces what is transmitted and keeps its own
        // Fresnel reflection, which is what stops it reading as plastic.
        const foamCol = vec3(0.92, 0.96, 1.0).mul(ambient.add(0.35));
        const body = mix(transmitted, foamCol, foamAmt.mul(0.9));
        const water = mix(body, refl, fres).add(spec).toVar();
        // the glass in front of the liquid goes back on top
        const g = glassTex.sample(c);
        const final = g.rgb.add(water.mul(float(1).sub(g.a)));
        const edge = smoothstep(0.0, this.uRadius.mul(0.35), t);
        out.assign(vec4(mix(base.rgb, final, edge), base.a));
      });
      return out;
    })();
  }

  dispose(): void { this.clear(); }

  // ---------------------------------------------------------------------------

  private clear(): void {
    for (const m of this.meshes) { m.removeFromParent(); m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    this.meshes = [];
  }

  private rebuild(): void {
    this.clear();
    const b = this.built;
    if (!b || !this.editAttr) return;
    // new buffers => new program key, or three.js reuses the old bindings
    const gen = ++this.generation;
    const keyed = (m: any) => { const k = m.customProgramCacheKey.bind(m); m.customProgramCacheKey = () => `${k()}|fluid${gen}`; return m; };
    const n = b.count;
    const hist = this.history ? storage(this.history.history, 'uvec2', this.history.frames * this.history.count).toReadOnly()
      : storage(this.editAttr, 'uvec2', n).toReadOnly();
    const edit = storage(this.editAttr, 'uvec2', n).toReadOnly();
    const animAttr = new THREE.InstancedBufferAttribute(b.anim, 4);
    const idx = uint(instanceIndex);
    const ra = hist.element(this.uBaseA.add(idx));
    const rb = hist.element(this.uBaseB.add(idx));
    const r0 = this.history ? hist.element(idx) : edit.element(idx);
    const anim = TSL.instancedBufferAttribute(animAttr);
    const center = decode({ ra, rb, r0, anim, f: this.uF, l0: this.uL0, l1: this.uL1, origin: this.uOrigin, ext: this.uExt });
    const speed = speedOf({ ra, rb, f: this.uF });

    const quad = () => {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      g.setAttribute('aAnim', animAttr);
      g.instanceCount = n;
      return g;
    };
    const impostor = (thickness: boolean) => {
      const m = new (THREE as any).MeshBasicNodeMaterial();
      const vc = cameraViewMatrix.mul(vec4(center.xyz, 1)).xyz;
      const rad = this.uRadius.mul(center.w).mul(thickness ? 1.0 : 1.0);
      const corner = positionGeometry.xy;
      m.vertexNode = cameraProjectionMatrix.mul(vec4(vc.add(vec3(corner.mul(rad), 0)), 1));
      const vC = varying(vc), vR = varying(rad), vUV = varying(corner);
      const sphere = Fn(() => {
        const r2 = dot(vUV, vUV);
        If(r2.greaterThan(1).or(vR.lessThan(1e-5)), () => { Discard(); });
        return sqrt(float(1).sub(r2));
      });
      if (thickness) {
        m.transparent = true;
        m.blending = THREE.AdditiveBlending;
        m.depthWrite = false;
        m.depthTest = false;
        const vFoam = varying(smoothstep(this.uFoamSpeed, this.uFoamSpeed.add(2), speed));
        m.outputNode = Fn(() => {
          const th = sphere().mul(vR).mul(2).mul(this.uThickScale);
          return vec4(th, th.mul(vFoam), 0, 1);
        })();
      } else {
        m.outputNode = Fn(() => {
          const nz = sphere();
          const pv = vC.add(vec3(vUV.mul(vR), nz.mul(vR)));
          return vec4(pv.z, 0, 0, 1);
        })();
        m.depthNode = Fn(() => {
          const nz = sphere();
          const pv = vC.add(vec3(vUV.mul(vR), nz.mul(vR)));
          const clip = cameraProjectionMatrix.mul(vec4(pv, 1));
          return clip.z.div(clip.w);
        })();
      }
      const mesh = new THREE.Mesh(quad(), keyed(m));
      mesh.frustumCulled = false;
      return mesh;
    };
    const dm = impostor(false), tm = impostor(true);
    this.depthScene.add(dm);
    this.thickScene.add(tm);
    // shadow caster: low-poly spheres on the shadow layer only
    const sg = new THREE.InstancedBufferGeometry();
    sg.copy(new THREE.IcosahedronGeometry(1, 1) as any);
    sg.setAttribute('aAnim', animAttr);
    sg.instanceCount = n;
    const sm = new (THREE as any).MeshBasicNodeMaterial();
    sm.positionNode = center.xyz.add(positionLocal.mul(this.uRadius.mul(center.w).mul(1.25)));
    const shadow = new THREE.Mesh(sg, keyed(sm));
    shadow.castShadow = true;
    shadow.receiveShadow = false;
    shadow.frustumCulled = false;
    shadow.layers.set(FLUID_LAYER_SHADOW);
    this.shadowRoot.add(shadow);
    this.meshes = [dm, tm, shadow];
  }
}
