// Serializable scene document: everything the user can edit lives here.

export type Vec3 = [number, number, number];

export type Finish = 'gloss' | 'satin' | 'matte' | 'metal' | 'chrome' | 'pearl' | 'neon' | 'glass' | 'hidden';
export const FINISHES: Finish[] = ['gloss', 'satin', 'matte', 'metal', 'chrome', 'pearl', 'neon', 'glass', 'hidden'];

export type ColorMode = 'single' | 'cycle' | 'gradient' | 'random' | 'height';
export const COLOR_MODES: ColorMode[] = ['single', 'cycle', 'gradient', 'random', 'height'];

export type BodyKind = 'dynamic' | 'static' | 'kinematic';
export type MotionKind = 'none' | 'spin' | 'swing' | 'slide' | 'gate';

export interface Look {
  colorMode: ColorMode;
  color: string; // used by 'single'
  paletteOffset: number; // shifts palette indices
  finish: Finish;
}

export interface Phys {
  body: BodyKind;
  density: number;
  friction: number;
  velocity: Vec3;
  angularVelocity: Vec3;
  spawnAt: number; // seconds
}

export interface MotionDef {
  kind: MotionKind;
  axis: Vec3;
  cycles: number; // per loop -> guarantees periodicity
  amplitude: number; // degrees (spin/swing/gate) or meters (slide)
  phase: number; // 0..1
  offset: Vec3; // gate translation
  open: number;
  close: number;
  ease: number;
}

export type EntityType =
  | 'box' | 'sphere' | 'wall' | 'pyramid' | 'tower' | 'dominoes' | 'grid'
  | 'chain' | 'wreckingBall' | 'container' | 'funnel' | 'galton' | 'stairs'
  | 'pegboard' | 'emitter' | 'hourglass' | 'fluidBlock' | 'fluidSource' | 'wheel'
  | 'drum' | 'pendulumWave'
  | 'path' | 'seesaw' | 'ramp' | 'hammer' | 'freeWheel' | 'piston' | 'cup' | 'rollers' | 'sensor';

export interface Entity {
  id: string;
  type: EntityType;
  name: string;
  enabled: boolean;
  position: Vec3;
  rotation: Vec3; // degrees, XYZ euler
  params: Record<string, any>;
  look: Look;
  phys: Phys;
  motion: MotionDef;
  /** entities sharing a group id are selected, moved and copied together */
  group?: string;
  /** machine check: false = this object is not expected to move (decor) */
  expect?: boolean;
  /** follow camera: false = its motion does not draw the camera */
  camera?: boolean;
}

export type LoopMode = 'reassemble' | 'shrink' | 'sink' | 'boomerang' | 'none' | 'continuous';
/** Order matters: the renderers receive the index. */
export const LOOP_MODES: LoopMode[] = ['reassemble', 'shrink', 'sink', 'boomerang', 'none', 'continuous'];

export interface LoopSettings {
  mode: LoopMode;
  outro: number; // seconds dedicated to the loop transition at the end
  stagger: number; // 0..1 fraction of outro used for per-object stagger
  order: 'height' | 'random' | 'index' | 'distance';
  arc: number; // lift during reassemble (m)
  intro: number; // grow-in duration at the start (shrink/sink)
  /** boomerang: peak rewind speed (x forward speed) */
  rewind: number;
  /** boomerang: slow-down into the turning point (s) */
  apex: number;
}

export interface PhysicsSettings {
  gravity: number;
  substeps: number;
  iterations: number;
  colors: number; // graph colours for the parallel GPU Gauss-Seidel sweep
  alpha: number;
  beta: number; // contacts
  jointBeta: number; // joints (chains, glue)
  gamma: number;
  friction: number;
  ground: boolean;
  timeScale: number; // slow motion (sim seconds per video second)
  settle: number; // seconds of invisible pre-roll letting contacts converge
  drag: number; // air drag on dynamic bodies (1/s)
}

export type CameraMotion = 'static' | 'orbit' | 'sway' | 'dolly' | 'crane' | 'follow';

export interface CameraSettings {
  position: Vec3;
  target: Vec3;
  fov: number;
  motion: CameraMotion;
  amount: number; // degrees (sway/orbit partial) or fraction (dolly)
  cycles: number;
  /** follow: smallest radius kept in frame (m) - how close the camera gets */
  followSize?: number;
  /** follow: smoothing of the camera path (s) */
  followSmooth?: number;
  /** follow: how far ahead the camera looks (s) */
  followLead?: number;
}

export interface RenderSettings {
  palette: string;
  background: string; // '' => palette background
  floorColor: string; // '' => palette floor
  floor: 'plain' | 'grid' | 'mirror' | 'none';
  exposure: number;
  envIntensity: number;
  lightAzimuth: number;
  lightElevation: number;
  lightIntensity: number;
  shadowSoftness: number;
  ao: number;
  gi: boolean;
  bloom: number;
  bloomThreshold: number;
  dof: number; // 0 = off; aperture-ish strength
  focus: number; // focus distance (m), 0 => target distance
  vignette: number;
  grain: number;
  bevel: number; // 0..0.5 fraction of smallest half extent
  motionBlur: number;
  aa: 'msaa' | 'smaa' | 'fxaa' | 'none';
  aspect: '1:1' | '9:16' | '4:5' | '16:9';
}

/** MLS-MPM liquid (see src/fluid). */
export interface FluidSettings {
  cell: number; // grid cell (m); particles start cell/2 apart (8 per cell)
  soundSpeed: number; // m/s: stiffness of the weakly compressible liquid
  viscosity: number; // 0..1
  density: number; // same units as body density (bodies lighter than this float)
  substeps: number; // 0 = automatic (CFL)
  maxParticles: number;
  /** damped pre-roll (s) so resting liquid starts in equilibrium (0 for dams) */
  settle: number;
  /** Simulation box [minX, minY, minZ, maxX, maxY, maxZ]; empty = fitted to the scene. */
  bounds: number[];
  // look
  color: string; // tint of deep liquid
  clarity: number; // metres of liquid before the tint dominates
  refraction: number;
  smoothing: number; // surface smoothing (0..1)
  foam: number; // whitening of fast liquid (0..1)
}

export interface SceneDoc {
  version: 1;
  name: string;
  seed: number;
  duration: number;
  fps: number;
  physics: PhysicsSettings;
  loop: LoopSettings;
  camera: CameraSettings;
  render: RenderSettings;
  fluid: FluidSettings;
  entities: Entity[];
}

let idCounter = 0;
export function newId(): string {
  idCounter = (idCounter + 1) % 1e6;
  return Date.now().toString(36) + '-' + idCounter.toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

export const FOLLOW_DEFAULTS = { followSize: 1.2, followSmooth: 0.8, followLead: 0.3 };

export function defaultLook(): Look {
  return { colorMode: 'cycle', color: '#ff6b6b', paletteOffset: 0, finish: 'gloss' };
}

export function defaultPhys(): Phys {
  return { body: 'dynamic', density: 1, friction: 0.6, velocity: [0, 0, 0], angularVelocity: [0, 0, 0], spawnAt: 0 };
}

export function defaultMotion(): MotionDef {
  return {
    kind: 'none', axis: [0, 1, 0], cycles: 1, amplitude: 45, phase: 0,
    offset: [0, -2, 0], open: 2, close: 8, ease: 0.4,
  };
}

export function defaultDoc(): SceneDoc {
  return {
    version: 1,
    name: 'Untitled loop',
    seed: 1,
    duration: 10,
    fps: 60,
    physics: {
      gravity: 9.81, substeps: 3, iterations: 10, colors: 8, alpha: 0.95, beta: 10000, jointBeta: 100000, gamma: 0.99,
      friction: 0.6, ground: true, timeScale: 1, settle: 0.5, drag: 0,
    },
    loop: { mode: 'reassemble', outro: 2.2, stagger: 0.55, order: 'height', arc: 0.6, intro: 0.6, rewind: 1.5, apex: 0.6 },
    camera: { position: [9, 6.5, 11], target: [0, 1.5, 0], fov: 35, motion: 'sway', amount: 12, cycles: 1, ...FOLLOW_DEFAULTS },
    render: {
      palette: 'sorbet', background: '', floorColor: '', floor: 'plain', exposure: 0.95, envIntensity: 0.8,
      lightAzimuth: 35, lightElevation: 52, lightIntensity: 3.6, shadowSoftness: 0.3,
      ao: 1, gi: false, bloom: 0.15, bloomThreshold: 0.85, dof: 0, focus: 0, vignette: 0.35, grain: 0.022,
      bevel: 0.18, motionBlur: 0, aa: 'msaa', aspect: '1:1',
    },
    fluid: defaultFluid(),
    entities: [],
  };
}

export function defaultFluid(): FluidSettings {
  return {
    cell: 0.06, soundSpeed: 9, viscosity: 0.05, density: 1, substeps: 0, maxParticles: 90000, settle: 0, bounds: [],
    color: '#1b8fd6', clarity: 0.6, refraction: 0.6, smoothing: 0.6, foam: 0.5,
  };
}
