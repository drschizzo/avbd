// Diagrams that run the real mini engine: the stack that sinks, the penalty
// wall, λ climbing, the convergence curve. Nothing here is a drawing of an
// idea — every number comes out of a simulation run through ./simcache.

import {
  CC, DH, DW, alpha, arrow, axes, camFor, camIn, circle, clamp, clamp01, dot, line, panel, px, py, sstep, text, type Cam,
} from './draw';
import { BUILD, poseOf, record, recordMaybe, solverOf, type Rec } from './simcache';
import { Mini, makeBox, separation } from './mini';
import type { DiagEnv } from './diagrams';

type Ctx = CanvasRenderingContext2D;

const SOLVER_LABEL = ['sans solveur', 'impulsions séquentielles', 'pénalité seule', 'AVBD (λ + β)'];
const SOLVER_COL = [CC.red, CC.acc, CC.violet, CC.green];

/** Draws one recorded frame of a mini scene. */
function drawRec(ctx: Ctx, r: Rec, f: number, cam: Cam, opts: { col?: string; ghost?: number } = {}): void {
  for (let i = 0; i < r.n; i++) {
    const [x, y, a] = poseOf(r, f, i);
    const s = r.shape[i];
    const col = opts.col ?? (s.m === 0 ? CC.dim : CC.blue);
    if (s.circle) {
      circle(ctx, px(cam, x), py(cam, y), s.hw * cam.s, col, alpha(col, 0.18), 1.4);
      line(ctx, px(cam, x), py(cam, y), px(cam, x + Math.cos(a) * s.hw), py(cam, y + Math.sin(a) * s.hw), alpha(col, 0.5), 1);
    } else {
      ctx.save();
      ctx.translate(px(cam, x), py(cam, y));
      ctx.rotate(-a);
      panel(ctx, -s.hw * cam.s, -s.hh * cam.s, s.hw * 2 * cam.s, s.hh * 2 * cam.s, col, alpha(col, 0.16), 2.5, 1.3);
      ctx.restore();
    }
  }
}

function floorLine(ctx: Ctx, cam: Cam, r: Rec): void {
  line(ctx, px(cam, r.bounds.x0), py(cam, r.bounds.y0), px(cam, r.bounds.x1), py(cam, r.bounds.y0), CC.dim, 2);
}

/** 1e5 → « 10⁵ » */
const sci = (v: number) => {
  const e = Math.floor(Math.log10(v) + 1e-9), m = v / 10 ** e;
  const sup = String(e).split('').map((d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[+d]).join('');
  return `${Math.abs(m - 1) < 0.05 ? '' : `${m.toFixed(1).replace('.', ',')}·`}10${sup}`;
};

const mm = (v: number) => (Number.isFinite(v) ? (v * 1000 < 0.01 ? '< 0,01' : (v * 1000).toFixed(2)) : '—');

// =====================================================================
// overlap — nothing in the integration forbids interpenetration
// =====================================================================

export function overlap(ctx: Ctx, e: DiagEnv): void {
  const cam = camFor(-1.5, 1.5, -1.4, 1.1, 24);
  const t = (e.t * 0.5) % 1;
  floorLine(ctx, cam, { bounds: { x0: -1.5, x1: 1.5, y0: 0 } } as Rec);
  const y = 0.9 - t * 1.9;
  const hh = 0.28;
  // the box, sinking straight through
  ctx.save();
  ctx.translate(px(cam, 0), py(cam, y));
  panel(ctx, -0.34 * cam.s, -hh * cam.s, 0.68 * cam.s, hh * 2 * cam.s, CC.blue, alpha(CC.blue, 0.16), 3, 1.5);
  ctx.restore();
  const C = y - hh;
  // the overlap, hatched
  if (C < 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(px(cam, -0.34), py(cam, 0), 0.68 * cam.s, -C * cam.s);
    ctx.clip();
    ctx.strokeStyle = alpha(CC.red, 0.55);
    ctx.lineWidth = 1;
    for (let i = -20; i < 40; i++) line(ctx, px(cam, -0.4) + i * 7, py(cam, 0), px(cam, -0.4) + i * 7 + 40, py(cam, 0) + 40, alpha(CC.red, 0.5), 1);
    ctx.restore();
    ctx.strokeStyle = CC.red; ctx.lineWidth = 1.4;
    ctx.strokeRect(px(cam, -0.34), py(cam, 0), 0.68 * cam.s, -C * cam.s);
  }
  // the measurement
  const mx = px(cam, 0.52);
  line(ctx, mx, py(cam, y - hh), mx, py(cam, 0), C < 0 ? CC.red : CC.green, 1.4);
  line(ctx, px(cam, 0.34), py(cam, y - hh), mx + 6, py(cam, y - hh), CC.faint, 1, [3, 3]);
  text(ctx, 'C', mx + 10, (py(cam, y - hh) + py(cam, 0)) / 2, C < 0 ? CC.red : CC.green, 12, 'left', true);
  text(ctx, `C = ${C.toFixed(2)} m`, DW - 14, 24, C < 0 ? CC.red : CC.green, 12, 'right', true);
  text(ctx, C < 0 ? 'interpénétration : interdit' : 'séparés : rien à faire', DW - 14, 40, CC.dim, 10.5, 'right');
  text(ctx, 'v ← v + h·g', 16, 24, CC.dim, 11, 'left', true);
  text(ctx, 'x ← x + h·v', 16, 40, CC.dim, 11, 'left', true);
  text(ctx, 'rien là-dedans ne parle du sol', 16, 58, CC.faint, 10);
}

// =====================================================================
// solve — the stack, with whichever solver and iteration count
// =====================================================================

export function solve(ctx: Ctx, e: DiagEnv): void {
  const compare = e.arg === 'compare';
  const si = compare ? Math.round(e.v.solver) : 1;
  const it = Math.max(1, Math.round(e.v.iterations));
  // the chapter that introduces impulses has not met substeps yet: it shows
  // the classic single-substep behaviour the text describes
  const sub = compare ? Math.max(1, Math.round(e.v.substeps ?? 1)) : 1;
  const N = 10;
  const r = record(`stack${N}`, BUILD.stack(N), {
    solver: solverOf(si), iterations: it, substeps: sub,
    k: e.v.kPenalty, beta: e.v.beta, friction: 0.5,
  }, 150);
  const f = Math.floor((e.t * 30) % r.frames);
  const cam = camIn(-0.9, 0.9, -0.1, 5.5, 8, 26, 150, 200);
  floorLine(ctx, cam, r);
  drawRec(ctx, r, f, cam, { col: r.diverged ? CC.red : SOLVER_COL[si] });
  // the ideal silhouette, for comparison
  ctx.save();
  ctx.setLineDash([2, 3]);
  ctx.strokeStyle = CC.faint; ctx.lineWidth = 1;
  for (let i = 0; i < N; i++) ctx.strokeRect(px(cam, -0.25), py(cam, 0.5 + i * 0.5), 0.5 * cam.s, 0.5 * cam.s);
  ctx.restore();

  text(ctx, SOLVER_LABEL[si], 168, 26, SOLVER_COL[si], 11.5);
  text(ctx, `${it} itération${it > 1 ? 's' : ''} · ${sub} sous-pas`, 168, 42, CC.dim, 11);
  const box = { x: DW - 160, y: 86, w: 146, h: 62 };
  panel(ctx, box.x, box.y, box.w, box.h, CC.faint, 'rgba(0,0,0,.25)', 8);
  text(ctx, 'enfoncement max', box.x + box.w / 2, box.y + 16, CC.dim, 10, 'center');
  const col = r.diverged ? CC.red : r.settled < 1e-4 ? CC.green : r.settled < 2e-3 ? CC.acc : CC.red;
  text(ctx, r.diverged ? 'diverge' : `${mm(r.settled)} mm`, box.x + box.w / 2, box.y + 38, col, 19, 'center', true);
  text(ctx, 'pointillés : pile idéale', box.x + box.w / 2, box.y + 55, CC.faint, 9.5, 'center');
  // the top of the stack, which says everything
  const top = poseOf(r, f, N - 1)[1];
  text(ctx, `sommet : ${top.toFixed(3)} m`, DW - 14, 184, CC.fg, 11, 'right', true);
  text(ctx, 'idéal : 4,750 m', DW - 14, 200, CC.faint, 10, 'right', true);
}

// =====================================================================
// penalty — the two walls: too soft, then unstable
// =====================================================================

export function penalty(ctx: Ctx, e: DiagEnv): void {
  const k = e.v.kPenalty;
  const r = record('stack10', BUILD.stack(10), { solver: 'penalty', k, iterations: Math.round(e.v.iterations), substeps: 4 }, 180);
  // the stack on the left, the measured curve on the right
  const cam = camIn(-0.9, 0.9, -0.1, 5.5, 8, 46, 130, 180);
  line(ctx, px(cam, -0.8), py(cam, 0), px(cam, 0.8), py(cam, 0), CC.dim, 2);
  const f = Math.floor((e.t * 30) % r.frames);
  drawRec(ctx, r, f, cam, { col: r.diverged ? CC.red : CC.violet });

  // residual penetration against k, measured
  const x0 = 180, y0 = 44, w = DW - x0 - 20, hh = 120;
  axes(ctx, x0, y0, w, hh, 'k', '');
  text(ctx, 'enfoncement mesuré', DW - 14, 18, CC.dim, 10, 'right');
  const ks = [1e3, 3e3, 1e4, 3e4, 1e5, 3e5, 1e6];
  const pts = ks.map((kk) => {
    const rr = recordMaybe('stack10', BUILD.stack(10), { solver: 'penalty', k: kk, iterations: Math.round(e.v.iterations), substeps: 4 }, 100);
    return { k: kk, p: !rr ? undefined : rr.diverged ? NaN : rr.settled };
  });
  const X = (kk: number) => x0 + (Math.log10(kk) - 3) / 3 * w;
  const Y = (p: number) => y0 + hh - clamp01(Math.log10(Math.max(1e-6, p) * 1000 + 1) / Math.log10(101)) * hh;
  ctx.save(); ctx.strokeStyle = CC.violet; ctx.lineWidth = 1.8; ctx.beginPath();
  let started = false;
  for (const p of pts) {
    if (p.p === undefined || !Number.isFinite(p.p)) { started = false; continue; }
    const xx = X(p.k), yy = Y(p.p);
    started ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
    started = true;
  }
  ctx.stroke(); ctx.restore();
  for (const p of pts) {
    if (p.p === undefined) { text(ctx, '·', X(p.k), y0 + hh / 2, CC.faint, 13, 'center'); continue; }
    if (!Number.isFinite(p.p)) { text(ctx, '✕', X(p.k), y0 + 12, CC.red, 13, 'center'); continue; }
    dot(ctx, X(p.k), Y(p.p), CC.violet, 3);
  }
  for (const kk of [1e3, 1e4, 1e5, 1e6]) text(ctx, kk.toExponential(0).replace('e+', 'e'), X(kk), y0 + hh + 12, CC.faint, 9, 'center', true);
  // where we are
  const here = X(k);
  line(ctx, here, y0, here, y0 + hh, CC.acc, 1.4, [3, 3]);
  text(ctx, r.diverged ? 'instable' : `${mm(r.settled)} mm`, here, y0 - 6, r.diverged ? CC.red : CC.acc, 11, 'center', true);
  text(ctx, 'trop mou', x0 + 6, y0 + hh - 10, CC.dim, 10);
  // past a point the curve flattens: the iterations, not k, set the error
  text(ctx, 'plateau', x0 + w - 6, y0 + 30, CC.red, 10, 'right');
  text(ctx, `k = ${k.toExponential(1)}`, 14, 20, CC.violet, 11.5, 'left', true);
  text(ctx, `${Math.round(e.v.iterations)} itérations`, 14, 36, CC.dim, 10.5, 'left', true);
}

// =====================================================================
// lambda — the multiplier carrying the force
// =====================================================================

/**
 * A controlled experiment: let a box settle, push it 4 mm into the floor, then
 * record one substep iteration by iteration. The curve then shows a contact
 * actually closing, instead of one that was already satisfied.
 */
function lambdaTrace(iterations: number, beta: number, withLambda: boolean): { C: number[]; lam: number[]; k: number[] } {
  const m = new Mini({ solver: withLambda ? 'avbd' : 'penalty', iterations, beta, substeps: 1, k: 2e4, friction: 0 }, { bounds: { x0: -3, x1: 3, y0: 0 } });
  m.add(makeBox(0, 0.25, 0.25, 0.25));
  m.commitInitial();
  for (let f = 0; f < 20; f++) m.step(); // settle, so warm starting is in play
  m.bodies[0].y -= 0.004;
  m.record = true;
  m.step();
  const C: number[] = [], lam: number[] = [], k: number[] = [];
  for (const s of m.trace) {
    if (s.phase !== 'iterate' && s.phase !== 'dual') continue;
    const c = s.contacts[0];
    if (!c) continue;
    C.push(c.C); lam.push(c.lam); k.push(c.k);
  }
  return { C, lam, k };
}

export function lambda(ctx: Ctx, e: DiagEnv): void {
  const it = Math.max(2, Math.round(e.v.iterations));
  const beta = e.v.beta;
  const a = lambdaTrace(it, beta, true);
  const b = lambdaTrace(it, beta, false);
  const n = Math.max(a.C.length, b.C.length, 2);
  const x0 = 44, y0 = 30, w = DW - 64, hh = 92;
  axes(ctx, x0, y0, w, hh, 'itérations', 'enfoncement |C|');
  const X = (i: number) => x0 + (i / (n - 1)) * w;
  const Y = (c: number) => y0 + hh - clamp01(Math.log10(Math.abs(c) * 1e6 + 1) / 5) * hh;
  const curve = (arr: number[], col: string) => {
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.beginPath();
    arr.forEach((c, i) => (i ? ctx.lineTo(X(i), Y(c)) : ctx.moveTo(X(i), Y(c))));
    ctx.stroke(); ctx.restore();
  };
  curve(b.C, CC.violet);
  curve(a.C, CC.green);
  for (const [v, l] of [[1e-3, '1 mm'], [1e-6, '1 µm']] as const) {
    line(ctx, x0, Y(v), x0 + w, Y(v), CC.faint, 1, [2, 4]);
    text(ctx, l, x0 - 4, Y(v), CC.faint, 9, 'right', true);
  }
  text(ctx, 'pénalité seule', x0 + 6, y0 + 10, CC.violet, 10.5);
  text(ctx, 'avec λ (AVBD)', x0 + 6, y0 + 25, CC.green, 10.5);

  // λ and k below
  const y1 = y0 + hh + 34;
  axes(ctx, x0, y1, w, 56, '', 'λ et k');
  const lmax = Math.max(1, ...a.lam.map(Math.abs));
  const kmax = Math.max(1, ...a.k);
  ctx.save(); ctx.strokeStyle = CC.pink; ctx.lineWidth = 1.6; ctx.beginPath();
  a.lam.forEach((v, i) => { const yy = y1 + 56 - (Math.abs(v) / lmax) * 56; i ? ctx.lineTo(X(i), yy) : ctx.moveTo(X(i), yy); });
  ctx.stroke();
  ctx.strokeStyle = CC.acc; ctx.setLineDash([3, 3]); ctx.beginPath();
  a.k.forEach((v, i) => { const yy = y1 + 56 - (v / kmax) * 56; i ? ctx.lineTo(X(i), yy) : ctx.moveTo(X(i), yy); });
  ctx.stroke(); ctx.restore();
  text(ctx, `|λ| → ${Math.abs(a.lam[a.lam.length - 1] ?? 0).toFixed(1)} N`, x0 + 6, y1 + 12, CC.pink, 10, 'left', true);
  text(ctx, `k → ${(a.k[a.k.length - 1] ?? 0).toExponential(0)}`, x0 + 6, y1 + 26, CC.acc, 10, 'left', true);
  text(ctx, 'λ par coin · poids 9,8 N', DW - 18, y1 + 12, CC.dim, 10, 'right', true);
  text(ctx, '+ la poussée qui ressort la caisse', DW - 18, y1 + 26, CC.faint, 9.5, 'right');
}

// =====================================================================
// beta — how fast the penalty climbs
// =====================================================================

export function beta(ctx: Ctx, e: DiagEnv): void {
  const it = Math.max(2, Math.round(e.v.iterations));
  const x0 = 50, y0 = 38, w = DW - 76, hh = 142;
  axes(ctx, x0, y0, w, hh, 'itérations', '');
  text(ctx, 'enfoncement |C| (un contact de 4 mm à refermer)', x0 - 4, y0 - 12, CC.dim, 10);
  // the trace holds one entry per primal sweep and one per dual update
  const n = Math.max(6, it * 2);
  const X = (i: number) => x0 + (i / (n - 1)) * w;
  const Y = (c: number) => y0 + hh - clamp01(Math.log10(Math.abs(c) * 1e6 + 1) / 5) * hh;
  const shown = [1e4, 1e5, 1e6].map((b) => ({ b, col: b === 1e4 ? CC.blue : b === 1e5 ? CC.green : CC.red }));
  const cur = e.v.beta;
  for (const s of [...shown, { b: cur, col: CC.acc }]) {
    const tr = lambdaTrace(it, s.b, true);
    ctx.save();
    ctx.strokeStyle = s.col; ctx.lineWidth = s.b === cur ? 2.4 : 1.2;
    if (s.b !== cur) ctx.globalAlpha = 0.45;
    ctx.beginPath();
    tr.C.forEach((c, i) => (i ? ctx.lineTo(X(i), Y(c)) : ctx.moveTo(X(i), Y(c))));
    ctx.stroke(); ctx.restore();
  }
  for (const [v, l] of [[1e-3, '1 mm'], [1e-6, '1 µm']] as const) {
    line(ctx, x0, Y(v), x0 + w, Y(v), CC.faint, 1, [2, 4]);
    text(ctx, l, x0 - 4, Y(v), CC.faint, 9, 'right', true);
  }
  shown.forEach((s, i) => text(ctx, `β = ${sci(s.b)}`, x0 + 8, y0 + 12 + i * 14, alpha(s.col, 0.7), 10, 'left', true));
  text(ctx, `β = ${sci(cur)}`, DW - 18, y0 + 12, CC.acc, 12, 'right', true);
  text(ctx, 'k ← k + β·|C| à chaque itération', DW - 18, y0 + 28, CC.dim, 10, 'right');
  text(ctx, 'plafond : 3 × M/h²', DW - 18, y0 + 42, CC.dim, 10, 'right');
}

// =====================================================================
// dualtiming — once per substep vs every iteration
// =====================================================================

export function dualtiming(ctx: Ctx, e: DiagEnv): void {
  const mk = (every: boolean) => {
    const m = new Mini({ solver: 'avbd', iterations: 8, substeps: 4, dualEvery: every, friction: 0 }, { bounds: { x0: -3, x1: 3, y0: 0 } });
    m.add(makeBox(0, 2, 0.25, 0.25));
    m.commitInitial();
    const ys: number[] = [];
    for (let f = 0; f < 90; f++) { m.step(); ys.push(m.bodies[0].y); }
    return ys;
  };
  const a = mk(false), b = mk(true);
  const x0 = 46, y0 = 46, w = DW - 70, hh = 130;
  axes(ctx, x0, y0, w, hh, 'images', 'hauteur');
  const Y = (y: number) => y0 + hh - clamp01(y / 2.2) * hh;
  line(ctx, x0, Y(0.25), x0 + w, Y(0.25), CC.faint, 1, [3, 3]);
  text(ctx, 'surface', x0 - 4, Y(0.25), CC.faint, 9, 'right');
  const curve = (arr: number[], col: string, lw: number) => {
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath();
    arr.forEach((y, i) => { const X = x0 + (i / (arr.length - 1)) * w; i ? ctx.lineTo(X, Y(y)) : ctx.moveTo(X, Y(y)); });
    ctx.stroke(); ctx.restore();
  };
  curve(a, CC.red, 1.8);
  curve(b, CC.green, 1.8);
  const hopA = Math.max(...a.slice(40)) - 0.25;
  text(ctx, 'λ mis à jour une fois par sous-pas', x0 + 8, y0 + 12, CC.red, 10.5);
  text(ctx, `→ rebond de ${(hopA * 100).toFixed(0)} cm, sans restitution`, x0 + 8, y0 + 26, alpha(CC.red, 0.75), 10);
  text(ctx, 'λ mis à jour à chaque itération', x0 + 8, y0 + 44, CC.green, 10.5);
  text(ctx, '→ le corps s’arrête net', x0 + 8, y0 + 58, alpha(CC.green, 0.75), 10);
  text(ctx, 'une caisse lâchée de 2 m, restitution 0', DW / 2, 22, CC.dim, 11, 'center');
}

// =====================================================================
// warm — keeping the multipliers between frames
// =====================================================================

export function warm(ctx: Ctx, e: DiagEnv): void {
  const mk = (gamma: number) => {
    const m = new Mini({ solver: 'avbd', iterations: 3, substeps: 4, gamma, friction: 0 }, { bounds: { x0: -3, x1: 3, y0: 0 } });
    for (let i = 0; i < 5; i++) m.add(makeBox(0, 0.25 + i * 0.502, 0.25, 0.25));
    m.commitInitial();
    const pen: number[] = [];
    for (let f = 0; f < 120; f++) { m.step(); pen.push(m.stats.pen); }
    return pen;
  };
  const cold = mk(0), hot = mk(0.99);
  const x0 = 50, y0 = 40, w = DW - 74, hh = 134;
  axes(ctx, x0, y0, w, hh, 'images', 'enfoncement');
  const Y = (p: number) => y0 + hh - clamp01(Math.log10(Math.max(1e-7, p) * 1e6 + 1) / 5) * hh;
  // the raw per-frame values are spiky; draw them faintly and the running
  // maximum on top, which is what the eye should follow
  const curve = (arr: number[], col: string) => {
    ctx.save();
    ctx.strokeStyle = alpha(col, 0.3); ctx.lineWidth = 1; ctx.beginPath();
    arr.forEach((p, i) => { const X = x0 + (i / (arr.length - 1)) * w; i ? ctx.lineTo(X, Y(p)) : ctx.moveTo(X, Y(p)); });
    ctx.stroke();
    const win = 8;
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath();
    arr.forEach((_, i) => {
      const mx = Math.max(...arr.slice(Math.max(0, i - win), i + 1));
      const X = x0 + (i / (arr.length - 1)) * w;
      i ? ctx.lineTo(X, Y(mx)) : ctx.moveTo(X, Y(mx));
    });
    ctx.stroke(); ctx.restore();
  };
  curve(cold, CC.red);
  curve(hot, CC.green);
  for (const [v, l] of [[1e-3, '1 mm'], [1e-6, '1 µm']] as const) {
    line(ctx, x0, Y(v), x0 + w, Y(v), CC.faint, 1, [2, 4]);
    text(ctx, l, x0 - 4, Y(v), CC.faint, 9, 'right', true);
  }
  text(ctx, 'γ = 0 : la raideur repart du minimum à chaque sous-pas', x0 + 8, y0 + hh - 30, CC.red, 10.5);
  text(ctx, 'γ = 0,99 : la raideur k est conservée', x0 + 8, y0 + hh - 16, CC.green, 10.5);
  text(ctx, 'une pile de 5, seulement 3 itérations par sous-pas', DW / 2, 22, CC.dim, 11, 'center');
  text(ctx, 'demi-vie de k ≈ 69 sous-pas', DW - 18, y0 + hh + 24, CC.faint, 10, 'right');
}

// =====================================================================
// converge — penetration vs iterations, measured
// =====================================================================

export function converge(ctx: Ctx, e: DiagEnv): void {
  const sub = Math.max(1, Math.round(e.v.substeps));
  const its = [1, 2, 3, 4, 6, 8, 12, 16, 24];
  const x0 = 54, y0 = 42, w = DW - 80, hh = 132;
  axes(ctx, x0, y0, w, hh, 'itérations', '');
  const X = (i: number) => x0 + (Math.log2(i) / Math.log2(24)) * w;
  const Y = (p: number) => y0 + hh - clamp01(Math.log10(Math.max(1e-6, p) * 1e6 + 1) / 5.2) * hh;
  for (const [s, col] of [[1, CC.red], [2, CC.acc], [4, CC.green], [8, CC.blue]] as const) {
    const pts = its.map((it) => {
      const r = recordMaybe('stack10', BUILD.stack(10), { solver: 'avbd', iterations: it, substeps: s }, 120);
      return { it, p: !r ? undefined : r.diverged ? NaN : r.settled };
    });
    ctx.save();
    ctx.strokeStyle = col; ctx.lineWidth = s === sub ? 2.4 : 1.1;
    if (s !== sub) ctx.globalAlpha = 0.4;
    ctx.beginPath();
    let on = false;
    for (const p of pts) {
      if (p.p === undefined || !Number.isFinite(p.p)) { on = false; continue; }
      on ? ctx.lineTo(X(p.it), Y(p.p)) : ctx.moveTo(X(p.it), Y(p.p));
      on = true;
    }
    ctx.stroke(); ctx.restore();
    if (s === sub) for (const p of pts) if (p.p !== undefined && Number.isFinite(p.p)) dot(ctx, X(p.it), Y(p.p), col, 3);
  }
  for (const it of [1, 2, 4, 8, 16]) text(ctx, String(it), X(it), y0 + hh + 12, CC.faint, 9, 'center', true);
  for (const [v, l] of [[1e-1, '100 mm'], [1e-3, '1 mm'], [1e-6, '1 µm']] as const) {
    line(ctx, x0, Y(v), x0 + w, Y(v), CC.faint, 1, [2, 4]);
    text(ctx, l, x0 - 4, Y(v), CC.faint, 9, 'right', true);
  }
  ([[1, CC.red], [2, CC.acc], [4, CC.green], [8, CC.blue]] as const).forEach(([s, col], i) => {
    const lx = x0 + 10 + i * 62, ly = y0 + 12;
    line(ctx, lx, ly, lx + 12, ly, s === sub ? col : alpha(col, 0.5), s === sub ? 2.4 : 1.2);
    text(ctx, `${s} s-pas`, lx + 16, ly, s === sub ? col : alpha(col, 0.6), 9.5, 'left', true);
  });
  // where the learner is
  const it = clamp(Math.round(e.v.iterations), 1, 24);
  const r = record('stack10', BUILD.stack(10), { solver: 'avbd', iterations: it, substeps: sub }, 120);
  const xx = X(it);
  line(ctx, xx, y0, xx, y0 + hh, CC.fg, 1, [3, 3]);
  if (!r.diverged) {
    circle(ctx, xx, Y(r.settled), 5, CC.fg, null, 1.6);
    text(ctx, `${mm(r.settled)} mm`, xx, Y(r.settled) - 12, CC.fg, 11, 'center', true);
  }
  text(ctx, `${it} itérations × ${sub} sous-pas = ${it * sub} balayages par image`, DW / 2, 18, CC.dim, 10.5, 'center');
}

// =====================================================================
// friction — the Coulomb cone, and a block on a slope
// =====================================================================

export function friction(ctx: Ctx, e: DiagEnv): void {
  const mu = e.v.friction;
  const r = record('slope18', BUILD.slope(18), { solver: 'avbd', friction: mu, iterations: 10, substeps: 4 }, 150, { x0: -4, x1: 4, y0: -2 });
  const cam = camFor(-2.6, 3.4, -1.0, 1.3, 16);
  const f = Math.floor((e.t * 30) % r.frames);
  drawRec(ctx, r, f, cam);
  // how far it slid
  const start = poseOf(r, 0, 1), now = poseOf(r, f, 1);
  const slid = Math.hypot(now[0] - start[0], now[1] - start[1]);

  // the cone
  const cx = DW - 68, cy = 158, R = 46;
  const half = Math.atan(mu);
  ctx.save();
  ctx.fillStyle = alpha(CC.acc, 0.14);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, R, -Math.PI / 2 - half, -Math.PI / 2 + half);
  ctx.closePath(); ctx.fill();
  ctx.restore();
  line(ctx, cx, cy, cx + R * Math.sin(half), cy - R * Math.cos(half), CC.acc, 1.4);
  line(ctx, cx, cy, cx - R * Math.sin(half), cy - R * Math.cos(half), CC.acc, 1.4);
  arrow(ctx, cx, cy, cx, cy - R, CC.dim, 1.2);
  text(ctx, 'n', cx + 5, cy - R + 6, CC.dim, 10, 'left', true);
  // the force actually applied: saturated while sliding
  const sliding = slid > 0.02;
  const ang = sliding ? half : half * 0.45;
  arrow(ctx, cx, cy, cx + R * 0.86 * Math.sin(ang), cy - R * 0.86 * Math.cos(ang), sliding ? CC.red : CC.green, 2);
  text(ctx, sliding ? 'sur le bord : ça glisse' : 'dans le cône : ça tient', cx, cy + 18, sliding ? CC.red : CC.green, 10, 'center');
  text(ctx, `μ = ${mu.toFixed(2)}`, cx, cy - R - 22, CC.acc, 13, 'center', true);
  text(ctx, 'tan 18° = 0,32', cx, cy - R - 8, CC.dim, 10, 'center', true);
  text(ctx, `glissement : ${slid.toFixed(2)} m`, 14, 206, sliding ? CC.red : CC.green, 11, 'left', true);
  text(ctx, '|f_t| ≤ μ·|f_n|', 14, 222, CC.dim, 11, 'left', true);
}

// =====================================================================
// restitution
// =====================================================================

export function restitution(ctx: Ctx, e: DiagEnv): void {
  const x0 = 44, y0 = 36, w = DW - 66, hh = 124;
  axes(ctx, x0, y0, w, hh, 'temps', 'hauteur');
  const Y = (y: number) => y0 + hh - clamp01(y / 2.2) * hh;
  // analytic bouncing ball for three restitutions
  const traj = (ee: number) => {
    const out: number[] = [];
    let y = 2, v = 0;
    for (let i = 0; i < 300; i++) {
      v -= 9.81 / 60;
      y += v / 60;
      if (y < 0.25) { y = 0.25; v = -v * ee; }
      out.push(y);
    }
    return out;
  };
  ([[0, CC.green], [0.5, CC.acc], [0.85, CC.pink]] as const).forEach(([ee, col], i) => {
    const arr = traj(ee);
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 1.7; ctx.beginPath();
    arr.forEach((y, k) => { const X = x0 + (k / (arr.length - 1)) * w; k ? ctx.lineTo(X, Y(y)) : ctx.moveTo(X, Y(y)); });
    ctx.stroke(); ctx.restore();
    text(ctx, `e = ${ee}`, x0 + 8, y0 + 12 + i * 14, col, 10.5, 'left', true);
  });
  line(ctx, x0, Y(0.25), x0 + w, Y(0.25), CC.dim, 1.5);
  text(ctx, 'ce moteur : e = 0, sans aucune règle de rebond', DW / 2, y0 + hh + 26, CC.dim, 10.5, 'center');
  text(ctx, 'v ← (x − x_précédent) / h', DW / 2, y0 + hh + 42, CC.green, 11, 'center', true);
}

// =====================================================================
// minimise — the energy landscape of one step
// =====================================================================

export function minimise(ctx: Ctx, e: DiagEnv): void {
  // One degree of freedom: the height of a body above a floor at 0.
  const M = 1, h = 1 / 60, k = 3e5;
  const xt = -0.09 + 0.035 * Math.sin(e.t * 0.7);   // the inertial target, under the floor
  const xa = -0.13, xb = 0.21;
  const inert = (x: number) => 0.5 * (M / (h * h)) * (x - xt) * (x - xt);
  const cons = (x: number) => (x < 0 ? 0.5 * k * x * x : 0);
  const x0 = 46, y0 = 26, w = DW - 70, hh = 126;
  const X = (x: number) => x0 + ((x - xa) / (xb - xa)) * w;
  // scaled on the inertia alone: the constraint wall then shoots off the top,
  // which is exactly what a near-rigid contact looks like
  const maxE = inert(xb);
  const Y = (v: number) => y0 + hh - clamp01(v / maxE) * hh;
  axes(ctx, x0, y0, w, hh, 'position du corps', '');
  text(ctx, 'énergie', x0 - 2, y0 - 10, CC.dim, 10);
  // the forbidden half
  ctx.save();
  ctx.fillStyle = alpha(CC.red, 0.07);
  ctx.fillRect(x0, y0, X(0) - x0, hh);
  ctx.restore();
  line(ctx, X(0), y0, X(0), y0 + hh, alpha(CC.red, 0.45), 1.3);
  text(ctx, 'sol', X(0) - 5, y0 + hh - 8, alpha(CC.red, 0.75), 10, 'right');

  const curve = (fn: (x: number) => number, col: string, lw: number, dash: number[] | null = null) => {
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = lw;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    for (let i = 0; i <= 200; i++) {
      const x = xa + (i / 200) * (xb - xa);
      const yy = Y(fn(x));
      if (i && Math.abs(yy - y0) < 0.5 && Math.abs(Y(fn(xa + ((i - 1) / 200) * (xb - xa))) - y0) < 0.5) { ctx.moveTo(X(x), yy); continue; }
      i ? ctx.lineTo(X(x), yy) : ctx.moveTo(X(x), yy);
    }
    ctx.stroke(); ctx.restore();
  };
  curve(inert, CC.blue, 1.3, [4, 3]);
  curve(cons, CC.pink, 1.3, [4, 3]);
  curve((x) => inert(x) + cons(x), CC.acc, 2.4);

  let best = 0, bestV = Infinity;
  for (let i = 0; i <= 600; i++) {
    const x = xa + (i / 600) * (xb - xa);
    const v = inert(x) + cons(x);
    if (v < bestV) { bestV = v; best = x; }
  }
  line(ctx, X(best), Y(bestV), X(best), y0 + hh, CC.acc, 1, [2, 3]);
  dot(ctx, X(best), Y(bestV), CC.acc, 5);
  text(ctx, 'x*', X(best), y0 + hh + 13, CC.acc, 11, 'center', true);
  dot(ctx, X(xt), y0 + hh, CC.blue, 4);
  text(ctx, 'x̃', X(xt), y0 + hh + 13, CC.blue, 11, 'center', true);

  // legend, out of the way, bottom right
  const lx = 56, ly = DH - 46;
  ([['inertie : ½(x−x̃)ᵀ M/h² (x−x̃)', CC.blue], ['contrainte : E(x)', CC.pink], ['somme : ce qu’on minimise', CC.acc]] as const)
    .forEach(([lab, col], i) => {
      line(ctx, lx + (i % 2) * 168, ly + Math.floor(i / 2) * 14, lx + (i % 2) * 168 + 12, ly + Math.floor(i / 2) * 14, col, i === 2 ? 2.4 : 1.3, i === 2 ? null : [4, 3]);
      text(ctx, lab, lx + (i % 2) * 168 + 17, ly + Math.floor(i / 2) * 14, col, 9.5);
    });
  text(ctx, `le minimum s’enfonce de ${Math.abs(best * 1000).toFixed(1)} mm`, DW - 16, y0 + 14, CC.fg, 10.5, 'right');
  text(ctx, `au lieu de ${Math.abs(xt * 1000).toFixed(0)} mm sans contrainte`, DW - 16, y0 + 28, CC.faint, 9.5, 'right');
}

// =====================================================================
// block — the sweep, one body at a time
// =====================================================================

export function block(ctx: Ctx, e: DiagEnv): void {
  const N = 5;
  const step = Math.round(e.v.frame ?? 0);
  const m = new Mini({ solver: 'avbd', iterations: 5, substeps: 1 }, { bounds: { x0: -3, x1: 3, y0: 0 } });
  for (let i = 0; i < N; i++) m.add(makeBox(0, 0.25 + i * 0.52, 0.25, 0.25));
  m.commitInitial();
  for (let f = 0; f < 10; f++) m.step();
  m.record = true;
  m.step();
  const trace = m.trace.filter((s) => s.phase === 'iterate' || s.phase === 'predict');
  const si = clamp(step, 0, Math.max(0, trace.length - 1));
  const s = trace[si];
  const active = s ? (s.iter >= 0 ? si % N : -1) : -1;
  const cam = camFor(-1.9, 1.3, -0.1, 3, 16);
  line(ctx, px(cam, -1.9), py(cam, 0), px(cam, 1.3), py(cam, 0), CC.dim, 2);
  for (let i = 0; i < N; i++) {
    const x = s ? s.pose[i * 3] : 0, y = s ? s.pose[i * 3 + 1] : 0;
    const on = i === active;
    ctx.save();
    ctx.translate(px(cam, x), py(cam, y));
    panel(ctx, -0.25 * cam.s, -0.25 * cam.s, 0.5 * cam.s, 0.5 * cam.s, on ? CC.acc : CC.blue, alpha(on ? CC.acc : CC.blue, on ? 0.22 : 0.1), 3, on ? 2 : 1.1);
    ctx.restore();
    if (on) {
      // the gradient and the local shape of the energy
      arrow(ctx, px(cam, x), py(cam, y), px(cam, x), py(cam, y) - 26, CC.pink, 2);
      ctx.save();
      ctx.strokeStyle = alpha(CC.green, 0.75); ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.ellipse(px(cam, x), py(cam, y), 26, 15, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }
  text(ctx, s ? (s.iter < 0 ? 'prédiction inertielle' : `itération ${Math.floor(si / N) + 1}, corps ${active + 1}`) : '', 14, 20, CC.fg, 11.5);
  text(ctx, `enfoncement : ${s ? mm(s.pen) : '—'} mm`, 14, 36, CC.dim, 11, 'left', true);
  // the 3x3 system, as a picture
  const bx = DW - 160, by = 50;
  text(ctx, 'le système du corps actif', bx + 70, by - 12, CC.dim, 10, 'center');
  for (let r0 = 0; r0 < 3; r0++) for (let c0 = 0; c0 < 3; c0++) {
    const on = active >= 0;
    panel(ctx, bx + c0 * 22, by + r0 * 22, 19, 19, on ? alpha(CC.green, 0.5) : CC.faint, on ? alpha(CC.green, 0.14) : null, 3, 1);
  }
  text(ctx, 'H', bx + 33, by + 78, CC.green, 12, 'center', true);
  text(ctx, '·', bx + 76, by + 33, CC.dim, 14, 'center');
  for (let r0 = 0; r0 < 3; r0++) panel(ctx, bx + 88, by + r0 * 22, 19, 19, alpha(CC.acc, 0.5), alpha(CC.acc, 0.14), 3, 1);
  text(ctx, 'Δ', bx + 97, by + 78, CC.acc, 12, 'center', true);
  text(ctx, '=', bx + 118, by + 33, CC.dim, 13, 'center');
  for (let r0 = 0; r0 < 3; r0++) panel(ctx, bx + 130, by + r0 * 22, 19, 19, alpha(CC.pink, 0.5), alpha(CC.pink, 0.14), 3, 1);
  text(ctx, '−g', bx + 139, by + 78, CC.pink, 12, 'center', true);
  text(ctx, '3 inconnues en 2D, 6 en 3D', bx + 70, by + 100, CC.faint, 9.5, 'center');
}

// =====================================================================
// joint — a chain, and why joints must be stiffer
// =====================================================================

export function joint(ctx: Ctx, e: DiagEnv): void {
  const x0 = 44, y0 = 44, w = DW - 110, hh = 112;
  axes(ctx, x0, y0, w, hh, 'raideur du joint', 'allongement');
  const X = (i: number, n: number) => x0 + (i / (n - 1)) * w;
  // elongation of a chain of n links under its own weight, for a few stiffnesses
  const ks = [1e3, 3e3, 1e4, 3e4, 1e5, 3e5];
  const vals = ks.map((k) => {
    // a chain of springs in series: each link stretches by its load / k
    let total = 0;
    for (let i = 0; i < 16; i++) total += ((16 - i) * 9.81) / k;
    return total;
  });
  const maxV = Math.max(...vals);
  ctx.save(); ctx.strokeStyle = CC.acc; ctx.lineWidth = 2; ctx.beginPath();
  vals.forEach((v, i) => { const yy = y0 + hh - (v / maxV) * hh; i ? ctx.lineTo(X(i, ks.length), yy) : ctx.moveTo(X(i, ks.length), yy); });
  ctx.stroke(); ctx.restore();
  vals.forEach((v, i) => dot(ctx, X(i, ks.length), y0 + hh - (v / maxV) * hh, CC.acc, 3));
  ks.forEach((k, i) => text(ctx, k.toExponential(0).replace('e+', 'e'), X(i, ks.length), y0 + hh + 12, CC.faint, 9, 'center', true));
  // the chain itself
  const cx = DW - 32;
  const sag = 0.3 + 0.5 * (1 - sstep(0, 1, (e.t * 0.3) % 1));
  for (let i = 0; i < 11; i++) {
    const y = 30 + i * (10 + sag * 5);
    if (y > DH - 14) break;
    circle(ctx, cx, y, 4.5, CC.blue, alpha(CC.blue, 0.3), 1.3);
    if (i) line(ctx, cx, y - (10 + sag * 5) + 4.5, cx, y - 4.5, alpha(CC.blue, 0.5), 1.2);
  }
  text(ctx, 'une chaîne est une file de contraintes', x0 + 10, y0 + 14, CC.dim, 10);
  text(ctx, 'en série : les erreurs s’additionnent', x0 + 10, y0 + 28, CC.dim, 10);
  text(ctx, 'allongement d’une chaîne de 16 maillons', x0 - 4, y0 - 12, CC.dim, 10);
  text(ctx, '16 maillons', DW - 32, 18, CC.blue, 9.5, 'center');
  text(ctx, 'β contacts ≈ 1e4 · β joints ≈ 1e5', DW / 2, DH - 10, CC.dim, 10.5, 'center');
}

export const SOLVER_DIAGRAMS = {
  overlap, solve, penalty, lambda, beta, dualtiming, warm, converge, friction, restitution, minimise, block, joint,
};

void separation; void clamp01; void sstep; void makeBox;
