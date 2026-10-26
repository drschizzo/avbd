import { defaultDoc, type SceneDoc } from './doc';
import { createEntity } from './entities';
import { catapultMachine, grandMachine, marbleRun, workshop } from './machines';

export interface Preset {
  key: string;
  name: string;
  blurb: string;
  /** shown under the blurb, highlighted (e.g. a long bake) */
  warn?: string;
  make(): SceneDoc;
}

function doc(patch: (d: SceneDoc) => void): SceneDoc {
  const d = defaultDoc();
  patch(d);
  return d;
}

export const PRESETS: Preset[] = [
  {
    key: 'catapult-machine', name: 'Catapult Machine', blurb: 'Chain reaction: piston, dominoes, a giant domino, a catapult and a basket',
    make: catapultMachine,
  },
  {
    key: 'grand-machine', name: 'Grand Machine',
    blurb: 'One unbroken 24 s chain reaction through almost every part, from a hammer tap to a wrecking ball through a tower',
    warn: 'Heavy scene (~1 500 bodies, 30 s): slow to bake',
    make: grandMachine,
  },
  {
    key: 'marble-run', name: 'Marble Run', blurb: 'A marble spirals down a drawn rail into a domino run',
    make: marbleRun,
  },
  {
    key: 'workshop', name: 'Machine Workshop', blurb: 'Empty bench to build your own chain reaction (try the XY plane and ✎ Draw)',
    make: workshop,
  },

  {
    key: 'domino-spiral', name: 'Domino Spiral', blurb: '190 dominoes, rainbow spiral, magnetic reassembly',
    make: () => doc((d) => {
      d.name = 'Domino Spiral';
      d.render.palette = 'rainbow';
      d.loop = { ...d.loop, mode: 'reassemble', outro: 2.6, stagger: 0.7, order: 'index', arc: 0.35 };
      d.physics.friction = 0.45;
      d.physics.gravity = 18;
      d.physics.substeps = 4;
      d.physics.iterations = 8;
      d.physics.colors = 4;
      d.camera = { position: [0, 4.4, 4.0], target: [0, 0, 0], fov: 34, motion: 'orbit', amount: 0, cycles: 1 };
      d.entities.push(createEntity('dominoes', {
        name: 'Spiral', params: { count: 190, size: [0.035, 0.22, 0.11], path: 'spiral', spacing: 0.48, radius: 0.3, turns: 6, push: 18 },
        look: { colorMode: 'gradient', color: '#fff', paletteOffset: 0, finish: 'gloss' },
      }));
    }),
  },
  {
    key: 'hourglass', name: 'Hourglass Flip', blurb: '1 350 grains: the glass turns over, the sand pours through the neck, settles, turns again',
    make: () => doc((d) => {
      d.name = 'Hourglass Flip';
      d.render.palette = 'sunset';
      d.render.aspect = '4:5';
      d.render.bloom = 0.25;
      d.physics.substeps = 6;
      d.physics.iterations = 8;
      // continuous: the clip is simulated twice and the second take starts
      // where the first one ended. The seam sits in the only quiet moment of
      // an hourglass - all the sand down and at rest, just before the turn -
      // where each grain glides onto the matching grain of the first take.
      d.loop = { ...d.loop, mode: 'continuous', outro: 0.6, stagger: 0, order: 'height', arc: 0 };
      d.camera = { position: [3.6, 2.55, 6.5], target: [0, 1.8, 0], fov: 36, motion: 'sway', amount: 12, cycles: 1 };
      // the neck sets the pace: a 1.8 s turn, ~6.5 s of pouring, a breath
      d.entities.push(createEntity('hourglass', {
        name: 'Hourglass', position: [0, 1.82, 0],
        params: { neck: 0.192, grains: 1300, flipAt: 0.15, flipTime: 1.7, sandBelow: true, glassFriction: 0.2 },
      }));
    }),
  },
  {
    key: 'wrecking-ball', name: 'Wrecking Ball', blurb: 'Heavy ball vs. a 320-block ring tower, then time runs backwards',
    make: () => doc((d) => {
      d.name = 'Wrecking Ball';
      d.render.palette = 'sorbet';
      // boomerang: the rewind is the collapse played backwards, so blocks
      // never cut through each other on their way home
      d.duration = 9;
      d.loop = { ...d.loop, mode: 'boomerang', rewind: 2.6, apex: 0.9 };
      d.camera = { position: [9.5, 5.8, 11], target: [0, 2.6, 0], fov: 38, motion: 'sway', amount: 10, cycles: 1 };
      d.entities.push(createEntity('tower', { name: 'Ring tower', params: { style: 'ring', levels: 20, block: [0.5, 0.22, 0.26], ringCount: 16, radius: 1.45, gap: 0.004 } }));
      d.entities.push(createEntity('wreckingBall', {
        name: 'Wrecking ball', position: [0, 7.0, 0],
        params: { length: 3.9, links: 9, ballRadius: 0.7, ballDensity: 30, angle: 75, heading: 0 },
      }));
    }),
  },
  {
    key: 'galton', name: 'Galton Board', blurb: '450 beads sink through 12 rows of pins into a bell curve, then rewind fast',
    make: () => doc((d) => {
      d.name = 'Galton Board';
      d.duration = 12;
      d.render.palette = 'rainbow';
      d.render.floor = 'plain';
      d.render.aspect = '4:5';
      // viscous board: drag kills the sideways momentum a bead would otherwise
      // carry along the lattice diagonals, so each pin is a fair coin flip
      // gravity is raised so all beads have landed ~2.5 s before the rewind,
      // leaving the finished bell curve on screen
      d.physics.substeps = 8;
      d.physics.iterations = 8;
      d.physics.gravity = 22;
      d.physics.drag = 9;
      // boomerang: beads rewind up through the pins (instead of flying
      // straight through them); the bell holds ~2 s, the rewind peaks at x4
      d.loop = { ...d.loop, mode: 'boomerang', rewind: 4, apex: 1.4 };
      d.camera = { position: [0, 2.6, 8.2], target: [0, 2.45, 0], fov: 36, motion: 'sway', amount: 7, cycles: 1 };
      d.entities.push(createEntity('galton', { name: 'Galton board', params: { rows: 12, binHeight: 2.1, beads: 450, funnelGap: 0.55 } }));
    }),
  },
  {
    key: 'dam-break', name: 'Dam Break', blurb: '50 000 water particles (MLS-MPM) crash into a pillar and floating blocks, then rewind',
    make: () => doc((d) => {
      d.name = 'Dam Break';
      d.render.palette = 'sorbet';
      d.physics.substeps = 4;
      d.fluid = { ...d.fluid, cell: 0.07, color: '#1f9bd8', clarity: 0.7 };
      d.loop = { ...d.loop, mode: 'boomerang', rewind: 2.4, apex: 0.8 };
      d.camera = { position: [3.9, 3.3, 6.2], target: [0, 0.4, 0], fov: 38, motion: 'sway', amount: 9, cycles: 1 };
      d.entities.push(createEntity('container', { name: 'Tank', params: { size: [4.2, 1.4, 1.5], thickness: 0.06, floor: false, lid: false } }));
      d.entities.push(createEntity('fluidBlock', { name: 'Water', position: [-1.44, 0, 0], params: { size: [1.3, 1.15, 1.46] } }));
      d.entities.push(createEntity('box', {
        name: 'Pillar', position: [0.15, 0.55, 0.25], params: { size: [0.22, 1.1, 0.22] },
        look: { colorMode: 'single', color: '#e9e6df', paletteOffset: 0, finish: 'satin' },
        phys: { body: 'static', density: 1, friction: 0.5, velocity: [0, 0, 0], angularVelocity: [0, 0, 0], spawnAt: 0 },
      }));
      d.entities.push(createEntity('pyramid', {
        name: 'Floating blocks', position: [1.35, 0, 0], params: { base: 3, brick: [0.24, 0.24, 0.24], gap: 0.01, mode: '3d' },
        look: { colorMode: 'random', color: '#fff', paletteOffset: 0, finish: 'gloss' },
        phys: { body: 'dynamic', density: 0.45, friction: 0.5, velocity: [0, 0, 0], angularVelocity: [0, 0, 0], spawnAt: 0 },
      }));
    }),
  },
  {
    key: 'fill-drain', name: 'Fill & Drain', blurb: 'A tap fills a glass basin, beach balls float up, then the floor opens',
    make: () => doc((d) => {
      d.name = 'Fill & Drain';
      d.render.palette = 'candy';
      d.render.aspect = '4:5';
      d.fluid = { ...d.fluid, cell: 0.07, color: '#27a7e0', clarity: 0.8 };
      d.loop = { ...d.loop, mode: 'sink', outro: 2.4, stagger: 0.5, order: 'height', intro: 0.5 };
      d.camera = { position: [3.0, 3.1, 4.4], target: [0, 1.05, 0], fov: 38, motion: 'sway', amount: 10, cycles: 1 };
      d.entities.push(createEntity('container', { name: 'Basin', params: { size: [1.8, 1.1, 1.8], thickness: 0.06, floor: false, lid: false } }));
      d.entities.push(createEntity('box', {
        name: 'Spout', position: [0, 3.0, 0], params: { size: [0.42, 0.3, 0.42] },
        look: { colorMode: 'single', color: '#dfe3ea', paletteOffset: 0, finish: 'chrome' },
        phys: { body: 'static', density: 1, friction: 0.5, velocity: [0, 0, 0], angularVelocity: [0, 0, 0], spawnAt: 0 },
      }));
      d.entities.push(createEntity('fluidSource', { name: 'Tap', position: [0, 2.82, 0], params: { radius: 0.16, speed: 3.2, start: 0.3, end: 6.4 } }));
      d.entities.push(createEntity('grid', {
        name: 'Beach balls', position: [0, 0, 0], params: { counts: [3, 1, 2], shape: 'sphere', size: 0.34, gap: 0.16, jitter: 0.6 },
        look: { colorMode: 'cycle', color: '#fff', paletteOffset: 0, finish: 'gloss' },
        phys: { body: 'dynamic', density: 0.25, friction: 0.5, velocity: [0, 0, 0], angularVelocity: [0, 0, 0], spawnAt: 0 },
      }));
    }),
  },
  {
    key: 'water-wheel', name: 'Paddle Wheel', blurb: 'A paddle wheel churns a pool and drives floating balls around',
    make: () => doc((d) => {
      d.name = 'Paddle Wheel';
      d.render.palette = 'forest';
      d.fluid = { ...d.fluid, cell: 0.065, color: '#2aa0c8', clarity: 0.8, settle: 1.0 };
      d.loop = { ...d.loop, mode: 'reassemble', outro: 2.4, stagger: 0.5, order: 'height', arc: 0.15 };
      d.camera = { position: [3.4, 2.7, 4.6], target: [0, 0.55, 0], fov: 38, motion: 'sway', amount: 9, cycles: 1 };
      d.entities.push(createEntity('container', { name: 'Pool', params: { size: [2.8, 1.5, 1.2], thickness: 0.06, floor: false, lid: false } }));
      d.entities.push(createEntity('fluidBlock', { name: 'Water', position: [0, 0, 0], params: { size: [2.76, 0.46, 1.16] } }));
      d.entities.push(createEntity('wheel', {
        name: 'Wheel', position: [-0.6, 0.74, 0], params: { radius: 0.55, paddles: 6, width: 1.0, thickness: 0.045, turns: -2, rims: false },
        look: { colorMode: 'single', color: '#d1495b', paletteOffset: 0, finish: 'gloss' },
      }));
      d.entities.push(createEntity('grid', {
        name: 'Floats', position: [0.7, 0.6, 0], params: { counts: [3, 1, 2], shape: 'sphere', size: 0.24, gap: 0.12, jitter: 0.5 },
        look: { colorMode: 'cycle', color: '#fff', paletteOffset: 0, finish: 'gloss' },
        phys: { body: 'dynamic', density: 0.3, friction: 0.5, velocity: [0, 0, 0], angularVelocity: [0, 0, 0], spawnAt: 0 },
      }));
    }),
  },
  {
    key: 'cannonball', name: 'Cannonball', blurb: 'A steel ball plunges into a deep pool of 75 000 particles',
    make: () => doc((d) => {
      d.name = 'Cannonball';
      d.render.palette = 'ocean';
      d.render.aspect = '4:5';
      d.fluid = { ...d.fluid, cell: 0.06, soundSpeed: 12, color: '#1e90c8', clarity: 0.9, settle: 1.2 };
      // boomerang: the splash folds back into a flat pool and spits the ball out
      d.loop = { ...d.loop, mode: 'boomerang', rewind: 2.2, apex: 1.0 };
      d.camera = { position: [3.0, 2.3, 4.1], target: [0, 0.75, 0], fov: 38, motion: 'sway', amount: 8, cycles: 1 };
      d.entities.push(createEntity('container', { name: 'Pool', params: { size: [1.7, 1.4, 1.7], thickness: 0.07, floor: false, lid: false } }));
      d.entities.push(createEntity('fluidBlock', { name: 'Water', position: [0, 0, 0], params: { size: [1.66, 0.85, 1.66] } }));
      d.entities.push(createEntity('sphere', {
        // starts out of frame (same fall as being dropped at 3.6 m / -7 m/s
        // 0.6 s later), so the rewind carries it away instead of popping it
        name: 'Cannonball', position: [0.04, 6.03, -0.04], params: { radius: 0.27 },
        look: { colorMode: 'single', color: '#1b1b1f', paletteOffset: 0, finish: 'metal' },
        phys: { body: 'dynamic', density: 5, friction: 0.4, velocity: [0, -1.11, 0], angularVelocity: [0, 0, 0], spawnAt: 0 },
      }));
    }),
  },
  {
    key: 'cube-rain', name: 'Cube Rain', blurb: '2 700 pastel cubes pouring into glass, then sinking away',
    make: () => doc((d) => {
      d.name = 'Cube Rain';
      d.render.palette = 'candy';
      d.loop = { ...d.loop, mode: 'sink', outro: 2.0, stagger: 0.5, order: 'height', intro: 0.5 };
      d.camera = { position: [8, 7, 8], target: [0, 1.2, 0], fov: 36, motion: 'orbit', amount: 0, cycles: 1 };
      d.entities.push(createEntity('container', { name: 'Glass box', params: { size: [3.2, 1.6, 3.2], thickness: 0.06, floor: false, lid: false } }));
      d.entities.push(createEntity('emitter', {
        name: 'Rain', position: [0, 6, 0],
        params: { shape: 'box', rate: 620, start: 0.1, end: 6.0, sizeMin: 0.15, sizeMax: 0.22, elongation: 1.5, area: 1.4, speed: 4, spread: 4, tumble: 4, maxCount: 3600 },
        look: { colorMode: 'random', color: '#fff', paletteOffset: 0, finish: 'satin' },
      }));
    }),
  },
  {
    key: 'glued-wall', name: 'Shattered Wall', blurb: 'Glued bricks with breakable joints vs. cannonballs',
    make: () => doc((d) => {
      d.name = 'Shattered Wall';
      d.render.palette = 'bauhaus';
      d.loop = { ...d.loop, mode: 'boomerang', rewind: 2.8, apex: 0.7 };
      d.camera = { position: [9, 3.8, 7.5], target: [0, 1.7, 0], fov: 36, motion: 'sway', amount: 8, cycles: 1 };
      d.entities.push(createEntity('wall', { name: 'Glued wall', params: { rows: 14, cols: 12, brick: [0.5, 0.25, 0.3], gap: 0.003, bond: true, glue: 40 } }));
      for (let i = 0; i < 3; i++) {
        d.entities.push(createEntity('sphere', {
          name: `Cannonball ${i + 1}`, position: [-1.2 + i * 1.2, 1 + i * 0.9, 7],
          params: { radius: 0.32 },
          look: { colorMode: 'single', color: '#1b1b1f', paletteOffset: 0, finish: 'metal' },
          phys: { body: 'dynamic', density: 30, friction: 0.4, velocity: [0, 3.2, -16], angularVelocity: [0, 0, 0], spawnAt: 0.6 + i * 1.1 },
        }));
      }
    }),
  },
  {
    key: 'curtain', name: 'Bead Curtain', blurb: '30 bead strands swept by a spinning bar',
    make: () => doc((d) => {
      d.name = 'Bead Curtain';
      d.render.palette = 'neon';
      d.render.bloom = 0.45;
      d.render.bloomThreshold = 0.7;
      // continuous: one full sweep is simulated first, so the recorded loop
      // starts with the curtain already swinging the way it ends
      d.loop = { ...d.loop, mode: 'continuous', outro: 1.2, stagger: 0, order: 'distance', arc: 0 };
      d.camera = { position: [0, 3, 10], target: [0, 2.5, 0], fov: 36, motion: 'sway', amount: 14, cycles: 1 };
      d.entities.push(createEntity('chain', {
        name: 'Curtain', position: [0, 4.6, 0], rotation: [0, 90, 0],
        params: { links: 26, linkType: 'bead', radius: 0.07, strands: 20, strandSpacing: 0.24, layout: 'hanging', anchors: 'start' },
        look: { colorMode: 'gradient', color: '#fff', paletteOffset: 0, finish: 'neon' },
      }));
      d.entities.push(createEntity('box', {
        name: 'Sweeper', position: [0, 1.4, 0.75], params: { size: [3.2, 0.2, 0.2] },
        look: { colorMode: 'single', color: '#e8e8f0', paletteOffset: 0, finish: 'chrome' },
        phys: { body: 'kinematic', density: 1, friction: 0.3, velocity: [0, 0, 0], angularVelocity: [0, 0, 0], spawnAt: 0 },
        motion: { kind: 'spin', axis: [0, 1, 0], cycles: 1, amplitude: 45, phase: 0, offset: [0, 0, 0], open: 0, close: 0, ease: 0.3 },
      }));
    }),
  },
  {
    key: 'funnel', name: 'Funnel Swirl', blurb: 'An endless stream of spheres spirals down a glass funnel into the void',
    make: () => doc((d) => {
      d.name = 'Funnel Swirl';
      d.render.palette = 'sunset';
      d.render.bloom = 0.3;
      d.render.floor = 'none';
      // no floor: what leaves the funnel falls away for good. Continuous loop:
      // the stream runs all clip long and every sphere is recycled through
      // the emitter, so the start is already mid-swirl
      d.physics.ground = false;
      d.loop = { ...d.loop, mode: 'continuous', outro: 0.8, stagger: 0, order: 'height', arc: 0 };
      d.camera = { position: [5.5, 6.5, 6.5], target: [0, 2.6, 0], fov: 38, motion: 'orbit', amount: 0, cycles: 1 };
      d.entities.push(createEntity('funnel', { name: 'Funnel', position: [0, 2.2, 0], params: { segments: 20, top: 2.4, bottom: 0.42, height: 1.7, thickness: 0.05 } }));
      d.entities.push(createEntity('emitter', {
        name: 'Swirl source', position: [1.9, 4.6, 0], rotation: [0, 0, -70],
        params: { shape: 'sphere', rate: 40, start: 0.05, end: 10, sizeMin: 0.17, sizeMax: 0.17, elongation: 1, area: 0.45, areaShape: 'disk', speed: 3.0, spread: 4, tumble: 0, maxCount: 600 },
        look: { colorMode: 'cycle', color: '#fff', paletteOffset: 0, finish: 'gloss' },
        phys: { body: 'dynamic', density: 1, friction: 0.15, velocity: [0, 0, 2.2], angularVelocity: [0, 0, 0], spawnAt: 0 },
      }));
    }),
  },
  {
    key: 'bridge', name: 'Rope Bridge', blurb: 'Plank bridge catching a shower of blocks',
    make: () => doc((d) => {
      d.name = 'Rope Bridge';
      d.render.palette = 'forest';
      d.physics.substeps = 4;
      // the bridge holds the blocks, so they could never sink away: the planks
      // fly back into place while the blocks pop out
      d.loop = { ...d.loop, mode: 'reassemble', outro: 2.2, stagger: 0.6, order: 'height', arc: 0.2 };
      d.camera = { position: [7, 5.5, 8.5], target: [0, 1.6, 0], fov: 38, motion: 'sway', amount: 10, cycles: 1 };
      d.entities.push(createEntity('chain', {
        name: 'Bridge', position: [0, 2.6, 0],
        params: { links: 22, linkType: 'plank', radius: 0.11, plank: [0.3, 2.0, 0], strands: 1, strandSpacing: 0.3, layout: 'span', anchors: 'both', slack: 0.94, breakForce: 0 },
        look: { colorMode: 'single', color: '#a47148', paletteOffset: 0, finish: 'satin' },
      }));
      d.entities.push(createEntity('emitter', {
        name: 'Blocks', position: [0, 4.8, 0],
        params: { shape: 'box', rate: 24, start: 0.3, end: 5.6, sizeMin: 0.2, sizeMax: 0.32, elongation: 1.5, area: 2.4, areaShape: 'line', speed: 1.5, spread: 1, tumble: 3, maxCount: 120 },
        look: { colorMode: 'random', color: '#fff', paletteOffset: 0, finish: 'gloss' },
      }));
    }),
  },
  {
    key: 'mixer', name: 'Paddle Mixer', blurb: 'A kinematic paddle churning 576 cubes, endlessly',
    make: () => doc((d) => {
      d.name = 'Paddle Mixer';
      d.render.palette = 'mint';
      // continuous: cubes keep churning across the seam and trade places
      // with identical cubes instead of popping out
      d.loop = { ...d.loop, mode: 'continuous', outro: 1.0, stagger: 0, order: 'height', arc: 0 };
      d.camera = { position: [6.5, 7.5, 7.5], target: [0, 0.6, 0], fov: 36, motion: 'orbit', amount: 0, cycles: 1 };
      // a glass lid: a steady churn needs every cube to stay in play
      d.entities.push(createEntity('container', { name: 'Tub', params: { size: [4, 2.2, 4], thickness: 0.08, floor: false, lid: true }, look: { colorMode: 'single', color: '', paletteOffset: 0, finish: 'glass' } }));
      d.entities.push(createEntity('grid', { name: 'Cubes', position: [0, 0.9, 0], params: { counts: [12, 4, 12], shape: 'box', size: 0.26, gap: 0.03, jitter: 0 } }));
      d.entities.push(createEntity('box', {
        name: 'Paddle', position: [0, 0.5, 0], params: { size: [3.6, 0.7, 0.18] },
        look: { colorMode: 'single', color: '#264653', paletteOffset: 0, finish: 'metal' },
        phys: { body: 'kinematic', density: 1, friction: 0.5, velocity: [0, 0, 0], angularVelocity: [0, 0, 0], spawnAt: 0 },
        motion: { kind: 'spin', axis: [0, 1, 0], cycles: 2, amplitude: 45, phase: 0, offset: [0, 0, 0], open: 0, close: 0, ease: 0.3 },
      }));
    }),
  },
  {
    key: 'stairs', name: 'Stair Cascade', blurb: 'An endless cascade of chrome marbles down a floating staircase',
    make: () => doc((d) => {
      d.name = 'Stair Cascade';
      d.render.palette = 'noir';
      d.render.floor = 'none';
      d.physics.ground = false;
      // continuous + recycled marbles: the cascade never stops, never resets
      d.loop = { ...d.loop, mode: 'continuous', outro: 0.8, stagger: 0, order: 'distance', arc: 0 };
      d.camera = { position: [8, 4.8, 3.6], target: [0, 1.6, 2.4], fov: 38, motion: 'sway', amount: 8, cycles: 1 };
      // treads tilted 7° forward: marbles never come to rest in a corner, so
      // the flow is steady (a pile building up could not loop)
      d.entities.push(createEntity('stairs', { name: 'Stairs', position: [0, 0.75, 0], rotation: [7, 0, 0], params: { steps: 10, step: [3, 0.28, 0.5], solid: true }, look: { colorMode: 'gradient', color: '', paletteOffset: 2, finish: 'satin' } }));
      d.entities.push(createEntity('emitter', {
        name: 'Marbles', position: [0, 4.5, 0.1],
        params: { shape: 'sphere', rate: 36, start: 0.05, end: 10, sizeMin: 0.18, sizeMax: 0.18, elongation: 1, area: 1.2, speed: 0.5, spread: 2, tumble: 0, maxCount: 400 },
        look: { colorMode: 'cycle', color: '#fff', paletteOffset: 0, finish: 'chrome' },
        phys: { body: 'dynamic', density: 1, friction: 0.3, velocity: [0, 0, 1.5], angularVelocity: [0, 0, 0], spawnAt: 0 },
      }));
    }),
  },
  {
    key: 'pyramid', name: 'Pyramid Topple', blurb: 'A 506-block 3D pyramid struck by a heavy cube, then rewound',
    make: () => doc((d) => {
      d.name = 'Pyramid Topple';
      d.render.palette = 'mono';
      // the pile is still by ~4 s: an 8 s clip turns around just after
      d.duration = 8;
      d.loop = { ...d.loop, mode: 'boomerang', rewind: 2.5, apex: 0.8 };
      d.camera = { position: [7.5, 4.6, 8.5], target: [0.6, 1.1, 0], fov: 36, motion: 'sway', amount: 10, cycles: 1 };
      d.entities.push(createEntity('pyramid', { name: 'Pyramid', params: { base: 11, brick: [0.38, 0.38, 0.38], gap: 0.015, mode: '3d' }, look: { colorMode: 'height', color: '#fff', paletteOffset: 0, finish: 'gloss' } }));
      d.entities.push(createEntity('box', {
        name: 'Hammer', position: [-8, 1.6, 0], params: { size: [0.9, 0.9, 0.9] },
        look: { colorMode: 'single', color: '#e63946', paletteOffset: 0, finish: 'gloss' },
        phys: { body: 'dynamic', density: 12, friction: 0.4, velocity: [14, 2, 0], angularVelocity: [0, 0, -3], spawnAt: 0.3 },
      }));
    }),
  },
  {
    key: 'tumbler', name: 'Tumbler Drum', blurb: 'A slow drum with lifters keeps 224 blocks cascading, forever',
    make: () => doc((d) => {
      d.name = 'Tumbler Drum';
      d.render.palette = 'candy';
      d.physics.substeps = 4;
      d.physics.settle = 0;
      // continuous: the first take turns the starting heap into a steady
      // cascade, the recorded take starts from it
      d.loop = { ...d.loop, mode: 'continuous', outro: 1.4, stagger: 0, order: 'height', arc: 0 };
      d.camera = { position: [1.2, 2.3, 5.2], target: [0, 1.5, 0], fov: 38, motion: 'sway', amount: 6, cycles: 1 };
      d.entities.push(createEntity('drum', { name: 'Drum', position: [0, 1.5, 0], params: { radius: 1.15, length: 0.8, segments: 36, thickness: 0.1, lifters: 6, lifterHeight: 0.16, turns: 2, window: true } }));
      // one shape and size, two colours: any block can stand in for any other
      // at the seam (crossing colours only when it spares a long trip)
      for (const [k, color] of [[0, '#ff5d8f'], [1, '#7bdff2']] as const) {
        d.entities.push(createEntity('grid', {
          name: `Blocks ${k + 1}`, position: [0, 1.05 + k * 0.62, 0],
          params: { counts: [7, 4, 4], shape: 'box', size: 0.14, gap: 0.015, jitter: 0.2 },
          look: { colorMode: 'single', color, paletteOffset: 0, finish: 'gloss' },
        }));
      }
    }),
  },
  {
    key: 'pendulum-wave', name: 'Pendulum Wave', blurb: '15 pendulums, 10 to 24 swings each: waves, rows, chaos, and back in line',
    make: () => doc((d) => {
      d.name = 'Pendulum Wave';
      d.duration = 15;
      d.render.palette = 'neon';
      d.render.bloom = 0.5;
      d.render.bloomThreshold = 0.6;
      d.render.aspect = '16:9';
      // purely kinematic: every swing is periodic over the clip, so the loop
      // is exact with no transition at all
      d.loop = { ...d.loop, mode: 'none' };
      d.camera = { position: [0.45, 0.98, 1.6], target: [0, 0.78, 0], fov: 31, motion: 'sway', amount: 8, cycles: 1 };
      d.entities.push(createEntity('pendulumWave', {
        name: 'Pendulums', position: [0, 1.05, 0], params: { count: 15, cycles: 10, amplitude: 24, spacing: 0.085, bob: 0.032 },
        look: { colorMode: 'gradient', color: '', paletteOffset: 0, finish: 'neon' },
      }));
    }),
  },
];
