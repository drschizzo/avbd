// Diagrams for the "foundations" chapters: the ideas a newcomer needs before
// the solver chapters make sense — the nested loops of a step, Newton's laws,
// impulses, reaction forces, energy landscapes, stiffness, conditioning, the
// GPU's execution model and floating-point rounding. Like every other course
// diagram, each one is a pure function of (time, values, pointer).

import { CC, DH, DW, alpha, arrow, axes, circle, clamp, clamp01, dot, line, panel, sstep, text } from './draw';
import type { DiagEnv } from './diagrams';

type Ctx = CanvasRenderingContext2D;

/** A row of progress dots, `cur` lit; collapses into a bar when there are many. */
function dots(ctx: Ctx, x: number, y: number, n: number, cur: number, col: string): void {
  if (n > 16) {
    panel(ctx, x, y - 3, 96, 6, CC.faint, null, 3, 1);
    panel(ctx, x, y - 3, 96 * ((cur + 1) / n), 6, col, alpha(col, 0.5), 3, 1);
    return;
  }
  for (let i = 0; i < n; i++) circle(ctx, x + i * 9, y, 3, i === cur ? col : CC.faint, i === cur ? col : null, 1.2);
}

// =====================================================================
// loops — one frame, seen from above: frame ⊃ substeps ⊃ iterations ⊃ colours
// =====================================================================

function loops(ctx: Ctx, e: DiagEnv): void {
  const S = Math.max(1, Math.round(e.v.substeps)), I = Math.max(1, Math.round(e.v.iterations));
  const K = Math.max(1, Math.round(e.v.colors));
  // the innermost counter ticks fast; the outer ones follow
  const tick = Math.floor(e.t / 0.11);
  const k = tick % K, it = Math.floor(tick / K) % I, s = Math.floor(tick / (K * I)) % S;
  const pal = [CC.acc, CC.blue, CC.green, CC.pink, CC.violet, CC.red, '#7ddcff', '#ffd27a'];

  panel(ctx, 8, 8, DW - 16, DH - 14, CC.dim, 'rgba(255,255,255,.015)', 9, 1.2);
  text(ctx, `une image · ${(e.v.h * 1000).toFixed(1)} ms`, 18, 22, CC.fg, 11);
  text(ctx, 'phase large : l’arbre', DW - 18, 22, CC.dim, 9.5, 'right');

  panel(ctx, 18, 34, DW - 36, DH - 46, alpha(CC.blue, 0.6), alpha(CC.blue, 0.04), 8, 1.2);
  text(ctx, `× ${S} sous-pas`, 28, 48, CC.blue, 11);
  dots(ctx, 112, 48, S, s, CC.blue);
  text(ctx, 'prédiction · phase étroite', DW - 28, 48, CC.dim, 9.5, 'right');
  text(ctx, 'vitesses = déplacement ÷ durée', DW - 28, DH - 20, CC.dim, 9.5, 'right');

  panel(ctx, 28, 60, DW - 56, 110, alpha(CC.green, 0.6), alpha(CC.green, 0.04), 7, 1.2);
  text(ctx, `× ${I} itérations`, 38, 74, CC.green, 11);
  dots(ctx, 128, 74, I, it, CC.green);
  text(ctx, 'puis λ et k', DW - 38, 74, CC.dim, 9.5, 'right');

  panel(ctx, 38, 86, DW - 76, 70, alpha(CC.acc, 0.7), alpha(CC.acc, 0.05), 6, 1.2);
  text(ctx, `× ${K} couleurs`, 48, 100, CC.acc, 11);
  const r = Math.min(9, (DW - 140) / (K * 2.6));
  for (let i = 0; i < K; i++) {
    const c = pal[i % pal.length];
    const x = 60 + r + i * r * 2.6, y = 120;
    circle(ctx, x, y, r, c, i === k ? alpha(c, 0.6) : alpha(c, 0.1), i === k ? 2 : 1);
  }
  text(ctx, 'les corps d’une couleur : tous en même temps', DW / 2, 144, CC.dim, 9.5, 'center');

  const perFrame = S * I * K;
  text(ctx, `${S} × ${I} × ${K} = ${perFrame} passes de résolution par image`, DW / 2, 186, CC.fg, 10.5, 'center', true);
  text(ctx, `chaque corps est résolu ${S * I} fois par image, ${Math.round((S * I) / e.v.h)} fois par seconde`, DW / 2, 201, CC.dim, 9.5, 'center');
}

// =====================================================================
// newton — a force changes the velocity; the velocity changes the position
// =====================================================================

const NEWTON_T = 7;
/** push from 0.6 to 1.6 s, glide, brake from 3.8 to 5.8 s — mass 1 kg */
const forceAt = (t: number) => (t >= 0.6 && t < 1.6 ? 2 : t >= 3.8 && t < 5.8 ? -1 : 0);
function newtonState(t: number): { v: number; x: number } {
  let v = 0, x = 0;
  const h = 0.01;
  for (let s = 0; s < t; s += h) { v += forceAt(s) * h; x += v * h; }
  return { v, x };
}

function newton(ctx: Ctx, e: DiagEnv): void {
  const t = e.t % NEWTON_T;
  const st = newtonState(t);
  const F = forceAt(t);
  const xMax = newtonState(NEWTON_T).x;
  // the puck
  const gx0 = 64, gx1 = DW - 64, gy = 40;
  line(ctx, gx0 - 10, gy + 10, gx1 + 10, gy + 10, CC.dim, 1.2);
  const px0 = gx0 + (st.x / xMax) * (gx1 - gx0);
  panel(ctx, px0 - 12, gy - 10, 24, 20, CC.blue, alpha(CC.blue, 0.2), 4, 1.5);
  if (F > 0) arrow(ctx, px0 - 40, gy, px0 - 13, gy, CC.pink, 2.2);
  if (F < 0) arrow(ctx, px0 + 40, gy, px0 + 13, gy, CC.pink, 2.2);
  const what = F > 0 ? 'on pousse : la vitesse augmente' : F < 0 ? 'on freine : la vitesse diminue'
    : st.v > 0.01 ? 'aucune force : la vitesse reste la même' : 'aucune force, aucune vitesse : rien ne bouge';
  text(ctx, what, DW / 2, 18, F !== 0 ? CC.pink : CC.fg, 11, 'center');

  // three stacked plots, one per quantity
  const x0 = 120, w = DW - x0 - 16;
  const X = (s: number) => x0 + (s / NEWTON_T) * w;
  const rows: { lab: string; sub: string; col: string; f: (s: number) => number; lo: number; hi: number }[] = [
    { lab: 'force', sub: 'a = F / m', col: CC.pink, f: forceAt, lo: -1.2, hi: 2.2 },
    { lab: 'vitesse', sub: 'cumule a', col: CC.acc, f: (s) => newtonState(s).v, lo: -0.2, hi: 2.3 },
    { lab: 'position', sub: 'cumule v', col: CC.blue, f: (s) => newtonState(s).x, lo: 0, hi: xMax * 1.05 },
  ];
  rows.forEach((r, i) => {
    const y0 = 66 + i * 56, hh = 42;
    const Y = (v: number) => y0 + hh - ((v - r.lo) / (r.hi - r.lo)) * hh;
    line(ctx, x0, Y(0), x0 + w, Y(0), CC.faint, 1);
    text(ctx, r.lab, 16, y0 + 14, r.col, 11);
    text(ctx, r.sub, 16, y0 + 29, CC.dim, 9.5, 'left', true);
    ctx.save();
    ctx.strokeStyle = r.col; ctx.lineWidth = 1.8; ctx.beginPath();
    // the curve is drawn up to now: the past is known, the future is not
    const n = 140;
    for (let j = 0; j <= n; j++) {
      const s = (j / n) * t;
      j ? ctx.lineTo(X(s), Y(r.f(s))) : ctx.moveTo(X(s), Y(r.f(s)));
    }
    ctx.stroke(); ctx.restore();
    dot(ctx, X(t), Y(r.f(t)), r.col, 3);
    if (i < 2) arrow(ctx, 70, y0 + hh - 2, 70, y0 + hh + 12, CC.faint, 1.2, 5);
  });
  line(ctx, X(t), 62, X(t), 62 + 3 * 56 - 12, CC.faint, 1, [2, 3]);
}

// =====================================================================
// impulse — the same push, spread over a long or a short time
// =====================================================================

function impulse(ctx: Ctx, e: DiagEnv): void {
  const J = 2;                               // N·s, kept constant
  const tau = clamp(e.v.pulse ?? 0.2, 0.004, 0.5);
  const Fpk = J / tau;
  const T = 0.6, t0 = 0.08;
  const x0 = 46, w = DW - 66;
  const X = (s: number) => x0 + (s / T) * w;
  // force plot, fixed scale: a short shock is far taller than the frame
  const y0 = 30, hh = 92, Fmax = 20;
  axes(ctx, x0, y0, w, hh, '', 'force (N)');
  // the solver's clock: one tick per step at 60 Hz
  for (let s = 0; s <= T; s += 1 / 60) line(ctx, X(s), y0 + hh, X(s), y0 + hh + 5, CC.dim, 1);
  const top = Math.min(Fpk, Fmax);
  const yTop = y0 + hh - (top / Fmax) * hh;
  ctx.save();
  ctx.fillStyle = alpha(CC.pink, 0.22);
  ctx.fillRect(X(t0), yTop, Math.max(1.2, X(t0 + tau) - X(t0)), y0 + hh - yTop);
  ctx.restore();
  line(ctx, X(t0), yTop, X(t0 + tau), yTop, CC.pink, 2);
  if (Fpk > Fmax) {
    arrow(ctx, X(t0 + tau / 2), y0 + 18, X(t0 + tau / 2), y0 + 2, CC.pink, 1.6, 6);
    text(ctx, `${Math.round(Fpk)} N`, X(t0 + tau / 2) + 8, y0 + 10, CC.pink, 10.5, 'left', true);
  } else text(ctx, `${Fpk.toFixed(1).replace('.', ',')} N`, X(t0 + tau) + 6, yTop, CC.pink, 10.5, 'left', true);

  // velocity plot: the same jump every time
  const y1 = 146, h1 = 52;
  axes(ctx, x0, y1, w, h1, 'temps', 'vitesse (m/s)');
  const V = (v: number) => y1 + h1 - (v / 2.5) * h1;
  ctx.save(); ctx.strokeStyle = CC.acc; ctx.lineWidth = 1.8; ctx.beginPath();
  ctx.moveTo(X(0), V(0)); ctx.lineTo(X(t0), V(0)); ctx.lineTo(X(t0 + tau), V(J)); ctx.lineTo(X(T), V(J));
  ctx.stroke(); ctx.restore();
  text(ctx, 'Δv = 2 m/s', X(T) - 2, V(J) - 9, CC.acc, 10.5, 'right', true);

  const steps = tau * 60;
  text(ctx, `durée ${tau >= 0.1 ? (tau * 1000).toFixed(0) : (tau * 1000).toFixed(1)} ms · aire = impulsion = 2 N·s`, DW - 14, 16, CC.fg, 10.5, 'right', true);
  text(ctx, steps < 1 ? 'tout le choc tient dans un seul pas : le solveur ne voit que l’aire'
    : `le choc dure ${steps.toFixed(1).replace('.', ',')} pas de temps`, DW / 2, DH - 6, steps < 1 ? CC.green : CC.dim, 10, 'center');
}

// =====================================================================
// reaction — contact forces are unknowns that depend on each other
// =====================================================================

function reaction(ctx: Ctx, e: DiagEnv): void {
  const cyc = 2.2, maxN = 5;
  const n = 1 + (Math.floor(e.t / cyc) % maxN);
  const land = sstep(0, 0.35, (e.t % cyc) / cyc);
  const s = 32, cx = 98, gy = 206;
  line(ctx, 20, gy, 190, gy, CC.dim, 2);
  for (let i = 0; i < n; i++) {
    const drop = i === n - 1 ? (1 - land) * 40 : 0;
    const y = gy - (i + 1) * s - drop;
    panel(ctx, cx - s / 2, y, s, s, CC.blue, alpha(CC.blue, 0.16), 3, 1.4);
    // weight
    arrow(ctx, cx + s / 2 + 8, y + s / 2 - 8, cx + s / 2 + 8, y + s / 2 + 8, CC.dim, 1.2, 5);
  }
  // the force at each interface carries everything above it
  for (let i = 0; i < n; i++) {
    const above = n - i - (i === n - 1 ? 1 - land : 0);
    const y = gy - i * s;
    const L = 8 + above * 9;
    arrow(ctx, cx - s / 2 - 12, y + 2, cx - s / 2 - 12, y - L, CC.pink, 2, 6);
    text(ctx, `${(n - i)} P`, cx - s / 2 - 18, y - L / 2, alpha(CC.pink, 0.95), 10, 'right', true);
  }
  text(ctx, 'P : le poids d’une caisse', 20, 16, CC.dim, 10);
  const tx = 214;
  text(ctx, 'chaque contact pousse', tx, 52, CC.fg, 11);
  text(ctx, 'exactement ce qu’il faut :', tx, 67, CC.fg, 11);
  text(ctx, 'moins, et ça s’enfonce', tx, 88, CC.red, 10);
  text(ctx, 'plus, et ça s’envole', tx, 103, CC.acc, 10);
  text(ctx, `${n} inconnue${n > 1 ? 's' : ''} : f₁ … f${'₀₁₂₃₄₅₆₇₈₉'[n]}`, tx, 132, CC.pink, 10.5, 'left', true);
  text(ctx, 'chacune dépend de toutes', tx, 152, CC.dim, 10);
  text(ctx, 'celles du dessus', tx, 166, CC.dim, 10);
  text(ctx, '→ un système à résoudre', tx, 186, CC.green, 10.5);
}

// =====================================================================
// landscape — energy as terrain: slope, curvature, a jump to the bottom
// =====================================================================

const LE = (x: number) => 0.3 * (x - 1) ** 2 + 0.02 * (x - 1) ** 4;
const LG = (x: number) => 0.6 * (x - 1) + 0.08 * (x - 1) ** 3;
const LH = (x: number) => 0.6 + 0.24 * (x - 1) ** 2;

function landscape(ctx: Ctx, e: DiagEnv): void {
  const xs = [-1.6];
  for (let i = 0; i < 4; i++) { const x = xs[xs.length - 1]; xs.push(x - LG(x) / LH(x)); }
  const per = 2.4;
  const k = Math.floor(e.t / per) % (xs.length + 1);
  const ph = (e.t % per) / per;
  const X = (x: number) => 30 + ((x + 2) / 5) * (DW - 60);
  const Y = (v: number) => 196 - v * 34;
  // the terrain
  ctx.save(); ctx.strokeStyle = CC.blue; ctx.lineWidth = 2; ctx.beginPath();
  for (let i = 0; i <= 160; i++) { const x = -1.8 + (i / 160) * 4.8; i ? ctx.lineTo(X(x), Y(LE(x))) : ctx.moveTo(X(x), Y(LE(x))); }
  ctx.stroke(); ctx.restore();
  text(ctx, 'énergie', 16, 20, CC.blue, 11);
  text(ctx, 'position →', DW - 16, 214, CC.dim, 10, 'right');
  dot(ctx, X(1), Y(0), CC.green, 3);
  text(ctx, 'le minimum : le compromis cherché', X(1), Y(0) + 14, CC.green, 10, 'center');
  if (k >= xs.length - 1) {
    const b = xs[xs.length - 1];
    circle(ctx, X(b), Y(LE(b)) - 7, 7, CC.acc, alpha(CC.acc, 0.35), 1.6);
    text(ctx, 'arrivé : la pente est nulle', DW / 2, 40, CC.green, 11, 'center');
    return;
  }
  const a = xs[k], b = xs[k + 1];
  const show = sstep(0.05, 0.25, ph);
  // slope: the gradient says which way is down
  const g = LG(a);
  ctx.globalAlpha = show;
  line(ctx, X(a - 0.7), Y(LE(a) - 0.7 * g), X(a + 0.7), Y(LE(a) + 0.7 * g), CC.pink, 1.4);
  // curvature: the Hessian gives a parabola, whose bottom is where we jump
  ctx.save(); ctx.strokeStyle = CC.acc; ctx.lineWidth = 1.3; ctx.setLineDash([4, 3]); ctx.beginPath();
  const H = LH(a);
  for (let i = 0; i <= 60; i++) {
    const x = a - 1.6 + (i / 60) * 3.2, v = LE(a) + g * (x - a) + 0.5 * H * (x - a) ** 2;
    i ? ctx.lineTo(X(x), Y(v)) : ctx.moveTo(X(x), Y(v));
  }
  ctx.stroke(); ctx.restore();
  ctx.globalAlpha = 1;
  const mv = sstep(0.5, 0.85, ph);
  const cur = a + (b - a) * mv;
  circle(ctx, X(cur), Y(LE(cur)) - 7, 7, CC.acc, alpha(CC.acc, 0.35), 1.6);
  text(ctx, `étape ${k + 1}`, DW - 16, 20, CC.fg, 11, 'right', true);
  text(ctx, 'pente (gradient) : de quel côté descendre', 16, 40, alpha(CC.pink, 0.9 * show + 0.1), 10);
  text(ctx, 'courbure (hessienne) : jusqu’où sauter', 16, 55, alpha(CC.acc, 0.9 * show + 0.1), 10);
}

// =====================================================================
// stiff — a stiff spring, stepped forward explicitly or implicitly
// =====================================================================

function stiff(ctx: Ctx, e: DiagEnv): void {
  const r = clamp(e.v.stiff ?? 0.5, 0.05, 4);   // h·√(k/m)
  const N = 36;
  const semi: number[] = [], impl: number[] = [];
  let xs = 1, vs = 0, xi = 1, vi = 0;
  for (let i = 0; i <= N; i++) {
    semi.push(xs); impl.push(xi);
    // ω = 1, h = r
    vs -= r * xs; xs += r * vs;
    const d = 1 + r * r;
    const nx = (xi + r * vi) / d, nv = (vi - r * xi) / d;
    xi = nx; vi = nv;
  }
  const x0 = 34, y0 = 40, w = DW - 52, hh = 144;
  axes(ctx, x0, y0, w, hh, `${N} pas de temps`, '');
  const X = (i: number) => x0 + (i / N) * w;
  const Y = (v: number) => y0 + hh / 2 - clamp(v, -1.9, 1.9) * (hh / 4);
  line(ctx, x0, Y(0), x0 + w, Y(0), CC.faint, 1);
  // the exact motion, sampled at the same instants
  ctx.save(); ctx.strokeStyle = alpha(CC.blue, 0.5); ctx.lineWidth = 1; ctx.beginPath();
  for (let i = 0; i <= N * 6; i++) { const s = i / 6; i ? ctx.lineTo(X(s), Y(Math.cos(s * r))) : ctx.moveTo(X(s), Y(Math.cos(s * r))); }
  ctx.stroke(); ctx.restore();
  const reveal = Math.min(N, Math.floor((e.t * 9) % (N + 14)));
  const draw = (arr: number[], col: string) => {
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.beginPath();
    for (let i = 0; i <= reveal; i++) i ? ctx.lineTo(X(i), Y(arr[i])) : ctx.moveTo(X(i), Y(arr[i]));
    ctx.stroke(); ctx.restore();
    for (let i = 0; i <= reveal; i++) dot(ctx, X(i), Y(arr[i]), col, 1.8);
  };
  draw(impl, CC.green);
  draw(semi, CC.red);
  const blew = semi.some((v) => Math.abs(v) > 1.9);
  text(ctx, `h·√(k/m) = ${r.toFixed(2).replace('.', ',')}`, 16, 16, CC.fg, 11, 'left', true);
  text(ctx, 'bleu : la vraie oscillation', 16, 30, alpha(CC.blue, 0.8), 9.5);
  text(ctx, blew ? 'semi-implicite : explose' : 'semi-implicite : oscille', DW - 16, 16, CC.red, 10.5, 'right');
  text(ctx, 'implicite : toujours stable', DW - 16, 30, CC.green, 10.5, 'right');
  text(ctx, r < 2 ? 'sous la limite de 2 : tout va bien' : 'au-delà de 2 : le pas explicite ne peut plus suivre',
    DW / 2, DH - 10, r < 2 ? CC.dim : CC.red, 10, 'center');
}

// =====================================================================
// valley — coordinate descent zigzagging in a narrow valley
// =====================================================================

function valley(ctx: Ctx, e: DiagEnv): void {
  // E(x, y) = ½(x² + y²) + ½·k·(x − y − 1)² : two bodies, one stiff spring
  const k = clamp(e.v.cond ?? 4, 0.2, 400);
  const xm = k / (1 + 2 * k), ym = -xm;
  const pts: [number, number][] = [[-1.3, 0.5]];
  let x = -1.3, y = 0.5, sweeps = 0;
  while (sweeps < 400) {
    x = (k * (y + 1)) / (1 + k); if (sweeps < 60) pts.push([x, y]);
    y = (k * (x - 1)) / (1 + k); if (sweeps < 60) pts.push([x, y]);
    sweeps++;
    if (Math.hypot(x - xm, y - ym) < 1e-3) break;
  }
  const R = 98, cx = 112, cy = 122;
  const S = R / 1.6;
  const PX = (u: number) => cx + u * S, PY = (v: number) => cy - v * S;
  // contours: ellipses along the eigenvectors (1, 1) and (1, −1)
  ctx.save();
  ctx.beginPath(); ctx.rect(cx - R, cy - R, 2 * R, 2 * R); ctx.clip();
  for (const L of [0.02, 0.08, 0.2, 0.4, 0.7, 1.1, 1.6]) {
    const a = Math.sqrt((2 * L) / 1), b = Math.sqrt((2 * L) / (1 + 2 * k));
    ctx.strokeStyle = alpha(CC.blue, 0.28); ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 80; i++) {
      const th = (i / 80) * Math.PI * 2;
      const u = a * Math.cos(th), v = b * Math.sin(th);
      const X = xm + (u + v) / Math.SQRT2, Y = ym + (u - v) / Math.SQRT2;
      i ? ctx.lineTo(PX(X), PY(Y)) : ctx.moveTo(PX(X), PY(Y));
    }
    ctx.stroke();
  }
  // the zigzag, revealed over time
  const shown = Math.min(pts.length - 1, Math.floor((e.t * 6) % (Math.min(pts.length, 61) + 12)));
  ctx.strokeStyle = CC.acc; ctx.lineWidth = 1.6; ctx.beginPath();
  for (let i = 0; i <= shown; i++) i ? ctx.lineTo(PX(pts[i][0]), PY(pts[i][1])) : ctx.moveTo(PX(pts[i][0]), PY(pts[i][1]));
  ctx.stroke();
  ctx.restore();
  panel(ctx, cx - R, cy - R, 2 * R, 2 * R, CC.faint, null, 6, 1);
  dot(ctx, PX(pts[0][0]), PY(pts[0][1]), CC.fg, 3);
  dot(ctx, PX(xm), PY(ym), CC.green, 4);
  text(ctx, 'corps 1 →', cx + R - 4, cy + R + 11, CC.dim, 9.5, 'right');
  text(ctx, 'corps 2 ↑', cx - R, cy - R - 8, CC.dim, 9.5);

  const tx = 232;
  text(ctx, 'raideur du ressort', tx, 40, CC.dim, 10);
  text(ctx, `${k < 10 ? k.toFixed(1).replace('.', ',') : Math.round(k)} × M/h²`, tx, 58, CC.fg, 14, 'left', true);
  text(ctx, 'balayages pour', tx, 92, CC.dim, 10);
  text(ctx, 'arriver au fond', tx, 105, CC.dim, 10);
  text(ctx, sweeps >= 400 ? '> 400' : String(sweeps), tx, 128, sweeps > 40 ? CC.red : CC.green, 22, 'left', true);
  text(ctx, 'un corps à la fois :', tx, 160, CC.dim, 10);
  text(ctx, 'horizontal, puis vertical', tx, 174, CC.dim, 10);
  text(ctx, 'la vallée étroite force', tx, 194, sweeps > 40 ? CC.red : CC.dim, 10);
  text(ctx, 'des pas minuscules', tx, 208, sweeps > 40 ? CC.red : CC.dim, 10);
}

// =====================================================================
// gpu — lanes, groups, kernels, and waiting on memory
// =====================================================================

function gpu(ctx: Ctx, e: DiagEnv): void {
  // the processor issues a launch
  panel(ctx, 12, 30, 58, 40, CC.violet, alpha(CC.violet, 0.12), 6, 1.4);
  text(ctx, 'processeur', 41, 50, CC.violet, 9.5, 'center');
  const pulse = (e.t * 0.6) % 1;
  arrow(ctx, 72, 50, 96, 50, pulse < 0.25 ? CC.violet : CC.faint, 1.6, 6);
  text(ctx, 'lance', 84, 40, CC.dim, 9, 'center');
  // twelve packets of 32 lanes; some compute while others wait on memory
  const gx = 102, gy = 22, cell = 4.4, gw = 8 * cell + 8, gh = 4 * cell + 8;
  for (let g = 0; g < 12; g++) {
    const col = g % 4, row = Math.floor(g / 4);
    const x = gx + col * (gw + 8), y = gy + row * (gh + 10);
    const phase = (e.t * 0.9 + g * 0.37) % 1;
    const waiting = phase > 0.35;
    panel(ctx, x, y, gw, gh, waiting ? CC.faint : CC.acc, waiting ? null : alpha(CC.acc, 0.08), 4, 1);
    for (let l = 0; l < 32; l++) {
      const lx = x + 4 + (l % 8) * cell, ly = y + 4 + Math.floor(l / 8) * cell;
      ctx.fillStyle = waiting ? alpha(CC.blue, 0.18) : CC.acc;
      ctx.fillRect(lx, ly, cell - 1.2, cell - 1.2);
    }
  }
  text(ctx, 'orange : calcule · gris : attend la mémoire', gx + 2 * (gw + 8) - 4, gy + 3 * (gh + 10) + 4, CC.dim, 9.5, 'center');
  // vocabulary
  const vx = 14, vy = 148;
  const rows: [string, string][] = [
    ['voie', 'un fil d’exécution : un petit carré'],
    ['paquet', '32 voies, même instruction au même instant'],
    ['noyau', 'le programme lancé sur tous les paquets'],
    ['mémoire partagée', 'rapide, propre à un groupe de travail'],
  ];
  rows.forEach(([a, b], i) => {
    text(ctx, a, vx, vy + i * 14, CC.fg, 10, 'left', true);
    text(ctx, b, vx + 112, vy + i * 14, CC.dim, 10);
  });
  // launches on a timeline: fixed costs between them
  const ty = 206;
  text(ctx, 'une image :', vx, ty, CC.dim, 9.5);
  let x = 80;
  for (let i = 0; i < 14 && x < DW - 20; i++) {
    const wk = 6 + ((i * 7) % 5) * 4;
    panel(ctx, x, ty - 6, wk, 12, CC.acc, alpha(CC.acc, 0.3), 2, 1);
    x += wk;
    line(ctx, x + 1, ty, x + 7, ty, CC.red, 1.4);
    x += 8;
  }
  text(ctx, 'rouge : frais fixes de chaque lancement', DW - 14, ty + 18, CC.red, 9, 'right');
}

// =====================================================================
// float — seven significant digits, and an addition that is not associative
// =====================================================================

const f = Math.fround;
const fmt = (v: number) => {
  const s = v.toPrecision(9);
  return s.includes('e') ? s : String(Number(s)).replace('.', ',');
};

function float(ctx: Ctx, e: DiagEnv): void {
  // gap between neighbouring float32 values, against magnitude
  const x0 = 46, y0 = 40, w = DW - 66, hh = 72;
  axes(ctx, x0, y0, w, hh, '', '');
  text(ctx, 'écart entre deux flottants voisins', 14, 14, CC.dim, 10);
  text(ctx, 'taille du nombre →', x0 + 2, y0 + hh + 24, CC.faint, 9.5);
  const X = (lg: number) => x0 + ((lg + 3) / 10) * w;        // 1e-3 … 1e7
  const Y = (lg: number) => y0 + hh - ((lg + 10) / 11) * hh;  // 1e-10 … 1e1
  ctx.save(); ctx.strokeStyle = CC.blue; ctx.lineWidth = 1.8; ctx.beginPath();
  for (let i = 0; i <= 100; i++) {
    const lg = -3 + i / 10;
    const v = 10 ** lg;
    const ulp = 2 ** (Math.floor(Math.log2(v)) - 23);
    i ? ctx.lineTo(X(lg), Y(Math.log10(ulp))) : ctx.moveTo(X(lg), Y(Math.log10(ulp)));
  }
  ctx.stroke(); ctx.restore();
  for (const [lg, l] of [[0, '1'], [3, '1 000'], [6, '10⁶']] as const) {
    line(ctx, X(lg), y0 + hh, X(lg), y0 + hh + 4, CC.dim, 1);
    text(ctx, l, X(lg), y0 + hh + 12, CC.faint, 9, 'center', true);
  }
  // the marker sweeps the axis
  const lg = -2 + ((Math.sin(e.t * 0.35) + 1) / 2) * 8;
  const v = 10 ** lg, ulp = 2 ** (Math.floor(Math.log2(v)) - 23);
  dot(ctx, X(lg), Y(Math.log10(ulp)), CC.acc, 4);
  text(ctx, `près de ${v < 1 ? v.toPrecision(2).replace('.', ',') : Math.round(v).toLocaleString('fr-FR')} : pas plus fin que ${ulp.toExponential(1).replace('.', ',')}`, DW - 14, 28, CC.acc, 10, 'right', true);

  // three additions, computed in float32 right now
  const rows: [string, number, string][] = [
    ['1 000 + 0,00001', f(f(1000) + f(1e-5)), 'le petit déplacement disparaît'],
    ['(10⁸ − 10⁸) + 1', f(f(f(1e8) - f(1e8)) + f(1)), ''],
    ['10⁸ + (−10⁸ + 1)', f(f(1e8) + f(f(-1e8) + f(1))), 'même calcul, autre ordre'],
  ];
  rows.forEach(([lab, val, note], i) => {
    const y = 152 + i * 21;
    text(ctx, lab, 18, y, CC.fg, 10.5, 'left', true);
    text(ctx, `= ${fmt(val)}`, 170, y, i === 0 || i === 2 ? CC.red : CC.green, 10.5, 'left', true);
    if (note) text(ctx, note, DW - 14, y, CC.dim, 9.5, 'right');
  });
  text(ctx, 'float32 : environ sept chiffres significatifs, pas un de plus', DW / 2, DH - 10, CC.dim, 10, 'center');
}

export const FOUNDATION_DIAGRAMS = { loops, newton, impulse, reaction, landscape, stiff, valley, gpu, float };

void clamp01;
