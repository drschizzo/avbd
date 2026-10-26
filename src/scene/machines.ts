// Chain-reaction presets ("Rube Goldberg" machines), built from the gadgets
// and drawn paths, and checked with the Machine tab: every step of these is
// expected to hold in all of the "Test ×5" runs.

import { defaultDoc, type Entity, type Phys, type SceneDoc, type Vec3 } from './doc';
import { createEntity } from './entities';
import { buildPath } from './path';

const dyn = (o: Partial<Phys> = {}): Phys => ({ body: 'dynamic', density: 1, friction: 0.5, velocity: [0, 0, 0], angularVelocity: [0, 0, 0], spawnAt: 0, ...o });
const stat = (o: Partial<Phys> = {}): Phys => ({ body: 'static', density: 1, friction: 0.5, velocity: [0, 0, 0], angularVelocity: [0, 0, 0], spawnAt: 0, ...o });
const single = (color: string, finish: Entity['look']['finish'] = 'satin'): Entity['look'] => ({ colorMode: 'single', color, paletteOffset: 0, finish });

/**
 * Catapult: a piston starts a domino run along a shelf; two ever bigger
 * dominoes tip the last one off the edge onto a seesaw, which flings its
 * ball against a glass backboard and into a hanging basket.
 */
export function catapultMachine(): SceneDoc {
  const d = defaultDoc();
  d.name = 'Catapult Machine';
  d.duration = 12;
  d.render.palette = 'bauhaus';
  d.render.aspect = '16:9';
  d.render.shadowSoftness = 0.45;
  d.physics.substeps = 4;
  d.physics.iterations = 10;
  d.loop = { ...d.loop, mode: 'boomerang', rewind: 1.6, apex: 0.7, outro: 2.2 };
  d.camera = { position: [-0.15, 2.25, 6.9], target: [-0.35, 1.05, 0], fov: 38, motion: 'sway', amount: 6, cycles: 1 };
  const ph = 1.6, edge = -0.06;
  const shelf = createEntity('box', { name: 'Shelf', position: [edge - 1.6, ph / 2, 0], params: { size: [3.2, ph, 0.6] }, phys: stat({ friction: 0.6 }), look: single('#2f3b52') });
  const piston = createEntity('piston', { name: 'Piston', position: [edge - 2.98, ph + 0.2, 0], params: { head: [0.05, 0.22, 0.2], stroke: 0.16, at: 0.6, speed: 0.15, hold: 0.8, housing: true } });
  const row = createEntity('path', {
    name: 'Domino run', position: [edge - 2.9, ph, 0],
    params: { fill: 'dominoes', size: [0.06, 0.42, 0.2], spacing: 0.55, push: 0, points: [[0, 0, 0], [0.9, 0, 0.14], [1.8, 0, -0.14], [2.3, 0, 0]] },
    look: { colorMode: 'gradient', color: '#ffffff', paletteOffset: 0, finish: 'gloss' },
  });
  const mid = createEntity('box', { name: 'Big domino', position: [edge - 0.37, ph + 0.275, 0], params: { size: [0.08, 0.55, 0.25] }, phys: dyn({ density: 1.4 }), look: single('#e76f51', 'gloss') });
  const big = createEntity('box', { name: 'Giant domino', position: [edge - 0.07, ph + 0.35, 0], params: { size: [0.1, 0.7, 0.3] }, phys: dyn({ density: 2.5 }), look: single('#264653', 'gloss') });
  const cat = createEntity('seesaw', { name: 'Catapult', position: [1.2, 0, 0], rotation: [0, 180, 0], params: { length: 2.4, width: 0.32, thickness: 0.045, height: 0.4, load: 'ball', loadSize: 0.16, pivotAt: 0.5 }, look: { colorMode: 'cycle', color: '#ffffff', paletteOffset: 2, finish: 'gloss' } });
  const rim = 1.52, cx = 1.27;
  const basket = createEntity('cup', { name: 'Basket', position: [cx, rim - 0.31, 0], params: { mode: 'hanging', size: [0.52, 0.28, 0.38], hang: 0.22, thickness: 0.03 }, look: single('#e9c46a', 'gloss') });
  const board = createEntity('box', { name: 'Backboard', position: [0.96, rim + 0.45, 0], params: { size: [0.03, 0.9, 0.42] }, phys: stat({ friction: 0.4 }), look: single('#ffffff', 'glass') });
  const goal = createEntity('sensor', { name: 'Ball in the basket', position: [cx, rim - 0.14, 0], params: { size: [0.5, 0.28, 0.34], watch: cat.id, count: 1 } });
  board.expect = false;
  d.entities.push(shelf, piston, row, mid, big, cat, board, basket, goal);
  return d;
}

/**
 * Marble run: a piston rolls a marble into a spiral rail; it leaves the rail
 * at floor level into a curving domino run that ends against a pyramid.
 */
export function marbleRun(): SceneDoc {
  const d = defaultDoc();
  d.name = 'Marble Run';
  d.duration = 20;
  d.render.palette = 'ocean';
  d.render.aspect = '4:5';
  d.physics.substeps = 4;
  d.loop = { ...d.loop, mode: 'boomerang', rewind: 2.2, apex: 0.7, outro: 2.2 };
  d.camera = { position: [4.2, 3.4, 4.6], target: [0.1, 0.9, -0.9], fov: 38, motion: 'sway', amount: 8, cycles: 1 };
  const R = 0.9, H = 1.55, turns = 1.5, per = 16, Y = 0.75;
  const pts: Vec3[] = [[R, H, -0.45], [R, H, -0.2]];
  const n = Math.round(turns * per);
  for (let i = 0; i <= n; i++) {
    const a = (i / per) * Math.PI * 2;
    pts.push([+(Math.cos(a) * R).toFixed(3), +(H * (1 - i / n)).toFixed(3), +(Math.sin(a) * R).toFixed(3)]);
  }
  // after 1.5 turns the rail heads along -z at x = -R: run it down to the floor
  pts.push([-R, -0.25, -0.5], [-R, -0.6, -0.95], [-R, -0.72, -1.25]);
  const rail = createEntity('path', { name: 'Spiral rail', position: [0, Y, 0], params: { fill: 'rail', size: [0.2, 0.07, 0.035], points: pts, drop: 0 }, phys: stat({ friction: 0.05 }), look: single('#1d3557', 'metal') });
  const column = createEntity('box', { name: 'Column', position: [0, (Y + H) / 2, 0], params: { size: [0.34, Y + H, 0.34] }, phys: stat(), look: single('#a8dadc', 'satin') });
  column.expect = false;
  const marble = createEntity('sphere', { name: 'Marble', position: [R, Y + H + 0.066, -0.3], params: { radius: 0.065 }, phys: dyn({ density: 4, friction: 0.1 }), look: single('#e63946', 'pearl') });
  const piston = createEntity('piston', { name: 'Piston', position: [R, Y + H + 0.07, -0.4], rotation: [0, -90, 0], params: { head: [0.04, 0.12, 0.12], stroke: 0.12, at: 0.5, speed: 0.1, hold: 0.6 } });
  const row = createEntity('path', {
    name: 'Domino run', position: [-R, 0, -1.55],
    params: { fill: 'dominoes', size: [0.04, 0.26, 0.13], spacing: 0.55, push: 0, points: [[0, 0, 0], [0, 0, -0.5], [0.6, 0, -1.1], [1.5, 0, -1.2], [2.2, 0, -0.7]] },
    look: { colorMode: 'gradient', color: '#ffffff', paletteOffset: 0, finish: 'gloss' },
  });
  // the run ends against a pyramid, its face square to the last dominoes
  const end: Vec3 = [-R + 2.2, 0, -1.55 - 0.7];
  const dir = [0.7 / Math.hypot(0.7, 0.5), 0.5 / Math.hypot(0.7, 0.5)];
  const yaw = (Math.atan2(-dir[0], -dir[1]) * 180) / Math.PI;
  const pyramid = createEntity('pyramid', { name: 'Pyramid', position: [+(end[0] + dir[0] * 0.2).toFixed(3), 0, +(end[2] + dir[1] * 0.2).toFixed(3)], rotation: [0, +yaw.toFixed(1), 0], params: { base: 6, brick: [0.11, 0.11, 0.11], gap: 0.006, mode: '2d' }, phys: dyn({ density: 0.25, friction: 0.4 }) });
  d.entities.push(column, rail, piston, marble, row, pyramid);
  return d;
}

/** An empty bench to build on: the front work plane is a good start. */
export function workshop(): SceneDoc {
  const d = defaultDoc();
  d.name = 'Machine workshop';
  d.duration = 14;
  d.render.palette = 'bauhaus';
  d.render.aspect = '16:9';
  d.physics.substeps = 4;
  d.loop = { ...d.loop, mode: 'boomerang', rewind: 1.6, apex: 0.6 };
  d.camera = { position: [0, 2.2, 8], target: [0, 1, 0], fov: 38, motion: 'static', amount: 0, cycles: 1 };
  return d;
}

/** Moves an entity built in a module frame (origin + yaw in degrees) into the scene. */
function place(e: Entity, origin: Vec3, yaw = 0): Entity {
  const a = yaw * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const [x, y, z] = e.position;
  e.position = [+(origin[0] + x * c + z * s).toFixed(4), +(origin[1] + y).toFixed(4), +(origin[2] - x * s + z * c).toFixed(4)];
  e.rotation = [e.rotation[0], e.rotation[1] + yaw, e.rotation[2]];
  return e;
}

/** Where the last domino of a drawn row stands (entity frame): rows are laid
 * every step from the start, so it can stop short of the end by up to a step. */
function lastDomino(params: Record<string, any>): Vec3 {
  const b = buildPath({ push: 0, smooth: true, ...params });
  return b[b.length - 1].p;
}

/**
 * The Grand Machine: one start, one long chain of cause and effect through
 * almost every part of the catalogue, ending in two branches that land on
 * the same beat.
 *
 * Back, left to right: a piston rolls a marble down a spiral column onto a
 * plinth; a domino row grows step by step up to a giant that drops onto a
 * catapult, whose ball bounces off a backboard into a glass funnel. A rail
 * brings it to the front, where it crosses a bead curtain on a roller
 * conveyor, turns a free wheel and starts a floor row that forks:
 * - left: a cascade of ever bigger dominoes; the last one knocks the latch
 *   of a wrecking ball, which swings through a ring tower;
 * - back: the row turns around, knocks the latch of a hammer, and the hammer
 *   sets off a domino spiral.
 */
export function grandMachine(): SceneDoc {
  const d = defaultDoc();
  d.name = 'Grand Machine';
  // 30 s: ~24.6 s of real physics, then a 5 s rewind peaking at x7
  d.duration = 30;
  d.render.palette = 'bauhaus';
  d.render.aspect = '16:9';
  d.render.shadowSoftness = 0.45;
  d.physics.substeps = 6;
  d.physics.iterations = 10;
  d.loop = { ...d.loop, mode: 'boomerang', rewind: 7, apex: 0.8, outro: 2.2 };
  // the follow camera keeps this angle, but comes close and tracks the chain
  d.camera = { position: [-1.3, 6.4, 12.6], target: [-1.2, 0.5, 0.5], fov: 40, motion: 'follow', amount: 4, cycles: 1, followSize: 1.4, followSmooth: 0.9, followLead: 0.35 };
  const E = d.entities;
  const decor = (e: Entity): Entity => { e.expect = false; return e; };
  const go = 0.5;
  const Tb = 1.63; // rail exit height; the plinth top is 3 cm lower (1.60, the shelf of "Catapult Machine")
  const zB = -2.2, zF = 1.0; // back and front lanes

  // --- 1. spiral column -------------------------------------------------------
  // built as in "Marble Run" (rail leaving along -z), turned so it leaves
  // along +x onto the plinth; one turn instead of one and a half, as steep
  const OB: Vec3 = [-3.1, 0, zB + 0.9];
  {
    const R = 0.9, H = 1.4, Y = Tb + 0.72, per = 16, n = 24, i0 = 8;
    const pts: Vec3[] = [[-R, H, 0.45], [-R, H, 0.2]];
    for (let i = i0; i <= n; i++) {
      const a = (i / per) * Math.PI * 2;
      pts.push([+(Math.cos(a) * R).toFixed(3), +(H * (1 - (i - i0) / (n - i0))).toFixed(3), +(Math.sin(a) * R).toFixed(3)]);
    }
    pts.push([-R, -0.25, -0.5], [-R, -0.6, -0.95], [-R, -0.72, -1.25]);
    const rail = createEntity('path', { name: 'Spiral rail', position: [0, Y, 0], params: { fill: 'rail', size: [0.2, 0.07, 0.035], points: pts, drop: 0 }, phys: stat({ friction: 0.05 }), look: single('#1d3557', 'metal') });
    const column = decor(createEntity('box', { name: 'Column', position: [0, (Y + H) / 2, 0], params: { size: [0.34, Y + H, 0.34] }, phys: stat(), look: single('#a8dadc', 'satin') }));
    const marble = createEntity('sphere', { name: 'Marble', position: [-R, Y + H + 0.066, 0.3], params: { radius: 0.065 }, phys: dyn({ density: 4, friction: 0.1 }), look: single('#e63946', 'pearl') });
    // the start: a small heavy hammer, let go at `go`, sends the marble down
    // the rail at ~1 m/s; its frame would straddle the rail, so a single post
    // outside the spiral and a boom carry the axle
    const arm = 0.35, hy = 0.06, hzA = 0.41, hA = Y + H + 0.066 + arm + hy / 2 - 0.015;
    const hammer = createEntity('hammer', { name: 'Start hammer', position: [-R, 0, hzA], rotation: [0, 90, 0], params: { height: hA, arm, head: [0.08, hy, 0.06], headDensity: 20, angle: 55, releaseAt: go, frame: false } });
    const post = decor(createEntity('box', { name: 'Hammer post', position: [-R - 0.32, (hA + 0.08) / 2, hzA], params: { size: [0.05, hA + 0.08, 0.05] }, phys: stat(), look: single('#2b2d33', 'metal') }));
    const boom = decor(createEntity('box', { name: 'Hammer boom', position: [-R - 0.15, hA + 0.06, hzA], params: { size: [0.39, 0.04, 0.04] }, phys: stat(), look: single('#2b2d33', 'metal') }));
    for (const e of [column, rail, hammer, post, boom, marble]) E.push(place(e, OB, -90));
  }

  // --- 2. plinth: a domino row growing up to the catapult -----------------------
  // rail exit: OB + (1.25, Tb, -0.9), heading +x
  const x0 = OB[0] + 1.25, top = Tb - 0.03;
  const row1 = x0 + 0.3, last1 = row1 + 7 * 0.143;
  // the shelf row, big and giant dominoes are those of "Catapult Machine",
  // to the centimetre: with a shorter row the launch turned erratic
  const step = last1 + 0.16, row2 = step + 0.2;
  const edge = row2 + 2.9; // shelf edge
  {
    // high friction under the small dominoes: on a box (unlike the floor)
    // they skid back and the row stalls halfway; the catapult end keeps the
    // shelf of "Catapult Machine" (friction 0.6), whose launch is tuned
    const mid = step + 0.1;
    E.push(decor(createEntity('box', { name: 'Plinth', position: [(x0 + mid) / 2, top / 2, zB], params: { size: [mid - x0, top, 0.6] }, phys: stat({ friction: 1 }), look: single('#2f3b52') })));
    E.push(decor(createEntity('box', { name: 'Shelf', position: [(mid + edge) / 2, top / 2, zB], params: { size: [edge - mid, top, 0.6] }, phys: stat({ friction: 0.6 }), look: single('#2f3b52') })));
    // glass lips keep the marble, which bounces back off the row, on the plinth
    for (const s of [-1, 1]) {
      E.push(decor(createEntity('box', { name: 'Plinth lip', position: [x0 + 0.5, top + 0.03, zB + s * 0.28], params: { size: [1.0, 0.06, 0.02] }, phys: stat(), look: single('#ffffff', 'glass') })));
    }
    E.push(createEntity('path', {
      name: 'Plinth dominoes', position: [row1, top, zB],
      params: { fill: 'dominoes', size: [0.04, 0.26, 0.13], spacing: 0.55, push: 0, points: [[0, 0, 0], [7 * 0.143 + 0.01, 0, 0]] },
      look: { colorMode: 'gradient', color: '#ffffff', paletteOffset: 0, finish: 'gloss' },
    }));
    // each step about twice to three times heavier than the one before
    E.push(createEntity('box', { name: 'Step domino', position: [step, top + 0.17, zB], params: { size: [0.045, 0.34, 0.17] }, phys: dyn(), look: single('#e9c46a', 'gloss') }));
    E.push(createEntity('path', {
      name: 'Shelf dominoes', position: [row2, top, zB],
      params: { fill: 'dominoes', size: [0.06, 0.42, 0.2], spacing: 0.55, push: 0, points: [[0, 0, 0], [0.9, 0, 0.14], [1.8, 0, -0.14], [2.3, 0, 0]] },
      look: { colorMode: 'gradient', color: '#ffffff', paletteOffset: 3, finish: 'gloss' },
    }));
    E.push(createEntity('box', { name: 'Big domino', position: [edge - 0.37, top + 0.275, zB], params: { size: [0.08, 0.55, 0.25] }, phys: dyn({ density: 1.4 }), look: single('#e76f51', 'gloss') }));
    E.push(createEntity('box', { name: 'Giant domino', position: [edge - 0.07, top + 0.35, zB], params: { size: [0.1, 0.7, 0.3] }, phys: dyn({ density: 2.5 }), look: single('#264653', 'gloss') }));
  }

  // --- 3. catapult into a funnel (geometry of "Catapult Machine") --------------
  const cx = edge + 1.33;
  {
    E.push(createEntity('seesaw', { name: 'Catapult', position: [edge + 1.26, 0, zB], rotation: [0, 180, 0], params: { length: 2.4, width: 0.32, thickness: 0.045, height: 0.4, load: 'ball', loadSize: 0.16, pivotAt: 0.5 }, look: { colorMode: 'cycle', color: '#ffffff', paletteOffset: 2, finish: 'gloss' } }));
    E.push(decor(createEntity('box', { name: 'Backboard', position: [edge + 1.02, 1.97, zB], params: { size: [0.03, 0.9, 0.42] }, phys: stat({ friction: 0.4 }), look: single('#ffffff', 'glass') })));
    // where the basket hung: a glass funnel, its throat over the next rail
    // the funnel keeps to the basket's envelope (rim 1.5 m, 0.28 m round):
    // any wider and the ball, on its way up, clips it; its throat stays a
    // ball's height above the rail (or the ball wedges in it)
    E.push(decor(createEntity('funnel', { name: 'Funnel', position: [cx, 1.25, zB], params: { segments: 18, top: 0.28, bottom: 0.11, height: 0.25, thickness: 0.03 } })));
  }

  // --- 4. rail to the front lane ------------------------------------------------
  const railEndY = 0.75;
  const xR = cx - 1.7; // rail end, heading -x
  E.push(createEntity('path', {
    name: 'Front rail', position: [cx, railEndY, zB],
    params: { fill: 'rail', size: [0.22, 0.07, 0.035], points: [[0, 0, -0.12], [0, 0, 0.6], [0, 0, 1.6], [-0.25, 0, 2.5], [-0.9, 0, 3.1], [-1.7, 0, zF - zB]], drop: 1.07 - railEndY },
    phys: stat({ friction: 0.05 }), look: single('#1d3557', 'metal'),
  }));

  // --- 5. conveyor under a bead curtain, free wheel ------------------------------
  // thin, close rollers: a ball sinks 4 mm between them (15 mm with the
  // default ones, where it stalls), and is driven at about a third of the
  // surface speed
  const rr = 0.03, nR = 30, pitch = 2 * rr + 0.004, span = (nR - 1) * pitch;
  const rollY = railEndY - 0.025 - 2 * rr;
  const rollX = xR - span / 2 - rr;
  {
    E.push(createEntity('rollers', { name: 'Conveyor', position: [rollX, rollY, zF], rotation: [0, 180, 0], params: { count: nR, radius: rr, gap: 0.004, speed: 3, rails: false, width: 0.3 } }));
    for (const s of [-1, 1]) {
      E.push(decor(createEntity('box', { name: 'Conveyor guide', position: [rollX, rollY + 2 * rr + 0.05, zF + s * 0.12], params: { size: [span + 0.1, 0.12, 0.02] }, phys: stat({ friction: 0.05 }), look: single('#ffffff', 'glass') })));
    }
    // the curtain's last beads brush the top of the ball
    const ct = rollY + 2 * rr + 0.14 + 9 * 0.07;
    E.push(decor(createEntity('box', { name: 'Curtain bar', position: [rollX, ct + 0.02, zF], params: { size: [0.05, 0.04, 0.62] }, phys: stat(), look: single('#2b2d33', 'metal') })));
    for (const s of [-1, 1]) {
      E.push(decor(createEntity('box', { name: 'Curtain post', position: [rollX, (ct + 0.04) / 2, zF + s * 0.29], params: { size: [0.04, ct + 0.04, 0.04] }, phys: stat(), look: single('#2b2d33', 'metal') })));
    }
    E.push(createEntity('chain', {
      name: 'Bead curtain', position: [rollX, ct, zF],
      params: { links: 9, linkType: 'bead', radius: 0.035, strands: 5, strandSpacing: 0.075, layout: 'hanging', anchors: 'start' },
      look: { colorMode: 'gradient', color: '#fff', paletteOffset: 0, finish: 'pearl' },
      phys: dyn({ density: 0.4, friction: 0.2 }),
    }));
  }
  // the ball leaves the conveyor at ~1 m/s and lands ~17 cm on, past the
  // axle, so the wheel turns forward and sets it down on the floor (right
  // over the axle it wedges between two paddles); the paddles pass under the
  // rollers, and over a ball on the floor (they would bat it back and forth)
  const xW = rollX - span / 2 - rr - 0.07, wR = 0.22, wY = rollY - 0.24;
  E.push(createEntity('freeWheel', { name: 'Free wheel', position: [xW, 0, zF], params: { height: wY, radius: wR, paddles: 6, width: 0.3, thickness: 0.035, phase: 15 } }));
  // glass cheeks: the landing twists the wheel a little and would throw the
  // ball sideways
  for (const s of [-1, 1]) {
    E.push(decor(createEntity('box', { name: 'Wheel pane', position: [xW - 0.08, 0.42, zF + s * 0.17], params: { size: [0.8, 0.76, 0.02] }, phys: stat({ friction: 0.05 }), look: single('#ffffff', 'glass') })));
  }

  // a low ramp under the wheel, clear of the paddles' sweep: however the
  // wheel lets go of the ball (at the bottom it flicks it backward), the
  // ball runs down it toward the floor row
  const rampL = 1.0, rampA = 9;
  const ca = Math.cos(rampA * Math.PI / 180), sa = Math.sin(rampA * Math.PI / 180);
  const rampTop = 0.165, xRampTop = xW + 0.06;
  E.push(decor(createEntity('ramp', { name: 'Ramp', position: [xRampTop - rampL / 2 * ca, rampTop - rampL / 2 * sa, zF], rotation: [0, 180, 0], params: { length: rampL, width: 0.3, angle: rampA, rails: 0, thickness: 0.04, legs: true } })));

  // --- 6. floor row and fork ------------------------------------------------------
  // two drawn guide walls funnel the ball back onto the lane
  const xG = xRampTop - rampL * ca - 0.02;
  for (const s of [-1, 1]) {
    E.push(decor(createEntity('path', { name: 'Floor guide', position: [xG, 0, zF], params: { fill: 'wall', size: [0.04, 0.1, 0.03], points: [[0.05, 0, s * 0.19], [-0.45, 0, s * 0.13]], smooth: false }, phys: stat({ friction: 0.05 }), look: single('#ffffff', 'glass') })));
  }
  // the light catapult ball tips small dominoes, which grow to the fork's size
  const xS = xG - 0.55;
  E.push(createEntity('path', {
    name: 'Floor starters', position: [xS, 0, zF],
    params: { fill: 'dominoes', size: [0.035, 0.2, 0.2], spacing: 0.55, push: 0, points: [[0, 0, 0], [-0.45, 0, 0]] },
    look: { colorMode: 'gradient', color: '#fff', paletteOffset: 5, finish: 'gloss' },
  }));
  const xC = xS - 0.44 - 0.14;
  E.push(createEntity('path', {
    name: 'Floor dominoes', position: [xC, 0, zF],
    params: { fill: 'dominoes', size: [0.05, 0.32, 0.24], spacing: 0.55, push: 0, points: [[0, 0, 0], [-1.25, 0, 0]] },
    look: { colorMode: 'gradient', color: '#fff', paletteOffset: 0, finish: 'gloss' },
  }));
  const xFork = xC - 1.23 - 0.18;
  E.push(createEntity('box', { name: 'Fork domino', position: [xFork, 0.2, zF], params: { size: [0.06, 0.4, 0.4] }, phys: dyn({ density: 1.2 }), look: single('#e9c46a', 'gloss') }));

  // --- 7a. front: giant cascade, wrecking ball, ring tower ---------------------
  // the cascade turns toward the camera, so the ball swings across the view
  const oA: Vec3 = [xFork - 0.2, 0, zF + 0.1];
  const casP = { fill: 'dominoes', size: [0.05, 0.32, 0.16], spacing: 0.55, push: 0, points: [[0, 0, 0], [-0.5, 0, 0.05], [-0.9, 0, 0.3], [-1.0, 0, 0.6], [-1.0, 0, 0.85]] };
  const casEnd = lastDomino(casP);
  E.push(createEntity('path', {
    name: 'Cascade dominoes', position: oA,
    params: casP,
    look: { colorMode: 'gradient', color: '#fff', paletteOffset: 2, finish: 'gloss' },
  }));
  // each giant ~1.35x taller and only ~2x heavier than the one before: a
  // domino leaning on a much heavier one (3x and more) ends up sliding in
  // under its foot. They only have to topple the next one, then a light prop.
  const xL = oA[0] + casEnd[0];
  let zg = oA[2] + casEnd[2];
  const giants: [number, number, number, number, string][] = [[0.06, 0.45, 0.22, 0.8, '#e9c46a'], [0.09, 0.62, 0.3, 0.55, '#e76f51'], [0.12, 0.85, 0.4, 0.45, '#2a9d8f']];
  let prevH = 0.32;
  giants.forEach(([t, h, w, den, color], i) => {
    zg += prevH * 0.5 + t / 2;
    E.push(createEntity('box', { name: `Giant ${i + 1}`, position: [xL, h / 2, +zg.toFixed(3)], rotation: [0, 90, 0], params: { size: [t, h, w] }, phys: dyn({ density: den }), look: single(color, 'gloss') }));
    prevH = h;
  });
  {
    // the ball waits level, its latch prop 0.65 m past the last giant's foot
    // (met by its top corner at ~0.55 m, below the bar); released, it swings
    // to the left, bottoms out 0.28 m above the floor and goes through the
    // base of the tower
    const R = 0.25, L = 0.47, Y = 1.0;
    const zb = zg + 0.06 + 0.65 + (R + 0.03) + 0.03;
    const xp = xL - (L + R);
    E.push(createEntity('wreckingBall', { name: 'Wrecking ball', position: [xp, Y, zb], params: { length: L, links: 1, ballRadius: R, ballDensity: 5, angle: 90, heading: 0, latch: true, latchFlip: true } }));
    for (const s of [-1, 1]) E.push(decor(createEntity('box', { name: 'Gantry post', position: [xp, (Y + 0.08) / 2, zb + s * 0.36], params: { size: [0.05, Y + 0.08, 0.05] }, phys: stat(), look: single('#2b2d33', 'metal') })));
    E.push(decor(createEntity('box', { name: 'Gantry beam', position: [xp, Y + 0.08, zb], params: { size: [0.05, 0.05, 0.77] }, phys: stat(), look: single('#2b2d33', 'metal') })));
    E.push(createEntity('tower', { name: 'Ring tower', position: [xp - R - 0.67, 0, zb], params: { style: 'ring', levels: 10, block: [0.34, 0.17, 0.2], ringCount: 12, radius: 0.62, gap: 0.004 }, phys: dyn({ density: 0.4 }) }));
  }

  // --- 7b. back: the second row swerves behind the cascade into a spiral ----
  {
    // spiral of 50: its first domino stands at C + (0.304, -0.685), heading
    // -x (read from the built scene)
    const o: Vec3 = [xFork - 0.2, 0, zF - 0.1];
    const F: Vec3 = [o[0] - 2.4, 0, -1.0];
    const C: Vec3 = [F[0] - 0.304, 0, F[2] + 0.685];
    const abs: [number, number][] = [[o[0], o[2]], [o[0] - 0.5, o[2] - 0.12], [o[0] - 1.05, o[2] - 0.75], [o[0] - 1.5, F[2] + 0.15], [F[0] + 0.6, F[2]], [F[0] + 0.2, F[2]]];
    const rowP = { fill: 'dominoes', size: [0.05, 0.32, 0.22], spacing: 0.55, push: 0, points: abs.map(([x, z]) => [+(x - o[0]).toFixed(3), 0, +(z - o[2]).toFixed(3)]) };
    // the spiral's first domino stands 0.2 m past the row's last
    const end = lastDomino(rowP);
    F[0] = o[0] + end[0] - 0.2;
    C[0] = F[0] - 0.304;
    E.push(createEntity('path', {
      name: 'Spiral dominoes', position: o,
      params: rowP,
      look: { colorMode: 'gradient', color: '#fff', paletteOffset: 4, finish: 'gloss' },
    }));
    E.push(createEntity('dominoes', {
      name: 'Domino spiral', position: C, params: { count: 50, size: [0.035, 0.22, 0.11], path: 'spiral', spacing: 0.5, radius: 0.25, turns: 4, push: 0 },
      look: { colorMode: 'gradient', color: '#fff', paletteOffset: 0, finish: 'gloss' },
    }));
  }

  // --- clock ---------------------------------------------------------------------
  // the hourglass turns with the start hammer: the machine runs on its sand
  const hourglass = createEntity('hourglass', { name: 'Hourglass', position: [5.4, 1.25, -1.4], params: { radius: 0.48, neck: 0.15, height: 0.8, grains: 600, grainRadius: 0.03, flipAt: go, flipTime: 1.6, sandBelow: true, glassFriction: 0.2 } });
  hourglass.camera = false; // its sand would hold the follow shot
  E.push(hourglass);
  return d;
}
