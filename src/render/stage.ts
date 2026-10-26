// Renderer, studio lighting, floor and post-processing pipeline.

import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
// TSL typings are too strict for this generated-shader code; use it untyped.
const TSL: any = TSLTyped;
const {
  abs, clamp, color, colorToDirection, directionToColor, float, fract, hash, length, max, mix, mrt, normalView,
  output, pass, positionWorld, renderOutput, sample, screenUV, smoothstep, uniform, vec2, vec3, vec4, Fn, time, uv,
} = TSL;
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { createStudioScene } from './studioEnv';
import { REQUESTED_MAX_STORAGE_BUFFERS_PER_SHADER_STAGE } from '../engine/gpuLimits';
import type { SceneDoc } from '../scene/doc';
import { PALETTES, hexToLinear } from '../scene/palettes';
import { FLUID_LAYER_SHADOW, type FluidRenderer } from '../fluid/fluidRender';

export async function createDevice(): Promise<GPUDevice> {
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter found.');
  const requiredFeatures: GPUFeatureName[] = [];
  if (adapter.features.has('timestamp-query')) requiredFeatures.push('timestamp-query');
  if (adapter.features.has('subgroups' as GPUFeatureName)) requiredFeatures.push('subgroups' as GPUFeatureName);
  if (adapter.features.has('float32-filterable')) requiredFeatures.push('float32-filterable');
  const storageBuffers = Math.min(REQUESTED_MAX_STORAGE_BUFFERS_PER_SHADER_STAGE, adapter.limits.maxStorageBuffersPerShaderStage);
  if (storageBuffers < REQUESTED_MAX_STORAGE_BUFFERS_PER_SHADER_STAGE) {
    throw new Error(`This GPU exposes only ${adapter.limits.maxStorageBuffersPerShaderStage} storage buffers per stage (needs ${REQUESTED_MAX_STORAGE_BUFFERS_PER_SHADER_STAGE}).`);
  }
  return adapter.requestDevice({
    requiredFeatures,
    requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxStorageBuffersPerShaderStage: storageBuffers,
    },
  });
}

export class Stage {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(35, 1, 0.05, 400);
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly fill = new THREE.HemisphereLight(0xffffff, 0x888888, 0.35);
  private floor: THREE.Mesh;
  private floorMat: THREE.MeshStandardNodeMaterial;
  private pipeline!: THREE.RenderPipeline;
  private pipelineKey = '';
  private envTex: THREE.Texture | null = null;
  /** Set by the app so the body renderer can reflect the same studio. */
  get environmentTexture(): THREE.Texture | null { return this.envTex; }

  // shared uniforms
  readonly uBg = uniform(new THREE.Color(0xf3e9e1));
  readonly uFloor = uniform(new THREE.Color(0xefe3d9));
  readonly uGrid = uniform(0);
  readonly uFadeNear = uniform(8);
  readonly uFadeFar = uniform(30);
  readonly uVignette = uniform(0.3);
  readonly uGrain = uniform(0.04);
  readonly uBloom = uniform(0.15);
  readonly uBloomThreshold = uniform(0.85);
  readonly uAo = uniform(1);
  readonly uFocus = uniform(10);
  readonly uDof = uniform(0);
  readonly uFrameSeed = uniform(0);
  private bloomNode: any = null;
  private aoNode: any = null;

  supersample = 1;
  /** Liquid surface, composited after the scene pass when the scene has water. */
  fluid: FluidRenderer | null = null;

  constructor(readonly canvas: HTMLCanvasElement, device: GPUDevice) {
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: false, device, alpha: false } as any);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;

    this.scene.background = new THREE.Color(0xf3e9e1);
    this.scene.backgroundNode = this.backgroundColor();

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = 6;
    (this.sun.shadow as any).blurSamples = 16;
    this.sun.shadow.camera.layers.enable(FLUID_LAYER_SHADOW);
    this.scene.add(this.sun, this.sun.target, this.fill);

    // Infinite studio floor: lit near the scene, dissolving into the background.
    this.floorMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
    const gridLine = Fn(() => {
      const p = positionWorld.xz;
      const g1 = abs(fract(p.mul(1.0).sub(0.5)).sub(0.5)).div(vec2(0.012));
      const g2 = abs(fract(p.mul(0.25).sub(0.5)).sub(0.5)).div(vec2(0.008));
      const l1 = float(1).sub(clamp(g1.x.min(g1.y), 0, 1));
      const l2 = float(1).sub(clamp(g2.x.min(g2.y), 0, 1));
      return max(l1.mul(0.35), l2.mul(0.6)).mul(this.uGrid);
    })();
    this.floorMat.colorNode = mix(vec3(this.uFloor), vec3(this.uFloor).mul(0.82), gridLine);
    const fade = smoothstep(this.uFadeNear, this.uFadeFar, length(positionWorld.xz));
    this.floorMat.outputNode = mix(output, vec4(this.backgroundColor(), 1), fade);
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(220, 96).rotateX(-Math.PI / 2), this.floorMat);
    this.floor.receiveShadow = true;
    this.floor.renderOrder = -1;
    this.scene.add(this.floor);

    this.camera.position.set(9, 6, 11);
  }

  /** Soft vertical studio gradient shared by the backdrop and the floor fade. */
  private backgroundColor(): any {
    const bg = vec3(this.uBg);
    const k = smoothstep(0.0, 1.0, screenUV.y);
    const d = length(screenUV.sub(vec2(0.5, 0.35)));
    return mix(bg.mul(1.04), bg.mul(0.9), k).mul(float(1).sub(d.mul(0.08)));
  }

  async init(): Promise<void> {
    await this.renderer.init();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTex = pmrem.fromScene(createStudioScene(), 0.02).texture;
    this.scene.environment = this.envTex;
    pmrem.dispose();
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Applies render settings; rebuilds the post pipeline only when its structure changes. */
  applyRender(doc: SceneDoc, bounds: { min: number[]; max: number[] }): void {
    const r = doc.render;
    const pal = PALETTES[r.palette] ?? PALETTES.sorbet;
    const bgHex = r.background || pal.background;
    const floorHex = r.floorColor || pal.floor;
    const bg = hexToLinear(bgHex);
    (this.scene.background as THREE.Color).setRGB(bg[0], bg[1], bg[2], THREE.LinearSRGBColorSpace);
    this.uBg.value.setRGB(bg[0], bg[1], bg[2], THREE.LinearSRGBColorSpace);
    const fl = hexToLinear(floorHex);
    this.uFloor.value.setRGB(fl[0], fl[1], fl[2], THREE.LinearSRGBColorSpace);
    this.uGrid.value = r.floor === 'grid' ? 1 : 0;
    this.floor.visible = r.floor !== 'none';
    this.floorMat.roughness = r.floor === 'mirror' ? 0.12 : 0.9;
    this.floorMat.metalness = 0;

    this.renderer.toneMappingExposure = r.exposure;
    this.scene.environmentIntensity = r.envIntensity;
    this.fill.intensity = r.envIntensity * 0.25;

    // Sun placement and shadow frustum fitted to the scene bounds.
    const cx = (bounds.min[0] + bounds.max[0]) / 2, cz = (bounds.min[2] + bounds.max[2]) / 2;
    const ext = Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2], bounds.max[1] - bounds.min[1], 4);
    const radius = ext * 0.85 + 2;
    const az = r.lightAzimuth * Math.PI / 180, el = r.lightElevation * Math.PI / 180;
    const dist = radius * 3;
    this.sun.position.set(cx + Math.cos(el) * Math.sin(az) * dist, Math.sin(el) * dist, cz + Math.cos(el) * Math.cos(az) * dist);
    this.sun.target.position.set(cx, 0, cz);
    this.sun.intensity = r.lightIntensity;
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -radius; sc.right = radius; sc.top = radius; sc.bottom = -radius;
    sc.near = 0.1; sc.far = dist + radius * 2;
    sc.updateProjectionMatrix();
    this.sun.shadow.radius = 1 + r.shadowSoftness * 14;
    this.sun.shadow.needsUpdate = true;

    this.uFadeNear.value = Math.max(6, ext * 1.4);
    this.uFadeFar.value = Math.max(22, ext * 4.5);

    this.uVignette.value = r.vignette;
    this.uGrain.value = r.grain;
    this.uBloom.value = r.bloom;
    this.uBloomThreshold.value = r.bloomThreshold;
    this.uAo.value = r.ao;
    this.uDof.value = r.dof;
    if (this.bloomNode) {
      this.bloomNode.strength.value = r.bloom;
      this.bloomNode.threshold.value = r.bloomThreshold;
    }
    if (this.aoNode) this.aoNode.radius.value = 0.35 + 0.3 * Math.min(1, ext / 12);

    if (this.fluid) {
      this.fluid.uSunDir.value.copy(this.sun.position).sub(this.sun.target.position).normalize();
      this.fluid.uSunColor.value.setRGB(r.lightIntensity / 3.6, r.lightIntensity / 3.6, r.lightIntensity / 3.6);
      this.fluid.uEnvIntensity.value = r.envIntensity;
    }
    const key = this.pipelineKeyOf(doc);
    if (key !== this.pipelineKey) this.buildPipeline(doc);
  }

  setFocus(distance: number): void { this.uFocus.value = distance; }

  private pipelineKeyOf(doc: SceneDoc): string {
    const r = doc.render;
    const f = this.fluid?.active ? `fluid${doc.fluid.smoothing}` : '';
    return [r.aa, r.ao > 0, r.bloom > 0, r.dof > 0, f].join('|');
  }

  private buildPipeline(doc: SceneDoc): void {
    const r = doc.render;
    this.pipelineKey = this.pipelineKeyOf(doc);
    this.pipeline?.dispose();
    const pipeline = new THREE.RenderPipeline(this.renderer);
    const scenePass = pass(this.scene, this.camera, { samples: r.aa === 'none' ? 0 : 4 } as any);
    // 'glass' holds only the transparent panes (premultiplied, blended like
    // the material); opaque surfaces write 0 there
    const sceneMRT = mrt({ output, normal: directionToColor(normalView), glass: vec4(0) });
    sceneMRT.setBlendMode('glass', sceneMRT.getBlendMode('output'));
    // The normal G-buffer must follow each material's own blending too: the
    // per-target blend state is read from THIS mrt, not from a material's, so
    // without this line every transparent surface replaces the normal of what
    // is behind it while the depth buffer keeps that object's depth. GTAO then
    // shades from a mismatched pair and stamps its sampling pattern on the
    // glass. Opaque materials do not blend, so they still write normally;
    // transparent ones write zero (see bodies.ts) and leave the target alone.
    sceneMRT.setBlendMode('normal', sceneMRT.getBlendMode('output'));
    scenePass.setMRT(sceneMRT);
    // 8-bit scene colour quantises the pale studio gradient: the steps are
    // invisible on the backdrop but the tone curve is much steeper where glass
    // darkens it, turning them into a visible hatched lattice on the panes.
    scenePass.getTexture('output').type = THREE.HalfFloatType;
    const colorTex = scenePass.getTextureNode('output');
    const depthTex = scenePass.getTextureNode('depth');
    const normalTex = scenePass.getTextureNode('normal');
    const nt = scenePass.getTexture('normal');
    nt.type = THREE.UnsignedByteType;

    let node: any = colorTex;
    this.aoNode = null;
    if (r.ao > 0) {
      const sceneNormal = sample((u: any) => colorToDirection(normalTex.sample(u)));
      const aoPass: any = ao(depthTex, sceneNormal, this.camera);
      aoPass.resolutionScale = 0.5;
      aoPass.samples.value = 16;
      aoPass.distanceExponent.value = 1.4;
      aoPass.thickness.value = 0.6;
      this.aoNode = aoPass;
      const aoValue = aoPass.getTextureNode().sample(screenUV).r;
      node = vec4(colorTex.rgb.mul(mix(float(1), aoValue, clamp(this.uAo, 0, 1))), colorTex.a);
    }
    if (this.fluid?.active) {
      node = this.fluid.composite(node, colorTex, scenePass.getTextureNode('glass'), scenePass.getViewZNode(), depthTex, this.camera, this.scene);
    }
    if (r.dof > 0) {
      const viewZ = scenePass.getViewZNode();
      node = dof(node, viewZ, this.uFocus, this.uDof.mul(18).add(2), this.uDof.mul(1.6));
    }
    if (r.bloom > 0) {
      const b: any = bloom(node, r.bloom, 0.45, r.bloomThreshold);
      this.bloomNode = b;
      node = node.add(b);
    } else {
      this.bloomNode = null;
    }

    // Vignette + film grain, then tone mapping/sRGB via renderOutput.
    const graded = Fn(() => {
      const c = vec4(node).toVar();
      const d = length(uv().sub(0.5).mul(vec2(1.1, 1)));
      const vig = float(1).sub(smoothstep(0.35, 0.95, d).mul(this.uVignette));
      const g = hash(uv().mul(vec2(1931.7, 1213.3)).add(this.uFrameSeed.mul(17.13)).add(time.mul(0)))
        .sub(0.5).mul(this.uGrain);
      return vec4(c.rgb.mul(vig).add(g.mul(c.rgb.add(0.05))), 1);
    })();
    let out: any = renderOutput(graded);
    pipeline.outputColorTransform = false;
    if (r.aa === 'smaa') out = smaa(out);
    else if (r.aa === 'fxaa') out = fxaa(out);
    pipeline.outputNode = out;
    this.pipeline = pipeline;
  }

  render(): void {
    this.uFrameSeed.value = (this.uFrameSeed.value + 1) % 1000;
    this.pipeline.render();
  }

  /**
   * Renders the post pipeline outside the animation loop (offscreen capture).
   * Pass nodes re-render once per node frame, and three.js only advances the
   * frame id from its requestAnimationFrame loop: without this bump, two
   * captures between ticks (or any capture in a hidden tab) reuse the previous
   * image, which duplicated frames in exports.
   */
  renderOffscreen(): void {
    (this.renderer as any)._nodes?.nodeFrame?.update();
    this.pipeline.render();
  }

  async renderAsync(): Promise<void> {
    this.uFrameSeed.value = (this.uFrameSeed.value + 1) % 1000;
    await (this.pipeline as any).renderAsync?.() ?? this.pipeline.render();
  }

  get floorMesh(): THREE.Mesh { return this.floor; }
}

export { color };
