// Bakes a scene: runs the GPU AVBD engine at a fixed step and records every
// frame into a compact GPU-resident history buffer (16 bytes per body/frame:
// float32 position + "smallest three" 10:10:10:2 quaternion). Playback and
// export read the history directly in the vertex shader: zero readback.

import { StorageBufferAttribute } from 'three/webgpu';
import { PhysicsEngine } from '../engine/physics/PhysicsEngine';
import { localId, storage, uniform, wgsl, wgslFn, workgroupId } from '../engine/physics/gpu/tslCompat';
import type { BuiltScene } from '../scene/build';
import { KIND_DYNAMIC, KIND_KINEMATIC } from '../scene/build';
import type { SceneDoc } from '../scene/doc';
import { angularVelocity, composePose, evalMotion, type Q4, type V3 } from './motion';
import { ComputeBatcher } from './batchedCompute';
import { FluidSolver } from '../fluid/fluidSolver';
import { QUAT_PACK_WGSL, writeRestPoses } from './poseCodec';
import { planFluidHistory, planHistory } from './bakePlan';
import { adoptGpuBuffer, releaseAttribute } from '../render/threeInternals';

export interface FluidBakeResult {
  history: StorageBufferAttribute; // vec2u per particle per recorded frame
  count: number; // particles per recorded frame
  frames: number;
  recordEvery: number;
}

export interface BakeResult {
  history: StorageBufferAttribute;
  stride: number; // bodies per recorded frame (engine body count incl. ground)
  frames: number; // recorded frames
  recordEvery: number;
  simFrames: number;
  fps: number;
  fluid: FluidBakeResult | null;
  /**
   * Continuous loops: the last recorded frames of the warm-up pass, stored
   * after the main frames. Recorded frame `start + i` of the warm-up lives in
   * slot `base + i`; the warm-up's last frame is the main pass's frame 0.
   */
  tail: { start: number; base: number; count: number } | null;
}

export interface BakeProgress {
  frame: number;
  total: number;
  recorded: number; // frames available for playback
  msPerFrame: number;
}

const WORKGROUP = 256;
/** Paced slices the GPU queue may hold (bounds the preview's latency). */
const SLICES_IN_FLIGHT = 2;
/** CPU encode budget of one paced slice (ms). */
const SLICE_CPU_MS = 6;

// Macrotask yield that is not subject to background timer throttling.
const channel = new MessageChannel();
const waiters: (() => void)[] = [];
channel.port1.onmessage = () => { waiters.shift()?.(); };
function yieldTask(): Promise<void> {
  return new Promise((r) => { waiters.push(r); channel.port2.postMessage(0); });
}
export const RECORD_WGSL = /* wgsl */`
  fn compute(
    positions: ptr<storage, array<vec4f>, read>,
    quaternions: ptr<storage, array<vec4f>, read>,
    history: ptr<storage, array<vec4u>, read_write>,
    frameBase: u32,
    bodyCount: u32,
    workgroupId: vec3u,
    localId: vec3u,
  ) -> void {
    let gid = workgroupId.x * ${WORKGROUP}u + localId.x;
    if (gid >= bodyCount) { return; }
    let p = positions[gid].xyz;
    let packed = hxPackQuat(quaternions[gid]);
    history[frameBase + gid] = vec4u(bitcast<u32>(p.x), bitcast<u32>(p.y), bitcast<u32>(p.z), packed);
  }
`;

// Sets dynamic body velocities: zero (mode 0) or the values from initVel (mode 1).
const VELOCITY_WGSL = /* wgsl */`
  fn compute(
    positions: ptr<storage, array<vec4f>, read>,
    velocities: ptr<storage, array<vec4f>, read_write>,
    prevLinearVelocities: ptr<storage, array<vec4f>, read_write>,
    angularVelocities: ptr<storage, array<vec4f>, read_write>,
    initVel: ptr<storage, array<vec4f>, read>,
    mode: u32,
    bodyCount: u32,
    workgroupId: vec3u,
    localId: vec3u,
  ) -> void {
    let gid = workgroupId.x * ${WORKGROUP}u + localId.x;
    if (gid >= bodyCount) { return; }
    if (positions[gid].w == 0.0) {
      if (mode == 0u) { velocities[gid] = vec4f(0.0); angularVelocities[gid] = vec4f(0.0); }
      return;
    }
    var v = vec4f(0.0);
    var w = vec4f(0.0);
    if (mode == 1u) { v = initVel[gid * 2u]; w = initVel[gid * 2u + 1u]; }
    velocities[gid] = v;
    prevLinearVelocities[gid] = v;
    angularVelocities[gid] = w;
  }
`;

export class Baker {
  engine: PhysicsEngine | null = null;
  private capacity = 0;
  private recordKernel: any = null;
  private velocityKernel: any = null;
  private velocityKernelEngine: PhysicsEngine | null = null;
  private initVelAttr: StorageBufferAttribute | null = null;
  private recordKernelHistory: StorageBufferAttribute | null = null;
  private result: BakeResult | null = null;
  /** Result being filled by the bake in progress (frames grow while baking). */
  currentPartial: BakeResult | null = null;
  private token = 0;
  lastStats = { bodies: 0, joints: 0, msPerFrame: 0, totalMs: 0 };

  readonly batcher: ComputeBatcher;
  batching = true;
  fluid: FluidSolver | null = null;

  // ---- display pacing
  // While the page is visible the bake is cut into slices, one per displayed
  // frame, so the streamed preview stays fluid: a slice is submitted right
  // after the frame's render, and the next one waits for the following frame
  // with at most SLICES_IN_FLIGHT slices queued on the GPU. The slice size
  // adapts (AIMD) so rendered frames stay at ~60 fps: when the GPU is the
  // bottleneck, bigger slices do not bake faster, they only drop frames.
  /** Set by the app when it renders a preview and calls onDisplayFrame(). */
  paced = false;
  /** Steps per slice (adaptive). */
  sliceSteps = 2;
  private frameWaiters: ((interval: number) => void)[] = [];
  private frameIntervals: number[] = [];
  private lastDisplayFrame = 0;

  constructor(private renderer: any, private device: GPUDevice) {
    this.batcher = new ComputeBatcher(device, renderer.backend);
  }

  get current(): BakeResult | null { return this.result; }

  cancel(): void { this.token++; }

  /** Called by the app once per displayed frame, before rendering. */
  onDisplayFrame(now = performance.now()): void {
    const interval = this.lastDisplayFrame > 0 ? now - this.lastDisplayFrame : 1000 / 60;
    this.lastDisplayFrame = now;
    this.frameIntervals.push(interval);
    if (this.frameIntervals.length > 60) this.frameIntervals.shift();
    const waiters = this.frameWaiters;
    this.frameWaiters = [];
    for (const w of waiters) w(interval);
  }

  private nextDisplayFrame(): Promise<number> {
    return new Promise((resolve) => {
      this.frameWaiters.push(resolve);
      // rAF can stop without the page being hidden (occluded window): never stall.
      setTimeout(() => {
        const i = this.frameWaiters.indexOf(resolve);
        if (i >= 0) { this.frameWaiters.splice(i, 1); resolve(250); }
      }, 250);
    });
  }

  /** Adapts the slice size to the last rendered-frame interval (target 60 fps). */
  private adaptSlice(interval: number): void {
    const target = Math.max(1000 / 60, Math.min(...this.frameIntervals.slice(-30)));
    if (interval <= target * 1.1) this.sliceSteps = Math.min(64, this.sliceSteps + 1);
    else if (interval > target * 1.35) this.sliceSteps = Math.max(1, Math.floor(this.sliceSteps * 0.7));
  }

  private ensureEngine(bodies: number, doc: SceneDoc): PhysicsEngine {
    const tiers = [1024, 2048, 4096, 8192, 12288, 16384, 24576, 32768];
    const need = tiers.find((t) => t >= bodies) ?? tiers[tiers.length - 1];
    if (bodies > tiers[tiers.length - 1]) throw new Error(`Scene too large: ${bodies} bodies (max ${tiers[tiers.length - 1]})`);
    if (!this.engine || this.capacity < need) {
      this.engine?.dispose(this.renderer);
      this.recordKernel = null;
      this.velocityKernel = null;
      this.engine = new PhysicsEngine(this.device, {
        maxBodies: need,
        gravity: [0, -doc.physics.gravity, 0],
        substeps: doc.physics.substeps,
        deltaTime: 1 / doc.fps,
        pairManifoldSlots: 4,
        solverIterations: doc.physics.iterations,
        pairSolveColorCount: 24,
        // dynamic-dynamic pairs belong to the lower-index body: a plank carrying a
        // pile (bridge) needs room, or its farthest contacts are evicted
        maxPairsPerBodyBroadphase: need > 12288 ? 20 : need > 4096 ? 28 : 48,
        maxContactsPerBodySolver: 64,
        maxFixedStepsPerFrame: 1,
        enableBvhBuild: true,
        bvhBuildOnce: false,
        bvhRebuildIntervalFrames: 1,
        bvhWaitForGpuCompletion: false,
        haltOnBroadphaseFallbackOverflow: true,
        avbdFriction: doc.physics.friction,
        avbdBodySolveMode: 'colored',
      });
      this.capacity = need;
    } else {
      this.engine.clearScene();
    }
    const e = this.engine;
    e.setGravity([0, -doc.physics.gravity, 0]);
    e.setDeltaTime((1 / doc.fps) * doc.physics.timeScale);
    e.setSubsteps(doc.physics.substeps);
    e.setSolverIterations(doc.physics.iterations);
    e.setAvbdDualUpdateBeta(doc.physics.beta);
    const jb = Math.min(doc.physics.jointBeta ?? 1e5, 3e5);
    e.setAvbdJointBeta(jb, jb / 100);
    e.setAvbdRegularizationAlpha(doc.physics.alpha);
    e.setAvbdPenaltyDecayGamma(doc.physics.gamma);
    e.setAvbdPairSweeps(1);
    e.setAvbdPreventPenetratingNormalDropout(false);
    e.setAvbdPenaltyFloor(1.0);
    e.setAvbdBodySolveMode('colored');
    e.setPairSolveColorCount(doc.physics.colors ?? 8);
    e.setAvbdFriction(doc.physics.friction);
    e.setDrag(doc.physics.drag ?? 0, (doc.physics.drag ?? 0) * 0.5);
    return e;
  }

  /**
   * Bakes the scene. Resolves with the result, or null when cancelled.
   * `onFrame` is called regularly so the UI can preview the recorded frames.
   */
  async bake(built: BuiltScene, doc: SceneDoc, onProgress: (p: BakeProgress) => void): Promise<BakeResult | null> {
    const token = ++this.token;
    const t0 = performance.now();
    const N = built.bodies.length + 1; // + ground at index 0
    const F = built.simFrames;
    const fps = built.fps;
    const dtSim = (1 / fps) * doc.physics.timeScale;

    const maxBinding = Number(this.device.limits.maxStorageBufferBindingSize);
    const { recordEvery, frames: recFrames, tailCount, tailStart, warm } = planHistory(N, F, fps, doc.loop, maxBinding);

    // Release the previous history before allocating the new one.
    const previous = this.result ?? this.currentPartial;
    if (previous) {
      releaseAttribute(this.renderer, previous.history);
      this.result = null;
      this.currentPartial = null;
    }
    const historyData = new Uint32Array((recFrames + tailCount) * N * 4);
    const history = new StorageBufferAttribute(historyData, 4);

    const engine = this.ensureEngine(N, doc);

    // Liquid: its own solver and history (8 bytes per particle per frame),
    // allocated directly on the GPU (no CPU mirror of hundreds of MB).
    if (previous?.fluid) releaseAttribute(this.renderer, previous.fluid.history);
    this.fluid?.dispose();
    this.fluid = null;
    let fluidRes: FluidBakeResult | null = null;
    const fl = built.fluid;
    if (fl) {
      this.fluid = new FluidSolver(this.device, fl, built.bodies, doc.fluid, fps, doc.physics.timeScale, doc.physics.gravity);
      const { recordEvery: every, frames: fFrames } = planFluidHistory(fl.count, F, recordEvery, Number(this.device.limits.maxBufferSize), maxBinding);
      const buffer = this.device.createBuffer({
        label: 'fluid.history', size: Math.max(16, fFrames * fl.count * 8),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | GPUBufferUsage.VERTEX,
      });
      // three.js adopts the buffer: the attribute's own array is never uploaded
      const attr = new StorageBufferAttribute(new Uint32Array(2), 2);
      adoptGpuBuffer(this.renderer, attr, buffer);
      this.fluid.bindHistory(buffer);
      fluidRes = { history: attr, count: fl.count, frames: fFrames, recordEvery: every };
    }
    const fluid = this.fluid;
    const bindFluidEngine = () => {
      if (!fluid || !fluid.needsEngine) return;
      const rb = engine.getRenderBuffers(), sb = engine.getStateBuffers();
      const be = this.renderer.backend;
      const buf = (a: any) => be.get(a)?.buffer as GPUBuffer | undefined;
      const pos = rb && buf(rb.positions), quat = rb && buf(rb.quaternions), vel = sb && buf(sb.velocities), ang = sb && buf(sb.angularVelocities);
      if (pos && quat && vel && ang) fluid.bindEngine({ pos, quat, vel, ang });
    };

    const partial: BakeResult = {
      history, stride: N, frames: recFrames, recordEvery, simFrames: F, fps, fluid: fluidRes,
      tail: tailCount > 0 ? { start: tailStart, base: recFrames, count: tailCount } : null,
    };
    this.currentPartial = partial;

    // ground
    engine.addBody({
      position: [0, -0.5, 0], halfExtents: [250, 0.5, 250], mass: 0,
      friction: doc.physics.friction, collisionGroup: 0x01, collisionMask: doc.physics.ground ? 0xff : 0x00,
    });

    const motionFrame = built.motions.map(() => new Array(7).fill(0));
    const motionNext = built.motions.map(() => new Array(7).fill(0));
    const kinematic = built.bodies.map((b, i) => (b.kind === KIND_KINEMATIC ? i : -1)).filter((i) => i >= 0);
    const P: V3 = [0, 0, 0], Q: Q4 = [0, 0, 0, 1], P1: V3 = [0, 0, 0], Q1: Q4 = [0, 0, 0, 1];

    const addBody = (i: number) => {
      const b = built.bodies[i];
      const common = {
        position: b.pos, quaternion: b.quat,
        linearVelocity: b.vel, angularVelocity: b.angVel,
        mass: b.kind === KIND_DYNAMIC ? b.mass : 0,
        friction: b.friction,
      };
      if (b.shape === 1) engine.addBody({ ...common, shapeType: 'sphere', radius: b.he[0] });
      else engine.addBody({ ...common, shapeType: 'box', halfExtents: b.he });
    };

    const driveKinematics = (frame: number) => {
      if (kinematic.length === 0) return;
      const t = frame / fps, tn = (frame + 1) / fps;
      built.motions.forEach((m, k) => {
        evalMotion(m, t, built.duration, motionFrame[k]);
        evalMotion(m, tn, built.duration, motionNext[k]);
      });
      for (const i of kinematic) {
        const b = built.bodies[i];
        if (b.motion < 0) continue;
        composePose(motionFrame[b.motion], b.localPos, b.localQuat, P, Q);
        composePose(motionNext[b.motion], b.localPos, b.localQuat, P1, Q1);
        const v: V3 = [(P1[0] - P[0]) / dtSim, (P1[1] - P[1]) / dtSim, (P1[2] - P[2]) / dtSim];
        engine.setBodyPose(i + 1, [P[0], P[1], P[2]], [Q[0], Q[1], Q[2], Q[3]], v, angularVelocity(Q, Q1, dtSim));
      }
    };

    // initial bodies + joints
    for (let i = 0; i < built.initialCount; i++) addBody(i);
    // Continuous loops recycle spawned bodies: they all exist from the start,
    // parked far below the floor (spread out so they never touch), and each
    // spawn teleports its body to the emitter - in the warm-up and again in
    // the recorded pass, where the body is still out from the previous cycle
    // until its turn comes.
    if (warm) {
      for (let i = built.initialCount; i < built.bodies.length; i++) {
        const b = built.bodies[i];
        const k = i - built.initialCount;
        const park = { ...b, pos: [(k % 64) * 2.5 - 80, -400, Math.floor(k / 64) * 2.5 - 80] as V3, vel: [0, 0, 0] as V3, angVel: [0, 0, 0] as V3 };
        const common = { position: park.pos, quaternion: b.quat, linearVelocity: park.vel, angularVelocity: park.angVel, mass: b.mass, friction: b.friction };
        if (b.shape === 1) engine.addBody({ ...common, shapeType: 'sphere', radius: b.he[0] });
        else engine.addBody({ ...common, shapeType: 'box', halfExtents: b.he });
      }
    }
    const respawn = (k: number) => {
      for (let i = built.initialCount; i < built.bodies.length; i++) {
        const b = built.bodies[i];
        if (b.spawnFrame === k) engine.setBodyPose(i + 1, [...b.pos], [...b.quat], [...b.vel], [...b.angVel]);
      }
    };
    for (const j of built.joints) {
      const a = j.a === null ? null : j.a + 1;
      if (j.type === 'fixed') engine.addFixedJoint(a, j.b + 1, j.anchorA, j.anchorB, j.stiffness, !j.collide, j.fracture);
      else if (j.type === 'spring') engine.addSpring(a, j.b + 1, j.anchorA, j.anchorB, j.stiffness, undefined, !j.collide);
      else engine.addSphericalJoint(a, j.b + 1, j.anchorA, j.anchorB, j.stiffness, !j.collide, j.fracture);
    }
    driveKinematics(0);

    // frame 0 straight from the scene description (engine buffers not yet on GPU)
    writeRestPoses(historyData, built.bodies);
    history.needsUpdate = true;

    const sinkFrame = doc.loop.mode === 'sink' && doc.physics.ground
      ? Math.round(Math.max(0, doc.duration - doc.loop.outro) * fps) : Infinity;

    let nextSpawn = built.initialCount;
    let recorded = 1;
    let lastYield = performance.now();
    const stepTimes: number[] = [];
    // a continuous bake runs the clip twice: report both passes as one
    let passOffset = 0;
    const passScale = warm ? 0.5 : 1;
    const progress = (k: number) => {
      const recent = stepTimes.slice(-30);
      onProgress({ frame: Math.floor((passOffset + k) * passScale), total: F, recorded, msPerFrame: recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0 });
    };

    // Paced mode (visible page, app attached): end the slice when its step
    // count or CPU budget is spent. Otherwise (hidden page) the old throughput
    // mode: batch work and drain the GPU between yields.
    let sliceStart = performance.now();
    let sliceCount = 0;
    const inFlight: Promise<void>[] = [];
    const tick = async (k: number): Promise<boolean> => {
      if (!document.hidden && this.paced) {
        sliceCount++;
        if (sliceCount < this.sliceSteps && performance.now() - sliceStart < SLICE_CPU_MS) return true;
        inFlight.push(this.device.queue.onSubmittedWorkDone());
        if (k >= 0) progress(k);
        const interval = await this.nextDisplayFrame();
        // Completion callbacks arrive tens of ms late in Chrome: waiting for the
        // previous slice would starve the GPU, so keep up to SLICES_IN_FLIGHT.
        while (inFlight.length > SLICES_IN_FLIGHT) await inFlight.shift();
        if (token !== this.token) return false;
        this.adaptSlice(interval);
        sliceCount = 0;
        sliceStart = performance.now();
        lastYield = sliceStart;
        return true;
      }
      // Hidden pages get GPU completion callbacks throttled (~180 ms each):
      // batch far more work per yield there, or the bake crawls.
      if (performance.now() - lastYield > (document.hidden ? 400 : 14)) {
        await this.device.queue.onSubmittedWorkDone();
        if (k >= 0) progress(k);
        await yieldTask();
        lastYield = performance.now();
        sliceStart = lastYield;
        return token === this.token;
      }
      return true;
    };

    const step = async (): Promise<boolean> => {
      for (let attempt = 0; attempt < 600; attempt++) {
        if (this.batching) this.batcher.begin();
        let ok = false;
        try { ok = engine.stepFixed(this.renderer); } finally { if (this.batching) this.batcher.end(); }
        if (ok) return true;
        await this.device.queue.onSubmittedWorkDone();
        await yieldTask();
        if (token !== this.token) return false;
      }
      throw new Error('Physics engine did not become ready (broadphase).');
    };

    // Settling: let contact penalties and joint multipliers converge on the
    // initial configuration with velocities clamped to zero, so stacks start at
    // rest instead of popping. Initial velocities are restored afterwards.
    const settle = Math.max(0, Math.round((doc.physics.settle ?? 0.5) * fps));
    if (settle > 0) {
      for (let s = 0; s < settle; s++) {
        if (!(await step())) return null;
        this.setVelocities(engine, N, built, 0);
        if (!(await tick(-1))) return null;
      }
      this.setVelocities(engine, N, built, 1);
      driveKinematics(0);
      this.batcher.begin();
      try { this.record(engine, history, 0, N); } finally { this.batcher.end(); }
    }
    if (fluid) {
      fluid.activate(0);
      const fs = Math.round(Math.max(0, doc.fluid.settle ?? 0) * fps);
      if (fs > 0) {
        for (let s = 0; s < fs; s += 10) {
          fluid.settle(Math.min(10, fs - s));
          if (!(await tick(-1))) return null;
        }
      }
      fluid.record(0);
    }
    onProgress({ frame: 0, total: F, recorded: 1, msPerFrame: 0 });

    if (warm) {
      // Warm-up pass: same clip, no spawns and no liquid. It streams into the
      // main slots as a preview (the recorded pass overwrites them) and keeps
      // its tail.
      if (F > 1 && !(await step())) return null;
      for (let k = 1; k < F; k++) {
        if (token !== this.token) return null;
        const ts = performance.now();
        driveKinematics(k);
        respawn(k);
        if (k % recordEvery === 0) {
          const rf = k / recordEvery;
          if (this.batching) this.batcher.begin();
          try {
            this.record(engine, history, rf * N, N);
            if (rf >= tailStart) this.record(engine, history, (recFrames + rf - tailStart) * N, N);
          } finally { if (this.batching) this.batcher.end(); }
          recorded = rf + 1;
        }
        if (k < F - 1 && !(await step())) return null;
        stepTimes.push(performance.now() - ts);
        if (!(await tick(k))) return null;
      }
      // The recorded pass starts from the warm-up's last frame. Periodic
      // kinematics are back at their t = 0 pose (a flipped hourglass is
      // indistinguishable from an upright one).
      passOffset = F;
      driveKinematics(0);
      this.batcher.begin();
      try { this.record(engine, history, 0, N); } finally { this.batcher.end(); }
      recorded = 1;
      progress(0);
    }

    const fluidStep = () => {
      if (!fluid) return;
      bindFluidEngine();
      fluid.step(engine.getBodyCount());
    };
    if (F > 1 && !(await step())) return null;
    fluidStep();

    for (let k = 1; k < F; k++) {
      if (token !== this.token) return null;
      const ts = performance.now();
      if (warm) respawn(k);
      else while (nextSpawn < built.bodies.length && built.bodies[nextSpawn].spawnFrame <= k) addBody(nextSpawn++);
      driveKinematics(k);
      if (k === sinkFrame) {
        engine.setBodyCollisionFilter(0, 0x01, 0x00);
        if (fluid) fluid.floorOpen = true;
      }

      if (k % recordEvery === 0) {
        if (this.batching) this.batcher.begin();
        try { this.record(engine, history, (k / recordEvery) * N, N); } finally { if (this.batching) this.batcher.end(); }
        recorded = k / recordEvery + 1;
      }
      if (fluid && fluidRes) {
        fluid.activate(k);
        if (k % fluidRes.recordEvery === 0) fluid.record(k / fluidRes.recordEvery);
      }
      if (k < F - 1) {
        if (!(await step())) return null;
        fluidStep();
      }
      stepTimes.push(performance.now() - ts);
      if (!(await tick(k))) return null;
    }
    await this.device.queue.onSubmittedWorkDone();
    if (token !== this.token) return null;

    const totalMs = performance.now() - t0;
    this.lastStats = { bodies: built.bodies.length, joints: built.joints.length, msPerFrame: totalMs / (warm ? 2 * F : F), totalMs };
    this.result = partial;
    onProgress({ frame: F, total: F, recorded: recFrames, msPerFrame: totalMs / F });
    return this.result;
  }

  private setVelocities(engine: PhysicsEngine, count: number, built: BuiltScene, mode: 0 | 1): void {
    const st = engine.getStateBuffers();
    if (!st) return;
    if (mode === 1 || !this.initVelAttr || this.initVelAttr.count < engine.config.maxBodies * 2) {
      const data = new Float32Array(engine.config.maxBodies * 8);
      for (let i = 0; i < built.bodies.length; i++) {
        const b = built.bodies[i];
        data.set([b.vel[0], b.vel[1], b.vel[2], 0, b.angVel[0], b.angVel[1], b.angVel[2], 0], (i + 1) * 8);
      }
      if (!this.initVelAttr || this.initVelAttr.count !== engine.config.maxBodies * 2) {
        if (this.initVelAttr) releaseAttribute(this.renderer, this.initVelAttr);
        this.initVelAttr = new StorageBufferAttribute(data, 4);
        this.velocityKernel = null;
      } else {
        (this.initVelAttr.array as Float32Array).set(data);
        this.initVelAttr.needsUpdate = true;
      }
    }
    if (!this.velocityKernel || this.velocityKernelEngine !== engine) {
      const n = engine.config.maxBodies;
      this.velocityKernel = wgslFn(VELOCITY_WGSL)({
        positions: storage(st.positions, 'vec4f', n).toReadOnly(),
        velocities: storage(st.velocities, 'vec4f', n),
        prevLinearVelocities: storage(st.prevLinearVelocities, 'vec4f', n),
        angularVelocities: storage(st.angularVelocities, 'vec4f', n),
        initVel: storage(this.initVelAttr!, 'vec4f', n * 2).toReadOnly(),
        mode: (uniform as any)(0, 'uint'),
        bodyCount: (uniform as any)(0, 'uint'),
        workgroupId,
        localId,
      }).computeKernel([WORKGROUP, 1, 1]).setName('Bake settle velocities');
      this.velocityKernelEngine = engine;
    }
    this.velocityKernel.computeNode.parameters.mode.value = mode;
    this.velocityKernel.computeNode.parameters.bodyCount.value = count;
    this.batcher.begin();
    try { this.renderer.compute(this.velocityKernel, [Math.ceil(count / WORKGROUP), 1, 1]); } finally { this.batcher.end(); }
  }

  private record(engine: PhysicsEngine, history: StorageBufferAttribute, frameBase: number, count: number): void {
    const buffers = engine.getRenderBuffers();
    if (!buffers) return;
    if (!this.recordKernel || this.recordKernelHistory !== history) {
      const shader = wgslFn(RECORD_WGSL, [wgsl(QUAT_PACK_WGSL)]);
      this.recordKernel = shader({
        positions: storage(buffers.positions, 'vec4f', engine.config.maxBodies).toReadOnly(),
        quaternions: storage(buffers.quaternions, 'vec4f', engine.config.maxBodies).toReadOnly(),
        history: storage(history, 'uvec4', history.count),
        frameBase: (uniform as any)(0, 'uint'),
        bodyCount: (uniform as any)(0, 'uint'),
        workgroupId,
        localId,
      }).computeKernel([WORKGROUP, 1, 1]).setName('Record history frame');
      this.recordKernelHistory = history;
    }
    this.recordKernel.computeNode.parameters.frameBase.value = frameBase;
    this.recordKernel.computeNode.parameters.bodyCount.value = count;
    this.renderer.compute(this.recordKernel, [Math.ceil(count / WORKGROUP), 1, 1]);
  }
}
