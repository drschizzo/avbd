// The workshop: the learner writes the pieces of the engine themselves.
//
// Each challenge hollows out one function of a small, readable 2D solver (the
// kernel below — the same algorithm as ./mini, stripped of everything that is
// not the lesson). The learner's version is compiled and run on the same
// scenario as the reference; the two trajectories are compared, body by body
// and frame by frame.

import type { Progress } from './course';
import { CC, DH, DW, alpha, arrow, camFor, circle, dot, line, panel, px, py, text } from './draw';
import { highlight } from './tourUI';
import { el as h } from '../util/dom';

// =====================================================================
// the kernel: a 2D solver whose steps are replaceable
// =====================================================================

export interface LabBody { x: number; y: number; a: number; vx: number; vy: number; w: number; m: number; I: number; hw: number; hh: number; px: number; py: number; pa: number; ox: number; oy: number; oa: number }
export interface LabContact { i: number; j: number; nx: number; ny: number; rax: number; ray: number; rbx: number; rby: number; bias: number; k: number; lam: number; C: number }

export type SlotName = 'integrate' | 'predict' | 'separation' | 'contactForce' | 'dualUpdate' | 'coulomb' | 'finishVelocity' | 'colourGraph';

export interface Slot { sig: string; sol: string; doc: string }

export const SLOTS: Record<SlotName, Slot> = {
  integrate: {
    sig: 'function integrate(b, h, g)',
    doc: 'b : un corps ({x, y, vx, vy}) · h : le pas de temps (s) · g : l’accélération de la pesanteur (négative)',
    sol: `function integrate(b, h, g) {
  b.vy += h * g;      // d'abord la vitesse…
  b.x  += h * b.vx;   // …puis la position, avec la NOUVELLE vitesse
  b.y  += h * b.vy;
}`,
  },
  predict: {
    sig: 'function predict(b, h, g, alpha)',
    doc: 'Renvoie [x̃, ỹ] : la position « inertielle », celle que le corps atteindrait si aucune contrainte ne le retenait. alpha (1 ici) dose la part de pesanteur mise dans la prédiction — rien à voir avec le α de stabilisation d’AVBD.',
    sol: `function predict(b, h, g, alpha) {
  return [b.x + h * b.vx,
          b.y + h * b.vy + h * h * g * alpha];
}`,
  },
  separation: {
    sig: 'function separation(c, A, B)',
    doc: 'c : le contact (normale n, ancres r_A et r_B dans le repère de chaque corps, décalage c.bias) · A, B : les deux corps. Renvoie C : positif si les corps sont séparés, négatif s’ils s’interpénètrent.',
    sol: `function separation(c, A, B) {
  const ax = A.x + rot(A.a, c.rax, c.ray)[0];
  const ay = A.y + rot(A.a, c.rax, c.ray)[1];
  const bx = B.x + rot(B.a, c.rbx, c.rby)[0];
  const by = B.y + rot(B.a, c.rbx, c.rby)[1];
  return (ax - bx) * c.nx + (ay - by) * c.ny + c.bias;
}`,
  },
  contactForce: {
    sig: 'function contactForce(c, C)',
    doc: 'c : le contact (raideur c.k, multiplicateur c.lam) · C : la séparation. Renvoie la force scalaire du contact — négative quand il pousse — ou 0 si le contact est inactif.',
    sol: `function contactForce(c, C) {
  const f = c.k * C + c.lam;
  // contact unilatéral : il pousse, il ne tire jamais
  if (C >= 0 && f >= 0) return 0;
  return f;
}`,
  },
  dualUpdate: {
    sig: 'function dualUpdate(c, C, beta, kMax)',
    doc: 'Met à jour c.lam (le multiplicateur, toujours ≤ 0) et c.k (la raideur, jamais au-delà de kMax) après une itération.',
    sol: `function dualUpdate(c, C, beta, kMax) {
  c.lam = Math.min(0, c.lam + c.k * C);
  if (c.lam < 0) c.k = Math.min(kMax, c.k + beta * Math.abs(C));
}`,
  },
  coulomb: {
    sig: 'function coulomb(ft, mu, lam)',
    doc: 'ft : la force tangentielle que voudrait appliquer le frottement · mu : le coefficient · lam : le multiplicateur normal (≤ 0). Renvoie la force tangentielle effectivement appliquée.',
    sol: `function coulomb(ft, mu, lam) {
  const lim = mu * Math.abs(lam);
  return Math.max(-lim, Math.min(lim, ft));
}`,
  },
  finishVelocity: {
    sig: 'function finishVelocity(b, h)',
    doc: 'Après la résolution, b.x / b.y / b.a sont les positions corrigées et b.ox / b.oy / b.oa celles du début du sous-pas. Mettez à jour b.vx, b.vy, b.w.',
    sol: `function finishVelocity(b, h) {
  b.vx = (b.x - b.ox) / h;
  b.vy = (b.y - b.oy) / h;
  b.w  = (b.a - b.oa) / h;
}`,
  },
  colourGraph: {
    sig: 'function colourGraph(n, edges)',
    doc: 'n : nombre de corps · edges : pour chaque corps, la liste des corps qui le touchent. Renvoie un tableau de couleurs (entiers ≥ 0) tel que deux corps en contact n’aient jamais la même.',
    sol: `function colourGraph(n, edges) {
  const col = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const used = new Set();
    for (const j of edges[i]) if (col[j] >= 0) used.add(col[j]);
    let c = 0;
    while (used.has(c)) c++;
    col[i] = c;
  }
  return col;
}`,
  },
};

const rot = (a: number, x: number, y: number): [number, number] => {
  const c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
};

type Impl = Record<SlotName, Function>;

function reference(): Impl {
  const out: Partial<Impl> = {};
  for (const k of Object.keys(SLOTS) as SlotName[]) out[k] = compile(SLOTS[k].sol, k);
  return out as Impl;
}

/** Compiles one slot. `rot` is in scope so the learner can use it. */
export function compile(src: string, name: SlotName): Function {
  const f = new Function('rot', `"use strict";\n${src}\nreturn ${name};`);
  return f(rot);
}

// --------------------------------------------------------------- the solver

export interface LabScene { bodies: LabBody[]; floor: number; mu: number }

const body = (x: number, y: number, hw: number, hh: number, m = 1): LabBody => ({
  x, y, a: 0, vx: 0, vy: 0, w: 0, m, I: m > 0 ? (m * (4 * hw * hw + 4 * hh * hh)) / 12 : 0,
  hw, hh, px: x, py: y, pa: 0, ox: x, oy: y, oa: 0,
});

export const LAB_SCENES: Record<string, () => LabScene> = {
  drop: () => ({ bodies: [body(0, 1.6, 0.25, 0.25)], floor: 0, mu: 0.5 }),
  stack: () => ({ bodies: [0, 1, 2, 3].map((i) => body(0, 0.25 + i * 0.52, 0.25, 0.25)), floor: 0, mu: 0.5 }),
  impact: () => ({ bodies: [Object.assign(body(0, 2.4, 0.25, 0.25), { vy: -1 })], floor: 0, mu: 0.5 }),
  slide: () => ({ bodies: [Object.assign(body(-1, 0.25, 0.25, 0.25), { vx: 3.2 })], floor: 0, mu: 0.35 }),
};

// kMax: 3 × M/h² for the workshop's 1 kg boxes at 240 Hz, as in ./mini
const P = { h: 1 / 60, substeps: 4, iterations: 8, g: -9.81, alpha: 1, beta: 1e6, kMin: 1e3, kMax: 1.7e5, gamma: 0.99 };

/**
 * One frame of the solver. Everything the challenges can replace goes through
 * `im`; the rest (collision detection, the 3x3 assembly) is fixed.
 */
export function labStep(sc: LabScene, im: Impl, store: Map<string, LabContact>): void {
  const hs = P.h / P.substeps;
  for (let s = 0; s < P.substeps; s++) {
    const cs = collide(sc, store);
    for (const b of sc.bodies) {
      b.ox = b.x; b.oy = b.y; b.oa = b.a;
      if (b.m === 0) continue;
      const [qx, qy] = im.predict(b, hs, P.g, P.alpha);
      b.px = qx; b.py = qy; b.pa = b.a + hs * b.w;
      b.x = b.px; b.y = b.py; b.a = b.pa;
    }
    const ih2 = 1 / (hs * hs);
    for (let it = 0; it < P.iterations; it++) {
      for (let i = 0; i < sc.bodies.length; i++) {
        const b = sc.bodies[i];
        if (b.m === 0) continue;
        let gx = b.m * ih2 * (b.x - b.px), gy = b.m * ih2 * (b.y - b.py), ga = b.I * ih2 * (b.a - b.pa);
        let h00 = b.m * ih2, h11 = b.m * ih2, h22 = b.I * ih2, h01 = 0, h02 = 0, h12 = 0;
        for (const c of cs) {
          const sgn = c.i === i ? 1 : c.j === i ? -1 : 0;
          if (sgn === 0) continue;
          const A = sc.bodies[c.i], B = c.j >= 0 ? sc.bodies[c.j] : GROUND(sc.floor);
          const C = im.separation(c, A, B);
          c.C = C;
          const f = im.contactForce(c, C);
          const [rx, ry] = rot(b.a, sgn > 0 ? c.rax : c.rbx, sgn > 0 ? c.ray : c.rby);
          const jx = sgn * c.nx, jy = sgn * c.ny, ja = sgn * (rx * c.ny - ry * c.nx);
          if (f !== 0) {
            gx += f * jx; gy += f * jy; ga += f * ja;
            h00 += c.k * jx * jx; h11 += c.k * jy * jy; h22 += c.k * ja * ja;
            h01 += c.k * jx * jy; h02 += c.k * jx * ja; h12 += c.k * jy * ja;
          }
          if (sc.mu > 0 && (C < 0 || f !== 0)) {
            const tx = -c.ny, ty = c.nx;
            const dx = (A.x - A.ox) - (A.a - A.oa) * ry, dy = (A.y - A.oy) + (A.a - A.oa) * rx;
            const Ct = dx * tx + dy * ty;
            const ft = im.coulomb(c.k * Ct, sc.mu, c.lam);
            const jtx = sgn * tx, jty = sgn * ty, jta = sgn * (rx * ty - ry * tx);
            gx += ft * jtx; gy += ft * jty; ga += ft * jta;
            const ke = Math.abs(ft) >= sc.mu * Math.abs(c.lam) ? Math.abs(ft) / Math.max(Math.abs(Ct), 1e-9) : c.k;
            h00 += ke * jtx * jtx; h11 += ke * jty * jty; h22 += ke * jta * jta;
            h01 += ke * jtx * jty; h02 += ke * jtx * jta; h12 += ke * jty * jta;
          }
        }
        const d = solve3(h00, h01, h02, h11, h12, h22, -gx, -gy, -ga);
        const L = Math.hypot(d[0], d[1]), fct = L > 0.25 ? 0.25 / L : 1;
        b.x += d[0] * fct; b.y += d[1] * fct; b.a += Math.max(-1, Math.min(1, d[2]));
      }
      for (const c of cs) {
        const A = sc.bodies[c.i], B = c.j >= 0 ? sc.bodies[c.j] : GROUND(sc.floor);
        im.dualUpdate(c, im.separation(c, A, B), P.beta, P.kMax);
      }
    }
    for (const b of sc.bodies) { if (b.m !== 0) im.finishVelocity(b, hs); }
  }
}

let groundCache: LabBody | null = null;
const GROUND = (y: number): LabBody => {
  if (!groundCache) groundCache = body(0, 0, 50, 1, 0);
  groundCache.x = 0; groundCache.y = y - 1; groundCache.a = 0;
  groundCache.ox = groundCache.x; groundCache.oy = groundCache.y; groundCache.oa = 0;
  return groundCache;
};

function collide(sc: LabScene, store: Map<string, LabContact>): LabContact[] {
  const out: LabContact[] = [];
  const add = (i: number, j: number, wx: number, wy: number, nx: number, ny: number, sep: number, id: string) => {
    const A = sc.bodies[i], B = j >= 0 ? sc.bodies[j] : GROUND(sc.floor);
    const [rax, ray] = rot(-A.a, wx - A.x, wy - A.y);
    const [rbx, rby] = rot(-B.a, wx - B.x, wy - B.y);
    const old = store.get(id);
    // the stiffness carries over (decayed by γ), λ is rebuilt each substep
    const c: LabContact = { i, j, nx, ny, rax, ray, rbx, rby, bias: 0, k: old ? Math.min(P.kMax, Math.max(P.kMin, old.k * P.gamma)) : P.kMin, lam: 0, C: sep };
    const raw = (A.x + rot(A.a, rax, ray)[0] - (B.x + rot(B.a, rbx, rby)[0])) * nx
      + (A.y + rot(A.a, rax, ray)[1] - (B.y + rot(B.a, rbx, rby)[1])) * ny;
    c.bias = sep - raw;
    store.set(id, c);
    out.push(c);
  };
  for (let i = 0; i < sc.bodies.length; i++) {
    const b = sc.bodies[i];
    if (b.m === 0) continue;
    for (const [ci, [sx, sy]] of ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).entries()) {
      const [lx, ly] = rot(b.a, sx * b.hw, sy * b.hh);
      const wy = b.y + ly;
      if (wy - sc.floor > 0.05) continue;
      add(i, -1, b.x + lx, wy, 0, 1, wy - sc.floor, `${i}-f${ci}`);
    }
    for (let j = i + 1; j < sc.bodies.length; j++) {
      const o = sc.bodies[j];
      const dy = b.y - o.y;
      const gap = Math.abs(dy) - (b.hh + o.hh);
      if (gap > 0.05 || Math.abs(b.x - o.x) > b.hw + o.hw) continue;
      const sgn = dy >= 0 ? 1 : -1;
      for (const sx of [-1, 1]) {
        const wx = (b.x + o.x) / 2 + sx * Math.min(b.hw, o.hw) * 0.8;
        add(i, j, wx, (b.y - sgn * b.hh + o.y + sgn * o.hh) / 2, 0, sgn, gap, `${i}-${j}-${sx}`);
      }
    }
  }
  return out;
}

function solve3(a00: number, a01: number, a02: number, a11: number, a12: number, a22: number, b0: number, b1: number, b2: number): [number, number, number] {
  const e = 1e-12;
  const d0 = a00 + e, l10 = a01 / d0, l20 = a02 / d0;
  const d1 = a11 - l10 * a01 + e, l21 = (a12 - l20 * a01) / d1;
  const d2 = a22 - l20 * a02 - l21 * l21 * d1 + e;
  const y0 = b0, y1 = b1 - l10 * y0, y2 = b2 - l20 * y0 - l21 * y1;
  const z2 = y2 / d2, z1 = y1 / d1 - l21 * z2, z0 = y0 / d0 - l10 * z1 - l20 * z2;
  return [z0, z1, z2];
}

// =====================================================================
// the challenges
// =====================================================================

export interface Challenge {
  id: string;
  module: number;
  slot: SlotName;
  title: string;
  scene: keyof typeof LAB_SCENES;
  goal: string;
  starter: string;
  hints: string[];
  win: string;
  /** pure check, for the slots that are not plugged into the solver */
  check?: (fn: Function) => string | null;
}

export const CHALLENGES: Challenge[] = [
  {
    id: 'integrate', module: 0, slot: 'integrate', scene: 'drop', title: 'Un pas d’intégration',
    goal: 'Faites avancer un corps d’un pas de temps avec la méthode d’Euler semi-implicite : la vitesse change d’abord sous l’effet de la pesanteur, puis la position suit la vitesse mise à jour.',
    starter: `function integrate(b, h, g) {
  // À vous : d'abord la vitesse, ensuite la position.

}`,
    hints: [
      'La pesanteur change la vitesse verticale : b.vy += h * g (g est déjà négatif).',
      'Ensuite la position suit la vitesse : b.x += h * b.vx, et pareil pour y.',
      'b.vy += h * g;\n  b.x += h * b.vx;\n  b.y += h * b.vy;',
    ],
    win: 'Votre corps tombe exactement comme celui de la référence.',
    // the solver below is position-based and never calls `integrate`, so this
    // challenge is checked directly against the reference integrator
    check(fn) {
      for (const [vx0, vy0, h] of [[0, 0, 1 / 60], [2.5, 4, 1 / 60], [-1, 3, 1 / 240]] as const) {
        const a: any = { x: 0, y: 2, vx: vx0, vy: vy0 };
        const b: any = { x: 0, y: 2, vx: vx0, vy: vy0 };
        const refFn = compile(SLOTS.integrate.sol, 'integrate');
        for (let i = 0; i < 200; i++) {
          try { fn(a, h, -9.81); } catch (err: any) { return `erreur : ${err?.message ?? err}`; }
          refFn(b, h, -9.81);
          if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) return 'le corps part à l’infini';
          if (Math.hypot(a.x - b.x, a.y - b.y) > 1e-9) {
            if (a.x === 0 && a.y === 2 && a.vx === vx0 && a.vy === vy0) return 'Votre fonction ne modifie rien : le corps reste sur place.';
            // the classic near-miss: the position updated before the velocity
            let px0 = 0, py0 = 2, pvx = vx0, pvy = vy0;
            for (let k = 0; k <= i; k++) { px0 += h * pvx; py0 += h * pvy; pvy += h * -9.81; }
            if (Math.hypot(a.x - px0, a.y - py0) < 1e-9) return 'C’est Euler *explicite* : la position est mise à jour avec l’ancienne vitesse. Inversez les deux lignes.';
            return `au pas ${i + 1}, votre corps est à ${Math.hypot(a.x - b.x, a.y - b.y).toFixed(4)} m de la référence`;
          }
        }
      }
      return null;
    },
  },
  {
    id: 'predict', module: 0, slot: 'predict', scene: 'drop', title: 'La position inertielle',
    goal: 'AVBD commence chaque sous-pas en calculant x̃ : où le corps irait si rien ne le retenait. C’est la cible que la minimisation essaiera de ne pas trop quitter. Renvoyez [x̃, ỹ].',
    starter: `function predict(b, h, g, alpha) {
  // À vous : position + vitesse × h + accélération × h², et alpha dose la pesanteur
  return [b.x, b.y];
}`,
    hints: [
      'Horizontalement, aucune force : x̃ = b.x + h * b.vx.',
      'Verticalement, il faut en plus le terme d’accélération : + h * h * g * alpha.',
      'return [b.x + h * b.vx, b.y + h * b.vy + h * h * g * alpha];',
    ],
    win: 'La prédiction est juste : le solveur part du bon endroit.',
  },
  {
    id: 'separation', module: 1, slot: 'separation', scene: 'stack', title: 'La valeur d’une contrainte',
    goal: 'Un contact stocke une ancre dans le repère de chaque corps — le même point du monde au moment où il a été créé. Mesurez de combien ces deux points se sont écartés le long de la normale, et ajoutez c.bias, qui porte la séparation initiale.',
    starter: `function separation(c, A, B) {
  // rot(angle, x, y) tourne un vecteur local vers le monde
  // À vous : les deux points du monde, puis leur écart le long de n
  return 0;
}`,
    hints: [
      'Point du monde côté A : A.x + rot(A.a, c.rax, c.ray)[0], et de même pour y.',
      'L’écart le long de la normale est un produit scalaire : (ax − bx) * c.nx + (ay − by) * c.ny.',
      'N’oubliez pas d’ajouter c.bias à la fin.',
    ],
    win: 'Le solveur connaît maintenant le chevauchement des corps : la pile tient.',
  },
  {
    id: 'contactForce', module: 1, slot: 'contactForce', scene: 'stack', title: 'Un contact ne fait que pousser',
    goal: 'La force d’un contact vaut k·C + λ. Mais un contact est unilatéral : s’il est séparé (C ≥ 0) et que cette force voudrait rapprocher les corps, il ne doit rien appliquer du tout. Renvoyez 0 dans ce cas.',
    starter: `function contactForce(c, C) {
  const f = c.k * C + c.lam;
  // À vous : désactiver le contact quand il voudrait tirer
  return f;
}`,
    hints: [
      'Une force positive, pour un contact dont la normale va de B vers A, rapproche les corps.',
      'Si le contact est séparé (C ≥ 0) et que f ≥ 0, le contact est inactif.',
      'if (C >= 0 && f >= 0) return 0;',
    ],
    win: 'Les corps ne se collent plus les uns aux autres en se séparant.',
  },
  {
    id: 'dualUpdate', module: 2, slot: 'dualUpdate', scene: 'stack', title: 'La mise à jour duale',
    goal: 'C’est l’étape propre à AVBD. Après chaque itération, le multiplicateur absorbe la force que la pénalité est encore en train de fournir (λ ← λ + k·C, toujours ≤ 0). Et tant que le contact pousse (λ < 0), la raideur monte de β·|C|, sans dépasser kMax. Un contact qui se sépare voit λ remonter tout seul jusqu’à 0.',
    starter: `function dualUpdate(c, C, beta, kMax) {
  // À vous : λ absorbe k·C (sans devenir positif) ;
  // puis, si le contact pousse encore, k monte de beta·|C|, plafonné à kMax.

}`,
    hints: [
      'Le multiplicateur : c.lam = Math.min(0, c.lam + c.k * C).',
      'Le contact pousse encore si c.lam < 0.',
      'Montée : if (c.lam < 0) c.k = Math.min(kMax, c.k + beta * Math.abs(C));',
    ],
    win: 'λ porte maintenant la force de contact : la pile ne s’enfonce plus que de quelques centièmes de millimètre.',
  },
  {
    id: 'coulomb', module: 2, slot: 'coulomb', scene: 'slide', title: 'Le cône de frottement',
    goal: 'Le frottement ne peut pas dépasser μ fois la force normale. Bornez la force tangentielle demandée dans cet intervalle — c’est tout le modèle de Coulomb.',
    starter: `function coulomb(ft, mu, lam) {
  // À vous : borner ft dans ±mu·|lam|
  return ft;
}`,
    hints: [
      'La limite vaut mu * Math.abs(lam) : λ est négatif, d’où la valeur absolue.',
      'Borner, c’est Math.max(-lim, Math.min(lim, ft)).',
      'const lim = mu * Math.abs(lam);\n  return Math.max(-lim, Math.min(lim, ft));',
    ],
    win: 'La caisse lancée s’arrête au lieu de glisser indéfiniment.',
  },
  {
    id: 'finishVelocity', module: 2, slot: 'finishVelocity', scene: 'impact', title: 'Déduire la vitesse des positions',
    goal: 'À la fin d’un sous-pas, on ne connaît pas la vitesse : on connaît les positions avant et après. Déduisez-en les vitesses. C’est ce qui fait qu’un corps arrêté par un contact n’a plus de vitesse, sans aucune règle de rebond.',
    starter: `function finishVelocity(b, h) {
  // b.ox, b.oy, b.oa : la pose au début du sous-pas
  // À vous : v = (nouvelle pose − ancienne pose) / h

}`,
    hints: [
      'b.vx = (b.x - b.ox) / h.',
      'Même chose pour vy, et b.w = (b.a - b.oa) / h.',
      'b.vx = (b.x - b.ox) / h;\n  b.vy = (b.y - b.oy) / h;\n  b.w = (b.a - b.oa) / h;',
    ],
    win: 'Le corps qui tombe s’arrête net sur le sol : plus aucune vitesse résiduelle.',
  },
  {
    id: 'colourGraph', module: 3, slot: 'colourGraph', scene: 'stack', title: 'Colorier le graphe des contacts',
    goal: 'Sur la carte graphique, deux corps qui se touchent ne peuvent pas être résolus en même temps. Attribuez à chaque corps la plus petite couleur libre parmi ses voisins : tous les corps d’une même couleur pourront alors être résolus ensemble.',
    starter: `function colourGraph(n, edges) {
  const col = new Array(n).fill(-1);
  // À vous : pour chaque corps, la plus petite couleur qu'aucun voisin n'utilise
  return col;
}`,
    hints: [
      'Pour le corps i, rassemblez les couleurs déjà prises : for (const j of edges[i]) if (col[j] >= 0) used.add(col[j]).',
      'Puis cherchez le plus petit entier absent : let c = 0; while (used.has(c)) c++.',
      'N’oubliez pas d’écrire col[i] = c avant de passer à la suivante.',
    ],
    win: 'Chaque couleur peut être résolue en parallèle : c’est ainsi que la carte graphique traite des milliers de corps.',
    check(fn) {
      // random graphs: the colouring must be valid and not wasteful
      for (let trial = 0; trial < 20; trial++) {
        const n = 6 + trial;
        const edges: number[][] = Array.from({ length: n }, () => []);
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (((i * 7 + j * 13 + trial * 3) % 5) < 2) { edges[i].push(j); edges[j].push(i); }
        let col: number[];
        try { col = fn(n, edges); } catch (e: any) { return `erreur : ${e?.message ?? e}`; }
        if (!Array.isArray(col) || col.length !== n) return 'il faut renvoyer un tableau de n couleurs';
        for (let i = 0; i < n; i++) {
          if (!Number.isInteger(col[i]) || col[i] < 0) return `la couleur ${col[i]} n’est pas un entier positif`;
          for (const j of edges[i]) if (col[i] === col[j]) return `les corps ${i} et ${j} se touchent et ont la même couleur ${col[i]}`;
        }
        const used = new Set(col).size;
        const maxDeg = Math.max(...edges.map((e) => e.length));
        if (used > maxDeg + 1) return `${used} couleurs pour un degré maximal de ${maxDeg} : l’algorithme glouton en garantit ${maxDeg + 1}`;
      }
      return null;
    },
  },
];

// =====================================================================
// verification
// =====================================================================

export interface Verdict { ok: boolean; msg: string; err?: number }

export function verify(ch: Challenge, src: string): Verdict {
  let fn: Function;
  try { fn = compile(src, ch.slot); } catch (e: any) { return { ok: false, msg: `Le code ne compile pas : ${e?.message ?? e}` }; }
  if (typeof fn !== 'function') return { ok: false, msg: `La fonction ${ch.slot} est introuvable — gardez sa signature.` };
  if (ch.check) {
    const bad = ch.check(fn);
    return bad ? { ok: false, msg: bad } : { ok: true, msg: ch.win };
  }
  const ref = reference();
  const mine: Impl = { ...ref, [ch.slot]: fn };
  let worst = 0;
  for (const key of Object.keys(LAB_SCENES)) {
    const a = LAB_SCENES[key](), b = LAB_SCENES[key]();
    const sa = new Map<string, LabContact>(), sb = new Map<string, LabContact>();
    for (let f = 0; f < 150; f++) {
      try { labStep(a, mine, sa); } catch (e: any) { return { ok: false, msg: `Votre code a levé une erreur : ${e?.message ?? e}` }; }
      labStep(b, ref, sb);
      for (let i = 0; i < a.bodies.length; i++) {
        const A = a.bodies[i], B = b.bodies[i];
        if (!Number.isFinite(A.x) || !Number.isFinite(A.y)) return { ok: false, msg: `La simulation a divergé (scène « ${key} », image ${f}).` };
        worst = Math.max(worst, Math.hypot(A.x - B.x, A.y - B.y));
      }
    }
  }
  if (worst > 2e-3) return { ok: false, msg: `Les corps s’écartent de ${(worst * 100).toFixed(1)} cm de la référence.`, err: worst };
  return { ok: true, msg: ch.win, err: worst };
}

// =====================================================================
// the panel
// =====================================================================

export function openLab(root: HTMLElement, prog: Progress, challenges: Challenge[], onClose: () => void): void {
  challenges.length = 0;
  challenges.push(...CHALLENGES);

  const el = h('div', 'c-lab');
  let cur = CHALLENGES.findIndex((c) => !prog.d.code[c.id]?.done);
  if (cur < 0) cur = 0;
  let hintShown = 0;
  let raf = 0;

  const list = h('div', 'lab-list');
  const editor = h('textarea', 'lab-editor') as HTMLTextAreaElement;
  editor.spellcheck = false;
  const goalEl = h('p', 'lab-goal');
  const sigEl = h('div', 'lab-sig');
  const docEl = h('p', 'lab-doc');
  const msg = h('div', 'lab-msg');
  const hintEl = h('div', 'lab-hints');
  const cv = h('canvas', 'lab-canvas') as HTMLCanvasElement;
  const dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = DW * dpr; cv.height = DH * dpr;
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const titleEl = h('h2', 'lab-title');
  const runBtn = h('button', 'c-btn go', 'Vérifier ▶') as HTMLButtonElement;
  const hintBtn = h('button', 'c-btn', 'Un indice') as HTMLButtonElement;
  const solBtn = h('button', 'c-btn ghost', 'Voir la solution') as HTMLButtonElement;
  const resetBtn = h('button', 'c-btn ghost', 'Repartir de zéro') as HTMLButtonElement;
  const closeBtn = h('button', 'home-x', '✕') as HTMLButtonElement;
  closeBtn.title = 'Fermer l’atelier (Échap)';

  const renderList = () => {
    list.replaceChildren();
    list.append(h('div', 'lab-listhead', 'Défis'));
    CHALLENGES.forEach((c, i) => {
      const b = h('button', `lab-item${i === cur ? ' on' : ''}${prog.d.code[c.id]?.done ? ' done' : ''}`) as HTMLButtonElement;
      b.innerHTML = `<span class="lab-n">${prog.d.code[c.id]?.done ? '✓' : i + 1}</span><span><b>${c.title}</b><small>Module ${c.module + 1}</small></span>`;
      b.onclick = () => { save(); cur = i; load(); };
      list.append(b);
    });
  };

  const save = () => { prog.code(CHALLENGES[cur].id, { src: editor.value }); };

  const load = () => {
    const c = CHALLENGES[cur];
    hintShown = 0;
    titleEl.textContent = c.title;
    goalEl.textContent = c.goal;
    sigEl.innerHTML = highlight(SLOTS[c.slot].sig);
    docEl.textContent = SLOTS[c.slot].doc;
    editor.value = prog.d.code[c.id]?.src ?? c.starter;
    msg.className = 'lab-msg';
    msg.textContent = prog.d.code[c.id]?.done ? `Déjà réussi — ${c.win}` : '';
    if (prog.d.code[c.id]?.done) msg.classList.add('ok');
    hintEl.replaceChildren();
    renderList();
    preview();
  };

  // live preview of the learner's code on the challenge's scene
  let previewScene: LabScene | null = null;
  let previewStore = new Map<string, LabContact>();
  let previewImpl: Impl | null = null;
  let previewErr = '';
  const preview = () => {
    const c = CHALLENGES[cur];
    previewScene = LAB_SCENES[c.scene]();
    previewStore = new Map();
    previewErr = '';
    try {
      const fn = compile(editor.value, c.slot);
      previewImpl = { ...reference(), [c.slot]: fn };
    } catch (e: any) { previewImpl = null; previewErr = String(e?.message ?? e); }
  };
  editor.addEventListener('input', () => { save(); preview(); });

  const draw = () => {
    raf = requestAnimationFrame(draw);
    ctx.clearRect(0, 0, DW, DH);
    const c = CHALLENGES[cur];
    if (c.slot === 'colourGraph') { drawGraph(ctx, editor.value); return; }
    if (c.slot === 'integrate') { drawIntegrate(ctx, editor.value); return; }
    if (!previewScene || !previewImpl) {
      text(ctx, previewErr || 'le code ne compile pas', DW / 2, DH / 2, CC.red, 11, 'center');
      return;
    }
    try { labStep(previewScene, previewImpl, previewStore); } catch (e: any) { previewErr = String(e?.message ?? e); previewImpl = null; return; }
    const bad = previewScene.bodies.some((b) => !Number.isFinite(b.y) || Math.abs(b.y) > 20);
    if (bad) { preview(); return; }
    const cam = camFor(-1.6, 1.6, -0.2, 2.8, 16);
    line(ctx, px(cam, -1.6), py(cam, 0), px(cam, 1.6), py(cam, 0), CC.dim, 2);
    for (const b of previewScene.bodies) {
      ctx.save();
      ctx.translate(px(cam, b.x), py(cam, b.y));
      ctx.rotate(-b.a);
      panel(ctx, -b.hw * cam.s, -b.hh * cam.s, b.hw * 2 * cam.s, b.hh * 2 * cam.s, CC.blue, alpha(CC.blue, 0.2), 3, 1.4);
      ctx.restore();
    }
    text(ctx, 'votre code, en direct', 12, 16, CC.dim, 10);
  };

  runBtn.onclick = () => {
    save();
    const c = CHALLENGES[cur];
    const v = verify(c, editor.value);
    msg.className = `lab-msg ${v.ok ? 'ok' : 'bad'}`;
    msg.textContent = v.msg;
    if (v.ok) {
      prog.code(c.id, { done: true });
      renderList();
      if (cur + 1 < CHALLENGES.length) {
        const next = h('button', 'c-btn go', 'Défi suivant ▶') as HTMLButtonElement;
        next.onclick = () => { cur++; load(); };
        msg.append(' ', next);
      }
    }
  };
  hintBtn.onclick = () => {
    const c = CHALLENGES[cur];
    if (hintShown >= c.hints.length) return;
    const p = h('p');
    p.innerHTML = `<b>Indice ${hintShown + 1}</b> ${esc(c.hints[hintShown])}`;
    hintEl.append(p);
    hintShown++;
    if (hintShown >= c.hints.length) hintBtn.disabled = true;
  };
  solBtn.onclick = () => {
    if (!confirm('Afficher la solution de ce défi ?')) return;
    editor.value = SLOTS[CHALLENGES[cur].slot].sol;
    save(); preview();
  };
  resetBtn.onclick = () => { editor.value = CHALLENGES[cur].starter; save(); preview(); };
  closeBtn.onclick = () => done();

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); done(); }
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); runBtn.click(); }
  };

  function done(): void {
    save();
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey, true);
    el.remove();
    onClose();
  }

  const left = h('div', 'lab-left');
  left.append(list);
  const mid = h('div', 'lab-mid');
  mid.append(titleEl, goalEl, sigEl, docEl, editor, h('div', 'lab-actions'), msg, hintEl);
  (mid.querySelector('.lab-actions') as HTMLElement).append(runBtn, hintBtn, solBtn, resetBtn);
  const right = h('div', 'lab-right');
  right.append(cv, h('p', 'lab-side', 'La scène tourne avec <b>votre</b> code. « Vérifier » la rejoue sur quatre scénarios et compare, image par image, avec la solution de référence.'));
  const inner = h('div', 'lab-inner');
  inner.append(left, mid, right);
  el.append(inner, closeBtn);
  root.append(el);
  window.addEventListener('keydown', onKey, true);
  load();
  draw();
  setTimeout(() => editor.focus(), 50);
}

/** Preview for the integration challenge: your trajectory against the exact one. */
function drawIntegrate(ctx: CanvasRenderingContext2D, src: string): void {
  let fn: Function | null = null;
  try { fn = compile(src, 'integrate'); } catch { fn = null; }
  const cam = camFor(-0.2, 4.2, -0.3, 2.6, 22);
  const g = -9.81, h = 1 / 30, vx0 = 3.2, vy0 = 4.4;
  // the exact parabola
  ctx.save();
  ctx.strokeStyle = CC.blue; ctx.lineWidth = 2; ctx.beginPath();
  for (let i = 0; i <= 120; i++) {
    const t = (i / 120) * 1.2;
    const X = px(cam, vx0 * t), Y = py(cam, 2 + vy0 * t + 0.5 * g * t * t);
    i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
  }
  ctx.stroke(); ctx.restore();
  text(ctx, 'trajectoire exacte', 12, 16, CC.blue, 10);
  if (!fn) { text(ctx, 'le code ne compile pas', DW / 2, DH / 2, CC.red, 11, 'center'); return; }
  const b: any = { x: 0, y: 2, vx: vx0, vy: vy0 };
  const pts: [number, number][] = [[b.x, b.y]];
  for (let i = 0; i < 36; i++) {
    try { fn(b, h, g); } catch { text(ctx, 'votre code lève une erreur', DW / 2, DH / 2, CC.red, 11, 'center'); return; }
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) break;
    pts.push([b.x, b.y]);
  }
  ctx.save();
  ctx.strokeStyle = CC.acc; ctx.lineWidth = 1.8; ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(px(cam, x), py(cam, y)) : ctx.moveTo(px(cam, x), py(cam, y))));
  ctx.stroke(); ctx.restore();
  for (const [x, y] of pts) dot(ctx, px(cam, x), py(cam, y), CC.acc, 2.4);
  text(ctx, 'votre intégrateur', 12, 32, CC.acc, 10);
  if (pts.length < 2) text(ctx, 'le corps ne bouge pas encore', DW / 2, DH - 16, CC.faint, 10, 'center');
}

/** Preview for the colouring challenge: a small contact graph. */
function drawGraph(ctx: CanvasRenderingContext2D, src: string): void {
  const n = 9;
  const edges: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (((i * 7 + j * 13) % 5) < 2) { edges[i].push(j); edges[j].push(i); }
  let col: number[] | null = null;
  try { col = compile(src, 'colourGraph')(n, edges); } catch { col = null; }
  const pal = [CC.acc, CC.blue, CC.green, CC.pink, CC.violet, CC.red, '#9aa3b8'];
  const pos = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return [DW / 2 + Math.cos(a) * 86, DH / 2 - 8 + Math.sin(a) * 76];
  });
  for (let i = 0; i < n; i++) for (const j of edges[i]) if (j > i) {
    const bad = col && col[i] === col[j];
    line(ctx, pos[i][0], pos[i][1], pos[j][0], pos[j][1], bad ? CC.red : CC.faint, bad ? 2 : 1);
  }
  for (let i = 0; i < n; i++) {
    const c = col && Number.isInteger(col[i]) && col[i] >= 0 ? pal[col[i] % pal.length] : CC.dim;
    circle(ctx, pos[i][0], pos[i][1], 13, c, alpha(c, 0.25), 1.8);
    text(ctx, String(i), pos[i][0], pos[i][1], CC.fg, 10, 'center', true);
  }
  const used = col ? new Set(col).size : 0;
  text(ctx, col ? `${used} couleur${used > 1 ? 's' : ''}` : 'pas encore de coloriage', DW / 2, DH - 10, CC.dim, 11, 'center');
}

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// kept so unused imports stay meaningful to the bundler
void arrow; void dot;
