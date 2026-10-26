// Content of the guided tour: what each step says, what it points at, how it
// knows the learner has done it, and what "do it for me" does.
//
// Part 2 builds a small machine — a ball rolls down a ramp, knocks over a
// domino run, the last domino topples a pyramid. The reference layout below
// was checked in the real engine (Machine tab: every step moves); the helpers
// rebuild it around wherever the learner actually put the ramp.

import * as THREE from 'three';
import type { App } from '../app';
import type { AppEvent } from '../core/events';
import type { Entity, Vec3 } from '../scene/doc';
import { createEntity } from '../scene/entities';
import { buildScene, entityQuat, type BuiltScene } from '../scene/build';
import { round as r3 } from '../util/num';

export interface TutHooks {
  /** the right-hand tab currently shown */
  tab(): string;
  setTab(name: string): void;
  openPresets(): void;
  openCourse(): void;
}

export interface TutCtx {
  app: App;
  ui: TutHooks;
  /** scratch memory of the current step, emptied when it starts */
  mem: Record<string, any>;
  /** app events seen since the step started */
  seen: Set<AppEvent>;
}

export interface Mark { p: Vec3; label: string }

export interface Step {
  /** 0 = the tour of the interface, 1 = the build */
  part: 0 | 1;
  title: string;
  html: string | ((c: TutCtx) => string);
  /** the "your turn" line */
  task?: string;
  /** what to light up: a `data-tut` name or a CSS selector */
  target?: string | ((c: TutCtx) => string | null);
  /** where the card sits relative to the target */
  side?: 'left' | 'right' | 'top' | 'bottom' | 'center';
  /** the step happens in the editor: finished bakes do not start playback */
  edit?: boolean;
  /** points of the scene to show in the viewport (edit mode only) */
  marks?(c: TutCtx): Mark[];
  enter?(c: TutCtx): void;
  /** called every frame while the step is shown */
  tick?(c: TutCtx): void;
  /** called on every app event while the step is shown */
  on?(c: TutCtx, what: AppEvent): void;
  done?(c: TutCtx): boolean;
  /** extra line shown while the task is not done */
  hint?(c: TutCtx): string | null;
  success?: string | ((c: TutCtx) => string);
  /** offered while the task is not done */
  doIt?: { label: string; run(c: TutCtx): void; show?(c: TutCtx): boolean };
  /** offered once it is done: tidy up what the learner did */
  fix?: { label: string; run(c: TutCtx): void; show?(c: TutCtx): boolean };
}

// ------------------------------------------------------------------ helpers

const V = (v: Vec3) => new THREE.Vector3(...v);
const arr = (v: THREE.Vector3): Vec3 => [r3(v.x), r3(v.y), r3(v.z)];

const first = (app: App, pred: (e: Entity) => boolean) => app.doc.entities.find(pred) ?? null;
const ramp = (app: App) => first(app, (e) => e.type === 'ramp');
const ball = (app: App) => first(app, (e) => e.type === 'sphere');
const run = (app: App) => first(app, (e) => e.type === 'path' && e.params.fill === 'dominoes');
const pyramid = (app: App) => first(app, (e) => e.type === 'pyramid');
const placing = (app: App) => !!app.tools?.placing;

const BALL_R = 0.12;
const RAMP_AT: Vec3 = [-1.9, 0.38, 0];
const RUN_LEN = 2;

/** Frame of a ramp: centre of the running surface, downhill, surface normal, across. */
function rampFrame(e: Entity) {
  const a = (e.params.angle * Math.PI) / 180;
  const q = entityQuat(e);
  const down = new THREE.Vector3(Math.cos(a), -Math.sin(a), 0).applyQuaternion(q);
  const normal = new THREE.Vector3(Math.sin(a), Math.cos(a), 0).applyQuaternion(q);
  const side = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const c = V(e.position);
  const L = e.params.length as number;
  return {
    c, down, normal, side, L, W: e.params.width as number,
    top: c.clone().addScaledVector(down, -L / 2),
    foot: c.clone().addScaledVector(down, L / 2),
  };
}

/** Where the ball should rest: near the top of the ramp, on its surface. */
function ballSpot(rp: Entity, r = BALL_R): THREE.Vector3 {
  const f = rampFrame(rp);
  return f.c.clone().addScaledVector(f.down, -0.38 * f.L).addScaledVector(f.normal, r + 0.004);
}

/** Start and end of the domino run: on the floor, from the foot of the ramp onward. */
function runSpots(rp: Entity): [THREE.Vector3, THREE.Vector3] {
  const f = rampFrame(rp);
  const dir = new THREE.Vector3(f.down.x, 0, f.down.z).normalize();
  const a = new THREE.Vector3(f.foot.x, 0, f.foot.z).addScaledVector(dir, 0.3);
  return [a, a.clone().addScaledVector(dir, RUN_LEN)];
}

/** The built dominoes of a run, in order. */
function runBodies(app: App, e: Entity, built: BuiltScene | undefined = app.built) {
  const idx = app.doc.entities.indexOf(e);
  return (built?.bodies ?? []).filter((b) => b.entity === idx && b.kind === 0);
}

/**
 * Pose of the pyramid at the end of the run: in line with the last two
 * dominoes, its near end a third of a domino height past the last one, so the
 * last domino strikes it while still falling fast (further away it only comes
 * to lean on it).
 */
function pyramidSpot(app: App, rn: Entity, py: Entity, built?: BuiltScene): { pos: Vec3; yaw: number } | null {
  const bs = runBodies(app, rn, built);
  if (bs.length < 2) return null;
  const last = V(bs[bs.length - 1].pos), prev = V(bs[bs.length - 2].pos);
  const dir = last.clone().sub(prev).setY(0).normalize();
  const h = rn.params.size[1] as number;
  const half = (py.params.base * (py.params.brick[0] + py.params.gap)) / 2;
  const c = last.setY(0).addScaledVector(dir, 0.3 * h + half);
  return { pos: arr(c), yaw: r3((Math.atan2(-dir.z, dir.x) * 180) / Math.PI) };
}

const ballOnRamp = (app: App): 'none' | 'ok' | 'high' | 'low' | 'side' | 'big' => {
  const b = ball(app), rp = ramp(app);
  if (!b || !rp) return 'none';
  if (b.params.radius > 0.25) return 'big';
  const f = rampFrame(rp);
  const d = V(b.position).sub(f.c);
  const along = d.dot(f.down), up = d.dot(f.normal), across = d.dot(f.side);
  if (Math.abs(across) > f.W / 2) return 'side';
  if (along > -0.12 * f.L || along < -0.5 * f.L) return 'low';
  if (up < b.params.radius * 0.6) return 'low';
  if (up > b.params.radius + 0.45) return 'high';
  return 'ok';
};

function setBall(app: App, b: Entity, rp: Entity): void {
  b.params.radius = BALL_R;
  b.phys.density = 3;
  b.phys.friction = 0.5;
  b.position = arr(ballSpot(rp));
}

function setRun(rn: Entity, rp: Entity): void {
  const [a, b] = runSpots(rp);
  rn.position = arr(a);
  rn.rotation = [0, 0, 0];
  rn.params.points = [[0, 0, 0], arr(b.clone().sub(a))];
  rn.params.push = 0;
}

function setPyramid(app: App, py: Entity, rn: Entity): void {
  py.params.base = 5;
  py.params.brick = [0.15, 0.15, 0.15];
  py.params.gap = 0.005;
  py.params.mode = '2d';
  py.phys.density = 0.3;
  // the run may have just changed: lay it out again to find its last domino
  const s = pyramidSpot(app, rn, py, buildScene(app.doc, app.buildOptions()));
  if (s) { py.position = s.pos; py.rotation = [0, s.yaw, 0]; }
}

/** Puts every part of the build where it works, keeping the learner's ramp. */
export function repairMachine(app: App): void {
  app.pushUndo();
  let rp = ramp(app);
  if (!rp) { rp = createEntity('ramp', { position: [...RAMP_AT] }); app.doc.entities.push(rp); }
  let b = ball(app);
  if (!b) { b = createEntity('sphere', { name: 'Bille' }); app.doc.entities.push(b); }
  setBall(app, b, rp);
  let rn = run(app);
  if (!rn) { rn = createEntity('path', { name: 'Dominos', params: { fill: 'dominoes', points: [[0, 0, 0], [1, 0, 0]] } as any }); app.doc.entities.push(rn); }
  setRun(rn, rp);
  let py = pyramid(app);
  if (!py) { py = createEntity('pyramid'); app.doc.entities.push(py); }
  setPyramid(app, py, rn);
  app.commit('physics');
}

/** Places a new entity for the learner (no cursor placement). */
function add(app: App, e: Entity): Entity {
  e.name = app.uniqueName(e.name);
  app.insertEntities([e]);
  return e;
}

const camMoved = (c: TutCtx) => {
  const p = c.app.stage.camera.position;
  if (!c.mem.cam) c.mem.cam = p.clone();
  return p.distanceTo(c.mem.cam) > 0.4;
};

const poses = (app: App) => JSON.stringify(app.doc.entities.map((e) => [e.position, e.rotation]));

const kbd = (k: string) => `<span class="tut-kbd">${k}</span>`;

const MACHINE_SVG = `
<svg class="tut-svg" viewBox="0 0 300 92" aria-hidden="true">
  <line x1="6" y1="84" x2="294" y2="84" class="g"/>
  <path d="M20 40 L104 76 L104 84 M20 40 L20 84" class="s"/>
  <circle cx="36" cy="38" r="7" class="b"/>
  <path d="M38 26 q 26 4 46 26" class="a"/>
  ${[130, 148, 166, 184, 202].map((x) => `<rect x="${x}" y="62" width="4" height="22" rx="1" class="d"/>`).join('')}
  ${[[232, 0], [244, 0], [256, 0], [268, 0], [238, 1], [250, 1], [262, 1], [244, 2], [256, 2], [250, 3]].map(([x, l]) => `<rect x="${x}" y="${73 - l * 11}" width="11" height="10" rx="1.5" class="p"/>`).join('')}
  <text x="44" y="22">bille</text><text x="25" y="80">rampe</text><text x="150" y="54">dominos</text><text x="236" y="26">pyramide</text>
</svg>`;

// ------------------------------------------------------------------ steps

export const PARTS = ['Prendre l’application en main', 'Construire votre première machine'];

export const STEPS: Step[] = [
  // ============================================================ part 1
  {
    part: 0, title: 'Bienvenue dans Loop Lab', side: 'center',
    html: `<p>Loop Lab fabrique de courtes vidéos en boucle parfaite à partir d’une vraie simulation physique.</p>
      <ol class="tut-steps">
        <li><b>Composer</b> une scène avec des objets, des gadgets et des tracés.</li>
        <li><b>Calculer</b> (« bake ») : le moteur AVBD simule toute la durée du clip sur la carte graphique.</li>
        <li><b>Boucler</b> : une transition cache la jointure entre la fin et le début.</li>
        <li><b>Exporter</b> la boucle en MP4.</li>
      </ol>
      <p>La première partie fait le tour de l’interface sur une machine toute faite. Dans la seconde, vous construisez la vôtre. Comptez une quinzaine de minutes.</p>
      <p class="tut-note">Chaque étape attend une action de votre part et la reconnaît toute seule. Si vous êtes bloqué, « Faire pour moi » la réalise à votre place.</p>`,
  },
  {
    part: 0, title: 'Charger une scène', target: 'presets', side: 'bottom',
    html: `<p>Les <b>presets</b> sont des scènes prêtes à l’emploi : chutes de dominos, sablier, liquides, machines en chaîne… Tout y reste modifiable.</p>`,
    task: 'Ouvrez ✦ Presets et chargez « Catapult Machine ».',
    done: (c) => c.seen.has('doc') && c.app.doc.name === 'Catapult Machine',
    doIt: { label: 'Charger', run: (c) => c.app.loadPreset('catapult-machine') },
    success: 'Une machine en chaîne : un piston pousse des dominos, qui font basculer une catapulte, qui lance une balle dans un panier.',
  },
  {
    part: 0, title: 'Le calcul (bake)', target: 'timeline', side: 'top',
    html: `<p>Une scène n’est pas simulée en direct : Loop Lab calcule d’abord toutes les images du clip, c’est le <b>bake</b>. La barre de la frise se remplit à mesure, et la pastille en haut à gauche indique <b>BAKING</b>.</p>
      <p>Avec <b>auto-bake</b> coché, chaque modification de la physique relance le calcul. Une fois le bake fini, on peut rejouer et parcourir le clip instantanément.</p>`,
    task: 'Attendez la fin du calcul (ou cliquez sur Bake).',
    done: (c) => !!c.app.result && !c.app.baking,
    hint: (c) => (c.app.baking ? `Calcul en cours : ${Math.round((c.app.bakeProgress.frame / Math.max(1, c.app.bakeProgress.total)) * 100)} %` : null),
    doIt: { label: 'Lancer le bake', run: (c) => void c.app.bake(), show: (c) => !c.app.baking },
  },
  {
    part: 0, title: 'Lire et parcourir', target: 'timeline', side: 'top',
    html: `<p>${kbd('Espace')} ou ▶ lance et arrête la lecture. Cliquer-glisser sur la frise déplace la tête de lecture ; ${kbd('←')} ${kbd('→')} avancent image par image.</p>
      <p>Sur la frise : la zone hachurée en fin de clip est la <b>transition de boucle</b> (ici REWIND : le clip repart à l’envers). Les petits traits blancs marquent l’instant où chaque pièce de la machine se met en mouvement.</p>`,
    task: 'Lancez la lecture, puis faites glisser la tête de lecture sur la frise.',
    tick: (c) => {
      const a = c.app;
      if (a.mode === 'play' && a.playing) c.mem.played = true;
      if (a.mode === 'play' && !a.playing) {
        if (c.mem.lastT !== undefined && Math.abs(a.time - c.mem.lastT) > 0.05) c.mem.scrubbed = true;
        c.mem.lastT = a.time;
      } else c.mem.lastT = undefined;
    },
    done: (c) => !!c.mem.played && !!c.mem.scrubbed,
    hint: (c) => (c.mem.played && !c.mem.scrubbed ? 'Reste à faire glisser la tête de lecture.' : !c.mem.played && c.mem.scrubbed ? 'Reste à lancer la lecture (Espace).' : null),
    doIt: { label: 'Lire', run: (c) => { c.mem.scrubbed = true; c.mem.played = true; c.app.seek(0); if (!c.app.playing) c.app.togglePlay(); } },
  },
  {
    part: 0, title: 'La caméra', target: 'cam', side: 'left',
    html: `<p>Pendant la lecture, la vue suit la caméra <b>🎬 Shot</b> : c’est le cadrage de la vidéo exportée, avec son mouvement éventuel (onglet Camera).</p>
      <p>La caméra <b>Free</b> sert à regarder ailleurs sans toucher au cadrage : glisser pour tourner, clic droit (ou deux doigts) pour décaler, molette pour zoomer.</p>`,
    task: 'Passez en caméra Free et tournez autour de la machine.',
    done: (c) => c.app.freeCamera && camMoved(c),
    tick: (c) => { if (!c.app.freeCamera) c.mem.cam = null; },
    doIt: {
      label: 'Faire tourner', run: (c) => {
        c.app.freeCamera = true;
        c.app.emit('gizmo');
        const cam = c.app.stage.camera, t = c.app.orbit.target;
        c.mem.cam = cam.position.clone();
        cam.position.sub(t).applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.6).add(t);
      },
    },
    success: 'Pour revenir au cadrage de la vidéo, cliquez sur 🎬 Shot.',
  },
  {
    part: 0, title: 'Sélectionner un objet', target: 'outliner', side: 'right',
    enter: (c) => { if (c.app.freeCamera) { c.app.freeCamera = false; c.app.applyCameraFromDoc(); c.app.emit('gizmo'); } },
    html: `<p>La liste <b>Scene</b> contient tous les objets ; le nombre à droite est le nombre de corps simulés. On peut aussi cliquer un objet directement dans la vue (re-cliquer au même endroit passe à l’objet situé derrière).</p>
      <p>Sélectionner un objet arrête la lecture et repasse en mode <b>EDIT</b> : la scène reprend sa pose de départ.</p>`,
    task: 'Sélectionnez « Catapult » dans la liste ou dans la vue.',
    done: (c) => c.app.selectedEntity?.name === 'Catapult',
    doIt: { label: 'Sélectionner', run: (c) => { const e = first(c.app, (x) => x.name === 'Catapult'); if (e) c.app.select(e.id); } },
  },
  {
    part: 0, title: 'Régler un objet', target: 'tabbody', side: 'left',
    enter: (c) => c.ui.setTab('Object'),
    html: `<p>L’onglet <b>Object</b> regroupe tout ce qui définit l’objet sélectionné : sa position (<i>Transform</i>), les réglages propres au gadget, son apparence (<i>Look</i>) et sa physique (<i>Physics</i> : masse volumique, frottement, vitesse initiale…).</p>
      <p>Laissez la souris sur un réglage pour afficher une bulle d’aide.</p>`,
    task: 'Dans le dossier « Seesaw », changez « Load size » (la taille de la balle) ou « Axle position ».',
    done: (c) => c.seen.has('physics'),
    success: `Le calcul repart aussitôt : c’est l’auto-bake. ${kbd('⌘Z')} annule une modification, ${kbd('⇧⌘Z')} la rétablit.`,
    doIt: { label: 'Modifier', run: (c) => { const e = c.app.selectedEntity ?? first(c.app, (x) => x.name === 'Catapult'); if (e) { e.params.loadSize = 0.2; c.app.commit('physics'); } } },
  },
  {
    part: 0, title: 'Le gizmo', target: 'view', side: 'left',
    html: `<p>Dans la vue, l’objet sélectionné porte un <b>gizmo</b> : les flèches le déplacent, les anneaux le font tourner. Maintenir ${kbd('⇧')} aligne sur une grille (0,25 m, 15°).</p>
      <p>${kbd('Q')} déplacer + tourner · ${kbd('W')} déplacer seulement · ${kbd('E')} tourner seulement · ${kbd('F')} cadrer la sélection · ${kbd('Suppr')} effacer · ${kbd('⌘D')} dupliquer.</p>`,
    task: 'Déplacez un objet avec une flèche du gizmo, puis annulez avec ⌘Z.',
    enter: (c) => { c.mem.poses = poses(c.app); },
    on: (c, what) => {
      if ((what === 'transform' || what === 'physics') && poses(c.app) !== c.mem.poses) c.mem.moved = true;
      else if (what === 'doc' && c.mem.moved) c.mem.undone = true;
    },
    done: (c) => !!c.mem.undone,
    hint: (c) => (!c.app.selectedEntity ? 'Sélectionnez d’abord un objet.' : c.mem.moved ? 'Bien. Maintenant ⌘Z pour annuler le déplacement.' : null),
  },
  {
    part: 0, title: 'Vérifier la machine', target: 'tab-Machine', side: 'left',
    html: `<p>Après chaque bake, l’onglet <b>Machine</b> analyse la simulation : quels objets se sont mis en mouvement, à quel instant, et où une chaîne s’est arrêtée. Cliquer une ligne amène la lecture à ce moment.</p>
      <p><b>Test ×5</b> recalcule la scène cinq fois en décalant les pièces de moins d’un millimètre : une machine qui ne marche qu’au millimètre près y est démasquée.</p>`,
    task: 'Ouvrez l’onglet Machine.',
    done: (c) => c.ui.tab() === 'Machine',
    doIt: { label: 'Ouvrir', run: (c) => c.ui.setTab('Machine') },
    success: '⚑ marque une pièce qui doit bouger ; cliquez-le pour la déclarer décor. Un capteur (Sensor, catégorie Testing) vérifie qu’un objet atteint sa cible.',
  },
  {
    part: 0, title: 'Les autres onglets', target: 'tabs', side: 'left',
    html: `<ul class="tut-list">
        <li><b>Scene</b> : durée du clip, transition de boucle, gravité et réglages du solveur AVBD.</li>
        <li><b>Look</b> : palette, sol, lumière, effets (flou de profondeur, bloom, grain), format d’image.</li>
        <li><b>Camera</b> : mouvement de caméra périodique (orbite, balancement…) qui boucle avec le clip.</li>
      </ul>
      <p>Vous les utiliserez tous dans la seconde partie.</p>`,
  },

  // ============================================================ part 2
  {
    part: 1, title: 'Votre machine', side: 'center',
    html: `<p>Vous allez construire une petite réaction en chaîne :</p>${MACHINE_SVG}
      <p>Une bille dévale une rampe, renverse une file de dominos, et le dernier domino fait s’écrouler une pyramide de cubes. Vous allez poser des gadgets, tracer une file, régler des paramètres, puis vérifier, habiller et exporter la boucle.</p>`,
  },
  {
    part: 1, title: 'Un établi vide', edit: true, target: 'presets', side: 'bottom',
    html: `<p>Le preset <b>Machine Workshop</b> est une scène vide préparée pour les machines : caméra de face, format 16:9, transition <i>boomerang</i>.</p>`,
    task: 'Ouvrez ✦ Presets et chargez « Machine Workshop ».',
    done: (c) => c.seen.has('doc') && c.app.doc.name === 'Machine workshop',
    doIt: { label: 'Charger', run: (c) => c.app.loadPreset('workshop') },
  },
  {
    part: 1, title: 'Poser une rampe', edit: true, target: 'add-ramp', side: 'right',
    html: `<p>La palette <b>Add</b> contient les objets, classés par catégorie. Un objet ajouté suit le curseur au-dessus de la scène ; un clic le pose (${kbd('⇧')} : sur la grille, clic droit ou ${kbd('Échap')} : annuler).</p>`,
    task: 'Cliquez sur « Ramp » (Gadgets), puis posez-la sur la marque, à gauche.',
    marks: () => [{ p: [RAMP_AT[0], 0, 0], label: 'rampe' }],
    done: (c) => !!ramp(c.app) && !placing(c.app),
    hint: (c) => (placing(c.app) ? 'Cliquez dans la vue pour la poser.' : null),
    doIt: { label: 'Poser', run: (c) => { add(c.app, createEntity('ramp', { position: [...RAMP_AT] })); } },
    fix: {
      label: 'Ajuster sur la marque',
      show: (c) => { const r = ramp(c.app); return !!r && (Math.hypot(r.position[0] - RAMP_AT[0], r.position[2]) > 0.05 || r.rotation.some((x) => x !== 0)); },
      run: (c) => { const r = ramp(c.app); if (r) { c.app.pushUndo(); r.position = [...RAMP_AT]; r.rotation = [0, 0, 0]; c.app.commit('physics'); } },
    },
    success: 'La rampe descend vers la droite (+x). Sa pente, sa longueur et ses rebords se règlent dans l’onglet Object.',
  },
  {
    part: 1, title: 'Ajouter la bille', edit: true, target: 'add-sphere', side: 'right',
    html: `<p>Un objet posé au-dessus d’un autre se dépose sur sa surface : la bille peut aller directement sur la rampe.</p>`,
    task: 'Ajoutez une « Sphere » (Primitives) et posez-la en haut de la rampe.',
    marks: (c) => { const r = ramp(c.app); return r ? [{ p: arr(ballSpot(r, 0)), label: 'bille' }] : []; },
    done: (c) => !!ball(c.app) && !placing(c.app),
    hint: (c) => (placing(c.app) ? 'Cliquez sur le haut de la rampe pour la poser.' : null),
    doIt: {
      label: 'Poser', run: (c) => {
        const r = ramp(c.app);
        add(c.app, createEntity('sphere', { position: r ? arr(ballSpot(r, 0.5)) : [-2.8, 1.2, 0] }));
      },
    },
    success: 'Elle est énorme : une sphère neuve mesure 1 m de diamètre. On la règle à l’étape suivante.',
  },
  {
    part: 1, title: 'Régler la bille', target: 'tabbody', side: 'left',
    enter: (c) => { c.ui.setTab('Object'); const b = ball(c.app); if (b && c.app.selection !== b.id) c.app.select(b.id); },
    html: `<p>Une bille plus petite roule dans la rampe, entre ses rebords ; plus dense, elle emporte les dominos au lieu de rebondir dessus.</p>
      <ul class="tut-list"><li>Dossier <b>Sphere</b> : <i>Radius</i> = <b>0.12</b></li><li>Dossier <b>Physics</b> : <i>Density</i> = <b>3</b></li></ul>
      <p class="tut-note">Dans un champ numérique, on peut taper la valeur ou glisser horizontalement sur le champ.</p>`,
    task: 'Réglez le rayon (≤ 0,2) et la masse volumique (≥ 2) de la sphère.',
    done: (c) => { const b = ball(c.app); return !!b && b.params.radius <= 0.2 && b.phys.density >= 2; },
    hint: (c) => { const b = ball(c.app); if (!b) return 'La sphère a disparu : revenez à l’étape précédente.'; return b.params.radius > 0.2 ? 'Le rayon est encore trop grand.' : b.phys.density < 2 ? 'Reste la masse volumique (Physics → Density).' : null; },
    doIt: { label: 'Régler', run: (c) => { const b = ball(c.app); if (b) { b.params.radius = BALL_R; b.phys.density = 3; c.app.commit('physics'); } } },
  },
  {
    part: 1, title: 'Placer la bille', edit: true, target: 'view', side: 'left',
    enter: (c) => { const b = ball(c.app); if (b && c.app.selection !== b.id) c.app.select(b.id); },
    html: `<p>En rapetissant, la bille est restée en l’air. Remettez-la en haut de la rampe :</p>
      <ul class="tut-list"><li>les flèches du gizmo la déplacent (${kbd('⇧')} pour aligner sur la grille) ;</li>
      <li>${kbd('Fin')} (ou ⤓ dans la barre d’outils) la laisse tomber sur ce qui se trouve dessous ;</li>
      <li>${kbd('F')} cadre la sélection si elle est petite à l’écran.</li></ul>`,
    task: 'Amenez la bille sur la marque, posée sur la rampe.',
    marks: (c) => { const r = ramp(c.app); return r ? [{ p: arr(ballSpot(r)), label: 'ici' }] : []; },
    done: (c) => ballOnRamp(c.app) === 'ok',
    hint: (c) => ({ none: 'Il faut une rampe et une sphère.', big: 'La sphère est encore trop grosse.', side: 'Elle n’est pas dans l’axe de la rampe (flèche bleue).', low: 'Elle doit être sur la moitié haute de la rampe.', high: 'Elle est trop haute : appuyez sur Fin pour la poser.', ok: null } as Record<string, string | null>)[ballOnRamp(c.app)],
    doIt: { label: 'Placer', run: (c) => { const b = ball(c.app), r = ramp(c.app); if (b && r) { c.app.pushUndo(); setBall(c.app, b, r); c.app.commit('physics'); } } },
  },
  {
    part: 1, title: 'Tracer les dominos', edit: true, target: 'draw', side: 'bottom',
    enter: (c) => c.app.select(null),
    html: `<p>L’outil <b>✎ Draw</b> (${kbd('D')}) remplit un tracé à main levée : file de dominos, rangée de billes ou de blocs, rail, piste, muret. Le menu à côté choisit le remplissage.</p>`,
    task: 'Choisissez ✎ Draw avec « Domino run », puis tracez au sol de la marque A à la marque B.',
    marks: (c) => { const r = ramp(c.app); if (!r) return []; const [a, b] = runSpots(r); return [{ p: arr(a), label: 'A' }, { p: arr(b), label: 'B' }]; },
    done: (c) => { const rn = run(c.app); return !!rn && runBodies(c.app, rn).length >= 4; },
    hint: (c) => (c.app.tools.tool === 'draw' ? (c.app.tools.drawFill === 'dominoes' ? 'Cliquez sur A et glissez jusqu’à B.' : 'Choisissez « Domino run » dans le menu à côté de ✎ Draw.') : null),
    doIt: {
      label: 'Tracer', run: (c) => {
        const r = ramp(c.app);
        const rn = createEntity('path', { name: 'Domino run', params: { ...createEntity('path').params, fill: 'dominoes' } });
        if (r) setRun(rn, r);
        rn.params.push = 12;
        add(c.app, rn);
      },
    },
    fix: {
      label: 'Redresser le tracé',
      show: (c) => { const rn = run(c.app), r = ramp(c.app); if (!rn || !r) return false; const [a] = runSpots(r); return V(rn.position).distanceTo(a) > 0.3; },
      run: (c) => { const rn = run(c.app), r = ramp(c.app); if (rn && r) { c.app.pushUndo(); const push = rn.params.push; setRun(rn, r); rn.params.push = push; c.app.commit('physics'); } },
    },
    success: 'Sélectionné, un tracé montre ses points de contrôle : cliquez un point bleu pour le déplacer, Suppr pour l’enlever. Le point vert est le départ.',
  },
  {
    part: 1, title: 'Qui pousse le premier domino ?', target: 'tabbody', side: 'left',
    enter: (c) => { c.ui.setTab('Object'); const rn = run(c.app); if (rn && c.app.selection !== rn.id) c.app.select(rn.id); },
    html: `<p>Un tracé de dominos penche son premier domino de quelques degrés (<i>Push</i>) pour que la chaîne parte toute seule. Ici, c’est la bille qui doit la déclencher.</p>`,
    task: 'Dans le dossier « Drawn path », mettez « Push (deg tilt) » à 0.',
    done: (c) => { const rn = run(c.app); return !!rn && rn.params.push === 0; },
    doIt: { label: 'Régler', run: (c) => { const rn = run(c.app); if (rn) { rn.params.push = 0; c.app.commit('physics'); } } },
  },
  {
    part: 1, title: 'Ajouter la pyramide', edit: true, target: 'add-pyramid', side: 'right',
    enter: (c) => c.app.select(null),
    html: `<p>Les <b>Structures</b> sont des empilements prêts à tomber : mur de briques, pyramide, tour, grille de blocs.</p>`,
    task: 'Ajoutez une « Pyramid » et posez-la au bout de la file (marque C).',
    marks: (c) => {
      const rn = run(c.app);
      if (!rn) return [];
      const s = pyramidSpot(c.app, rn, { params: { base: 5, brick: [0.15, 0.15, 0.15], gap: 0.005 } } as any);
      return s ? [{ p: s.pos, label: 'C' }] : [];
    },
    done: (c) => !!pyramid(c.app) && !placing(c.app),
    hint: (c) => (placing(c.app) ? 'Cliquez au bout de la file pour la poser.' : null),
    doIt: { label: 'Poser', run: (c) => { const rn = run(c.app); const py = createEntity('pyramid'); if (rn) setPyramid(c.app, py, rn); add(c.app, py); } },
    success: 'Avec ses réglages d’origine elle est gigantesque (12 blocs de 50 cm à la base). On la réduit à l’étape suivante.',
  },
  {
    part: 1, title: 'Régler la pyramide', target: 'tabbody', side: 'left',
    enter: (c) => { c.ui.setTab('Object'); const py = pyramid(c.app); if (py && c.app.selection !== py.id) c.app.select(py.id); },
    html: `<p>Dans le dossier <b>Pyramid</b> :</p>
      <ul class="tut-list"><li><i>Base count</i> = <b>5</b> (blocs à la base)</li><li><i>Block</i> = <b>0.15</b> sur x, y et z</li></ul>
      <p>Puis dans <b>Physics</b>, <i>Density</i> = <b>0.3</b> : un domino ne renverse pas des blocs plus lourds que lui, il reste appuyé contre eux.</p>`,
    task: 'Réduisez la pyramide (base ≤ 7, blocs ≤ 0,25 m) et allégez-la (densité ≤ 0,5).',
    done: (c) => { const py = pyramid(c.app); return !!py && py.params.base <= 7 && Math.max(...(py.params.brick as number[])) <= 0.25 && py.phys.density <= 0.5; },
    hint: (c) => { const py = pyramid(c.app); if (!py) return 'La pyramide a disparu : revenez à l’étape précédente.'; return py.params.base > 7 || Math.max(...(py.params.brick as number[])) > 0.25 ? null : py.phys.density > 0.5 ? 'Reste la densité (Physics → Density).' : null; },
    doIt: { label: 'Régler', run: (c) => { const py = pyramid(c.app); if (py) { py.params.base = 5; py.params.brick = [0.15, 0.15, 0.15]; py.phys.density = 0.3; c.app.commit('physics'); } } },
    fix: {
      label: 'Coller au bout de la file',
      show: (c) => {
        const py = pyramid(c.app), rn = run(c.app);
        if (!py || !rn) return false;
        const s = pyramidSpot(c.app, rn, py);
        const turn = Math.abs((((s?.yaw ?? 0) - py.rotation[1]) % 360 + 540) % 360 - 180);
        return !!s && (Math.hypot(s.pos[0] - py.position[0], s.pos[2] - py.position[2]) > 0.08 || turn > 8);
      },
      run: (c) => { const py = pyramid(c.app), rn = run(c.app); if (py && rn) { c.app.pushUndo(); const s = pyramidSpot(c.app, rn, py); if (s) { py.position = s.pos; py.rotation = [0, s.yaw, 0]; } c.app.commit('physics'); } },
    },
    success: 'Le dernier domino doit tomber sur la pyramide : si elle est trop loin, « Coller au bout de la file » la place à la bonne distance.',
  },
  {
    part: 1, title: 'Regarder la machine', target: 'timeline', side: 'top',
    enter: (c) => c.app.select(null),
    html: `<p>Le bake s’est relancé à chaque changement. Lancez la lecture pour voir la machine fonctionner — ou échouer : c’est normal, une machine se met au point.</p>`,
    task: 'Lancez la lecture (Espace).',
    tick: (c) => { if (c.app.mode === 'play' && c.app.playing) c.mem.played = true; },
    done: (c) => !!c.mem.played,
    doIt: { label: 'Lire', run: (c) => { c.mem.played = true; c.app.seek(0); if (!c.app.playing) c.app.togglePlay(); } },
  },
  {
    part: 1, title: 'Le diagnostic', target: (c) => (c.ui.tab() === 'Machine' ? 'tabbody' : 'tab-Machine'), side: 'left',
    html: (c) => {
      const r = c.app.report;
      const base = `<p>L’onglet <b>Machine</b> suit la chaîne : la bille, puis chaque domino, puis la pyramide. Une file de dominos ne compte comme réussie que si elle tombe jusqu’au dernier.</p>`;
      if (c.ui.tab() !== 'Machine' || !r || c.app.reportStale) return base;
      if (r.ok) return `${base}<p class="tut-ok">Toute la chaîne fonctionne.</p>`;
      return `${base}<p class="tut-bad">Une étape échoue :</p><ul class="tut-list">${r.issues.filter((x) => x.level === 'bad').map((x) => `<li>${x.text}</li>`).join('')}</ul>
        <p>Cliquez la ligne en rouge pour voir l’instant où la chaîne s’arrête, corrigez (position, taille, pente de la rampe…), et le bake repart. Ou laissez le tutoriel replacer les pièces.</p>`;
    },
    task: 'Obtenez le verdict « The machine runs end to end ».',
    enter: (c) => c.ui.setTab('Machine'),
    done: (c) => c.ui.tab() === 'Machine' && !!c.app.report && !c.app.reportStale && c.app.report.ok && !c.app.baking,
    hint: (c) => (c.app.baking || c.app.analyzing ? 'Calcul en cours…' : null),
    doIt: { label: 'Replacer les pièces', run: (c) => { repairMachine(c.app); c.ui.setTab('Machine'); } },
  },
  {
    part: 1, title: 'Fiabilité', target: 'tabbody', side: 'left',
    enter: (c) => c.ui.setTab('Machine'),
    html: `<p>Une simulation est sensible aux détails : un domino décalé d’un cheveu peut tomber de travers. <b>Test ×5</b> refait le calcul cinq fois en bougeant chaque pièce de moins d’un millimètre et note, pour chaque étape, combien de fois elle a fonctionné.</p>
      <p><b>Bake until it works</b> recommence jusqu’à obtenir un essai réussi, et garde ce calcul-là pour l’export.</p>`,
    task: 'Cliquez sur « Test ×5 » et attendez le résultat.',
    done: (c) => !!c.app.trials && !c.app.trials.running && c.app.trials.done >= c.app.trials.total,
    hint: (c) => (c.app.trials?.running ? `Essai ${Math.min(c.app.trials.done + 1, c.app.trials.total)} sur ${c.app.trials.total}…` : null),
    doIt: { label: 'Lancer', run: (c) => void c.app.runTrials(5, false), show: (c) => !c.app.trials?.running },
  },
  {
    part: 1, title: 'La boucle', target: 'tabbody', side: 'left',
    enter: (c) => c.ui.setTab('Scene'),
    html: `<p>Dans <b>Scene → Clip</b>, la durée du clip. La chaîne dure environ 4 s : un clip de 14 s passerait l’essentiel à attendre.</p>
      <p><b>Loop → Transition</b> choisit comment la fin rejoint le début : <i>boomerang</i> rejoue la scène à l’envers, <i>reassemble</i> ramène chaque pièce à sa place, <i>shrink</i> et <i>sink</i> font disparaître puis réapparaître les objets, <i>continuous</i> raccorde une scène qui tourne en régime permanent.</p>`,
    task: 'Réglez « Duration (s) » sur 8 s ou moins.',
    done: (c) => c.app.doc.duration <= 8,
    doIt: { label: 'Régler', run: (c) => { c.app.doc.duration = 7; c.app.commit('physics'); c.ui.setTab('Scene'); } },
    success: 'Avec boomerang, « Rewind speed » règle la vitesse du retour en arrière et « Apex slow-down » le ralenti au point de bascule.',
  },
  {
    part: 1, title: 'L’habillage', target: 'tabbody', side: 'left',
    enter: (c) => { c.ui.setTab('Look'); c.mem.pal = c.app.doc.render.palette; },
    html: `<p>L’onglet <b>Look</b> ne touche pas à la physique : pas de nouveau calcul. La <b>palette</b> colore tous les objets qui ne sont pas en couleur fixe (les dominos en dégradé, par exemple). Plus bas : lumière, ombres, occlusion ambiante, bloom, profondeur de champ.</p>`,
    task: 'Choisissez une autre palette.',
    done: (c) => c.app.doc.render.palette !== c.mem.pal,
    doIt: { label: 'Changer', run: (c) => { c.app.doc.render.palette = c.app.doc.render.palette === 'sorbet' ? 'ocean' : 'sorbet'; c.app.commit('visual'); c.ui.setTab('Look'); } },
    success: 'Chaque objet a aussi son propre réglage d’apparence dans Object → Look : mode de couleur et finition (brillant, métal, verre, néon…).',
  },
  {
    part: 1, title: 'Le cadrage', target: 'tabbody', side: 'left',
    enter: (c) => { c.ui.setTab('Camera'); if (c.app.freeCamera) { c.app.freeCamera = false; c.app.emit('gizmo'); } },
    html: `<p>En caméra <b>🎬 Shot</b> et en mode EDIT, tourner dans la vue règle directement le cadrage exporté. L’onglet <b>Camera</b> ajoute un mouvement : <i>orbit</i> fait des tours complets, <i>sway</i> balance doucement, <i>dolly</i> avance et recule, <i>crane</i> monte et descend. Tous sont périodiques, la boucle reste parfaite.</p>`,
    task: 'Choisissez un mouvement de caméra (Motion), par exemple « sway ».',
    done: (c) => c.app.doc.camera.motion !== 'static',
    doIt: { label: 'Choisir', run: (c) => { const k = c.app.doc.camera; k.motion = 'sway'; k.amount = Math.max(k.amount, 6); c.app.commit('camera'); c.ui.setTab('Camera'); } },
    success: '« Amount » règle l’amplitude du mouvement. Lancez la lecture pour le voir.',
  },
  {
    part: 1, title: 'Exporter et partager', target: 'export', side: 'bottom',
    html: `<ul class="tut-list">
        <li><b>⬇ Export MP4</b> : rendu image par image de la simulation calculée, en 720p à 4K, à jouer en boucle.</li>
        <li><b>PNG</b> : une image de la vue.</li>
        <li><b>Save</b> / <b>Open</b> : la scène en fichier JSON.</li>
        <li><b>Share</b> : copie un lien qui contient toute la scène.</li>
      </ul>
      <p>Pour réutiliser une partie de machine : sélectionnez plusieurs objets (${kbd('⇧')}-clic), puis <b>Save as gadget…</b> dans l’onglet Object. Elle apparaît dans <i>My gadgets</i>, en bas de la palette.</p>`,
  },
  {
    part: 1, title: 'Bravo !', side: 'center',
    html: `<p>Vous savez composer une scène, la calculer, la vérifier, l’habiller et l’exporter.</p>
      <p><b>Pour aller plus loin</b></p>
      <ul class="tut-list">
        <li><b>Plan de travail</b> (${kbd('P')}) : XY pose et trace dans une tranche verticale face à la caméra — idéal pour une machine en hauteur, avec des rails tracés.</li>
        <li><b>Groupes</b> (${kbd('⌘G')}) et <b>Repeat…</b> : déplacer plusieurs pièces ensemble, répéter une pièce en ligne ou en cercle.</li>
        <li><b>Presets</b> : <i>Marble Run</i> et <i>Catapult Machine</i> pour des machines plus longues ; <i>Dam Break</i> ou <i>Paddle Wheel</i> pour les liquides.</li>
        <li><b>? Comment ça marche</b> : le cours qui explique ce que fait le moteur physique à chaque image.</li>
      </ul>`,
    fix: { label: 'Ouvrir le cours', run: (c) => c.ui.openCourse() },
  },
];
