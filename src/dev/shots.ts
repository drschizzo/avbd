// Dev-only diagnostics: `shots(key, times)` saves frames to .debug/,
// `seam(key)` measures the visual jump across the loop point (last frame vs
// first frame, mean abs RGB diff, plus a diff image), `hist(key)` reads the
// baked history back to inspect final body positions.

import type { App } from '../app';
import { setFrame } from '../export/video';
import * as THREE from 'three/webgpu';
import { createEntity } from '../scene/entities';
import { defaultDoc } from '../scene/doc';

async function save(name: string, blob: Blob): Promise<void> {
  await fetch(`/__debug/save?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
}

async function grab(app: App, t: number, w: number, h: number): Promise<ImageData> {
  const { snapshotPNG } = await import('../export/video');
  if (app.mode !== 'play') app.setMode('play');
  app.playing = false;
  app.time = t;
  const blob = await snapshotPNG(app, w, h);
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, w, h);
}

async function toPng(img: ImageData): Promise<Blob> {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}

async function bakeFull(app: App, key?: string): Promise<void> {
  app.autoBake = false;
  if (key) app.loadPreset(key);
  await app.bake();
  app.playing = false;
  app.setMode('play');
}

export function installShots(app: App): void {
  const w = window as any;
  // Gadget bench: mk(type, overrides) builds an entity, rig(list, patch)
  // bakes a scene made of them and returns the machine check plus the final
  // pose of every body of each entity (name -> [[x,y,z],...]).
  w.mk = (type: string, o: any = {}) => createEntity(type as any, o);
  /** traj(entityName, nth dynamic body, every s): sampled x,y from the machine check. */
  w.traj = (name: string, nth = 0, every = 0.2) => {
    const r = app.report;
    if (!r) return '';
    const ei = app.doc.entities.findIndex((e) => e.name === name);
    const ids: number[] = [];
    app.built.bodies.forEach((b, i) => { if (b.entity === ei && b.kind === 0) ids.push(i); });
    const k = (ids[nth] + 1) * 4;
    const out: string[] = [];
    let next = 0;
    r.samples.forEach((smp, j) => {
      if (r.sampleTimes[j] + 1e-6 < next) return;
      next += every;
      const f = new Float32Array(smp.buffer, smp.byteOffset, smp.length);
      out.push(`${r.sampleTimes[j].toFixed(1)}:${f[k].toFixed(2)},${f[k + 1].toFixed(2)}`);
    });
    return out.join(' ');
  };
  /** machine(key|null): bake a preset (or the current scene) and summarise its check. */
  w.machine = async (key: string | null) => {
    app.autoBake = false;
    if (key) app.loadPreset(key);
    await app.bake();
    for (let i = 0; i < 100 && (app.analyzing || !app.report); i++) await new Promise((r) => setTimeout(r, 50));
    const r = app.report!;
    return { ok: r.ok, simEnd: r.simEnd, ents: r.entities.map((e) => `${e.name}:${e.status}:${e.activated}/${e.bodies}@${e.first?.toFixed(2)}`).join(' | '), sensors: r.sensors.map((x) => `${x.name}:${x.triggered?.toFixed(2)}`), issues: r.issues.map((x) => x.text) };
  };
  w.rig = async (list: any[], patch: (d: any) => void = () => {}) => {
    const d = defaultDoc();
    d.name = 'rig';
    d.entities = list;
    d.camera = { position: [0, 4, 9], target: [0, 1, 0], fov: 40, motion: 'static', amount: 0, cycles: 1 };
    d.loop.mode = 'boomerang';
    patch(d);
    app.autoBake = false;
    app.setDoc(d);
    await app.bake();
    for (let i = 0; i < 100 && (app.analyzing || !app.report); i++) await new Promise((r) => setTimeout(r, 50));
    const r = app.report!;
    const last = r.samples[r.samples.length - 1];
    const f = new Float32Array(last.buffer, last.byteOffset, last.length);
    const ends: Record<string, number[][]> = {};
    app.built.bodies.forEach((b, i) => {
      if (b.kind !== 0) return;
      const n = app.doc.entities[b.entity].name;
      (ends[n] ??= []).push([+f[(i + 1) * 4].toFixed(2), +f[(i + 1) * 4 + 1].toFixed(2), +f[(i + 1) * 4 + 2].toFixed(2)]);
    });
    return { ok: r.ok, ents: r.entities.map((e) => `${e.name}:${e.status}:${e.activated}/${e.bodies}@${e.first?.toFixed(2)}`), sensors: r.sensors.map((x) => `${x.name}:${x.triggered}`), motionEnd: r.motionEnd, issues: r.issues.map((x) => x.text), ends };
  };
  /** soloN(['prefix', ...]): solo the entities whose name starts with one of the prefixes. */
  w.soloN = (names: string[]) => {
    const ids = app.doc.entities.filter((e) => names.some((n) => e.name.startsWith(n))).map((e) => e.id);
    app.setSolo(ids);
    return ids.length;
  };
  w.ent = (name: string) => app.doc.entities.find((e) => e.name === name);
  /** traj3(entityName, nth dynamic body, every s, from, to): sampled x,y,z. */
  w.traj3 = (name: string, nth = 0, every = 0.25, from = 0, to = 1e9) => {
    const r = app.report;
    if (!r) return '';
    const ei = app.doc.entities.findIndex((e) => e.name === name);
    const ids: number[] = [];
    app.built.bodies.forEach((b, i) => { if (b.entity === ei && b.kind === 0) ids.push(i); });
    if (ids[nth] === undefined) return 'no body';
    const k = (ids[nth] + 1) * 4;
    const out: string[] = [];
    let next = from;
    r.samples.forEach((smp, j) => {
      const t = r.sampleTimes[j];
      if (t + 1e-6 < next || t > to) return;
      next += every;
      const f = new Float32Array(smp.buffer, smp.byteOffset, smp.length);
      out.push(`${t.toFixed(2)}:${f[k].toFixed(2)},${f[k + 1].toFixed(2)},${f[k + 2].toFixed(2)}`);
    });
    return out.join(' ');
  };
  /** view(name, pos, target, w, h, t?): frame of the current scene from any camera (edit pose, or baked time t). */
  w.view = async (name: string, pos: number[], target: number[], wd = 960, ht = 540, t?: number) => {
    const { snapshotPNG } = await import('../export/video');
    const saved = { ...app.doc.camera };
    app.doc.camera = { ...saved, position: pos as any, target: target as any, motion: 'static' };
    app.applyCameraFromDoc();
    try {
      if (t !== undefined) { app.setMode('play'); app.playing = false; app.time = t; } else app.setMode('edit');
      await save(`v-${name}.png`, await snapshotPNG(app, wd, ht));
    } finally {
      app.doc.camera = saved;
      app.applyCameraFromDoc();
    }
    return 'ok';
  };
  /** shot(name, t, w, h): frame of the baked clip at video time t, through the shot camera. */
  w.shot = async (name: string, t: number, wd = 960, ht = 540) => {
    const { snapshotPNG } = await import('../export/video');
    app.setMode('play'); app.playing = false; app.time = t;
    await save(`shot-${name}.png`, await snapshotPNG(app, wd, ht));
    return 'ok';
  };
  w.shots = async (key: string | null, times: number[], size = 640, name?: string) => {
    if (key) await bakeFull(app, key);
    const tag = name ?? key ?? 'cur';
    for (const t of times) {
      const img = await grab(app, t, size, size);
      await save(`s-${tag}-${t.toFixed(2)}.png`, await toPng(img));
    }
    return 'ok';
  };
  w.seam = async (key: string | null, size = 360) => {
    if (key) await bakeFull(app, key);
    const D = app.doc.duration, fps = app.doc.fps;
    const a = await grab(app, D - 1 / fps, size, size);
    const b = await grab(app, 0, size, size);
    const c = await grab(app, 1 / fps, size, size);
    const diff = (x: ImageData, y: ImageData) => {
      let s = 0; let big = 0;
      const out = new ImageData(x.width, x.height);
      for (let i = 0; i < x.data.length; i += 4) {
        const d = (Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2])) / 3;
        s += d; if (d > 24) big++;
        out.data[i] = out.data[i + 1] = out.data[i + 2] = Math.min(255, d * 4); out.data[i + 3] = 255;
      }
      return { mean: s / (x.width * x.height), bigFrac: big / (x.width * x.height), out };
    };
    const seamD = diff(a, b), ref = diff(b, c);
    const tag = key ?? 'cur';
    await save(`seam-${tag}-end.png`, await toPng(a));
    await save(`seam-${tag}-start.png`, await toPng(b));
    await save(`seam-${tag}-diff.png`, await toPng(seamD.out));
    return { key: tag, seamMean: +seamD.mean.toFixed(3), seamBig: +seamD.bigFrac.toFixed(4), refMean: +ref.mean.toFixed(3), refBig: +ref.bigFrac.toFixed(4) };
  };
  w.hist = async (frame = -1) => {
    const res = app.result;
    if (!res) return null;
    const raw = await (app.stage.renderer as any).getArrayBufferAsync(res.history);
    const u = new Uint32Array(raw);
    const f = new Float32Array(raw);
    const fr = frame < 0 ? res.frames - 1 : frame;
    const out: { i: number; p: number[]; kind: number; spawn: number; he: number[] }[] = [];
    app.built.bodies.forEach((b, i) => {
      const o = (fr * res.stride + i + 1) * 4;
      out.push({ i, p: [f[o], f[o + 1], f[o + 2]], kind: b.kind, spawn: b.spawnFrame, he: b.he });
    });
    void u;
    return out;
  };
  /** Bakes a preset (or the current doc) and counts dynamic bodies per y band at a few frames. */
  w.bands = async (key: string | null, bands: number[], frames: number[]) => {
    if (key) await bakeFull(app, key); else if (!app.result) { app.autoBake = false; await app.bake(); }
    const out: Record<string, number[]> = {};
    for (const f of frames) {
      const h = await w.hist(f);
      const ys = h.filter((b: any) => b.kind === 0).map((b: any) => b.p[1]);
      out[f] = bands.map((lo, i) => ys.filter((y: number) => y >= lo && (i + 1 >= bands.length || y < bands[i + 1])).length);
    }
    return out;
  };
  /** Galton diagnostics: bin histogram + spread (in bins) at a frame. */
  w.galDist = async (frame: number, spacing: number, binTop: number) => {
    const h = await w.hist(frame);
    const xs = h.filter((b: any) => b.kind === 0 && b.p[1] < binTop).map((b: any) => Math.round(b.p[0] / spacing));
    const hist: Record<number, number> = {};
    for (const k of xs) hist[k] = (hist[k] ?? 0) + 1;
    const mean = xs.reduce((a: number, b: number) => a + b, 0) / Math.max(1, xs.length);
    const sd = Math.sqrt(xs.reduce((a: number, b: number) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length));
    return { n: xs.length, sd: +sd.toFixed(2), hist: Object.keys(hist).map(Number).sort((a, b) => a - b).map((k) => hist[k]).join(' ') };
  };
  w.galRun = async (params: any = {}, physics: any = {}) => {
    const P = await import('../scene/presets');
    const d = P.PRESETS.find((p) => p.key === 'galton')!.make();
    Object.assign(d.entities[0].params, params);
    Object.assign(d.physics, physics);
    app.autoBake = false;
    app.setDoc(d);
    await app.bake();
    const b = await w.bands(null, [-9, 0.1, d.entities[0].params.binHeight + 0.1, 3.3], [240, 480, 552]);
    return { bands: b, dist: await w.galDist(552, d.entities[0].params.spacing, d.entities[0].params.binHeight + 0.1) };
  };
  /** Hourglass: dynamic bodies that ever leave the (flipping) glass. */
  w.hgLeak = async () => {
    const res = app.result;
    if (!res) return null;
    const raw = new Float32Array(await (app.stage.renderer as any).getArrayBufferAsync(res.history));
    const N = res.stride, B = app.built.bodies, m = app.built.motions[0], c = m.origin;
    const e = app.doc.entities.find((x) => x.type === 'hourglass')!.params;
    const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10));
    const out: string[] = [];
    for (let i = 0; i < B.length; i++) {
      if (B[i].kind !== 0) continue;
      for (let f = 0; f < res.frames; f += 2) {
        const o = (f * N + i + 1) * 4;
        const ang = Math.PI * smooth((f / app.doc.fps - m.tOpen) / m.ease);
        const x = raw[o] - c[0], y = raw[o + 1] - c[1], z = raw[o + 2] - c[2];
        const lx = Math.cos(-ang) * x - Math.sin(-ang) * y, ly = Math.sin(-ang) * x + Math.cos(-ang) * y;
        if (Math.hypot(lx, z) > e.radius + 0.06 || Math.abs(ly) > e.height + 0.1) { out.push([f, lx.toFixed(2), ly.toFixed(2), z.toFixed(2)].join(',')); break; }
      }
    }
    return out;
  };
  /** Galton: share of beads in the bins when the rewind starts, arrival time, spread, pile height. */
  w.galTry = async (params: any = {}, physics: any = {}, duration?: number, loop: any = {}) => {
    const P = await import('../scene/presets');
    const d = P.PRESETS.find((p) => p.key === 'galton')!.make();
    if (duration) d.duration = duration;
    Object.assign(d.entities[0].params, params);
    Object.assign(d.physics, physics);
    Object.assign(d.loop, loop);
    app.autoBake = false;
    app.setDoc(d);
    await app.bake();
    const ep = d.entities[0].params, binTop = ep.binHeight + 0.1;
    const fr = Math.round((d.duration - d.loop.outro) * d.fps) - 1;
    const dyn = (await w.hist(fr)).filter((b: any) => b.kind === 0);
    const inBins = dyn.filter((b: any) => b.p[1] < binTop);
    const xs = inBins.map((b: any) => Math.round(b.p[0] / ep.spacing));
    const hh: Record<number, number> = {};
    xs.forEach((k: number) => { hh[k] = (hh[k] ?? 0) + 1; });
    const m = xs.reduce((a: number, b: number) => a + b, 0) / Math.max(1, xs.length);
    const sd = Math.sqrt(xs.reduce((a: number, b: number) => a + (b - m) ** 2, 0) / Math.max(1, xs.length));
    let t95: number | null = null;
    for (let f = 60; f <= fr; f += 30) {
      const n = (await w.hist(f)).filter((b: any) => b.kind === 0 && b.p[1] < binTop).length;
      if (n >= 0.95 * dyn.length) { t95 = f / d.fps; break; }
    }
    return {
      frac: +(inBins.length / dyn.length).toFixed(2), t95, rewindAt: d.duration - d.loop.outro, sd: +sd.toFixed(2),
      peakH: +Math.max(0, ...inBins.map((b: any) => b.p[1])).toFixed(2), bake: Math.round(app.baker.lastStats.totalMs / 1000),
      hist: Object.keys(hh).map(Number).sort((a, b) => a - b).map((k) => hh[k]).join(' '),
    };
  };
  /** Liquid: decoded particle stats at a recorded fluid frame. */
  w.fluidStats = async (frame = -1) => {
    const res = app.result ?? app.baker.currentPartial;
    const fr = res?.fluid, fb = app.built.fluid;
    if (!fr || !fb) return null;
    const raw = new Uint32Array(await (app.stage.renderer as any).getArrayBufferAsync(fr.history));
    const f = frame < 0 ? fr.frames - 1 : frame;
    let alive = 0, sy = 0, maxY = -1e9, minY = 1e9, maxSpeed = 0, nan = 0;
    const ext = [fb.dims[0] * fb.h, fb.dims[1] * fb.h, fb.dims[2] * fb.h];
    let minX = 1e9, maxX = -1e9;
    for (let i = 0; i < fr.count; i++) {
      const a = raw[(f * fr.count + i) * 2], b = raw[(f * fr.count + i) * 2 + 1];
      if (!(b >>> 31)) continue;
      alive++;
      const x = fb.origin[0] + ((a & 0xffff) / 65535) * ext[0];
      const y = fb.origin[1] + ((a >>> 16) / 65535) * ext[1];
      if (!isFinite(y)) nan++;
      sy += y; maxY = Math.max(maxY, y); minY = Math.min(minY, y); minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      maxSpeed = Math.max(maxSpeed, ((b >>> 16) & 0x7fff) / 100);
    }
    return { frame: f, alive, meanY: +(sy / Math.max(1, alive)).toFixed(3), minY: +minY.toFixed(3), maxY: +maxY.toFixed(3), minX: +minX.toFixed(2), maxX: +maxX.toFixed(2), maxSpeed, nan, count: fr.count, substeps: app.baker.fluid?.substeps, dims: fb.dims, h: +fb.h.toFixed(3) };
  };
  /** Small liquid test scenes. */
  w.fluidTest = async (kind = 'tank', duration = 3) => {
    const E = await import('../scene/entities');
    const D = await import('../scene/doc');
    const d = D.defaultDoc();
    d.loop.mode = 'none'; d.duration = duration; d.physics.settle = 0;
    d.camera = { position: [3.2, 2.2, 3.6], target: [0, 0.3, 0], fov: 38, motion: 'static', amount: 0, cycles: 1 };
    d.entities.push(E.createEntity('container', { params: { size: [2, 1.2, 1.2], thickness: 0.08, floor: false, lid: false } }));
    d.entities.push(E.createEntity('fluidBlock', { position: [-0.5, 0, 0], params: { size: [1, 0.8, 1.2] } }));
    if (kind === 'float') {
      d.entities.push(E.createEntity('box', { name: 'light', position: [0.5, 0.9, 0], params: { size: [0.3, 0.3, 0.3] }, phys: { body: 'dynamic', density: 0.4, friction: 0.5, velocity: [0, 0, 0], angularVelocity: [0, 0, 0], spawnAt: 0 } }));
    }
    app.autoBake = false;
    app.setDoc(d);
    await app.bake();
    return app.bakeError;
  };
  /** Continuous loops: how far each body travels to its matched twin at the seam. */
  w.matchStats = async (noSwap = false) => {
    const r = app.result;
    if (!r?.tail) return null;
    const pe = await w.hist(r.frames - 1), we = await w.hist(r.tail.base + r.tail.count - 1);
    const { matchLoop } = await import('../sim/loopMatch');
    (globalThis as any).__matchNoSwap = noSwap;
    const t = (await matchLoop(app.device, app.stage.renderer, r, app.built, app.doc))!;
    (globalThis as any).__matchNoSwap = false;
    const ds: number[] = [];
    let hops = 0, swaps = 0;
    for (let i = 0; i < pe.length; i++) {
      if (pe[i].kind !== 0) continue;
      const j = t[(i + 1) * 4] - 1;
      if (t[(i + 1) * 4 + 2]) hops++;
      if (t[(i + 1) * 4 + 3]) swaps++;
      const a = pe[i].p, b = we[j].p;
      if (a[1] < -8 && b[1] < -8) continue;
      ds.push(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
    ds.sort((a, b) => a - b);
    const q = (f: number) => +ds[Math.min(ds.length - 1, Math.floor(ds.length * f))].toFixed(3);
    return ds.length ? { n: ds.length, hops, swaps, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: q(1) } : null;
  };
  /** Bakes a preset, saves frames (named after it), measures the seam. */
  w.evalPreset = async (key: string, times?: number[]) => {
    app.autoBake = false;
    app.loadPreset(key);
    await app.bake();
    await new Promise((r) => setTimeout(r, 1500));
    if (times) await w.shots(null, times, 480, key);
    const sm = await w.seam(null, 360);
    return { key, seam: sm, match: await w.matchStats(), bakeS: Math.round(app.baker.lastStats.totalMs / 1000), err: app.bakeError };
  };
  /**
   * When does a preset calm down? Bakes it without a loop transition (full
   * clip simulated) and returns, every half second, the share of dynamic
   * bodies still moving faster than `minSpeed` (m/s).
   */
  w.activity = async (key: string, minSpeed = 0.15) => {
    const P = await import('../scene/presets');
    const d = P.PRESETS.find((p) => p.key === key)!.make();
    d.loop.mode = 'none';
    app.autoBake = false;
    app.setDoc(d);
    await app.bake();
    const fps = d.fps, step = Math.round(fps / 2);
    const out: number[] = [];
    let prev = await w.hist(0);
    for (let f = step; f < app.result!.frames; f += step) {
      const cur = await w.hist(f);
      let moving = 0, n = 0;
      for (let i = 0; i < cur.length; i++) {
        if (cur[i].kind !== 0 || cur[i].spawn > f) continue;
        n++;
        const a = cur[i].p, b = prev[i].p;
        if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / (step / fps) > minSpeed) moving++;
      }
      out.push(Math.round((100 * moving) / Math.max(1, n)));
      prev = cur;
    }
    return out.map((v, k) => `${((k + 1) * step / fps).toFixed(1)}:${v}`).join(' ');
  };
  w.run = async (fn: () => Promise<any>) => { w.runOut = null; w.runOut = await fn().catch((err: any) => ({ error: String(err) })); };
  void setFrame; void THREE;
}
