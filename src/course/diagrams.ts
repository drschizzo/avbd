// The animated 2D diagrams of the course. Each one is a function of (time,
// current values, pointer): no internal state, so scrubbing the tour or
// dragging a slider redraws a consistent picture.
//
// The diagrams that explain the solver do not fake it: they run the real
// mini engine from ./mini and show what it actually produced.

import {
  CC, DW, DH, alpha, arrow, axes, camFor, circle, clamp, clamp01, dot, line, mix, panel, px, py, sstep, text,
  type Cam,
} from './draw';
import { Mini, corners, makeBox, makeCircle, separation, type Params, type Solver } from './mini';
import type { Vals } from './tour';
import { beginBudget } from './simcache';
import { SOLVER_DIAGRAMS } from './diagrams2';
import { DETECTION_DIAGRAMS } from './diagrams3';
import { FOUNDATION_DIAGRAMS } from './diagrams4';

type Ctx = CanvasRenderingContext2D;
export interface DiagEnv { t: number; v: Vals; ptr: { x: number; y: number } | null; hits: Set<string>; arg?: string }

// =====================================================================
// 1. Roadmap — the shape of a physics step
// =====================================================================

const STEPS = [
  { k: 'Prédiction', s: 'où irait chaque corps\nsans rien pour l’arrêter' },
  { k: 'Détection', s: 'qui touche qui,\net selon quelle normale' },
  { k: 'Contraintes', s: 'ce que chaque contact\ninterdit' },
  { k: 'Résolution', s: 'corriger les poses\njusqu’à satisfaire tout' },
  { k: 'Vitesses', s: 'la vitesse est le\nmouvement qui a eu lieu' },
];

function roadmap(ctx: Ctx, e: DiagEnv): void {
  const n = STEPS.length;
  const w = 64, h = 44, gap = (DW - 28 - n * w) / (n - 1);
  const cur = Math.floor((e.t / 2.4) % n);
  const sub = ((e.t / 2.4) % 1);
  text(ctx, 'un pas de temps', 14, 18, CC.dim, 11);
  for (let i = 0; i < n; i++) {
    const x = 14 + i * (w + gap), y = 34;
    const on = i === cur;
    panel(ctx, x, y, w, h, on ? CC.acc : CC.faint, on ? alpha(CC.acc, 0.12) : 'rgba(255,255,255,.02)', 7, on ? 1.6 : 1);
    text(ctx, STEPS[i].k, x + w / 2, y + 16, on ? CC.acc : CC.fg, 11, 'center');
    text(ctx, String(i + 1), x + w / 2, y + 32, CC.dim, 10, 'center', true);
    if (i < n - 1) arrow(ctx, x + w + 3, y + h / 2, x + w + gap - 3, y + h / 2, i < cur ? CC.dim : CC.faint, 1.4, 5);
  }
  // the detail of the current step
  const d = STEPS[cur].s.split('\n');
  const fade = sstep(0, 0.15, sub) * (1 - sstep(0.85, 1, sub));
  ctx.globalAlpha = fade;
  d.forEach((l, i) => text(ctx, l, DW / 2, 100 + i * 15, CC.fg, 12, 'center'));
  ctx.globalAlpha = 1;
  // the loop arrow underneath
  ctx.save();
  ctx.strokeStyle = CC.faint; ctx.lineWidth = 1.2; ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(14 + (n - 1) * (w + gap) + w / 2, 34 + h + 6);
  ctx.bezierCurveTo(DW - 10, 160, 10, 160, 14 + w / 2, 34 + h + 6);
  ctx.stroke(); ctx.restore();
  text(ctx, '… et on recommence, 60 à 480 fois par seconde', DW / 2, 168, CC.dim, 11, 'center');
  // what the GPU does on top
  panel(ctx, 14, 184, DW - 28, 36, alpha(CC.violet, 0.5), alpha(CC.violet, 0.08), 7);
  text(ctx, 'sur la carte graphique, les milliers de corps', DW / 2, 194, CC.violet, 10.5, 'center');
  text(ctx, 'traversent chaque étape ensemble · module 4', DW / 2, 208, CC.dim, 10, 'center');
}

// =====================================================================
// 2. The state of a body
// =====================================================================

function state(ctx: Ctx, e: DiagEnv): void {
  const cx = 150, cy = 128;
  const a = Math.sin(e.t * 0.5) * 0.6;
  const hw = 36, hh = 26;
  // world axes
  line(ctx, 30, 196, DW - 20, 196, CC.grid, 1);
  line(ctx, 30, 196, 30, 36, CC.grid, 1);
  text(ctx, 'O', 22, 202, CC.dim, 10, 'center', true);
  // the body
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(-a);
  panel(ctx, -hw, -hh, hw * 2, hh * 2, CC.blue, alpha(CC.blue, 0.16), 5, 1.6);
  line(ctx, 0, 0, hw, 0, alpha(CC.blue, 0.5), 1, [3, 3]);
  ctx.restore();
  // x: position of the centre of mass
  arrow(ctx, 30, 196, cx, cy, CC.acc, 1.8);
  text(ctx, 'x', (30 + cx) / 2 - 6, (196 + cy) / 2 + 10, CC.acc, 12, 'left', true);
  dot(ctx, cx, cy, CC.acc, 4);
  text(ctx, 'centre de masse', cx + 8, cy + 44, CC.dim, 10);
  // q: orientation
  ctx.save();
  ctx.strokeStyle = CC.green; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.arc(cx, cy, 52, -a, 0, a > 0); ctx.stroke();
  ctx.restore();
  text(ctx, 'q', cx + 58 * Math.cos(-a / 2), cy + 58 * Math.sin(-a / 2), CC.green, 12, 'center', true);
  // v and omega
  const vx = 54 * Math.cos(e.t * 0.8), vy = -30;
  arrow(ctx, cx, cy, cx + vx, cy + vy, CC.pink, 1.8);
  text(ctx, 'v', cx + vx + 6, cy + vy - 4, CC.pink, 12, 'left', true);
  ctx.save();
  ctx.strokeStyle = CC.violet; ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.arc(cx, cy, 20, 0.4, 0.4 + 1.9); ctx.stroke();
  ctx.restore();
  arrow(ctx, cx + 20 * Math.cos(2.2), cy + 20 * Math.sin(2.2), cx + 20 * Math.cos(2.45), cy + 20 * Math.sin(2.45), CC.violet, 1.8, 6);
  text(ctx, 'ω', cx - 30, cy - 20, CC.violet, 12, 'center', true);
  // the twelve numbers
  const rows: [string, string, string][] = [
    ['x', 'position', CC.acc], ['q', 'orientation', CC.green], ['v', 'vitesse', CC.pink], ['ω', 'vitesse angulaire', CC.violet],
  ];
  rows.forEach(([k, l, c], i) => {
    const y = 48 + i * 22;
    text(ctx, k, DW - 112, y, c, 12, 'left', true);
    text(ctx, l, DW - 96, y, CC.dim, 10);
    text(ctx, k === 'q' ? '4' : '3', DW - 18, y, CC.fg, 10, 'right', true);
  });
  line(ctx, DW - 114, 48 + 4 * 22 - 10, DW - 14, 48 + 4 * 22 - 10, CC.faint, 1);
  text(ctx, 'en mémoire', DW - 112, 48 + 4 * 22 + 4, CC.dim, 10);
  text(ctx, '13', DW - 18, 48 + 4 * 22 + 4, CC.fg, 10, 'right', true);
}

// =====================================================================
// 3. Euler — explicit vs semi-implicit
// =====================================================================

/** True ballistic trajectory and its Euler polyline, over one second. */
function euler(ctx: Ctx, e: DiagEnv): void {
  if (e.arg === 'compare') return eulerCompare(ctx, e);
  const g = 9.81, v0x = 3.0, v0y = 4.2, T = 1.05;
  const cam = camFor(-0.2, 3.4, -1.9, 1.3, 26);
  // exact parabola
  ctx.save();
  ctx.strokeStyle = CC.blue; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i <= 120; i++) {
    const t = (i / 120) * T;
    const X = px(cam, v0x * t), Y = py(cam, v0y * t - 0.5 * g * t * t);
    i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
  }
  ctx.stroke(); ctx.restore();

  // Euler polyline
  const n = Math.max(2, Math.round(e.v.steps ?? 12));
  const h = T / n;
  const pts: [number, number][] = [];
  let x = 0, y = 0, vx = v0x, vy = v0y;
  pts.push([x, y]);
  for (let i = 0; i < n; i++) { x += h * vx; y += h * vy; vy += h * -g; pts.push([x, y]); }

  // the gap between the two, as an area
  ctx.save();
  ctx.fillStyle = alpha(CC.acc, 0.14);
  ctx.beginPath();
  ctx.moveTo(px(cam, pts[0][0]), py(cam, pts[0][1]));
  for (const [X, Y] of pts) ctx.lineTo(px(cam, X), py(cam, Y));
  for (let i = 120; i >= 0; i--) {
    const t = (i / 120) * T;
    ctx.lineTo(px(cam, v0x * t), py(cam, v0y * t - 0.5 * g * t * t));
  }
  ctx.closePath(); ctx.fill(); ctx.restore();

  ctx.save();
  ctx.strokeStyle = CC.acc; ctx.lineWidth = 1.8;
  ctx.beginPath();
  pts.forEach(([X, Y], i) => (i ? ctx.lineTo(px(cam, X), py(cam, Y)) : ctx.moveTo(px(cam, X), py(cam, Y))));
  ctx.stroke(); ctx.restore();
  for (const [X, Y] of pts) dot(ctx, px(cam, X), py(cam, Y), CC.acc, 2.4);

  // the ball travelling along the exact curve
  const tt = (e.t * 0.5) % 1 * T;
  dot(ctx, px(cam, v0x * tt), py(cam, v0y * tt - 0.5 * g * tt * tt), CC.blue, 5);

  const last = pts[pts.length - 1];
  const exact = [v0x * T, v0y * T - 0.5 * g * T * T];
  const err = Math.hypot(last[0] - exact[0], last[1] - exact[1]);
  text(ctx, 'trajectoire exacte', 16, 22, CC.blue, 11);
  text(ctx, `${n} pas d’Euler`, 16, 38, CC.acc, 11);
  text(ctx, `écart à l’arrivée : ${(err * 100).toFixed(1)} cm`, DW - 14, 22, CC.fg, 11, 'right', true);
  text(ctx, `h = ${(h * 1000).toFixed(1)} ms`, DW - 14, 38, CC.dim, 11, 'right', true);
}

/** Energy of a pendulum over time: explicit grows, semi-implicit does not. */
function eulerCompare(ctx: Ctx, e: DiagEnv): void {
  const N = 240, h = 0.05, g = 9.81, L = 1;
  const series = (semi: boolean) => {
    let th = 1.0, w = 0;
    const out: number[] = [];
    for (let i = 0; i < N; i++) {
      if (semi) { w += h * (-g / L) * Math.sin(th); th += h * w; } else { const t0 = th; th += h * w; w += h * (-g / L) * Math.sin(t0); }
      out.push(0.5 * w * w * L * L + g * L * (1 - Math.cos(th)));
    }
    return out;
  };
  const ex = series(false), si = series(true);
  const e0 = g * L * (1 - Math.cos(1.0));
  const x0 = 46, y0 = 34, w = DW - 70, hh = 128;
  axes(ctx, x0, y0, w, hh, 'temps', 'énergie');
  const maxE = e0 * 3;
  const Y = (v: number) => y0 + hh - clamp01(v / maxE) * hh;   // clipped: the explicit run leaves the top
  line(ctx, x0, Y(e0), x0 + w, Y(e0), CC.faint, 1, [3, 3]);
  text(ctx, 'énergie de départ', x0 + 4, Y(e0) - 8, CC.dim, 10);
  const shown = Math.min(N, Math.floor((e.t % 6) / 6 * N) + 8);
  for (const [arr, col] of [[si, CC.green], [ex, CC.red]] as const) {
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.beginPath();
    for (let i = 0; i < shown; i++) { const X = x0 + (i / (N - 1)) * w; i ? ctx.lineTo(X, Y(arr[i])) : ctx.moveTo(X, Y(arr[i])); }
    ctx.stroke(); ctx.restore();
  }
  text(ctx, 'Euler explicite', x0 + 6, y0 + 12, CC.red, 11);
  text(ctx, 'Euler semi-implicite', x0 + 6, y0 + 28, CC.green, 11);
  // the two pendulums
  const bob = (cx: number, arr: number[], col: string, lab: string) => {
    const E = arr[Math.max(0, shown - 1)];
    const amp = Math.min(1.5, Math.acos(clamp(1 - E / (g * L), -1, 1)));
    const th = amp * Math.sin(e.t * 2.2);
    const cy = 184, R = 26;
    line(ctx, cx, cy - R, cx, cy - R + 2, CC.dim, 1);
    line(ctx, cx, cy - R, cx + R * Math.sin(th), cy - R + R * Math.cos(th), col, 1.4);
    dot(ctx, cx + R * Math.sin(th), cy - R + R * Math.cos(th), col, 5);
    text(ctx, lab, cx, cy + 22, CC.dim, 10, 'center');
  };
  bob(DW / 2 - 70, ex, CC.red, 'explicite');
  bob(DW / 2 + 70, si, CC.green, 'semi-implicite');
}

// =====================================================================
// 4. Rotation: inertia and torque
// =====================================================================

function rotation(ctx: Ctx, e: DiagEnv): void {
  const cx = 104, cy = 112;
  const a = e.t * 0.7;
  // a bar, easy to spin about one axis, hard about the other
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(a);
  panel(ctx, -62, -11, 124, 22, CC.blue, alpha(CC.blue, 0.16), 4, 1.6);
  ctx.restore();
  dot(ctx, cx, cy, CC.acc, 4);
  // r x F
  const ang = 0.5 + Math.sin(e.t * 0.8) * 0.8;
  const rx = 56 * Math.cos(a), ry = 56 * Math.sin(a);
  arrow(ctx, cx, cy, cx + rx, cy + ry, CC.acc, 1.6);
  text(ctx, 'r', cx + rx * 0.55 + 4, cy + ry * 0.55 - 8, CC.acc, 12, 'left', true);
  const fx = 42 * Math.cos(ang), fy = 42 * Math.sin(ang);
  arrow(ctx, cx + rx, cy + ry, cx + rx + fx, cy + ry + fy, CC.pink, 2);
  text(ctx, 'F', cx + rx + fx + 6, cy + ry + fy, CC.pink, 12, 'left', true);
  // the torque is the cross product: only the perpendicular part turns the body
  const tz = rx * fy - ry * fx;
  const R = 32;
  ctx.save();
  ctx.strokeStyle = CC.violet; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, clamp(tz / 2600, -2.6, 2.6), tz < 0); ctx.stroke();
  ctx.restore();
  text(ctx, 'τ = r × F', cx, cy + 74, CC.violet, 12, 'center', true);
  text(ctx, tz > 0 ? 'fait tourner dans le sens direct' : 'fait tourner dans l’autre sens', cx, cy + 90, CC.dim, 10, 'center');

  // inertia: the same mass, two axes
  const bx = DW - 104;
  text(ctx, 'moment d’inertie', bx, 32, CC.dim, 10.5, 'center');
  const bars: [string, number, string][] = [['autour du milieu', 1, CC.red], ['autour de sa longueur', 0.1, CC.green]];
  bars.forEach(([l, val, col], i) => {
    const y = 56 + i * 44;
    text(ctx, l, bx - 50, y, CC.fg, 9.5);
    panel(ctx, bx - 50, y + 8, 100, 10, CC.faint, null, 5, 1);
    panel(ctx, bx - 50, y + 8, 100 * val, 10, col, alpha(col, 0.5), 5, 1);
  });
  text(ctx, 'même masse, dix fois plus dur', bx, 158, CC.dim, 9.5, 'center');
  text(ctx, 'à faire tourner dans un sens', bx, 172, CC.dim, 9.5, 'center');
}

// =====================================================================
// registry
// =====================================================================

export type DiagFn = (ctx: Ctx, e: DiagEnv) => void;

export const DIAGRAMS: Record<string, DiagFn> = {
  roadmap, state, euler, rotation,
  ...SOLVER_DIAGRAMS,
  ...DETECTION_DIAGRAMS,
  ...FOUNDATION_DIAGRAMS,
};

export function drawDiagram(name: string, ctx: Ctx, e: DiagEnv): void {
  beginBudget(2);
  ctx.clearRect(0, 0, DW, DH);
  const fn = DIAGRAMS[name];
  if (!fn) { text(ctx, `schéma « ${name} » manquant`, DW / 2, DH / 2, CC.dim, 11, 'center'); return; }
  try { fn(ctx, e); } catch (err) { text(ctx, String(err), 10, 20, CC.red, 10); }
}

// Re-exported so the solver diagrams (added below) share one engine instance.
export { Mini, makeBox, makeCircle, separation, corners };
export type { Params, Solver, Cam };
export { camFor, px, py, mix, sstep, dot, line, circle, text, arrow, panel, alpha, clamp, clamp01, axes, CC, DW, DH };
