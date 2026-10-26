// Kinematic motions. Every motion is periodic over the loop duration (integer
// cycles, gates that close again) so baked animations wrap seamlessly.

export type V3 = [number, number, number];
export type Q4 = [number, number, number, number];

export const MOTION_NONE = 0;
export const MOTION_SPIN = 1;
export const MOTION_SWING = 2;
export const MOTION_SLIDE = 3;
export const MOTION_GATE = 4;

export interface SimMotion {
  kind: number;
  origin: V3;
  baseQuat: Q4;
  axis: V3; // world space, unit
  cycles: number;
  amp: number; // radians (spin/swing/gate rotation) or meters (slide)
  phase: number;
  offset: V3;
  tOpen: number;
  tClose: number;
  ease: number;
}

const TAU = Math.PI * 2;

function smooth(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** Frame of a motion at time t: writes [px,py,pz,qx,qy,qz,qw] into out. */
export function evalMotion(m: SimMotion, t: number, duration: number, out: number[]): void {
  let px = m.origin[0], py = m.origin[1], pz = m.origin[2];
  let angle = 0;
  const u = t / duration;
  switch (m.kind) {
    case MOTION_SPIN:
      angle = TAU * (m.cycles * u + m.phase);
      break;
    case MOTION_SWING:
      angle = m.amp * Math.sin(TAU * (m.cycles * u + m.phase));
      break;
    case MOTION_SLIDE: {
      const s = m.amp * Math.sin(TAU * (m.cycles * u + m.phase));
      px += m.axis[0] * s; py += m.axis[1] * s; pz += m.axis[2] * s;
      break;
    }
    case MOTION_GATE: {
      const e = Math.max(m.ease, 1e-3);
      const s = smooth((t - m.tOpen) / e) - smooth((t - m.tClose) / e);
      px += m.offset[0] * s; py += m.offset[1] * s; pz += m.offset[2] * s;
      angle = m.amp * s;
      break;
    }
  }
  const bq = m.baseQuat;
  if (angle !== 0) {
    const h = angle * 0.5, s = Math.sin(h), c = Math.cos(h);
    const ax = m.axis[0] * s, ay = m.axis[1] * s, az = m.axis[2] * s, aw = c;
    out[3] = aw * bq[0] + ax * bq[3] + ay * bq[2] - az * bq[1];
    out[4] = aw * bq[1] - ax * bq[2] + ay * bq[3] + az * bq[0];
    out[5] = aw * bq[2] + ax * bq[1] - ay * bq[0] + az * bq[3];
    out[6] = aw * bq[3] - ax * bq[0] - ay * bq[1] - az * bq[2];
  } else {
    out[3] = bq[0]; out[4] = bq[1]; out[5] = bq[2]; out[6] = bq[3];
  }
  out[0] = px; out[1] = py; out[2] = pz;
}

/** World pose of a body attached to motion frame f with a local pose. */
export function composePose(f: number[], lp: V3, lq: Q4, outP: V3, outQ: Q4): void {
  const qx = f[3], qy = f[4], qz = f[5], qw = f[6];
  const vx = lp[0], vy = lp[1], vz = lp[2];
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
  outP[0] = f[0] + vx + qw * tx + (qy * tz - qz * ty);
  outP[1] = f[1] + vy + qw * ty + (qz * tx - qx * tz);
  outP[2] = f[2] + vz + qw * tz + (qx * ty - qy * tx);
  const bx = lq[0], by = lq[1], bz = lq[2], bw = lq[3];
  outQ[0] = qw * bx + qx * bw + qy * bz - qz * by;
  outQ[1] = qw * by - qx * bz + qy * bw + qz * bx;
  outQ[2] = qw * bz + qx * by - qy * bx + qz * bw;
  outQ[3] = qw * bw - qx * bx - qy * by - qz * bz;
}

/** Angular velocity taking q0 to q1 in dt (world frame). */
export function angularVelocity(q0: Q4, q1: Q4, dt: number): V3 {
  // d = q1 * conj(q0)
  const ax = q1[0], ay = q1[1], az = q1[2], aw = q1[3];
  const bx = -q0[0], by = -q0[1], bz = -q0[2], bw = q0[3];
  let x = aw * bx + ax * bw + ay * bz - az * by;
  let y = aw * by - ax * bz + ay * bw + az * bx;
  let z = aw * bz + ax * by - ay * bx + az * bw;
  let w = aw * bw - ax * bx - ay * by - az * bz;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.hypot(x, y, z);
  if (s < 1e-12) return [0, 0, 0];
  const angle = 2 * Math.atan2(s, w);
  const k = angle / (s * dt);
  return [x * k, y * k, z * k];
}
