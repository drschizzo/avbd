// MLS-MPM liquid on WebGPU (raw WGSL, same device as three.js / AVBD).
//
// Per substep: P2G (mass + APIC momentum) -> P2G (pressure / viscous stress)
// -> grid update (gravity, walls, colliders, momentum handed to bodies)
// -> G2P (velocity, affine field, advection, collider push-out).
// Grid accumulation uses fixed-point atomics (WebGPU has no float atomics).
//
// Units inside the solver: lengths in grid cells, time in seconds, particle
// mass 1 (rest density = particles per cell). Rigid bodies are colliders:
// static ones are rasterised once into a nearest-collider map, kinematic and
// dynamic ones every frame from the AVBD engine buffers (no readback).
// Dynamic bodies receive the momentum the liquid loses against them (two-way
// coupling), applied to the engine velocities once per frame.

import type { FluidBuilt } from './fluidBuild';
import { PARTICLES_PER_CELL } from './fluidBuild';
import type { BuiltBody } from '../scene/build';
import { KIND_DYNAMIC, KIND_STATIC } from '../scene/build';
import type { FluidSettings } from '../scene/doc';

const WG = 64;
const FP = 65536; // fixed point for grid mass & momentum
const FP_ACC = 8; // fixed point for body impulses
const COLLIDER_VEC4 = 5;

const COMMON = /* wgsl */`
struct Params {
  dims: vec3u, nActive: u32,
  gravity: vec3f, dt: f32,
  restDensity: f32, stiffness: f32, viscosity: f32, vmax: f32,
  floorOpen: u32, nStatic: u32, nDynamic: u32, engineCount: u32,
  rp: f32, frameDt: f32, cellM: f32, foamSpeed: f32,
  activateFrom: u32, activateTo: u32, historyBase: u32, damp: f32,
};
const FP: f32 = ${FP}.0;
const FP_ACC: f32 = ${FP_ACC}.0;

fn qrot(q: vec4f, v: vec3f) -> vec3f { let t = 2.0 * cross(q.xyz, v); return v + q.w * t + cross(q.xyz, t); }
fn qinv(q: vec4f) -> vec4f { return vec4f(-q.xyz, q.w); }
fn nodeIndex(c: vec3i, dims: vec3u) -> u32 { return (u32(c.z) * dims.y + u32(c.y)) * dims.x + u32(c.x); }
fn sgn(x: f32) -> f32 { return select(1.0, -1.0, x < 0.0); }

fn unpackId(m: u32) -> u32 { return m & 0xFFFFFu; }
`;

const COLLIDERS = /* wgsl */`
// collider: [pos.xyz, shape] [quat] [he.xyz, active] [vel.xyz, coupledIndex] [angVel.xyz, 0]
// returns (world normal, signed distance) in cells
fn colliderSdf(k: u32, x: vec3f) -> vec4f {
  let c = col[k * 5u];
  let q = col[k * 5u + 1u];
  let he4 = col[k * 5u + 2u];
  if (he4.w < 0.5) { return vec4f(0.0, 1.0, 0.0, 1e9); }
  let local = qrot(qinv(q), x - c.xyz);
  if (c.w > 0.5) {
    let l = length(local);
    let n = select(vec3f(0.0, 1.0, 0.0), local / max(l, 1e-6), l > 1e-6);
    return vec4f(qrot(q, n), l - he4.x);
  }
  let d = abs(local) - he4.xyz;
  let outside = length(max(d, vec3f(0.0)));
  if (outside > 0.0) {
    let n = max(d, vec3f(0.0)) * vec3f(sgn(local.x), sgn(local.y), sgn(local.z)) / outside;
    return vec4f(qrot(q, n), outside);
  }
  var n = vec3f(sgn(local.x), 0.0, 0.0);
  var dist = d.x;
  if (d.y > dist) { dist = d.y; n = vec3f(0.0, sgn(local.y), 0.0); }
  if (d.z > dist) { dist = d.z; n = vec3f(0.0, 0.0, sgn(local.z)); }
  return vec4f(qrot(q, n), dist);
}
fn colliderVel(k: u32, x: vec3f) -> vec3f {
  let c = col[k * 5u];
  return col[k * 5u + 3u].xyz + cross(col[k * 5u + 4u].xyz, x - c.xyz);
}
`;

const P2G1 = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read> vel: array<vec4f>;
@group(0) @binding(3) var<storage, read> aff: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> grid: array<atomic<i32>>;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.nActive) { return; }
  let p = pos[i];
  if (p.w == 0.0) { return; }
  let v = vel[i].xyz;
  let C = mat3x3f(aff[i * 3u].xyz, aff[i * 3u + 1u].xyz, aff[i * 3u + 2u].xyz);
  let cell = vec3i(floor(p.xyz));
  let d = p.xyz - vec3f(cell) - 0.5;
  var W = array<vec3f, 3>(0.5 * (0.5 - d) * (0.5 - d), 0.75 - d * d, 0.5 * (0.5 + d) * (0.5 + d));
  for (var gx = 0; gx < 3; gx++) {
    for (var gy = 0; gy < 3; gy++) {
      for (var gz = 0; gz < 3; gz++) {
        let w = W[gx].x * W[gy].y * W[gz].z;
        let node = cell + vec3i(gx - 1, gy - 1, gz - 1);
        let dist = vec3f(node) - p.xyz + 0.5;
        let mom = w * (v + C * dist);
        let n = nodeIndex(node, P.dims) * 4u;
        atomicAdd(&grid[n], i32(w * FP));
        atomicAdd(&grid[n + 1u], i32(clamp(mom.x * FP, -2e8, 2e8)));
        atomicAdd(&grid[n + 2u], i32(clamp(mom.y * FP, -2e8, 2e8)));
        atomicAdd(&grid[n + 3u], i32(clamp(mom.z * FP, -2e8, 2e8)));
      }
    }
  }
}`;

const P2G2 = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;
@group(0) @binding(3) var<storage, read> aff: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> grid: array<atomic<i32>>;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.nActive) { return; }
  let p = pos[i];
  if (p.w == 0.0) { return; }
  let C = mat3x3f(aff[i * 3u].xyz, aff[i * 3u + 1u].xyz, aff[i * 3u + 2u].xyz);
  let cell = vec3i(floor(p.xyz));
  let d = p.xyz - vec3f(cell) - 0.5;
  var W = array<vec3f, 3>(0.5 * (0.5 - d) * (0.5 - d), 0.75 - d * d, 0.5 * (0.5 + d) * (0.5 + d));
  var density = 0.0;
  for (var gx = 0; gx < 3; gx++) {
    for (var gy = 0; gy < 3; gy++) {
      for (var gz = 0; gz < 3; gz++) {
        let w = W[gx].x * W[gy].y * W[gz].z;
        let node = cell + vec3i(gx - 1, gy - 1, gz - 1);
        density += f32(atomicLoad(&grid[nodeIndex(node, P.dims) * 4u])) / FP * w;
      }
    }
  }
  let volume = 1.0 / max(density, 1e-3);
  let r = density / P.restDensity;
  // Tait equation of state; mild tension allowed so the surface holds together
  let pressure = clamp(P.stiffness * (pow(r, 7.0) - 1.0), -0.1 * P.stiffness, 40.0 * P.stiffness);
  let strain = C + transpose(C);
  let stress = mat3x3f(-pressure, 0.0, 0.0, 0.0, -pressure, 0.0, 0.0, 0.0, -pressure) + strain * P.viscosity;
  let term = stress * (-volume * 4.0 * P.dt);
  for (var gx = 0; gx < 3; gx++) {
    for (var gy = 0; gy < 3; gy++) {
      for (var gz = 0; gz < 3; gz++) {
        let w = W[gx].x * W[gy].y * W[gz].z;
        let node = cell + vec3i(gx - 1, gy - 1, gz - 1);
        let dist = vec3f(node) - p.xyz + 0.5;
        let mom = (term * w) * dist;
        let n = nodeIndex(node, P.dims) * 4u;
        atomicAdd(&grid[n + 1u], i32(clamp(mom.x * FP, -2e8, 2e8)));
        atomicAdd(&grid[n + 2u], i32(clamp(mom.y * FP, -2e8, 2e8)));
        atomicAdd(&grid[n + 3u], i32(clamp(mom.z * FP, -2e8, 2e8)));
      }
    }
  }
}`;

const GRID = COMMON + COLLIDERS + /* wgsl */`
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(4) var<storage, read_write> grid: array<atomic<i32>>;
@group(0) @binding(5) var<storage, read_write> gridV: array<vec4f>;
@group(0) @binding(6) var<storage, read> col: array<vec4f>;
@group(0) @binding(7) var<storage, read> staticMap: array<u32>;
@group(0) @binding(8) var<storage, read> dynMap: array<u32>;
@group(0) @binding(9) var<storage, read_write> acc: array<atomic<i32>>;

fn collide(k: u32, x: vec3f, v: vec3f) -> vec3f {
  let s = colliderSdf(k, x);
  // nodes within a cell of the surface carry the boundary: particles resting
  // against it are then driven by boundary nodes and do not pancake into it
  if (s.w > 1.0) { return v; }
  let vc = colliderVel(k, x);
  var rel = v - vc;
  let vn = dot(rel, s.xyz);
  if (vn < 0.0) { rel -= s.xyz * vn; }
  return vc + rel;
}

@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let nNodes = P.dims.x * P.dims.y * P.dims.z;
  let n = gid.x;
  if (n >= nNodes) { return; }
  let mi = atomicLoad(&grid[n * 4u]);
  let mx = atomicLoad(&grid[n * 4u + 1u]);
  let my = atomicLoad(&grid[n * 4u + 2u]);
  let mz = atomicLoad(&grid[n * 4u + 3u]);
  atomicStore(&grid[n * 4u], 0);
  atomicStore(&grid[n * 4u + 1u], 0);
  atomicStore(&grid[n * 4u + 2u], 0);
  atomicStore(&grid[n * 4u + 3u], 0);
  if (mi <= 0) { gridV[n] = vec4f(0.0); return; }
  let m = f32(mi) / FP;
  var v = vec3f(f32(mx), f32(my), f32(mz)) / f32(mi) + P.gravity * P.dt;
  let sp = length(v);
  if (sp > P.vmax) { v *= P.vmax / sp; }

  let ix = n % P.dims.x;
  let iy = (n / P.dims.x) % P.dims.y;
  let iz = n / (P.dims.x * P.dims.y);
  let x = vec3f(f32(ix), f32(iy), f32(iz)) + 0.5;

  // scenery
  let sm = staticMap[n];
  if (sm != 0xFFFFFFFFu) { v = collide(unpackId(sm), x, v); }
  // moving bodies: the momentum taken from the liquid is handed to the body
  let dm = dynMap[n];
  if (dm != 0xFFFFFFFFu) {
    let k = unpackId(dm);
    let before = v;
    v = collide(k, x, v);
    let ci = (col[k * 5u + 3u]).w;
    if (ci >= 0.0) {
      let J = (before - v) * m;
      let r = x - col[k * 5u].xyz;
      let T = cross(r, J);
      let b = u32(ci) * 6u;
      atomicAdd(&acc[b], i32(J.x * FP_ACC));
      atomicAdd(&acc[b + 1u], i32(J.y * FP_ACC));
      atomicAdd(&acc[b + 2u], i32(J.z * FP_ACC));
      atomicAdd(&acc[b + 3u], i32(clamp(T.x * FP_ACC, -2e9, 2e9)));
      atomicAdd(&acc[b + 4u], i32(clamp(T.y * FP_ACC, -2e9, 2e9)));
      atomicAdd(&acc[b + 5u], i32(clamp(T.z * FP_ACC, -2e9, 2e9)));
    }
  }
  // domain walls (the floor can open for draining loops)
  if (ix < 3u && v.x < 0.0) { v.x = 0.0; }
  if (ix > P.dims.x - 4u && v.x > 0.0) { v.x = 0.0; }
  if (iy < 3u && v.y < 0.0 && P.floorOpen == 0u) { v.y = 0.0; }
  if (iy > P.dims.y - 4u && v.y > 0.0) { v.y = 0.0; }
  if (iz < 3u && v.z < 0.0) { v.z = 0.0; }
  if (iz > P.dims.z - 4u && v.z > 0.0) { v.z = 0.0; }
  gridV[n] = vec4f(v, m);
}`;

const G2P = COMMON + COLLIDERS + /* wgsl */`
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> vel: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> aff: array<vec4f>;
@group(0) @binding(5) var<storage, read> gridV: array<vec4f>;
@group(0) @binding(6) var<storage, read> col: array<vec4f>;
@group(0) @binding(7) var<storage, read> staticMap: array<u32>;
@group(0) @binding(8) var<storage, read> dynMap: array<u32>;

fn pushOut(k: u32, x: ptr<function, vec3f>, v: ptr<function, vec3f>) {
  let s = colliderSdf(k, *x);
  if (s.w >= P.rp) { return; }
  *x += s.xyz * (P.rp - s.w);
  let vc = colliderVel(k, *x);
  let rel = *v - vc;
  let vn = dot(rel, s.xyz);
  if (vn < 0.0) { *v -= s.xyz * vn; }
}

@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.nActive) { return; }
  let p = pos[i];
  if (p.w == 0.0) { return; }
  let cell = vec3i(floor(p.xyz));
  let d = p.xyz - vec3f(cell) - 0.5;
  var W = array<vec3f, 3>(0.5 * (0.5 - d) * (0.5 - d), 0.75 - d * d, 0.5 * (0.5 + d) * (0.5 + d));
  var v = vec3f(0.0);
  var B = mat3x3f(vec3f(0.0), vec3f(0.0), vec3f(0.0));
  for (var gx = 0; gx < 3; gx++) {
    for (var gy = 0; gy < 3; gy++) {
      for (var gz = 0; gz < 3; gz++) {
        let w = W[gx].x * W[gy].y * W[gz].z;
        let node = cell + vec3i(gx - 1, gy - 1, gz - 1);
        let dist = vec3f(node) - p.xyz + 0.5;
        let gv = gridV[nodeIndex(node, P.dims)].xyz * w;
        v += gv;
        B += mat3x3f(gv * dist.x, gv * dist.y, gv * dist.z);
      }
    }
  }
  let C = B * 4.0 * P.damp;
  v *= P.damp;
  var x = p.xyz + v * P.dt;
  // colliders: the maps keep one (nearest) collider per node, so look at the
  // 8 surrounding nodes; in a corner each wall is nearest to some of them
  let base = vec3i(floor(x - 0.5));
  for (var c = 0; c < 8; c++) {
    let node = clamp(base + vec3i(c & 1, (c >> 1) & 1, (c >> 2) & 1), vec3i(0), vec3i(P.dims) - 1);
    let ni = nodeIndex(node, P.dims);
    let sm = staticMap[ni];
    if (sm != 0xFFFFFFFFu) { pushOut(unpackId(sm), &x, &v); }
    let dm = dynMap[ni];
    if (dm != 0xFFFFFFFFu) { pushOut(unpackId(dm), &x, &v); }
  }
  var alive = 1.0;
  let lo = 2.0 + P.rp;
  let hi = vec3f(P.dims) - 2.0 - P.rp;
  if (P.floorOpen != 0u && x.y < 1.2) { alive = 0.0; }
  if (x.x < lo) { x.x = lo; v.x = max(v.x, 0.0); }
  if (x.x > hi.x) { x.x = hi.x; v.x = min(v.x, 0.0); }
  if (P.floorOpen == 0u && x.y < lo) { x.y = lo; v.y = max(v.y, 0.0); }
  if (x.y > hi.y) { x.y = hi.y; v.y = min(v.y, 0.0); }
  if (x.z < lo) { x.z = lo; v.z = max(v.z, 0.0); }
  if (x.z > hi.z) { x.z = hi.z; v.z = min(v.z, 0.0); }
  x = clamp(x, vec3f(1.0), vec3f(P.dims) - 1.5);
  pos[i] = vec4f(x, alive);
  vel[i] = vec4f(v, 0.0);
  aff[i * 3u] = vec4f(C[0], 0.0);
  aff[i * 3u + 1u] = vec4f(C[1], 0.0);
  aff[i * 3u + 2u] = vec4f(C[2], 0.0);
}`;

// One workgroup per collider: rasterise its distance field into the
// nearest-collider map over its bounding box.
const RASTER = COMMON + COLLIDERS + /* wgsl */`
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(6) var<storage, read> col: array<vec4f>;
@group(0) @binding(10) var<storage, read_write> map: array<atomic<u32>>;
@group(0) @binding(11) var<uniform> range: vec4u; // first collider, count
@compute @workgroup_size(${WG}) fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let k = range.x + wid.x + wid.y * 65535u;
  if (wid.x + wid.y * 65535u >= range.y) { return; }
  let c = col[k * 5u];
  let q = col[k * 5u + 1u];
  let he4 = col[k * 5u + 2u];
  if (he4.w < 0.5) { return; }
  var e = he4.xyz;
  if (c.w > 0.5) { e = vec3f(he4.x); } else {
    let a0 = abs(qrot(q, vec3f(he4.x, 0.0, 0.0)));
    let a1 = abs(qrot(q, vec3f(0.0, he4.y, 0.0)));
    let a2 = abs(qrot(q, vec3f(0.0, 0.0, he4.z)));
    e = a0 + a1 + a2;
  }
  let lo = vec3i(max(floor(c.xyz - e - 1.5), vec3f(0.0)));
  let hi = vec3i(min(ceil(c.xyz + e + 1.5), vec3f(P.dims) - 1.0));
  if (any(hi < lo)) { return; }
  let ext = vec3u(hi - lo) + 1u;
  let total = ext.x * ext.y * ext.z;
  for (var t = lid.x; t < total; t += ${WG}u) {
    let cx = i32(t % ext.x);
    let cy = i32((t / ext.x) % ext.y);
    let cz = i32(t / (ext.x * ext.y));
    let node = lo + vec3i(cx, cy, cz);
    let x = vec3f(node) + 0.5;
    let s = colliderSdf(k, x);
    if (s.w < 1.5) {
      let qd = u32(clamp((s.w + 3.0) / 6.0, 0.0, 1.0) * 1023.0);
      atomicMin(&map[nodeIndex(node, P.dims)], (qd << 20u) | (k & 0xFFFFFu));
    }
  }
}`;

const CLEAR_MAP = /* wgsl */`
@group(0) @binding(0) var<storage, read_write> map: array<u32>;
@group(0) @binding(1) var<uniform> n: vec4u;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * 65535u * 256u;
  if (i < n.x) { map[i] = 0xFFFFFFFFu; }
}`;

// Moving colliders follow the engine bodies (world -> cells).
const SYNC = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> col: array<vec4f>;
@group(0) @binding(2) var<storage, read> bodyOf: array<vec4f>; // engine index, coupled index, he.xyz in cells (as 2 vec4)
@group(0) @binding(3) var<storage, read> ePos: array<vec4f>;
@group(0) @binding(4) var<storage, read> eQuat: array<vec4f>;
@group(0) @binding(5) var<storage, read> eVel: array<vec4f>;
@group(0) @binding(6) var<storage, read> eAng: array<vec4f>;
@group(0) @binding(7) var<uniform> world: array<vec4f, 2>; // origin.xyz, 1/h
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let j = gid.x;
  if (j >= P.nDynamic) { return; }
  let info = bodyOf[j * 2u];
  let he = bodyOf[j * 2u + 1u];
  let bi = u32(info.x);
  let k = P.nStatic + j;
  let invH = world[0].w;
  let present = select(0.0, 1.0, bi < P.engineCount);
  col[k * 5u] = vec4f((ePos[bi].xyz - world[0].xyz) * invH, he.w);
  col[k * 5u + 1u] = normalize(eQuat[bi]);
  col[k * 5u + 2u] = vec4f(he.xyz, present);
  col[k * 5u + 3u] = vec4f(eVel[bi].xyz * invH, info.y);
  col[k * 5u + 4u] = vec4f(eAng[bi].xyz, 0.0);
}`;

// Hands the accumulated momentum to the engine bodies (world units).
const APPLY = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> acc: array<atomic<i32>>;
@group(0) @binding(2) var<storage, read> coupled: array<vec4f>; // [engine index, J scale, T scale, collider+1] [invI.xyz, invMass]
@group(0) @binding(3) var<storage, read> eQuat: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> eVel: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> eAng: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> col: array<vec4f>;
@group(0) @binding(7) var<uniform> world: array<vec4f, 2>;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let j = gid.x;
  let info = coupled[j * 2u];
  if (info.w < 0.5) { return; }
  let bi = u32(info.x);
  let b = j * 6u;
  let J = vec3f(f32(atomicExchange(&acc[b], 0)), f32(atomicExchange(&acc[b + 1u], 0)), f32(atomicExchange(&acc[b + 2u], 0))) / FP_ACC;
  let T = vec3f(f32(atomicExchange(&acc[b + 3u], 0)), f32(atomicExchange(&acc[b + 4u], 0)), f32(atomicExchange(&acc[b + 5u], 0))) / FP_ACC;
  if (bi >= P.engineCount) { return; }
  let inv = coupled[j * 2u + 1u];
  // particle-mass * cells/s -> kg m/s ; torque gets one more cell -> m
  let Jw = J * info.y;
  let Tw = T * info.z;
  var dv = Jw * inv.w;
  let q = normalize(eQuat[bi]);
  var dw = qrot(q, inv.xyz * qrot(qinv(q), Tw));
  let lv = length(dv); if (lv > 2.0) { dv *= 2.0 / lv; }
  let lw = length(dw); if (lw > 6.0) { dw *= 6.0 / lw; }
  eVel[bi] = vec4f(eVel[bi].xyz + dv, eVel[bi].w);
  eAng[bi] = vec4f(eAng[bi].xyz + dw, eAng[bi].w);
  // the collider slows down within the frame too, so later substeps do not
  // keep pushing the liquid with a stale velocity (that over-counted momentum
  // and made heavy bodies bounce off the surface)
  let k = u32(info.w) - 1u;
  col[k * 5u + 3u] = vec4f(col[k * 5u + 3u].xyz + dv * world[0].w, col[k * 5u + 3u].w);
  col[k * 5u + 4u] = vec4f(col[k * 5u + 4u].xyz + dw, 0.0);
}`;

const ACTIVATE = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> vel: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> aff: array<vec4f>;
@group(0) @binding(4) var<storage, read> init: array<vec4f>; // pos (cells), vel (cells/s)
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = P.activateFrom + gid.x;
  if (i >= P.activateTo) { return; }
  pos[i] = vec4f(init[i * 2u].xyz, 1.0);
  vel[i] = vec4f(init[i * 2u + 1u].xyz, 0.0);
  aff[i * 3u] = vec4f(0.0);
  aff[i * 3u + 1u] = vec4f(0.0);
  aff[i * 3u + 2u] = vec4f(0.0);
}`;

// History sample: x|y (16+16 bits), z (16) | speed (15) | alive (1), positions
// normalised to the simulation box.
const RECORD = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read> vel: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> hist: array<vec2u>;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.nActive) { return; }
  let p = pos[i];
  let u = vec3u(round(clamp(p.xyz / vec3f(P.dims), vec3f(0.0), vec3f(1.0)) * 65535.0));
  let speed = u32(clamp(length(vel[i].xyz) * P.cellM * 100.0, 0.0, 32767.0));
  let alive = select(0u, 1u, p.w > 0.0);
  hist[P.historyBase + i] = vec2u(u.x | (u.y << 16u), u.z | (speed << 16u) | (alive << 31u));
}`;

type Binding = [number, GPUBuffer];

export interface FluidHistory {
  buffer: GPUBuffer;
  count: number; // particles per recorded frame
  frames: number;
}

export class FluidSolver {
  readonly count: number;
  readonly dims: [number, number, number];
  readonly nodes: number;
  readonly substeps: number;
  private params = new ArrayBuffer(96);
  private paramsF = new Float32Array(this.params);
  private paramsU = new Uint32Array(this.params);
  private paramsBuf: GPUBuffer;
  private bufs: Record<string, GPUBuffer> = {};
  private pipes: Record<string, GPUComputePipeline> = {};
  private groups: Record<string, GPUBindGroup> = {};
  private nStatic: number;
  private nDynamic: number;
  private nCoupled: number;
  private active = 0;
  private engineBound = false;
  floorOpen = false;

  constructor(
    private device: GPUDevice,
    private fluid: FluidBuilt,
    bodies: BuiltBody[],
    settings: FluidSettings,
    fps: number,
    timeScale: number,
    gravity: number,
  ) {
    const f = fluid;
    this.count = f.count;
    this.dims = f.dims;
    this.nodes = f.dims[0] * f.dims[1] * f.dims[2];
    const h = f.h;
    const frameDt = timeScale / fps;
    const c = Math.max(1, settings.soundSpeed) / h; // cells/s
    this.substeps = settings.substeps > 0 ? Math.round(settings.substeps) : Math.max(2, Math.ceil(c * frameDt / 0.33));
    const dt = frameDt / this.substeps;
    const rest = PARTICLES_PER_CELL;
    const stiffness = (c * c * rest) / 7;

    // --- colliders: static first, then every non-static body (moving / coupled)
    const inBox = (b: BuiltBody) => {
      const r = Math.hypot(b.he[0], b.he[1], b.he[2]);
      for (let k = 0; k < 3; k++) {
        if (b.pos[k] + r < f.origin[k] || b.pos[k] - r > f.origin[k] + f.dims[k] * h) return b.kind !== KIND_STATIC;
      }
      return true;
    };
    const stat = bodies.map((b, i) => i).filter((i) => bodies[i].kind === KIND_STATIC && inBox(bodies[i]));
    const moving = bodies.map((b, i) => i).filter((i) => bodies[i].kind !== KIND_STATIC);
    this.nStatic = stat.length;
    this.nDynamic = moving.length;
    const nCol = Math.max(1, this.nStatic + this.nDynamic);
    const col = new Float32Array(nCol * COLLIDER_VEC4 * 4);
    stat.forEach((bi, k) => {
      const b = bodies[bi];
      const o = k * 20;
      col.set([(b.pos[0] - f.origin[0]) / h, (b.pos[1] - f.origin[1]) / h, (b.pos[2] - f.origin[2]) / h, b.shape], o);
      col.set(b.quat, o + 4);
      col.set([b.he[0] / h, b.he[1] / h, b.he[2] / h, 1], o + 8);
      col.set([0, 0, 0, -1], o + 12);
    });
    // moving bodies: engine index, coupled index (dynamic only)
    const particleMass = settings.density * 8 * h * h * h / rest; // kg (body density 1 => 8 kg/m3)
    const bodyOf = new Float32Array(Math.max(1, this.nDynamic) * 8);
    const coupledList: number[] = [];
    moving.forEach((bi, j) => {
      const b = bodies[bi];
      const dyn = b.kind === KIND_DYNAMIC;
      const ci = dyn ? coupledList.length : -1;
      if (dyn) coupledList.push(bi);
      bodyOf.set([bi + 1, ci, 0, 0, b.he[0] / h, b.he[1] / h, b.he[2] / h, b.shape], j * 8);
    });
    this.nCoupled = coupledList.length;
    const coupled = new Float32Array(Math.max(1, this.nCoupled) * 8);
    const colliderOf = new Map<number, number>();
    moving.forEach((bi, j) => colliderOf.set(bi, this.nStatic + j));
    coupledList.forEach((bi, j) => {
      const b = bodies[bi];
      const m = b.mass;
      let I: number[];
      if (b.shape === 1) { const v = 0.4 * m * b.he[0] * b.he[0]; I = [v, v, v]; } else {
        const [x, y, z] = [b.he[0] * 2, b.he[1] * 2, b.he[2] * 2];
        I = [m * (y * y + z * z) / 12, m * (x * x + z * z) / 12, m * (x * x + y * y) / 12];
      }
      coupled.set([bi + 1, particleMass * h, particleMass * h * h, colliderOf.get(bi)! + 1, 1 / I[0], 1 / I[1], 1 / I[2], 1 / m], j * 8);
    });

    // --- buffers
    const dev = device;
    const mk = (name: string, size: number, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC) => {
      this.bufs[name] = dev.createBuffer({ label: `fluid.${name}`, size: Math.max(16, Math.ceil(size / 16) * 16), usage });
      return this.bufs[name];
    };
    this.paramsBuf = dev.createBuffer({ label: 'fluid.params', size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    mk('pos', f.count * 16);
    mk('vel', f.count * 16);
    mk('aff', f.count * 48);
    mk('grid', this.nodes * 16);
    mk('gridV', this.nodes * 16);
    mk('col', col.byteLength);
    mk('staticMap', this.nodes * 4);
    mk('dynMap', this.nodes * 4);
    mk('acc', Math.max(1, this.nCoupled) * 24);
    mk('init', f.count * 32);
    mk('bodyOf', bodyOf.byteLength);
    mk('coupled', coupled.byteLength);
    const range = (first: number, n: number) => {
      const b = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(b, 0, new Uint32Array([first, n, 0, 0]));
      return b;
    };
    this.bufs.rangeStatic = range(0, this.nStatic);
    this.bufs.rangeDyn = range(this.nStatic, this.nDynamic);
    this.bufs.mapCount = range(this.nodes, 0);
    this.bufs.world = dev.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(this.bufs.world, 0, new Float32Array([f.origin[0], f.origin[1], f.origin[2], 1 / h, 0, 0, 0, 0]));

    const init = new Float32Array(f.count * 8);
    for (let i = 0; i < f.count; i++) {
      init.set([(f.pos[i * 4] - f.origin[0]) / h, (f.pos[i * 4 + 1] - f.origin[1]) / h, (f.pos[i * 4 + 2] - f.origin[2]) / h, 0,
        f.vel[i * 4] / h, f.vel[i * 4 + 1] / h, f.vel[i * 4 + 2] / h, 0], i * 8);
    }
    dev.queue.writeBuffer(this.bufs.init, 0, init);
    dev.queue.writeBuffer(this.bufs.col, 0, col);
    dev.queue.writeBuffer(this.bufs.bodyOf, 0, bodyOf);
    dev.queue.writeBuffer(this.bufs.coupled, 0, coupled);

    // --- params
    const U = this.paramsU, F = this.paramsF;
    U[0] = f.dims[0]; U[1] = f.dims[1]; U[2] = f.dims[2];
    F[4] = 0; F[5] = -gravity / h; F[6] = 0; F[7] = dt;
    F[8] = rest; F[9] = stiffness; F[10] = Math.max(0, settings.viscosity) * 30; F[11] = 0.45 / dt;
    U[13] = this.nStatic; U[14] = this.nDynamic;
    F[16] = 0.3; F[17] = frameDt; F[18] = h; F[23] = 1;

    // --- pipelines
    const pipe = (name: string, code: string) => {
      const module = dev.createShaderModule({ label: `fluid.${name}`, code });
      this.pipes[name] = dev.createComputePipeline({ label: `fluid.${name}`, layout: 'auto', compute: { module, entryPoint: 'main' } });
    };
    pipe('p2g1', P2G1); pipe('p2g2', P2G2); pipe('grid', GRID); pipe('g2p', G2P);
    pipe('raster', RASTER); pipe('clearMap', CLEAR_MAP); pipe('sync', SYNC); pipe('apply', APPLY);
    pipe('activate', ACTIVATE); pipe('record', RECORD);

    const B = this.bufs, Pb = this.paramsBuf;
    this.groups.p2g1 = this.group('p2g1', [[0, Pb], [1, B.pos], [2, B.vel], [3, B.aff], [4, B.grid]]);
    this.groups.p2g2 = this.group('p2g2', [[0, Pb], [1, B.pos], [3, B.aff], [4, B.grid]]);
    this.groups.grid = this.group('grid', [[0, Pb], [4, B.grid], [5, B.gridV], [6, B.col], [7, B.staticMap], [8, B.dynMap], [9, B.acc]]);
    this.groups.g2p = this.group('g2p', [[0, Pb], [1, B.pos], [2, B.vel], [3, B.aff], [5, B.gridV], [6, B.col], [7, B.staticMap], [8, B.dynMap]]);
    this.groups.rasterStatic = this.group('raster', [[0, Pb], [6, B.col], [10, B.staticMap], [11, B.rangeStatic]]);
    this.groups.rasterDyn = this.group('raster', [[0, Pb], [6, B.col], [10, B.dynMap], [11, B.rangeDyn]]);
    this.groups.clearStatic = this.group('clearMap', [[0, B.staticMap], [1, B.mapCount]]);
    this.groups.clearDyn = this.group('clearMap', [[0, B.dynMap], [1, B.mapCount]]);
    this.groups.activate = this.group('activate', [[0, Pb], [1, B.pos], [2, B.vel], [3, B.aff], [4, B.init]]);

    // static scenery is rasterised once
    this.writeParams();
    const enc = dev.createCommandEncoder({ label: 'fluid.init' });
    const pass = enc.beginComputePass();
    this.dispatchClear(pass, 'clearStatic');
    this.dispatchClear(pass, 'clearDyn');
    if (this.nStatic > 0) {
      pass.setPipeline(this.pipes.raster);
      pass.setBindGroup(0, this.groups.rasterStatic);
      pass.dispatchWorkgroups(Math.min(this.nStatic, 65535), Math.ceil(this.nStatic / 65535));
    }
    pass.end();
    dev.queue.submit([enc.finish()]);
  }

  /** Binds the AVBD engine buffers (they exist once the engine has stepped). */
  bindEngine(buffers: { pos: GPUBuffer; quat: GPUBuffer; vel: GPUBuffer; ang: GPUBuffer }): void {
    const B = this.bufs, Pb = this.paramsBuf;
    if (this.nDynamic > 0) {
      this.groups.sync = this.group('sync', [[0, Pb], [1, B.col], [2, B.bodyOf], [3, buffers.pos], [4, buffers.quat], [5, buffers.vel], [6, buffers.ang], [7, B.world]]);
    }
    if (this.nCoupled > 0) {
      this.groups.apply = this.group('apply', [[0, Pb], [1, B.acc], [2, B.coupled], [3, buffers.quat], [4, buffers.vel], [5, buffers.ang], [6, B.col], [7, B.world]]);
    }
    this.engineBound = true;
  }

  get needsEngine(): boolean { return this.nDynamic > 0 && !this.engineBound; }

  bindHistory(buffer: GPUBuffer): void {
    this.groups.record = this.group('record', [[0, this.paramsBuf], [1, this.bufs.pos], [2, this.bufs.vel], [3, buffer]]);
  }

  /** Activates the particles spawned up to `frame`. */
  activate(frame: number): void {
    const to = this.fluid.activeAt[Math.min(frame, this.fluid.activeAt.length - 1)];
    if (to <= this.active) return;
    this.paramsU[20] = this.active; this.paramsU[21] = to;
    this.active = to;
    this.paramsU[3] = to;
    this.writeParams();
    const enc = this.device.createCommandEncoder({ label: 'fluid.activate' });
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipes.activate);
    pass.setBindGroup(0, this.groups.activate);
    pass.dispatchWorkgroups(Math.ceil((to - this.paramsU[20]) / WG));
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /** Writes the current particles into history slot `slot`. */
  record(slot: number): void {
    if (!this.groups.record || this.active === 0) return;
    this.paramsU[22] = slot * this.count;
    this.writeParams();
    const enc = this.device.createCommandEncoder({ label: 'fluid.record' });
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipes.record);
    pass.setBindGroup(0, this.groups.record);
    pass.dispatchWorkgroups(Math.ceil(this.active / WG));
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /**
   * Pre-roll with damped velocities so a resting pool starts in hydrostatic
   * equilibrium instead of slumping and ringing at frame 0.
   */
  settle(frames: number): void {
    this.paramsF[23] = 0.86;
    for (let i = 0; i < frames; i++) this.step(0);
    this.paramsF[23] = 1;
    this.writeParams();
  }

  /** Advances one frame; colliders follow the engine's current poses. */
  step(engineCount: number): void {
    if (this.active === 0) return;
    this.paramsU[3] = this.active;
    this.paramsU[12] = this.floorOpen ? 1 : 0;
    this.paramsU[15] = engineCount;
    this.writeParams();
    const enc = this.device.createCommandEncoder({ label: 'fluid.step' });
    const pass = enc.beginComputePass();
    if (this.nDynamic > 0 && this.groups.sync) {
      pass.setPipeline(this.pipes.sync);
      pass.setBindGroup(0, this.groups.sync);
      pass.dispatchWorkgroups(Math.ceil(this.nDynamic / WG));
      this.dispatchClear(pass, 'clearDyn');
      pass.setPipeline(this.pipes.raster);
      pass.setBindGroup(0, this.groups.rasterDyn);
      pass.dispatchWorkgroups(Math.min(this.nDynamic, 65535), Math.ceil(this.nDynamic / 65535));
    }
    const pw = Math.ceil(this.active / WG), gw = Math.ceil(this.nodes / WG);
    for (let s = 0; s < this.substeps; s++) {
      pass.setPipeline(this.pipes.p2g1); pass.setBindGroup(0, this.groups.p2g1); pass.dispatchWorkgroups(pw);
      pass.setPipeline(this.pipes.p2g2); pass.setBindGroup(0, this.groups.p2g2); pass.dispatchWorkgroups(pw);
      pass.setPipeline(this.pipes.grid); pass.setBindGroup(0, this.groups.grid); this.dispatch1D(pass, gw);
      pass.setPipeline(this.pipes.g2p); pass.setBindGroup(0, this.groups.g2p); pass.dispatchWorkgroups(pw);
      if (this.nCoupled > 0 && this.groups.apply) {
        pass.setPipeline(this.pipes.apply);
        pass.setBindGroup(0, this.groups.apply);
        pass.dispatchWorkgroups(Math.ceil(this.nCoupled / WG));
      }
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  dispose(): void {
    for (const b of Object.values(this.bufs)) b.destroy();
    this.paramsBuf.destroy();
  }

  // ---------------------------------------------------------------------------

  private group(pipe: string, entries: Binding[]): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.pipes[pipe].getBindGroupLayout(0),
      entries: entries.map(([binding, buffer]) => ({ binding, resource: { buffer } })),
    });
  }

  private dispatch1D(pass: GPUComputePassEncoder, groups: number): void {
    // 1D dispatches only: the grid kernel indexes with global_invocation_id.x
    pass.dispatchWorkgroups(Math.min(groups, 65535), 1);
    if (groups > 65535) throw new Error('Fluid grid too large');
  }

  private dispatchClear(pass: GPUComputePassEncoder, group: string): void {
    pass.setPipeline(this.pipes.clearMap);
    pass.setBindGroup(0, this.groups[group]);
    const g = Math.ceil(this.nodes / 256);
    pass.dispatchWorkgroups(Math.min(g, 65535), Math.ceil(g / 65535));
  }

  private writeParams(): void {
    this.device.queue.writeBuffer(this.paramsBuf, 0, this.params);
  }
}
