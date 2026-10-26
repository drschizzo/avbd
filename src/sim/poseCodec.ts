// The baked pose format, in one place for the CPU and the GPU: 16 bytes per
// body and frame, float32 position + a "smallest three" quaternion packed as
// 10:10:10 bits plus the index of the dropped (largest) component in bits 30-31.
// The baker writes it, the body shaders, the loop matcher and the machine
// check read it: any change here must stay mirrored in the WGSL below.

export const BYTES_PER_POSE = 16;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
/** The bits of a float32, as stored in the uvec4 history. */
export function fbits(x: number): number { f32[0] = x; return u32[0]; }

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

/** Inverse of packQuat. */
export function unpackQuat(v: number, out: number[]): number[] {
  const idx = v >>> 30;
  const dec = (x: number) => ((x & 1023) / 1023 - 0.5) / 0.70710678;
  const c = [dec(v), dec(v >>> 10), dec(v >>> 20)];
  const w = Math.sqrt(Math.max(0, 1 - c[0] * c[0] - c[1] * c[1] - c[2] * c[2]));
  for (let i = 0, j = 0; i < 4; i++) out[i] = i === idx ? w : c[j++];
  return out;
}

/** WGSL twin of packQuat (normalises its input). */
export const QUAT_PACK_WGSL = /* wgsl */`
  fn hxPackQuat(qIn: vec4f) -> u32 {
    var q = normalize(qIn);
    let a = abs(q);
    var idx = 0u;
    var m = a.x;
    if (a.y > m) { m = a.y; idx = 1u; }
    if (a.z > m) { m = a.z; idx = 2u; }
    if (a.w > m) { m = a.w; idx = 3u; }
    var big = q.x;
    if (idx == 1u) { big = q.y; } else if (idx == 2u) { big = q.z; } else if (idx == 3u) { big = q.w; }
    if (big < 0.0) { q = -q; }
    var c = q.yzw;
    if (idx == 1u) { c = q.xzw; } else if (idx == 2u) { c = q.xyw; } else if (idx == 3u) { c = q.xyz; }
    let e = vec3u(round(clamp(c * 0.70710678 + 0.5, vec3f(0.0), vec3f(1.0)) * 1023.0));
    return e.x | (e.y << 10u) | (e.z << 20u) | (idx << 30u);
  }
`;

/** WGSL twin of unpackQuat. */
export const QUAT_UNPACK_WGSL = /* wgsl */`
  fn hxDecodeQuat(p: u32) -> vec4f {
    let idx = p >> 30u;
    let c = (vec3f(f32(p & 1023u), f32((p >> 10u) & 1023u), f32((p >> 20u) & 1023u)) / 1023.0 - 0.5) * 1.41421356;
    let w = sqrt(max(0.0, 1.0 - dot(c, c)));
    if (idx == 0u) { return vec4f(w, c.x, c.y, c.z); }
    if (idx == 1u) { return vec4f(c.x, w, c.y, c.z); }
    if (idx == 2u) { return vec4f(c.x, c.y, w, c.z); }
    return vec4f(c.x, c.y, c.z, w);
  }
`;

/**
 * One frame of poses at rest: slot 0 is the ground (half a metre down, as the
 * engine places it), slot i + 1 is body i.
 */
export function writeRestPoses(out: Uint32Array, bodies: readonly { pos: ArrayLike<number>; quat: ArrayLike<number> }[]): void {
  out[0] = fbits(0); out[1] = fbits(-0.5); out[2] = fbits(0); out[3] = packQuat([0, 0, 0, 1]);
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    const o = (i + 1) * 4;
    out[o] = fbits(b.pos[0]); out[o + 1] = fbits(b.pos[1]); out[o + 2] = fbits(b.pos[2]);
    out[o + 3] = packQuat(b.quat);
  }
}
