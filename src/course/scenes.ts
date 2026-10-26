// The 3D scenes the course runs in the real engine. They are deliberately
// small (a handful of seconds, few bodies) so that changing a solver setting
// during a lesson re-bakes in a fraction of a second.

import { defaultDoc, type SceneDoc } from '../scene/doc';
import { createEntity } from '../scene/entities';

export type SceneKey =
  | 'intro' | 'onebox' | 'freefall' | 'noSolver' | 'twoBoxes' | 'stack' | 'pyramid'
  | 'slope' | 'dominoes' | 'chain' | 'wrecking' | 'spheres' | 'crowd' | 'galton'
  | 'fluid' | 'hourglass';

export interface CourseScene {
  key: SceneKey;
  /** short label shown in the viewport badge */
  label: string;
  make(): SceneDoc;
}

function base(patch: (d: SceneDoc) => void): SceneDoc {
  const d = defaultDoc();
  // short clips at 30 fps: a lesson re-bakes a scene every time a solver
  // setting changes, and the renderer interpolates between recorded frames
  d.duration = 5;
  d.fps = 30;
  d.render.aspect = '16:9';
  d.render.palette = 'sorbet';
  d.render.floor = 'plain';
  d.render.vignette = 0.32;
  d.render.bloom = 0.12;
  d.render.ao = 0.9;
  d.loop = { ...d.loop, mode: 'reassemble', outro: 1.4, stagger: 0.5, order: 'height', arc: 0.3, intro: 0.4 };
  d.camera = { position: [6.5, 4.2, 8], target: [0, 1.2, 0], fov: 34, motion: 'sway', amount: 6, cycles: 1 };
  d.physics.settle = 0;
  patch(d);
  return d;
}

const statics = { body: 'static' as const, density: 1, friction: 0.6, velocity: [0, 0, 0] as [number, number, number], angularVelocity: [0, 0, 0] as [number, number, number], spawnAt: 0 };

export const SCENES: Record<SceneKey, CourseScene> = {
  intro: {
    key: 'intro', label: 'Une pyramide, une boule',
    make: () => base((d) => {
      d.name = 'Cours · introduction';
      d.duration = 8;
      d.render.palette = 'sorbet';
      d.physics.substeps = 4;
      d.physics.iterations = 10;
      d.camera = { position: [7.5, 3.4, 9], target: [0, 1.1, 0], fov: 32, motion: 'sway', amount: 8, cycles: 1 };
      d.entities.push(createEntity('pyramid', { name: 'Pyramide', params: { base: 9, brick: [0.46, 0.46, 0.46], gap: 0.015, mode: '2d' } }));
      d.entities.push(createEntity('sphere', {
        name: 'Boulet', position: [-6.5, 2.6, 0], params: { radius: 0.52 },
        phys: { body: 'dynamic', density: 14, friction: 0.4, velocity: [9.5, 0, 0], angularVelocity: [0, 0, -6], spawnAt: 0 },
      }));
    }),
  },

  onebox: {
    key: 'onebox', label: 'Un corps, un pas de temps',
    make: () => base((d) => {
      d.name = 'Cours · un corps';
      d.duration = 5;
      d.camera = { position: [5.8, 3.2, 7], target: [0, 1.5, 0], fov: 32, motion: 'static', amount: 0, cycles: 1 };
      d.entities.push(createEntity('box', { name: 'Caisse', position: [0, 2.4, 0], params: { size: [1, 1, 1] } }));
    }),
  },

  freefall: {
    key: 'freefall', label: 'Chute libre',
    make: () => base((d) => {
      d.name = 'Cours · chute libre';
      d.duration = 5;
      d.physics.ground = false;
      d.render.floor = 'none';
      d.camera = { position: [5.2, 1.2, 6], target: [0, 0.4, 0], fov: 36, motion: 'static', amount: 0, cycles: 1 };
      d.entities.push(createEntity('sphere', {
        name: 'Balle', position: [-2.6, 2.4, 0], params: { radius: 0.3 },
        phys: { body: 'dynamic', density: 1, friction: 0.4, velocity: [3.4, 3.2, 0], angularVelocity: [0, 0, 0], spawnAt: 0 },
      }));
    }),
  },

  noSolver: {
    key: 'noSolver', label: 'Sans contraintes',
    make: () => base((d) => {
      d.name = 'Cours · sans solveur';
      d.duration = 5;
      d.physics.ground = false;
      d.render.floor = 'grid';
      d.camera = { position: [5, 2.4, 6.2], target: [0, 0.6, 0], fov: 34, motion: 'static', amount: 0, cycles: 1 };
      for (let i = 0; i < 5; i++) {
        d.entities.push(createEntity('box', {
          name: `Caisse ${i + 1}`, position: [(i - 2) * 1.05, 1.6 + i * 0.1, 0], params: { size: [0.8, 0.8, 0.8] },
        }));
      }
    }),
  },

  twoBoxes: {
    key: 'twoBoxes', label: 'Deux corps, un contact',
    make: () => base((d) => {
      d.name = 'Cours · un contact';
      d.duration = 5;
      d.camera = { position: [5, 2.6, 6], target: [0, 1.1, 0], fov: 32, motion: 'static', amount: 0, cycles: 1 };
      d.entities.push(createEntity('box', { name: 'Socle', position: [0, 0.4, 0], params: { size: [1.6, 0.8, 1.6] }, phys: { ...statics } }));
      d.entities.push(createEntity('box', { name: 'Caisse', position: [0.18, 2.3, 0], rotation: [0, 0, 11], params: { size: [1, 1, 1] } }));
    }),
  },

  stack: {
    key: 'stack', label: 'Une pile de dix',
    make: () => base((d) => {
      d.name = 'Cours · la pile';
      d.duration = 6;
      d.physics.substeps = 4;
      d.physics.iterations = 10;
      d.camera = { position: [5.4, 3.4, 6.4], target: [0, 1.9, 0], fov: 32, motion: 'sway', amount: 5, cycles: 1 };
      d.entities.push(createEntity('tower', {
        name: 'Pile', params: { style: 'column', levels: 10, block: [0.7, 0.38, 0.7], ringCount: 12, radius: 1, gap: 0.004 },
      }));
    }),
  },

  pyramid: {
    key: 'pyramid', label: 'Pyramide',
    make: () => base((d) => {
      d.name = 'Cours · pyramide';
      d.duration = 6;
      d.physics.substeps = 4;
      d.camera = { position: [6.2, 3, 7], target: [0, 1, 0], fov: 32, motion: 'sway', amount: 5, cycles: 1 };
      d.entities.push(createEntity('pyramid', { name: 'Pyramide', params: { base: 8, brick: [0.5, 0.5, 0.5], gap: 0.015, mode: '2d' } }));
    }),
  },

  slope: {
    key: 'slope', label: 'Le plan incliné',
    make: () => base((d) => {
      d.name = 'Cours · frottement';
      d.duration = 6;
      d.physics.friction = 0.45;
      d.camera = { position: [5.6, 2.6, 6.4], target: [0, 1, 0], fov: 32, motion: 'static', amount: 0, cycles: 1 };
      d.entities.push(createEntity('box', {
        name: 'Rampe', position: [0, 1, 0], rotation: [0, 0, -18], params: { size: [7, 0.3, 3] }, phys: { ...statics, friction: 2 },
      }));
      // The engine's coefficient for a pair is global × √(μA·μB). With the ramp
      // at 2, these give ⅓, 1 and 2 × the global value: 0.15, 0.45 and 0.9 at
      // the course's 0.45 — the numbers its text quotes against tan 18° = 0.32.
      for (let i = 0; i < 3; i++) {
        d.entities.push(createEntity('box', {
          name: `Caisse ${i + 1}`, position: [-2.2 + i * 0.1, 2.6 + i * 0.02, (i - 1) * 0.9], rotation: [0, 0, -18],
          params: { size: [0.55, 0.55, 0.55] },
          phys: { body: 'dynamic', density: 1, friction: [1 / 18, 0.5, 2][i], velocity: [0, 0, 0], angularVelocity: [0, 0, 0], spawnAt: 0 },
        }));
      }
    }),
  },

  dominoes: {
    key: 'dominoes', label: 'Dominos fins',
    make: () => base((d) => {
      d.name = 'Cours · dominos';
      d.duration = 6;
      d.physics.substeps = 4;
      d.physics.iterations = 10;
      d.physics.gravity = 14;
      d.physics.friction = 0.5;
      d.camera = { position: [0, 4.2, 8.8], target: [0, 0.2, 0.8], fov: 34, motion: 'sway', amount: 5, cycles: 1 };
      // the 'arc' path is a half-circle of radius 3 × radius, walked from one
      // end: 26 dominoes 0.25 m apart cover it exactly with radius 0.7, which
      // centres the row in front of the camera
      d.entities.push(createEntity('dominoes', {
        name: 'Dominos', position: [0, 0, 0],
        params: { count: 26, size: [0.045, 0.42, 0.22], path: 'arc', spacing: 0.6, radius: 0.7, turns: 0.55, push: 14 },
        look: { colorMode: 'gradient', color: '#fff', paletteOffset: 0, finish: 'gloss' },
      }));
    }),
  },

  chain: {
    key: 'chain', label: 'Une chaîne',
    make: () => base((d) => {
      d.name = 'Cours · joints';
      d.duration = 6;
      d.physics.substeps = 4;
      d.camera = { position: [4.8, 3, 6], target: [0, 2, 0], fov: 34, motion: 'static', amount: 0, cycles: 1 };
      d.entities.push(createEntity('chain', {
        name: 'Chaîne', position: [-1.4, 4.4, 0],
        params: { links: 16, linkType: 'bead', radius: 0.12, plank: [0.3, 1, 0], strands: 1, strandSpacing: 0.3, layout: 'hanging', anchors: 'start', slack: 0.92, breakForce: 0 },
      }));
      d.entities.push(createEntity('box', { name: 'Cible', position: [1.1, 0.5, 0], params: { size: [0.7, 1, 0.7] } }));
    }),
  },

  wrecking: {
    key: 'wrecking', label: 'Boule de démolition',
    make: () => base((d) => {
      d.name = 'Cours · masses';
      d.duration = 7;
      d.physics.substeps = 4;
      d.camera = { position: [7.5, 4, 8.4], target: [0, 2, 0], fov: 34, motion: 'sway', amount: 5, cycles: 1 };
      d.entities.push(createEntity('tower', {
        name: 'Tour', params: { style: 'ring', levels: 12, block: [0.45, 0.22, 0.24], ringCount: 12, radius: 1.1, gap: 0.004 },
      }));
      d.entities.push(createEntity('wreckingBall', {
        name: 'Boule', position: [0, 5.4, 0],
        params: { length: 2.8, links: 8, ballRadius: 0.5, ballDensity: 30, angle: 70, heading: 0 },
      }));
    }),
  },

  spheres: {
    key: 'spheres', label: 'Billes qui roulent',
    make: () => base((d) => {
      d.name = 'Cours · roulement';
      d.duration = 6;
      d.physics.substeps = 4;
      d.camera = { position: [5, 2.6, 6], target: [0, 0.6, 0], fov: 34, motion: 'static', amount: 0, cycles: 1 };
      d.entities.push(createEntity('box', { name: 'Rampe', position: [-1.6, 1.1, 0], rotation: [0, 0, -16], params: { size: [5, 0.25, 2.4] }, phys: { ...statics } }));
      for (let i = 0; i < 6; i++) {
        d.entities.push(createEntity('sphere', {
          name: `Bille ${i + 1}`, position: [-3.4 + i * 0.05, 2.5 + i * 0.03, (i - 2.5) * 0.4], params: { radius: 0.22 },
        }));
      }
    }),
  },

  crowd: {
    key: 'crowd', label: 'Mille corps',
    make: () => base((d) => {
      d.name = 'Cours · parallélisme';
      d.duration = 6;
      d.physics.substeps = 3;
      d.physics.iterations = 8;
      d.physics.colors = 8;
      d.render.palette = 'rainbow';
      d.camera = { position: [6.4, 4.4, 7.6], target: [0, 1.2, 0], fov: 34, motion: 'sway', amount: 6, cycles: 1 };
      d.entities.push(createEntity('container', { name: 'Bac', params: { size: [4.2, 2.6, 4.2], thickness: 0.1, floor: false, lid: false } }));
      d.entities.push(createEntity('grid', {
        name: 'Cubes', position: [0, 0.2, 0],
        params: { counts: [10, 10, 10], shape: 'mixed', size: 0.3, gap: 0.06, jitter: 0.6 },
      }));
    }),
  },

  galton: {
    key: 'galton', label: 'Planche de Galton',
    make: () => base((d) => {
      d.name = 'Cours · statistique';
      d.duration = 9;
      d.physics.substeps = 6;
      d.physics.iterations = 8;
      d.physics.gravity = 22;
      d.physics.drag = 9;
      d.render.palette = 'rainbow';
      d.loop.outro = 2;
      d.camera = { position: [0, 2.6, 7.6], target: [0, 2.4, 0], fov: 36, motion: 'static', amount: 0, cycles: 1 };
      d.entities.push(createEntity('galton', { name: 'Galton', params: { rows: 10, binHeight: 1.9, beads: 300, funnelGap: 0.55 } }));
    }),
  },

  fluid: {
    key: 'fluid', label: 'Rupture de barrage',
    make: () => base((d) => {
      d.name = 'Cours · liquides';
      d.duration = 6;
      d.physics.substeps = 4;
      d.fluid = { ...d.fluid, cell: 0.075, color: '#1f9bd8', clarity: 0.7 };
      d.camera = { position: [3.9, 3.1, 6], target: [0, 0.4, 0], fov: 38, motion: 'static', amount: 0, cycles: 1 };
      d.entities.push(createEntity('container', { name: 'Bac', params: { size: [4.2, 1.4, 1.5], thickness: 0.06, floor: false, lid: false } }));
      d.entities.push(createEntity('fluidBlock', { name: 'Eau', position: [-1.44, 0, 0], params: { size: [1.3, 1.15, 1.46] } }));
      d.entities.push(createEntity('box', {
        name: 'Pilier', position: [0.15, 0.55, 0.25], params: { size: [0.22, 1.1, 0.22] },
        look: { colorMode: 'single', color: '#e9e6df', paletteOffset: 0, finish: 'satin' }, phys: { ...statics, friction: 0.5 },
      }));
      d.entities.push(createEntity('grid', {
        name: 'Flotteurs', position: [1.3, 0.1, 0],
        params: { counts: [2, 3, 2], shape: 'box', size: 0.22, gap: 0.03, jitter: 0 },
      }));
    }),
  },

  hourglass: {
    key: 'hourglass', label: 'Le sablier',
    make: () => base((d) => {
      d.name = 'Cours · la boucle';
      d.duration = 10;
      d.render.palette = 'sunset';
      d.render.bloom = 0.22;
      d.physics.substeps = 6;
      d.physics.iterations = 8;
      d.loop = { ...d.loop, mode: 'reassemble', outro: 1.3, stagger: 0.5, order: 'height', arc: 0 };
      d.camera = { position: [3.6, 2.55, 6.5], target: [0, 1.8, 0], fov: 36, motion: 'sway', amount: 8, cycles: 1 };
      d.entities.push(createEntity('hourglass', { name: 'Sablier', position: [0, 1.82, 0] }));
    }),
  },
};

export const sceneDoc = (k: SceneKey): SceneDoc => SCENES[k].make();
