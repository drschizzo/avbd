// Diagrams for collision detection and for the GPU module.

import {
  CC, DH, DW, alpha, arrow, axes, camFor, camIn, circle, clamp, clamp01, dot, line, mix, panel, px, py, sstep, text,
} from './draw';
import type { DiagEnv } from './diagrams';

type Ctx = CanvasRenderingContext2D;

const rnd = (k: number) => { const s = Math.sin(k * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); };

// =====================================================================
// broad — AABBs, a tree, and the cost of being naive
// =====================================================================

export function broad(ctx: Ctx, e: DiagEnv): void {
  const n = 9;
  const cam = camIn(-1.9, 1.9, 0.2, 1.8, 14, 30, DW - 28, 78);
  const items = Array.from({ length: n }, (_, i) => ({
    x: -1.2 + rnd(i) * 2.4,
    y: 0.2 + rnd(i + 40) * 1.4 + Math.sin(e.t * 0.5 + i) * 0.06,
    r: 0.1 + rnd(i + 90) * 0.1,
  }));
  // two clusters, so the tree has something to prune
  for (let i = 0; i < n; i++) if (i % 2) items[i].x = items[i].x * 0.35 - 0.8; else items[i].x = items[i].x * 0.35 + 0.8;
  for (const it of items) {
    circle(ctx, px(cam, it.x), py(cam, it.y), it.r * cam.s, CC.blue, alpha(CC.blue, 0.2), 1.3);
    ctx.save();
    ctx.strokeStyle = alpha(CC.acc, 0.55); ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
    ctx.strokeRect(px(cam, it.x - it.r), py(cam, it.y + it.r), it.r * 2 * cam.s, it.r * 2 * cam.s);
    ctx.restore();
  }
  // the two group boxes
  for (const side of [-1, 1]) {
    const g = items.filter((_, i) => (i % 2 ? -1 : 1) === side);
    const x0 = Math.min(...g.map((p) => p.x - p.r)), x1 = Math.max(...g.map((p) => p.x + p.r));
    const y0 = Math.min(...g.map((p) => p.y - p.r)), y1 = Math.max(...g.map((p) => p.y + p.r));
    ctx.save();
    ctx.strokeStyle = alpha(CC.green, 0.75); ctx.lineWidth = 1.4;
    ctx.strokeRect(px(cam, x0) - 3, py(cam, y1) - 3, (x1 - x0) * cam.s + 6, (y1 - y0) * cam.s + 6);
    ctx.restore();
  }
  text(ctx, 'AABB', 14, 20, CC.acc, 10);
  text(ctx, 'nœuds de l’arbre', 14, 34, CC.green, 10);
  text(ctx, 'deux sous-arbres disjoints : aucune paire à tester entre eux', DW / 2, 124, CC.faint, 9.5, 'center');

  // the cost curves
  const N = clamp(Math.round(e.v.bodies ?? 1000), 50, 4000);
  const x0 = 50, y0 = 150, w = DW - 76, hh = 56;
  axes(ctx, x0, y0, w, hh, 'nombre de corps', 'tests');
  const X = (k: number) => x0 + (k / 4000) * w;
  const maxY = 4000 * 4000 / 2;
  const Y = (v: number) => y0 + hh - clamp01(Math.log10(v + 1) / Math.log10(maxY)) * hh;
  const plot = (fn: (k: number) => number, col: string) => {
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.beginPath();
    for (let k = 50; k <= 4000; k += 50) { const xx = X(k), yy = Y(fn(k)); k === 50 ? ctx.moveTo(xx, yy) : ctx.lineTo(xx, yy); }
    ctx.stroke(); ctx.restore();
  };
  plot((k) => (k * (k - 1)) / 2, CC.red);
  plot((k) => k * Math.log2(Math.max(2, k)) * 3, CC.green);
  line(ctx, X(N), y0, X(N), y0 + hh, CC.fg, 1, [3, 3]);
  const pairs = (N * (N - 1)) / 2;
  const tree = Math.round(N * Math.log2(N) * 3);
  text(ctx, 'tout contre tout', x0 + 6, y0 + 12, CC.red, 9.5);
  text(ctx, 'arbre', x0 + 6, y0 + 26, CC.green, 9.5);
  text(ctx, `${N} corps`, X(N), y0 - 7, CC.fg, 9.5, 'center', true);
  text(ctx, `${pairs.toLocaleString('fr-FR')} paires`, DW - 16, y0 + 10, CC.red, 10, 'right', true);
  text(ctx, `≈ ${tree.toLocaleString('fr-FR')} nœuds`, DW - 16, y0 + 24, CC.green, 10, 'right', true);
  text(ctx, `${Math.round(pairs / tree)} fois moins`, DW - 16, y0 + 40, CC.fg, 10, 'right');
}

// =====================================================================
// morton — the Z-order curve
// =====================================================================

export function morton(ctx: Ctx, e: DiagEnv): void {
  const G = 8, cell = 19, ox = 24, oy = 34;
  const part = (v: number) => { let r = 0; for (let b = 0; b < 3; b++) r |= ((v >> b) & 1) << (2 * b); return r; };
  const code = (x: number, y: number) => part(x) | (part(y) << 1);
  // the curve through all cells in code order
  const cells: { x: number; y: number; c: number }[] = [];
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) cells.push({ x, y, c: code(x, y) });
  cells.sort((a, b) => a.c - b.c);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
    panel(ctx, ox + x * cell, oy + (G - 1 - y) * cell, cell - 2, cell - 2, CC.grid, null, 2, 1);
  }
  const shown = Math.floor(((e.t * 0.5) % 1) * cells.length) + 1;
  ctx.save();
  ctx.strokeStyle = CC.acc; ctx.lineWidth = 1.6;
  ctx.beginPath();
  cells.slice(0, shown).forEach((c, i) => {
    const X = ox + c.x * cell + cell / 2 - 1, Y = oy + (G - 1 - c.y) * cell + cell / 2 - 1;
    i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
  });
  ctx.stroke(); ctx.restore();
  const head = cells[shown - 1];
  dot(ctx, ox + head.x * cell + cell / 2 - 1, oy + (G - 1 - head.y) * cell + cell / 2 - 1, CC.fg, 4);
  text(ctx, 'la courbe passe par les cases', ox, 22, CC.dim, 10.5);
  text(ctx, 'dans l’ordre de leur code', ox, DH - 14, CC.faint, 10);

  // the interleaving, in bits
  const bx = ox + G * cell + 26;
  const bits = (v: number, n: number) => v.toString(2).padStart(n, '0');
  text(ctx, 'entrelacer les bits', bx, 34, CC.dim, 10.5);
  text(ctx, `x = ${head.x}`, bx, 56, CC.blue, 11, 'left', true);
  text(ctx, bits(head.x, 3), bx + 54, 56, CC.blue, 11, 'left', true);
  text(ctx, `y = ${head.y}`, bx, 74, CC.green, 11, 'left', true);
  text(ctx, bits(head.y, 3), bx + 54, 74, CC.green, 11, 'left', true);
  line(ctx, bx, 86, bx + 120, 86, CC.faint, 1);
  // the interleaved result, coloured per source
  const s = bits(head.c, 6);
  for (let i = 0; i < 6; i++) {
    text(ctx, s[i], bx + 54 + i * 9, 104, i % 2 === 0 ? CC.green : CC.blue, 12, 'left', true);
  }
  text(ctx, 'code', bx, 104, CC.acc, 11, 'left', true);
  text(ctx, `= ${head.c}`, bx + 54, 124, CC.acc, 11, 'left', true);
  text(ctx, 'deux codes proches', bx, 156, CC.fg, 10.5);
  text(ctx, '⇒ deux cases proches', bx, 170, CC.fg, 10.5);
  text(ctx, 'trier les codes, c’est', bx, 190, CC.dim, 10);
  text(ctx, 'trier dans l’espace', bx, 204, CC.dim, 10);
}

// =====================================================================
// sat — separating axis
// =====================================================================

export function sat(ctx: Ctx, e: DiagEnv): void {
  const cam = camFor(-1.6, 1.6, -0.9, 1.1, 26);
  const t = e.t;
  const A = { x: -0.42, y: 0.12, a: 0.22, hw: 0.4, hh: 0.26 };
  const B = { x: 0.3 + 0.16 * Math.sin(t * 0.55), y: -0.02, a: -0.5 + 0.25 * Math.sin(t * 0.33), hw: 0.3, hh: 0.3 };
  const cornersOf = (b: typeof A) => {
    const c = Math.cos(b.a), s = Math.sin(b.a);
    return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => [b.x + sx * b.hw * c - sy * b.hh * s, b.y + sx * b.hw * s + sy * b.hh * c] as [number, number]);
  };
  const drawBox = (b: typeof A, col: string) => {
    const cs = cornersOf(b);
    ctx.save(); ctx.strokeStyle = col; ctx.fillStyle = alpha(col, 0.14); ctx.lineWidth = 1.6;
    ctx.beginPath();
    cs.forEach(([x, y], i) => (i ? ctx.lineTo(px(cam, x), py(cam, y)) : ctx.moveTo(px(cam, x), py(cam, y))));
    ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
  };
  drawBox(A, CC.blue);
  drawBox(B, CC.acc);

  // the four candidate axes, and the best separation on each
  const axesList: { nx: number; ny: number; src: string }[] = [];
  for (const [b, src] of [[A, 'A'], [B, 'B']] as const) {
    const c = Math.cos(b.a), s = Math.sin(b.a);
    axesList.push({ nx: c, ny: s, src }, { nx: -s, ny: c, src });
  }
  let best = { sep: -Infinity, nx: 0, ny: 0 };
  const seps = axesList.map((ax) => {
    const pa = cornersOf(A).map(([x, y]) => x * ax.nx + y * ax.ny);
    const pb = cornersOf(B).map(([x, y]) => x * ax.nx + y * ax.ny);
    const sep = Math.max(Math.min(...pb) - Math.max(...pa), Math.min(...pa) - Math.max(...pb));
    if (sep > best.sep) best = { sep, nx: ax.nx, ny: ax.ny };
    return { ax, sep, pa, pb };
  });

  // projections, drawn as intervals on a side bar
  const bx = DW - 126;
  text(ctx, 'axes candidats', bx, 24, CC.dim, 10, 'left');
  seps.forEach((s0, i) => {
    const y = 42 + i * 34;
    const isBest = Math.abs(s0.sep - best.sep) < 1e-9;
    const lo = Math.min(...s0.pa, ...s0.pb), hi = Math.max(...s0.pa, ...s0.pb);
    const sc = 92 / Math.max(1e-6, hi - lo);
    const seg = (vals: number[], col: string, yy: number) => {
      const a0 = (Math.min(...vals) - lo) * sc, a1 = (Math.max(...vals) - lo) * sc;
      line(ctx, bx + a0, yy, bx + a1, yy, col, 3.5);
    };
    seg(s0.pa, CC.blue, y);
    seg(s0.pb, CC.acc, y + 7);
    text(ctx, `${s0.ax.src}${i % 2 ? '⊥' : '∥'}`, bx - 22, y + 3, isBest ? CC.green : CC.faint, 10, 'left', true);
    if (s0.sep > 0) text(ctx, '✓', bx + 98, y + 3, CC.green, 11, 'left');
    else if (isBest) text(ctx, 'min', bx + 98, y + 3, CC.red, 9, 'left');
  });

  const touching = best.sep <= 0;
  // the winning normal, drawn on the shapes
  if (touching) {
    const mxp = (A.x + B.x) / 2, myp = (A.y + B.y) / 2;
    arrow(ctx, px(cam, mxp), py(cam, myp), px(cam, mxp + best.nx * 0.42), py(cam, myp + best.ny * 0.42), CC.red, 2.2);
    text(ctx, 'n', px(cam, mxp + best.nx * 0.5), py(cam, myp + best.ny * 0.5), CC.red, 12, 'center', true);
  }
  text(ctx, touching ? `contact · profondeur ${(-best.sep).toFixed(3)} m` : 'un axe les sépare : pas de contact',
    14, 22, touching ? CC.red : CC.green, 11, 'left');
  text(ctx, touching ? 'la normale est l’axe de recouvrement minimal' : 'on s’arrête dès qu’un axe sépare', 14, 38, CC.dim, 10);
}

// =====================================================================
// manifold — clipping gives several points
// =====================================================================

export function manifold(ctx: Ctx, e: DiagEnv): void {
  const cam = camFor(-1.5, 1.5, -0.5, 1.1, 26);
  const a = 0.1 * Math.sin(e.t * 0.5);
  // reference face: the ground; incident face: the bottom of a tilted box
  line(ctx, px(cam, -1.4), py(cam, 0), px(cam, 1.4), py(cam, 0), CC.dim, 2.5);
  const bx = 0, by = 0.3, hw = 0.55, hh = 0.3;
  const c = Math.cos(a), s = Math.sin(a);
  const cs = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => [bx + sx * hw * c - sy * hh * s, by + sx * hw * s + sy * hh * c] as [number, number]);
  ctx.save(); ctx.strokeStyle = CC.blue; ctx.fillStyle = alpha(CC.blue, 0.14); ctx.lineWidth = 1.6;
  ctx.beginPath();
  cs.forEach(([x, y], i) => (i ? ctx.lineTo(px(cam, x), py(cam, y)) : ctx.moveTo(px(cam, x), py(cam, y))));
  ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
  // the two lowest corners become the contact points
  const sorted = [...cs].sort((p, q) => p[1] - q[1]).slice(0, 2);
  const single = ((e.t * 0.35) % 2) < 1;
  const pts = single ? [sorted[0]] : sorted;
  for (const [x, y] of pts) {
    circle(ctx, px(cam, x), py(cam, 0), 7, CC.red, alpha(CC.red, 0.25), 1.8);
    arrow(ctx, px(cam, x), py(cam, 0), px(cam, x), py(cam, 0) - 24, CC.red, 1.8);
    line(ctx, px(cam, x), py(cam, y), px(cam, x), py(cam, 0), CC.faint, 1, [2, 2]);
  }
  text(ctx, single ? 'un seul point : la caisse bascule autour de lui' : 'deux points : la caisse est tenue',
    DW / 2, 28, single ? CC.red : CC.green, 11.5, 'center');
  text(ctx, single ? 'les vibrations classiques d’un moteur mal réglé' : 'c’est le « manifold » de contact',
    DW / 2, 44, CC.dim, 10, 'center');
  text(ctx, 'en 3D : jusqu’à quatre points par face', DW / 2, DH - 32, CC.dim, 10.5, 'center');
  text(ctx, 'chacun devient une contrainte indépendante', DW / 2, DH - 16, CC.faint, 10, 'center');
}

// =====================================================================
// jacobian — the lever arm, driven by the pointer
// =====================================================================

export function jacobian(ctx: Ctx, e: DiagEnv): void {
  const cx = 150, cy = 118, hw = 62, hh = 56;
  panel(ctx, cx - hw, cy - hh, hw * 2, hh * 2, CC.blue, alpha(CC.blue, 0.14), 5, 1.6);
  dot(ctx, cx, cy, CC.acc, 4);
  text(ctx, 'centre de masse', cx, cy + hh + 16, CC.dim, 10, 'center');
  // contact on the right face; the pointer chooses its height
  const py0 = e.ptr ? clamp(e.ptr.y, cy - hh, cy + hh) : cy + Math.sin(e.t * 0.6) * hh * 0.9;
  const cxp = cx + hw;
  // n points to the left (the wall pushes the body)
  const nx = -1, ny = 0;
  dot(ctx, cxp, py0, CC.red, 4.5);
  arrow(ctx, cxp, py0, cxp - 46, py0, CC.red, 2);
  text(ctx, 'n', cxp - 54, py0 - 8, CC.red, 12, 'left', true);
  arrow(ctx, cx, cy, cxp, py0, CC.acc, 1.6);
  text(ctx, 'r', (cx + cxp) / 2 + 4, (cy + py0) / 2 - 8, CC.acc, 12, 'left', true);
  // r x n (2D scalar): rx*ny - ry*nx, with screen y flipped
  const rx = (cxp - cx) / 80, ry = (cy - py0) / 80;
  const cross = rx * ny - ry * nx;
  const R = 34;
  ctx.save();
  ctx.strokeStyle = CC.violet; ctx.lineWidth = 2.2;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, clamp(cross * 2.2, -2.6, 2.6), cross < 0); ctx.stroke();
  ctx.restore();
  text(ctx, '∂C/∂x = n', 14, 22, CC.red, 11, 'left', true);
  text(ctx, '∂C/∂θ = r × n', 14, 40, CC.violet, 11, 'left', true);
  const box = { x: DW - 128, y: 40, w: 114, h: 64 };
  panel(ctx, box.x, box.y, box.w, box.h, CC.faint, 'rgba(0,0,0,.25)', 8);
  text(ctx, 'r × n', box.x + box.w / 2, box.y + 16, CC.dim, 10, 'center');
  text(ctx, cross.toFixed(3), box.x + box.w / 2, box.y + 38, Math.abs(cross) < 0.04 ? CC.green : CC.violet, 18, 'center', true);
  text(ctx, Math.abs(cross) < 0.04 ? 'aucune rotation' : cross > 0 ? 'bascule vers le haut' : 'bascule vers le bas',
    box.x + box.w / 2, box.y + 54, CC.faint, 9.5, 'center');
  text(ctx, e.ptr ? '' : 'déplacez la souris sur le schéma', DW / 2, DH - 12, CC.faint, 10, 'center');
}

// =====================================================================
// conflict — two touching bodies solved at the same time
// =====================================================================

export function conflict(ctx: Ctx, e: DiagEnv): void {
  const t = (e.t * 0.32) % 1;
  const s = 46, d = 16, fy = 150;
  const W = DW / 2 - 18;
  // Jacobi: both lanes read the other's old pose and each removes the whole
  // overlap. Gauss-Seidel: A moves first, then B sees A already moved.
  const pJ = sstep(0.18, 0.5, t);
  const pA = sstep(0.18, 0.36, t), pB = sstep(0.4, 0.58, t);
  const fade = 1 - sstep(0.93, 1, t);
  for (const [k, x0] of [[0, 10], [1, DW / 2 + 8]] as const) {
    const cx = x0 + W / 2;
    const jac = k === 0;
    panel(ctx, x0, 26, W, 176, jac ? alpha(CC.red, 0.35) : alpha(CC.green, 0.35), 'rgba(255,255,255,.015)', 8, 1);
    text(ctx, jac ? 'en même temps' : 'l’un après l’autre', cx, 42, jac ? CC.red : CC.green, 11.5, 'center');
    text(ctx, jac ? 'Jacobi' : 'Gauss-Seidel', cx, 57, CC.faint, 9.5, 'center');
    line(ctx, x0 + 10, fy, x0 + W - 10, fy, CC.dim, 1.4);
    const ax0 = cx - s + d / 2, bx0 = cx - d / 2;
    const ax = ax0 - d * (jac ? pJ : pA) * fade;
    const bx = bx0 + (jac ? d * pJ : 0) * fade;
    // overlap, or the gap the parallel version leaves
    const ov = ax + s - bx;
    if (ov > 0.5) {
      ctx.fillStyle = alpha(CC.red, 0.35);
      ctx.fillRect(bx, fy - s, ov, s);
    } else if (ov < -0.5) {
      line(ctx, ax + s, fy - s / 2, bx, fy - s / 2, CC.red, 1.4, [2, 2]);
      text(ctx, 'trou', (ax + s + bx) / 2, fy - s / 2 - 10, CC.red, 9.5, 'center');
    }
    panel(ctx, ax, fy - s, s, s, CC.blue, alpha(CC.blue, 0.14), 4, 1.5);
    panel(ctx, bx, fy - s, s, s, CC.acc, alpha(CC.acc, 0.14), 4, 1.5);
    text(ctx, 'A', ax + s / 2, fy - s / 2, CC.blue, 12, 'center', true);
    text(ctx, 'B', bx + s / 2, fy - s / 2, CC.acc, 12, 'center', true);
    // which lane is working right now
    const busyA = jac ? pJ > 0 && pJ < 1 : pA > 0 && pA < 1;
    const busyB = jac ? pJ > 0 && pJ < 1 : pB > 0 && pB < 1;
    text(ctx, 'voie 1', ax + s / 2 - 6, fy - s - 14, busyA ? CC.blue : CC.faint, 9.5, 'center');
    text(ctx, 'voie 2', bx + s / 2 + 6, fy - s - 14, busyB ? CC.acc : CC.faint, 9.5, 'center');
    // the verdict, once the motion is over
    const done = sstep(0.6, 0.7, t) * fade;
    ctx.globalAlpha = done;
    if (jac) {
      text(ctx, 'chacun a corrigé tout le recouvrement', cx, fy + 18, CC.red, 9.5, 'center');
      text(ctx, 'en croyant l’autre immobile', cx, fy + 32, alpha(CC.red, 0.8), 9.5, 'center');
    } else {
      text(ctx, 'B voit A déjà déplacé :', cx, fy + 18, CC.green, 9.5, 'center');
      text(ctx, 'il n’a plus rien à corriger', cx, fy + 32, alpha(CC.green, 0.8), 9.5, 'center');
    }
    ctx.globalAlpha = 1;
  }
  text(ctx, 'deux corps qui se touchent ne peuvent pas être résolus ensemble', DW / 2, 14, CC.dim, 10.5, 'center');
  text(ctx, 'deux corps sans contact commun, en revanche, sont libres', DW / 2, DH - 14, CC.faint, 10, 'center');
}

// =====================================================================
// colouring — the contact graph (AVBD colours bodies, not constraints)
// =====================================================================

export function colouring(ctx: Ctx, e: DiagEnv): void {
  const n = 12;
  const edges: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (rnd(i * 31 + j * 7) < 0.26) { edges[i].push(j); edges[j].push(i); }
  const maxCol = clamp(Math.round(e.v.colors ?? 8), 1, 16);
  // greedy, but capped: a capped colouring is what a too-small budget produces
  const col = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const used = new Set(edges[i].filter((j) => j < i).map((j) => col[j]));
    let c = 0;
    while (used.has(c) && c < maxCol - 1) c++;
    col[i] = c;
  }
  const pal = [CC.acc, CC.blue, CC.green, CC.pink, CC.violet, CC.red, '#7ddcff', '#ffd27a', '#9aa3b8'];
  const pos = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return [DW / 2 - 40 + Math.cos(a) * 90, DH / 2 + 6 + Math.sin(a) * 78];
  });
  let bad = 0;
  for (let i = 0; i < n; i++) for (const j of edges[i]) if (j > i) {
    const clash = col[i] === col[j];
    if (clash) bad++;
    line(ctx, pos[i][0], pos[i][1], pos[j][0], pos[j][1], clash ? CC.red : CC.faint, clash ? 2.2 : 1);
  }
  for (let i = 0; i < n; i++) {
    const c = pal[col[i] % pal.length];
    circle(ctx, pos[i][0], pos[i][1], 12, c, alpha(c, 0.28), 1.8);
  }
  const used = new Set(col).size;
  text(ctx, 'un sommet = un corps', 14, 20, CC.dim, 10.5);
  text(ctx, 'une arête = un contact entre deux corps', 14, 34, CC.dim, 10.5);
  const bx = DW - 104;
  text(ctx, 'couleurs', bx, 54, CC.dim, 10, 'center');
  text(ctx, String(used), bx, 76, CC.fg, 22, 'center', true);
  text(ctx, 'conflits', bx, 104, CC.dim, 10, 'center');
  text(ctx, String(bad), bx, 126, bad ? CC.red : CC.green, 22, 'center', true);
  text(ctx, bad ? 'voisins en même temps' : 'aucun conflit', bx, 144, bad ? CC.red : CC.green, 9.5, 'center');
  text(ctx, `${used} lancements par itération`, bx, 170, CC.faint, 9.5, 'center');
}

// =====================================================================
// workgroup — one lane per body vs 32 lanes per body
// =====================================================================

export function workgroup(ctx: Ctx, e: DiagEnv): void {
  const t = (e.t * 0.45) % 1;
  const N = 16;
  // top: one lane, 16 serial reads
  const y0 = 46;
  text(ctx, 'une voie par corps : 16 lectures en file', 16, y0 - 14, CC.red, 11);
  for (let i = 0; i < N; i++) {
    const on = i <= t * N;
    panel(ctx, 16 + i * 20, y0, 16, 16, on ? CC.red : CC.faint, on ? alpha(CC.red, 0.3) : null, 3, 1);
  }
  line(ctx, 16, y0 + 26, 16 + N * 20 - 4, y0 + 26, alpha(CC.red, 0.6), 1.4);
  text(ctx, '16 × la latence mémoire', 16 + N * 10, y0 + 38, alpha(CC.red, 0.8), 10, 'center');

  // bottom: 32 lanes, all at once, then a tree reduction
  const y1 = 128;
  text(ctx, '32 voies pour un corps : tout en même temps, puis réduction', 16, y1 - 14, CC.green, 11);
  const p1 = clamp01(t * 2);
  for (let i = 0; i < N; i++) {
    const on = p1 > 0.1;
    panel(ctx, 16 + i * 20, y1, 16, 16, on ? CC.green : CC.faint, on ? alpha(CC.green, 0.3) : null, 3, 1);
  }
  // the reduction tree
  const p2 = clamp01((t - 0.5) * 2);
  let span = 1;
  let level = 0;
  while (span < N) {
    const yy = y1 + 26 + level * 13;
    const lvlOn = p2 > level / 4;
    for (let i = 0; i < N; i += span * 2) {
      if (i + span >= N) continue;
      const xa = 16 + i * 20 + 8, xb = 16 + (i + span) * 20 + 8;
      line(ctx, xa, yy - 10, xa, yy, lvlOn ? CC.green : CC.faint, 1.2);
      line(ctx, xb, yy - 10, xa, yy, lvlOn ? CC.green : CC.faint, 1.2);
    }
    span *= 2; level++;
  }
  text(ctx, 'log₂(32) = 5 étages en mémoire partagée', 16 + N * 10, y1 + 84, alpha(CC.green, 0.8), 10, 'center');
  text(ctx, 'bake d’une pyramide : 60 s → 4 s', DW / 2, DH - 12, CC.fg, 10.5, 'center');
}

// =====================================================================
// dispatch — where the time actually goes
// =====================================================================

export function dispatch(ctx: Ctx, e: DiagEnv): void {
  const colors = clamp(Math.round(e.v.colors ?? 8), 2, 16);
  const it = clamp(Math.round(e.v.iterations ?? 10), 1, 40);
  const sub = clamp(Math.round(e.v.substeps ?? 4), 1, 8);
  const solveD = colors * it * sub;
  const otherD = 40;
  const total = solveD + otherD;
  const fixedMs = (total * 6) / 1000;
  const workMs = 1.4;
  const x0 = 44, y0 = 48, w = DW - 70, hh = 36;
  text(ctx, 'une image de simulation', x0, 30, CC.dim, 11);
  const scale = w / Math.max(4, fixedMs + workMs);
  panel(ctx, x0, y0, fixedMs * scale, hh, CC.red, alpha(CC.red, 0.28), 5, 1.4);
  panel(ctx, x0 + fixedMs * scale, y0, workMs * scale, hh, CC.green, alpha(CC.green, 0.28), 5, 1.4);
  text(ctx, 'frais de lancement', x0 + 8, y0 + hh / 2, CC.red, 10.5);
  if (workMs * scale > 60) text(ctx, 'calcul utile', x0 + fixedMs * scale + 8, y0 + hh / 2, CC.green, 10.5);
  text(ctx, `${fixedMs.toFixed(2)} ms`, x0 + 8, y0 + hh + 14, CC.red, 10, 'left', true);
  text(ctx, `${workMs.toFixed(2)} ms`, x0 + fixedMs * scale + 8, y0 + hh + 14, CC.green, 10, 'left', true);

  const rows: [string, number][] = [
    ['détection, arbre, tri', otherD],
    [`solveur : ${colors} couleurs × ${it} itérations × ${sub} sous-pas`, solveD],
  ];
  rows.forEach(([lab, v], i) => {
    const y = 128 + i * 30;
    text(ctx, lab, x0, y, CC.dim, 10.5);
    panel(ctx, x0, y + 8, (v / total) * w, 10, i ? CC.violet : CC.blue, alpha(i ? CC.violet : CC.blue, 0.45), 4, 1);
    text(ctx, `${v}`, x0 + w, y, CC.fg, 10.5, 'right', true);
  });
  text(ctx, `${total} lancements de noyau par image`, DW / 2, DH - 30, CC.fg, 11.5, 'center');
  text(ctx, 'plancher mesuré : ≈ 6 µs par lancement', DW / 2, DH - 14, CC.faint, 10, 'center');
}

// =====================================================================
// determinism
// =====================================================================

export function determinism(ctx: Ctx, e: DiagEnv): void {
  const t = (e.t * 0.4) % 1;
  text(ctx, 'deux exécutions du même pas de temps', DW / 2, 26, CC.dim, 11, 'center');
  const order = (i: number, run: number) => (run === 0 ? i : [2, 0, 3, 1][i]);
  for (const run of [0, 1]) {
    const y = 56 + run * 46;
    text(ctx, run ? 'exécution B' : 'exécution A', 16, y + 10, run ? CC.violet : CC.acc, 10.5);
    for (let i = 0; i < 4; i++) {
      const on = t * 4 > i;
      const x = 110 + order(i, run) * 42;
      panel(ctx, x, y, 34, 20, on ? (run ? CC.violet : CC.acc) : CC.faint, on ? alpha(run ? CC.violet : CC.acc, 0.25) : null, 4, 1);
      text(ctx, `f${i}`, x + 17, y + 10, on ? CC.fg : CC.faint, 10, 'center', true);
    }
    text(ctx, 'atomicAdd', 110 + 4 * 42 + 8, y + 10, CC.faint, 9.5);
  }
  line(ctx, 16, 150, DW - 16, 150, CC.faint, 1);
  text(ctx, 'somme de contrôle', 16, 166, CC.dim, 10.5);
  text(ctx, '0x4A1F…C2', 180, 166, CC.acc, 10.5, 'left', true);
  text(ctx, '0x4A1F…C9', 290, 166, CC.violet, 10.5, 'left', true);
  text(ctx, 'diffère ✗', DW - 16, 166, CC.red, 10, 'right');
  text(ctx, 'enfoncement max', 16, 188, CC.dim, 10.5);
  text(ctx, '0,31 mm', 180, 188, CC.acc, 10.5, 'left', true);
  text(ctx, '0,31 mm', 290, 188, CC.violet, 10.5, 'left', true);
  text(ctx, 'stable ✓', DW - 16, 188, CC.green, 10, 'right');
  text(ctx, 'l’addition flottante n’est pas associative', DW / 2, 212, CC.faint, 10, 'center');
}

// =====================================================================
// mpm — particles and grid, in turn
// =====================================================================

export function mpm(ctx: Ctx, e: DiagEnv): void {
  const phase = Math.floor((e.t * 0.5) % 4);
  const labels = ['1 · particules → grille', '2 · pression et viscosité sur la grille', '3 · intégration de la grille', '4 · grille → particules'];
  const G = 7, cell = 22, ox = 60, oy = 48;
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
    const active = (phase === 1 || phase === 2) && rnd(x * 13 + y * 7) > 0.45;
    panel(ctx, ox + x * cell, oy + y * cell, cell - 2, cell - 2, active ? alpha(CC.blue, 0.6) : CC.grid, active ? alpha(CC.blue, 0.18) : null, 2, 1);
  }
  const P = 34;
  for (let i = 0; i < P; i++) {
    const a = rnd(i) * 6.28, r = rnd(i + 20) * 60;
    const x = ox + G * cell / 2 + Math.cos(a) * r * 0.9;
    const y = oy + G * cell / 2 + Math.sin(a) * r * 0.55 + 10;
    dot(ctx, x, y, phase === 0 || phase === 3 ? CC.acc : alpha(CC.acc, 0.4), 3);
    if (phase === 0 || phase === 3) {
      const gx = ox + (Math.floor((x - ox) / cell) + 0.5) * cell;
      const gy = oy + (Math.floor((y - oy) / cell) + 0.5) * cell;
      if (gx > ox && gx < ox + G * cell && gy > oy && gy < oy + G * cell) {
        arrow(ctx, phase === 0 ? x : gx, phase === 0 ? y : gy, phase === 0 ? gx : x, phase === 0 ? gy : y, alpha(phase === 0 ? CC.acc : CC.green, 0.6), 1, 4);
      }
    }
  }
  text(ctx, labels[phase], DW / 2, 26, CC.fg, 11.5, 'center');
  const bx = ox + G * cell + 22;
  const rows = ['masse et', 'quantité de', 'mouvement', '', 'puis la', 'vitesse', 'corrigée'];
  rows.forEach((r, i) => text(ctx, r, bx, 60 + i * 15, CC.dim, 10));
  text(ctx, 'particules : la matière', 16, DH - 28, CC.acc, 10);
  text(ctx, 'grille : le voisinage, gratuit', 16, DH - 14, CC.blue, 10);
}

// =====================================================================
// coupling
// =====================================================================

export function coupling(ctx: Ctx, e: DiagEnv): void {
  const t = (e.t * 0.5) % 2;
  const cx = DW / 2, cy = 120;
  // a floating box and the water around it
  panel(ctx, cx - 34, cy - 24, 68, 48, CC.blue, alpha(CC.blue, 0.18), 5, 1.6);
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    const r = 70 + Math.sin(a * 3 + e.t) * 8;
    dot(ctx, cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.55, alpha(CC.acc, 0.6), 2.6);
  }
  const toBox = t < 1;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const r0 = 66, r1 = 38;
    const p = toBox ? sstep(0, 1, t) : sstep(0, 1, t - 1);
    const ra = toBox ? mix(r0, r1, p) : mix(r1, r0, p);
    const x = cx + Math.cos(a) * ra, y = cy + Math.sin(a) * ra * 0.6;
    arrow(ctx, x, y, x + Math.cos(a) * (toBox ? -10 : 10), y + Math.sin(a) * (toBox ? -10 : 10) * 0.6, toBox ? CC.acc : CC.green, 1.6, 5);
  }
  text(ctx, toBox ? 'le liquide perd de la quantité de mouvement contre le corps' : 'le corps la rend au liquide, en se déplaçant',
    DW / 2, 28, toBox ? CC.acc : CC.green, 11, 'center');
  text(ctx, toBox ? '→ elle devient une impulsion sur le corps' : '→ la carte de collision est refaite avec sa nouvelle vitesse',
    DW / 2, 44, CC.dim, 10, 'center');
  text(ctx, 'à chaque sous-pas du liquide, pas une fois par image', DW / 2, DH - 16, CC.faint, 10, 'center');
}

// =====================================================================
// bake — the recording and the loop
// =====================================================================

export function bake(ctx: Ctx, e: DiagEnv): void {
  const x0 = 28, w = DW - 56, y0 = 52;
  text(ctx, 'la simulation est enregistrée image par image', DW / 2, 26, CC.dim, 11, 'center');
  const F = 24;
  const head = Math.floor((e.t * 6) % (F + 8));
  for (let i = 0; i < F; i++) {
    const on = i <= head;
    panel(ctx, x0 + (i * w) / F, y0, w / F - 2, 22, on ? CC.green : CC.faint, on ? alpha(CC.green, 0.25) : null, 3, 1);
  }
  text(ctx, '16 octets par corps et par image', x0, y0 + 38, CC.dim, 10.5);
  text(ctx, 'position : 3 × f32', x0 + 16, y0 + 54, CC.blue, 10, 'left', true);
  text(ctx, 'orientation : 10:10:10:2', x0 + 16, y0 + 70, CC.violet, 10, 'left', true);
  text(ctx, '(les 3 plus petites composantes du quaternion)', x0 + 16, y0 + 84, CC.faint, 9.5);
  // the loop
  const ly = y0 + 112;
  line(ctx, x0, ly, x0 + w, ly, CC.faint, 1.4);
  const lp = (e.t * 0.25) % 1;
  dot(ctx, x0 + lp * w, ly, CC.acc, 5);
  const outro = 0.78;
  panel(ctx, x0 + outro * w, ly - 9, (1 - outro) * w, 18, CC.acc, alpha(CC.acc, 0.2), 4, 1);
  text(ctx, 'transition', x0 + outro * w + (1 - outro) * w / 2, ly + 24, CC.acc, 9.5, 'center');
  text(ctx, 'début', x0, ly + 24, CC.dim, 9.5, 'left');
  text(ctx, 'fin = début', x0 + w, ly + 24, CC.dim, 9.5, 'right');
  ctx.save();
  ctx.strokeStyle = alpha(CC.acc, 0.5); ctx.lineWidth = 1.2; ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(x0 + w, ly - 12);
  ctx.bezierCurveTo(x0 + w, ly - 42, x0, ly - 42, x0, ly - 12);
  ctx.stroke(); ctx.restore();
}

export const DETECTION_DIAGRAMS = {
  broad, morton, sat, manifold, jacobian, conflict, colouring, workgroup, dispatch, determinism, mpm, coupling, bake,
};

void axes; void clamp01; void camFor;
