// How a bake fits in GPU memory: which simulated frames are recorded, and
// how many frames of a continuous loop's warm-up are kept.

import type { LoopSettings } from '../scene/doc';
import { BYTES_PER_POSE } from './poseCodec';

/** Largest history buffer we allow ourselves, whatever the device offers. */
const HISTORY_CAP = 1536 * 1024 * 1024;
/** Liquid history: 8 bytes per particle per recorded frame. */
const FLUID_BYTES = 8;
const FLUID_CAP = 1024 * 1024 * 1024;
/** Beyond one recorded frame in 8, playback would visibly stutter. */
const MAX_EVERY = 8;

export interface HistoryPlan {
  /** record one simulated frame in `recordEvery` */
  recordEvery: number;
  /** recorded frames of the main pass */
  frames: number;
  /** continuous loops: warm-up frames kept after the main ones (0 otherwise) */
  tailCount: number;
  /** first recorded warm-up frame that is kept */
  tailStart: number;
  /** continuous loops simulate the clip twice (warm-up, then the recorded pass) */
  warm: boolean;
}

/**
 * `bodies` includes the ground. Continuous loops keep the warm-up's last
 * `outro` seconds: the trajectory that leads into frame 0, which the loop
 * blend steers each body onto.
 */
export function planHistory(bodies: number, simFrames: number, fps: number, loop: Pick<LoopSettings, 'mode' | 'outro'>, maxBinding: number): HistoryPlan {
  const budget = Math.min(maxBinding, HISTORY_CAP);
  const F = simFrames;
  const warm = loop.mode === 'continuous';
  const tailOf = (every: number) => warm ? Math.min(Math.ceil(F / every) - 1, Math.ceil((loop.outro * fps) / every) + 2) : 0;
  const bytes = (every: number) => (Math.ceil(F / every) + tailOf(every)) * bodies * BYTES_PER_POSE;
  let recordEvery = 1;
  while (bytes(recordEvery) > budget && recordEvery < MAX_EVERY) recordEvery++;
  if (bytes(recordEvery) > budget) throw new Error('Scene too large for the GPU history buffer');
  const frames = Math.ceil(F / recordEvery);
  const tailCount = tailOf(recordEvery);
  return { recordEvery, frames, tailCount, tailStart: frames - tailCount, warm };
}

/** Recording rate of the liquid history (never denser than the bodies'). */
export function planFluidHistory(particles: number, simFrames: number, bodyEvery: number, maxBuffer: number, maxBinding: number): { recordEvery: number; frames: number } {
  const maxBuf = Math.min(maxBuffer, maxBinding, FLUID_CAP);
  let every = bodyEvery;
  while (Math.ceil(simFrames / every) * particles * FLUID_BYTES > maxBuf && every < MAX_EVERY) every++;
  return { recordEvery: every, frames: Math.ceil(simFrames / every) };
}
