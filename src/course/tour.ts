// The guided tour: one timeline of chapters, captions, diagrams, questions and
// hands-on pauses. Everything is a function of time, so the learner can scrub
// anywhere. Scene changes and solver settings are discrete events: unlike a
// shader uniform, they cost a re-bake, so they are applied when crossed rather
// than interpolated.

import type { SceneDoc } from '../scene/doc';
import type { SceneKey } from './scenes';

// ---------------------------------------------------------------- the state

/**
 * Live values shared by the diagrams and (for the keys listed in DOC_KEYS) by
 * the 3D scene. A hands-on pause writes into a copy of this.
 */
export type Vals = Record<string, number>;

export const DEFAULT_VALS: Vals = {
  // integration
  h: 1 / 60, substeps: 4, iterations: 10, gravity: 9.81, drag: 0, steps: 12,
  // solver
  solver: 3, // 0 none, 1 pgs, 2 penalty, 3 avbd
  beta: 1e6, kPenalty: 2e4, gamma: 0.99, alpha: 0.95, friction: 0.5, bias: 0.2,
  // GPU
  colors: 8, bodies: 1000,
  // diagram-only knobs
  frame: 0, slow: 0, zoom: 1, showForces: 1, showContacts: 1,
  // foundation chapters
  pulse: 0.2, stiff: 0.8, cond: 4,
};

/**
 * How a value reaches the 3D document. Keys absent here are diagram-only —
 * and several names deliberately stay out: both engines ramp the penalty by
 * β·|C|, but with very different scales (≈ 1e6 here, ≈ 1e4 on the GPU), and
 * `alpha` and `gamma` are tuned per engine. Writing one into the other
 * silently destroys the 3D scene.
 */
export const DOC_KEYS: Record<string, (d: SceneDoc, v: number) => void> = {
  substeps: (d, v) => { d.physics.substeps = Math.max(1, Math.round(v)); },
  iterations: (d, v) => { d.physics.iterations = Math.max(1, Math.round(v)); },
  gravity: (d, v) => { d.physics.gravity = v; },
  friction: (d, v) => { d.physics.friction = v; },
  drag: (d, v) => { d.physics.drag = v; },
  colors: (d, v) => { d.physics.colors = Math.max(2, Math.round(v)); },
  timeScale: (d, v) => { d.physics.timeScale = v; },
};

// ---------------------------------------------------------------- the model

export interface Caption {
  t: number;
  kicker: string;
  title: string;
  text: string;
  /** plain-language aside for beginners */
  note: string;
  /** code shown under the text; {{key|min|max|step}} becomes a draggable value */
  code: string;
  /** live read-out computed from the current values */
  hud: ((v: Vals) => string) | null;
  /** how many of the LAYERS are lit */
  layers: number;
}

export interface DiagSpec { t0: number; t1: number; name: string; arg?: string; big?: boolean }
export interface Chapter { t: number; title: string; part: string; module: number }
export interface SceneEvent { t: number; key: SceneKey; patch?: Partial<Vals> }

export interface Control {
  type: 'range' | 'toggle' | 'choice';
  key: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  fmt?: (v: number) => string;
  /** toggle */
  on?: number;
  off?: number;
  /** choice */
  options?: { label: string; value: number }[];
  help?: string;
}

export interface Goal { label: string; test(x: { v: Vals; ptr: { x: number; y: number } | null; hits: Set<string> }): boolean }

export interface Stop {
  t: number;
  until: number;
  kind: 'try' | 'quiz' | 'card';
  id: string;
  title: string;
  prompt?: string;
  controls: Control[];
  goals?: Goal[];
  seq?: boolean;
  /** the diagram reacts to the pointer */
  diag?: boolean;
  quiz?: { question: string; choices: string[]; answer: number; explain: string };
  /** module card: from (just finished, −1 at the start) → to (next, null at the end) */
  from?: number;
  to?: number | null;
  visited?: boolean;
  reached?: boolean[];
  ov: Vals;
}

/** The pipeline of a physics step, lit progressively in the chapter badges. */
export const LAYERS = ['Prédiction', 'Détection', 'Contraintes', 'Itérations', 'λ et β', 'Vitesses', 'Parallèle'];

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export class Tour {
  t = 0;
  playing = true;
  pauses = true;
  stop: Stop | null = null;
  /** seconds spent inside pauses — diagrams keep animating */
  extra = 0;
  ptr: { x: number; y: number } | null = null;
  /** things the learner clicked on a diagram (used by missions) */
  hits = new Set<string>();

  caps: Caption[] = [];
  diags: DiagSpec[] = [];
  chapters: Chapter[] = [];
  stops: Stop[] = [];
  scenes: SceneEvent[] = [];
  /** discrete value changes applied when crossed */
  sets: { t: number; patch: Partial<Vals> }[] = [];
  modules: { id: string; title: string; bonus?: boolean; chapters: number[]; t0: number; t1: number }[] = [];
  duration = 0;

  constructor(private moduleDefs: { id: string; title: string; parts: string[]; bonus?: boolean }[]) {
    this.build();
    this.index();
  }

  private moduleOfPart(part: string): number {
    const i = this.moduleDefs.findIndex((m) => m.parts.includes(part));
    return i < 0 ? 0 : i;
  }

  private index(): void {
    this.duration = this.chapters.length ? this.lastT : 1;
    this.modules = this.moduleDefs.map((m, i) => {
      const chs = this.chapters.map((c, k) => ({ c, k })).filter(({ c }) => c.module === i).map(({ k }) => k);
      const t0 = chs.length ? this.chapters[chs[0]].t : 0;
      const last = chs.length ? chs[chs.length - 1] : 0;
      const t1 = last + 1 < this.chapters.length ? this.chapters[last + 1].t : this.duration;
      return { id: m.id, title: m.title, bonus: m.bonus, chapters: chs, t0, t1 };
    });
  }

  private lastT = 0;

  // ------------------------------------------------------------- evaluation

  /** Values in force at time t (base + the pause the learner is in). */
  eval(t: number): Vals {
    const v: Vals = { ...DEFAULT_VALS };
    for (const s of this.sets) { if (t < s.t) break; Object.assign(v, s.patch); }
    for (const st of this.stops) {
      if (st.kind !== 'try') continue;
      const w = this.stopWeight(st, t);
      if (w <= 0) continue;
      Object.assign(v, st.ov);
    }
    return v;
  }

  /** A pause's settings hold until `until`, then the tour takes over again. */
  private stopWeight(st: Stop, t: number): number {
    if (st === this.stop) return 1;
    if (!st.visited || t < st.t) return 0;
    return t <= st.until ? 1 : 0;
  }

  /** Values the 3D scene should run with at time t. */
  docVals(t: number): Vals {
    const v = this.eval(t);
    const out: Vals = {};
    for (const k of Object.keys(DOC_KEYS)) if (k in v) out[k] = v[k];
    return out;
  }

  sceneAt(t: number): SceneEvent | null {
    let cur: SceneEvent | null = null;
    for (const s of this.scenes) { if (t < s.t) break; cur = s; }
    return cur;
  }

  chapterAt(t: number): number {
    let i = 0;
    for (let j = 0; j < this.chapters.length; j++) if (t >= this.chapters[j].t) i = j;
    return i;
  }

  capAt(t: number): number {
    let i = 0;
    for (let j = 0; j < this.caps.length; j++) if (t >= this.caps[j].t) i = j;
    return i;
  }

  diagAt(t: number): DiagSpec | null {
    return this.diags.find((d) => t >= d.t0 && t < d.t1) ?? null;
  }

  enterStop(st: Stop): void {
    const v = this.eval(st.t);
    st.ov = {};
    for (const c of st.controls) st.ov[c.key] = v[c.key] ?? 0;
    st.visited = true;
    st.reached ||= st.goals?.map(() => false);
    this.stop = st;
    this.playing = false;
    this.ptr = null;
    this.hits = new Set();
  }

  resume(): void {
    if (!this.stop) return;
    this.stop = null;
    this.ptr = null;
    this.playing = true;
  }

  resetStops(t: number): void {
    this.stop = null;
    this.ptr = null;
    this.extra = 0;
    for (const st of this.stops) if (st.t >= t - 1e-3) { st.visited = false; st.ov = {}; st.reached = undefined; }
  }

  stopBetween(t0: number, t1: number): Stop | null {
    return this.stops.find((st) => !st.visited && (this.pauses || st.kind === 'card') && st.t > t0 && st.t <= t1) ?? null;
  }

  // ---------------------------------------------------------------- content

  private build(): void {
    // Each chapter has its own clock: times below are relative to the start of
    // the chapter, so inserting one does not shift every following timestamp.
    const S = 1.0;
    let o = 0, part = '', chap = '';
    const at = (t: number) => o + t * S;
    const PART = (name: string) => { part = name; };
    const CH = (title: string, len: number, body: () => void) => {
      chap = title;
      this.chapters.push({ t: o, title, part, module: this.moduleOfPart(part) });
      body();
      o += len * S;
      this.lastT = o;
    };
    const C = (t: number, title: string, text: string, x: Partial<Caption> = {}) => {
      this.caps.push({ t: at(t), kicker: part === chap ? part : `${part} · ${chap}`, title, text, note: '', code: '', hud: null, layers: 0, ...x });
    };
    const G = (t0: number, t1: number, name: string, arg?: string, big?: boolean) => { this.diags.push({ t0: at(t0), t1: at(t1), name, arg, big }); };
    const SCENE = (t: number, key: SceneKey, patch?: Partial<Vals>) => {
      this.scenes.push({ t: at(t), key, patch });
      // the scene's settings join the ordinary value stream, so that a pause
      // the learner is in still overrides them
      if (patch) this.sets.push({ t: at(t), patch });
    };
    const SET = (t: number, patch: Partial<Vals>) => { this.sets.push({ t: at(t), patch }); };
    const I = (t: number, until: number, spec: Omit<Stop, 't' | 'until' | 'kind' | 'ov' | 'id' | 'controls'> & { id?: string; controls?: Control[] }) => {
      this.stops.push({ controls: [], ...spec, t: at(t), until: at(until), kind: 'try', id: spec.id ?? spec.title, ov: {} });
    };
    const Q = (t: number, id: string, question: string, choices: string[], answer: number, explain: string) => {
      this.stops.push({ t: at(t), until: at(t), kind: 'quiz', id, title: 'Question', quiz: { question, choices, answer, explain }, controls: [], ov: {} });
    };
    const CARD = (t: number, from: number, to: number | null) => {
      this.stops.push({ t: at(t), until: at(t), kind: 'card', id: `card${from}`, title: 'Module', from, to, controls: [], ov: {} });
    };

    // ════════════════════════════════════════════════════════════════════
    // MODULE 1 — Mouvement et intégration
    // ════════════════════════════════════════════════════════════════════
    PART('Introduction');
    CH('Introduction', 52, () => {
      SCENE(0, 'intro');
      C(0, 'Anatomie d’un moteur physique',
        'Dans cette scène, aucune trajectoire n’a été dessinée à la main. Un programme calcule, soixante fois par seconde, où chaque corps se trouvera à l’instant suivant, à partir des lois du mouvement et d’une seule règle supplémentaire : deux solides ne peuvent pas occuper le même espace. Ce cours explique, étape par étape, comment fonctionne ce programme.',
        { note: 'Vous savez programmer : c’est tout ce qu’il faut. La physique et les mathématiques nécessaires sont reprises depuis le début. Espace met en pause, ← et → reculent ou avancent de 5 secondes, et la frise en bas permet de sauter d’un chapitre à l’autre.' });
      CARD(3, -1, 0);
      C(16, 'Ce que fait un moteur physique',
        'Un moteur physique répond en boucle à une seule question : connaissant la position et la vitesse de chaque corps à l’instant t, où sont-ils à l’instant t + h ? Les contacts, le frottement et les articulations servent tous à rendre cette réponse correcte. La principale difficulté vient de ce que h n’est pas infiniment petit : entre deux instants calculés, les corps parcourent une distance finie, et le moteur doit tenir compte de ce qui se passe pendant cet intervalle.',
        { note: 'h est le pas de temps. À 60 images par seconde, h vaut 1/60 de seconde, soit 16,7 millisecondes. Pendant ce laps de temps, une bille lancée à 10 m/s parcourt 17 cm : assez pour traverser un mur mince si rien ne le détecte.' });
      G(16, 52, 'roadmap');
      C(32, 'Le plan du cours',
        'On suivra l’ordre dans lequel le moteur travaille. D’abord faire avancer un corps libre dans le temps. Puis détecter les contacts et écrire ce qu’ils interdisent. Ensuite résoudre : c’est là qu’intervient AVBD, la méthode utilisée par ce logiciel, qui formule chaque pas de temps comme un problème de minimisation. Enfin, faire tout cela sur des milliers de corps à la fois, sur la carte graphique.',
        { note: 'Chaque case du schéma correspond à un module. Le moteur de cette application est une implémentation GPU d’AVBD — Augmented Vertex Block Descent, publié à SIGGRAPH 2025 —, et le cours finit par ce qui se passe réellement dans ses noyaux de calcul.' });
    });

    CH('Vue d’ensemble d’un pas de temps', 48, () => {
      G(0, 48, 'loops', undefined, true);
      C(0, 'Quatre boucles emboîtées',
        'Avant d’entrer dans le détail, voici la forme générale du calcul. Chaque image de l’animation est découpée en sous-pas ; dans chaque sous-pas, le solveur fait plusieurs itérations ; dans chaque itération, il passe sur tous les corps, un groupe de couleur après l’autre. Presque tous les réglages d’un moteur sont le nombre de tours de l’une de ces boucles.',
        { note: 'Le schéma tourne à vitesse réduite : le vrai moteur parcourt une image entière en quelques millisecondes.' });
      C(15, 'Ce qui se passe à chaque niveau',
        'Une fois par image : la phase large, qui repère les paires de corps assez proches pour se toucher. Une fois par sous-pas : la prédiction — où irait chaque corps si rien ne l’arrêtait —, la phase étroite, qui mesure précisément les contacts, puis, à la fin, le calcul des vitesses. À chaque itération : chaque corps se replace au mieux compte tenu de ses voisins, puis les forces de contact sont réajustées.',
        { note: 'Chacun de ces mots a son chapitre, et il est normal qu’ils soient encore flous. Revenez à ce schéma quand vous vous perdez : il sert de carte.' });
      C(30, 'Le coût d’une image',
        'Le travail d’une image est le produit des nombres de tours de chaque boucle : doubler l’un d’eux double le temps de calcul. Le module 3 explique comment choisir lequel augmenter selon le défaut observé.',
        { code: 'for (image)                // 60 fois par seconde\n  for (sous-pas)           // {{substeps|1|8|1}}\n    for (itération)        // {{iterations|1|20|1}}\n      for (couleur)        // 8\n        résoudre ensemble tous les corps de cette couleur' });
      Q(42, 'q-loops', 'À 60 images par seconde, avec 4 sous-pas et 10 itérations, combien de fois par seconde chaque corps est-il replacé par le solveur ?',
        ['60', '240', '2 400'], 2,
        '60 images × 4 sous-pas × 10 itérations = 2 400. Chaque corps n’est résolu qu’une fois par itération — dans sa couleur —, donc le nombre de couleurs ne change pas ce total : il décide seulement quels corps sont traités en même temps.');
    });

    PART('L’état');
    CH('L’état d’un corps', 44, () => {
      SCENE(0, 'onebox');
      G(0, 44, 'state', undefined, true);
      C(0, 'L’état d’un solide',
        'Un solide rigide dans l’espace est entièrement décrit par sa position x — trois nombres — et son orientation q. Six degrés de liberté : trois pour translater, trois pour tourner. Pour savoir où il ira, il faut aussi sa vitesse v et sa vitesse angulaire ω. Ces douze grandeurs forment l’état du corps : ce sont les seules qui changent d’une image à l’autre. La forme, la masse et l’inertie, elles, sont fixées une fois pour toutes.',
        { code: 'struct Body {\n  vec3 x;   // position du centre de masse\n  quat q;   // orientation (4 nombres, 3 indépendants)\n  vec3 v;   // vitesse (m/s)\n  vec3 w;   // vitesse angulaire (rad/s)\n}',
          note: 'L’orientation est stockée sur quatre nombres — un quaternion, présenté au chapitre « La rotation » — mais ces quatre nombres sont liés (leur longueur vaut toujours 1) : ils ne portent que trois degrés de liberté.' });
      C(15, 'Le centre de masse',
        'La position d’un solide, c’est par convention celle de son centre de masse : le point d’équilibre, celui autour duquel l’objet tourne quand rien ne le retient. C’est le seul choix qui sépare proprement le mouvement en deux : une translation du centre de masse, et une rotation autour de lui. Pour un cube homogène, c’est son centre géométrique.',
        { note: 'Dans l’image, la caisse tombe. Son centre de masse suit une parabole, quelle que soit la manière dont elle tourne. Elle finit par traverser le sol : les contacts ne sont pas encore pris en compte à ce stade.' });
      C(29, 'Masse et inertie',
        'La masse m mesure la résistance d’un corps quand on veut l’accélérer en ligne droite (le chapitre suivant y revient). Son équivalent pour la rotation est le tenseur d’inertie I, qui dit combien il est difficile de le faire tourner — et ce n’est pas un simple nombre : faire tourner une règle autour de sa longueur est bien plus facile que de la faire pivoter en son milieu, comme une hélice. I est donc une matrice 3×3, qui tourne avec le corps.',
        { code: '// boîte pleine, demi-dimensions (hx, hy, hz)\nIxx = m·(hy² + hz²)/3\nIyy = m·(hx² + hz²)/3\nIzz = m·(hx² + hy²)/3' });
      Q(40, 'q-dof', 'Combien de degrés de liberté possède un solide rigide dans l’espace ?',
        ['3 : sa position', '6 : position et orientation', '12 : position, orientation, vitesse et vitesse angulaire'], 1,
        'Un degré de liberté est une façon indépendante de *bouger* : trois translations et trois rotations, soit six. Les vitesses ne sont pas des degrés de liberté supplémentaires : ce sont les dérivées des six premiers. Il faut bien douze nombres pour décrire l’état, mais la configuration, elle, en compte six.');
    });

    CH('Forces et mouvement', 46, () => {
      G(0, 46, 'newton', undefined, true);
      C(0, 'Une force change la vitesse',
        'Le premier principe de la mécanique va à l’encontre de l’intuition : une force ne fait pas bouger un objet, elle fait *changer* sa vitesse. Poussez une caisse sur de la glace : tant que vous poussez, elle accélère ; quand vous lâchez, elle continue à la même vitesse. Elle ne ralentit pas, puisqu’aucune force ne la pousse dans l’autre sens.',
        { note: 'C’est le principe d’inertie, la première loi de Newton. Dans la vie courante, les objets s’arrêtent d’eux-mêmes parce que le frottement et l’air les freinent — mais ce sont des forces comme les autres, et un moteur physique doit les programmer.' });
      C(15, 'F = m·a',
        'La deuxième loi dit de combien la vitesse change : l’accélération vaut la force divisée par la masse. Le même coup de pied fait voler un ballon et bouge à peine un rocher. Sur le schéma, la courbe du haut est la force ; celle du milieu, la vitesse, qui s’accumule tant que la force agit ; celle du bas, la position, qui s’accumule à son tour.',
        { code: 'a = F / m             // la force donne l’accélération\nv : accumule a        // au fil du temps\nx : accumule v        // au fil du temps' });
      C(30, 'De la force à la position',
        'Un moteur physique suit cette chaîne : il détermine les forces, en déduit les accélérations, puis accumule deux fois — l’accélération dans la vitesse, la vitesse dans la position. Le chapitre suivant montre comment un ordinateur fait cette accumulation pas à pas. La plus grande partie du cours porte ensuite sur les forces de contact, qui ne sont pas connues à l’avance et doivent être calculées.',
        { note: 'Le poids est la force la plus simple : m·g, toujours vers le bas. Comme il est proportionnel à la masse, l’accélération qu’il donne, g = 9,81 m/s², est la même pour tous les corps — une plume et une enclume tombent ensemble dans le vide.' });
      Q(40, 'q-newton', 'Une caisse glisse sans frottement à 2 m/s, et plus aucune force n’agit sur elle. Que fait-elle ?',
        ['elle ralentit puis s’arrête', 'elle continue à 2 m/s indéfiniment', 'elle accélère'], 1,
        'Sans force, la vitesse ne change pas : c’est le principe d’inertie. Une caisse réelle s’arrête parce que le frottement la freine — et dans un moteur physique, ce frottement doit être programmé, sinon il n’existe pas.');
    });

    PART('Intégration');
    CH('Intégrer pas à pas', 50, () => {
      SCENE(0, 'freefall');
      G(0, 50, 'euler', 'explicit', true);
      C(0, 'Du continu au discret',
        'La mécanique s’écrit en temps continu : l’accélération est la dérivée de la vitesse, elle-même dérivée de la position. Un ordinateur, lui, ne sait pas dériver : il sait additionner. On remplace donc les dérivées par des différences sur un petit intervalle h, et on avance de proche en proche. C’est ce qu’on appelle intégrer.',
        { code: '// une seule force : le poids\na = g                 // g = (0, −9.81, 0) m/s²\nx ← x + h·v           // la position avance avec la vitesse actuelle\nv ← v + h·a           // puis la vitesse change' });
      C(16, 'Euler explicite',
        'La recette ci-dessus porte un nom : la méthode d’Euler explicite. Elle devient exacte quand h tend vers zéro, mais commet une erreur pour tout h fini : pendant le pas, on fait comme si la vitesse restait celle du début, alors qu’elle change continûment. Sur le schéma, la ligne brisée orange est ce que calcule le moteur, la courbe bleue est la vraie trajectoire.',
        { hud: (v) => `h = ${(v.h * 1000).toFixed(1)} ms  ·  ${Math.round(1 / v.h)} pas par seconde` });
      C(30, 'L’erreur dépend du pas',
        'Diviser h par deux divise l’écart par deux : l’erreur est proportionnelle à h. On dit que la méthode est d’ordre 1. Doubler la fréquence double aussi le coût, et cet arbitrage entre précision et temps de calcul revient tout au long du cours.',
        { code: 'for (int i = 0; i < {{steps|2|60|1}}; i++) {   // pas sur la durée affichée\n  x += h * v;\n  v += h * g;\n}' });
      I(42, 48, {
        title: 'Changez le pas de temps',
        prompt: 'Faites varier le nombre de pas utilisés pour tracer la même seconde de chute. Avec très peu de pas, la ligne brisée coupe les virages et la balle « rate » sa trajectoire. L’aire grisée mesure l’écart accumulé.',
        controls: [{ type: 'range', key: 'steps', label: 'pas par seconde', min: 2, max: 60, step: 1, fmt: (v) => String(Math.round(v)) }],
        diag: true,
        seq: true,
        goals: [
          { label: 'Descendez à 4 pas ou moins : l’erreur devient importante', test: ({ v }) => v.steps <= 4 },
          { label: 'Remontez à 40 pas ou plus : les deux courbes se confondent', test: ({ v }) => v.steps >= 40 },
        ],
      });
    });

    CH('Explicite ou semi-implicite', 44, () => {
      G(0, 44, 'euler', 'compare', true);
      C(0, 'Euler semi-implicite',
        'Dans la recette précédente, x est mis à jour avec l’ancienne vitesse. Si on met d’abord la vitesse à jour, puis la position avec la *nouvelle* vitesse, on obtient la méthode d’Euler semi-implicite — ou symplectique. Ce simple changement d’ordre modifie nettement le comportement sur de longues durées.',
        { code: '// explicite               // semi-implicite\nx ← x + h·v;               v ← v + h·a;\nv ← v + h·a;               x ← x + h·v;' });
      C(14, 'Pourquoi presque tous les moteurs l’utilisent',
        'Euler explicite ajoute un peu d’énergie à chaque pas : un pendule simulé ainsi oscille de plus en plus fort. Le semi-implicite n’est pas plus précis à chaque pas, mais il ne dérive pas : l’énergie oscille autour de la bonne valeur sans croître. Pour une simulation qui dure, cette stabilité compte davantage que la précision d’un pas isolé.',
        { note: 'Sur le schéma, deux pendules identiques lâchés en même temps : à gauche l’explicite, à droite le semi-implicite. Au bout de quelques dizaines de secondes, l’un monte de plus en plus haut, l’autre non.' });
      Q(26, 'q-symplectic', 'Un pendule simulé avec Euler explicite, sans aucun frottement, pendant dix minutes :',
        ['oscille indéfiniment à la même hauteur', 'monte de plus en plus haut', 's’arrête peu à peu'], 1,
        'L’explicite injecte un peu d’énergie à chaque pas, et cette erreur s’accumule toujours dans le même sens : l’amplitude croît. Le semi-implicite commet une erreur comparable, mais qui ne s’accumule pas : elle grandit pendant une moitié de l’oscillation et se résorbe pendant l’autre, si bien que l’énergie oscille autour de sa valeur sans dériver.');
      C(28, 'Les sous-pas',
        'Un autre réglage, commun à tous les moteurs, consiste à découper le pas d’affichage en plusieurs sous-pas. À 60 images par seconde avec 4 sous-pas, le solveur travaille à 240 Hz. C’est quatre fois plus cher, mais chaque sous-pas porte sur un déplacement quatre fois plus court. Comme on le verra, ce sont surtout les contacts qui en bénéficient.',
        { code: 'float hs = h / {{substeps|1|8|1}};   // sous-pas\nfor (int s = 0; s < substeps; s++) { … }',
          hud: (v) => `${Math.round(v.substeps)} sous-pas → le solveur tourne à ${Math.round(v.substeps / v.h)} Hz` });
    });

    CH('La rotation', 40, () => {
      SCENE(0, 'spheres');
      G(0, 40, 'rotation', undefined, true);
      C(0, 'Représenter l’orientation',
        'On pourrait stocker l’orientation sous forme de trois angles — tangage, roulis, lacet. Cette représentation pose deux problèmes : à certaines orientations, deux axes se confondent et l’on perd un degré de liberté (c’est le « blocage de cardan ») ; et composer deux rotations demande des calculs trigonométriques lourds. Les moteurs utilisent plutôt des quaternions : quatre nombres, sans cas particulier, et la composition de deux rotations est un simple produit.',
        { code: 'q ← normalize(q + 0.5·h·(ω ⊗ q))   // ⊗ : produit quaternionique\n// puis on renormalise : q doit rester de longueur 1' });
      C(14, 'Le couple et l’inertie',
        'Une force appliquée ailleurs qu’au centre de masse fait tourner : son couple vaut τ = r × F, où r va du centre de masse au point d’application. L’équivalent de F = m·a s’écrit alors τ = I·α, où α est l’accélération angulaire.',
        { note: 'En 3D, la loi complète contient un terme de plus, ω × (I·ω) : c’est lui qui fait tourner une toupie de travers ou basculer un objet lancé en rotation autour de son axe intermédiaire. Dans l’image, des billes descendent une rampe : une bille qui roule sans glisser met une partie de son énergie dans sa rotation, et arrive en bas moins vite qu’un objet qui glisserait sans frotter.' });
      C(28, 'Le bras de levier d’une sphère',
        'Le bras de levier d’un contact sur une sphère doit rester aligné sur la normale, et ne pas tourner avec le corps. Le point de contact d’une bille qui roule change à chaque instant : c’est toujours le point le plus bas, pas un point peint sur la bille. Si le bras tournait avec elle, une bille roulant vite signalerait au solveur une séparation qui n’existe pas, et s’enfoncerait dans le sol. Les deux moteurs de ce cours gardent donc ce bras fixe dans le monde.',
        { note: 'Cet exemple illustre une difficulté générale : les formules sont simples, mais chaque approximation a un domaine de validité, et en sortir produit des symptômes souvent éloignés de leur cause.' });
      CARD(38, 0, 1);
    });

    // ════════════════════════════════════════════════════════════════════
    // MODULE 2 — Contacts et impulsions
    // ════════════════════════════════════════════════════════════════════
    PART('Le problème');
    CH('Le problème des contacts', 52, () => {
      SCENE(0, 'noSolver', { solver: 0 });
      G(0, 52, 'overlap');
      C(0, 'L’intégration seule ne suffit pas',
        'Reprenons le pas de temps du module précédent et ajoutons quelques caisses. Les deux lignes « v ← v + h·a ; x ← x + h·v » ne font intervenir aucun autre corps : les caisses se traversent, traversent le sol et continuent de tomber. C’est ce que montre la scène, où le solveur est désactivé.',
        { note: 'L’intégration fonctionne correctement : elle ignore simplement l’existence des autres corps. Le reste du moteur sert à ajouter une condition : deux solides ne doivent pas occuper le même espace.',
          layers: 1 });
      C(17, 'La contrainte de contact',
        'Formellement, pour chaque paire de corps en contact, on impose C(x) ≥ 0, où C mesure l’écart entre les deux surfaces le long de leur normale commune : positif s’ils sont séparés, nul s’ils se touchent, négatif s’ils s’interpénètrent. Tout ce module consiste à trouver ces C, puis à les faire respecter.',
        { code: 'C(x) ≥ 0        // contrainte unilatérale : un contact pousse,\n                // il ne tire jamais', layers: 1 });
      Q(32, 'q-pairs', 'Mille corps dans une scène. Combien de paires faut-il examiner si on compare naïvement tout le monde à tout le monde ?',
        ['mille', 'environ cinq cent mille', 'un million'], 1,
        'n(n−1)/2, soit 999 × 1000 / 2 ≈ 500 000 paires — et un million si on compte chaque paire deux fois. À soixante images par seconde, cela ferait 30 millions de tests de paires par seconde pour une scène très modeste, et le nombre est multiplié par quatre quand le nombre de corps double. Réduire ce nombre est le rôle de la phase large.');
      C(33, 'Détection et résolution',
        'Faire respecter l’inégalité se décompose en deux tâches de nature complètement différente. Trouver qui touche qui est un problème de géométrie et de structures de données — c’est la détection de collisions. Corriger les poses pour satisfaire toutes les contraintes à la fois est un problème numérique — c’est le solveur. Ce module traite le premier, puis le second.',
        { layers: 2 });
    });

    PART('Détection');
    CH('La phase large', 50, () => {
      SCENE(0, 'crowd');
      G(0, 50, 'broad');
      C(0, 'Éliminer les paires éloignées',
        'L’idée de la phase large : ne pas chercher la bonne réponse, mais éliminer très vite l’immense majorité des paires qui n’ont aucune chance de se toucher. On remplace chaque corps par une boîte englobante alignée sur les axes — une AABB — et on ne garde que les paires dont les boîtes se chevauchent.',
        { code: 'bool overlap(AABB a, AABB b) {\n  return a.min.x <= b.max.x && b.min.x <= a.max.x\n      && a.min.y <= b.max.y && b.min.y <= a.max.y\n      && a.min.z <= b.max.z && b.min.z <= a.max.z;\n}', layers: 2 });
      C(16, 'Un test rapide et prudent',
        'Tester deux AABB coûte six comparaisons : des dizaines de fois moins qu’un test exact entre deux boîtes tournées, qui doit essayer jusqu’à quinze directions. Une AABB répond toujours « peut-être » ou « non » — jamais « oui ». Les faux positifs sont acceptables : ils seront tranchés par la phase étroite. Les faux négatifs, en revanche, sont exclus : une collision manquée laisserait un corps traverser un mur.',
        { layers: 2 });
      C(31, 'Un arbre de boîtes : le BVH',
        'Six comparaisons multipliées par un demi-million de paires, cela reste coûteux. Il vaut mieux éviter de former la plupart des paires. La réponse est une structure spatiale : un arbre de boîtes englobantes — un BVH — dans lequel on descend. Si deux sous-arbres ne se chevauchent pas, aucune de leurs feuilles ne peut se toucher, et on élimine des milliers de paires d’un coup.',
        { note: 'Dans la scène : mille cubes et sphères tombent dans un bac. Le moteur de cette application reconstruit son arbre à chaque image, entièrement sur la carte graphique — le processeur ne voit jamais la liste des paires. La phase étroite, elle, est refaite à chaque sous-pas sur les paires retenues.', layers: 2 });
      I(44, 48, {
        id: 'Le coût de la naïveté',
        title: 'Comparaison exhaustive ou arbre',
        prompt: 'Faites varier le nombre de corps et regardez les deux courbes : le nombre de paires d’une comparaison exhaustive, et le nombre de nœuds visités dans un arbre. L’une est une parabole, l’autre presque une droite.',
        controls: [{ type: 'range', key: 'bodies', label: 'nombre de corps', min: 50, max: 4000, step: 50, fmt: (v) => String(Math.round(v)) }],
        diag: true,
        seq: true,
        goals: [
          { label: 'Montez à 2 000 corps : lisez le nombre de paires', test: ({ v }) => v.bodies >= 2000 },
          { label: 'Redescendez sous 200 corps', test: ({ v }) => v.bodies <= 200 },
        ],
      });
    });

    CH('Construire l’arbre en parallèle', 44, () => {
      G(0, 44, 'morton');
      C(0, 'Éviter la construction récursive',
        'Un arbre se construit naturellement de façon récursive, c’est-à-dire séquentielle, ce qui convient mal à une carte graphique. La solution consiste à ranger d’abord les corps dans un ordre qui respecte la proximité spatiale, puis bâtir l’arbre directement depuis cette liste triée, tous les nœuds à la fois.',
        { layers: 2 });
      C(15, 'Les codes de Morton',
        'On quantifie la position de chaque corps sur une grille, puis on entrelace les bits de x, y et z : un bit de x, un de y, un de z, et on recommence. Le nombre obtenu a une propriété utile : deux corps dont les codes sont proches sont, presque toujours, proches dans l’espace. Trier les codes, c’est trier spatialement — avec quelques sauts aux frontières de la grille, qui coûtent un peu d’efficacité à l’arbre mais jamais de justesse.',
        { code: 'u32 morton3(uvec3 p) {    // 10 bits par axe\n  return part1by2(p.x) | (part1by2(p.y) << 1)\n                       | (part1by2(p.z) << 2);\n}' });
      C(29, 'Tri radix et construction de l’arbre',
        'Reste à trier des milliers — parfois des dizaines de milliers — d’entiers, soixante fois par seconde. Un tri radix convient parfaitement au parallélisme : il range les clés par paquets selon quelques bits à la fois, sans jamais comparer deux éléments. Une fois la liste triée, la structure de l’arbre se déduit des bits où deux codes voisins commencent à différer — chaque nœud se calcule indépendamment des autres.',
        { note: 'Le moteur de cette application utilise un tri « one-sweep » et un constructeur de BVH linéaire (dossier src/engine/lvbh). Dans ce type de code, les performances dépendent surtout de l’organisation des données, bien plus que du nombre d’opérations.' });
      Q(40, 'q-morton', 'À quoi sert l’entrelacement des bits dans un code de Morton ?',
        ['à compresser la position sur un seul entier', 'à ce que deux codes proches désignent des positions proches', 'à accélérer le tri radix'], 1,
        'La compression est un effet de bord, et le tri radix fonctionne sur n’importe quelle clé. Ce qui compte, c’est la localité : en entrelaçant les bits, les corps voisins dans l’espace se retrouvent voisins dans la liste triée, ce qui permet de construire l’arbre — et de le parcourir — sans recherche.');
    });

    CH('La phase étroite', 54, () => {
      SCENE(0, 'twoBoxes');
      G(0, 30, 'sat');
      C(0, 'Le test exact',
        'Deux boîtes dont les AABB se chevauchent se touchent-elles vraiment ? Et si oui, où, et selon quelle direction ? C’est la phase étroite. Pour deux polyèdres convexes, un théorème permet de répondre : s’ils ne se touchent pas, il existe un plan qui les sépare — et il suffit de chercher sa direction dans une courte liste de candidats. En 2D, ce sont les normales des faces ; en 3D, il faut y ajouter les produits vectoriels d’une arête de chaque forme.',
        { note: 'C’est le théorème de l’axe séparateur. Pour deux boîtes en 3D, cela fait quinze axes : les trois normales de faces de chacune, plus les neuf produits vectoriels d’une arête de l’une par une arête de l’autre.' });
      C(15, 'Projeter sur chaque axe candidat',
        'Pour chaque axe candidat, on projette les deux formes et on compare les intervalles obtenus. Si l’un est entièrement à gauche de l’autre, l’axe les sépare : il n’y a pas de contact, on s’arrête. Sinon, on note le recouvrement, et on garde l’axe où il est le plus petit.',
        { code: 'float sep = min(B.proj(n)) - max(A.proj(n));\nif (sep > 0.) return NO_CONTACT;   // cet axe les sépare\nif (sep > best) { best = sep; normal = n; }' });
      G(30, 54, 'manifold');
      C(30, 'La normale et la profondeur',
        'L’axe retenu donne la normale du contact n, et le recouvrement donne la profondeur. On tient enfin notre C : C = −profondeur, négatif puisque les corps se chevauchent. Dans la scène, la caisse arrive de biais sur son socle : la normale basculera d’une face à l’autre selon l’angle du choc.');
      C(42, 'Plusieurs points de contact',
        'Deux faces qui se rencontrent se touchent le long d’une surface, pas en un point. Si l’on ne garde qu’un point, la caisse peut pivoter autour de lui et osciller d’un coin sur l’autre. On découpe donc la face entrante contre la face de référence et on garde plusieurs points — un « manifold », deux points en 2D, jusqu’à quatre en 3D. Chacun devient une contrainte à part entière.',
        { note: 'Le choix des points a des effets visibles : avec trop peu de points, les objets vibrent ; si les points ne sont pas retrouvés d’une image à l’autre, la mémoire du solveur (présentée au module 3) ne peut plus être réutilisée.', layers: 3 });
    });

    PART('Contraintes');
    CH('Écrire une contrainte', 50, () => {
      SCENE(0, 'twoBoxes');
      G(0, 50, 'jacobian', undefined, true);
      C(0, 'Du contact à l’équation',
        'Un point de contact se stocke comme deux ancres : le même point du monde, exprimé dans le repère de chacun des deux corps. Quand les corps bougent, ces deux ancres s’écartent, et c’est cet écart, mesuré le long de la normale, qui donne la valeur de la contrainte.',
        { code: 'C = ( (x_A + R_A·r_A) − (x_B + R_B·r_B) ) · n + C₀', layers: 3 });
      C(15, 'Le jacobien',
        'Pour corriger la contrainte, le solveur a besoin de savoir comment C réagit à un déplacement de chaque corps : c’est le jacobien, la dérivée de C par rapport aux six degrés de liberté. Pour la translation, c’est simplement la normale. Pour la rotation, c’est r × n : le bras de levier.',
        { code: '∂C/∂x = n            // déplacer le corps de n augmente C de 1\n∂C/∂θ = r × n        // tourner : le bras de levier' });
      C(29, 'Le rôle du bras de levier',
        'Le terme r × n explique la plupart des rotations que l’on observe dans une scène : une caisse poussée trop haut qui bascule, un domino qui fait tourner le suivant, une bille qui roule. Sur le schéma, déplacez le point de contact : la flèche de rotation change de longueur et de sens, et bascule quand le point passe de l’autre côté du centre de masse.');
      I(42, 47, {
        title: 'Promenez le point de contact',
        prompt: 'Déplacez la souris sur le schéma : le point de contact suit, et avec lui le bras de levier. Cherchez la position où une poussée ne fait pas tourner le corps du tout, puis celles qui le font basculer d’un côté ou de l’autre.',
        diag: true,
        goals: [
          { label: 'Trouvez le point où r × n s’annule (aucune rotation)', test: ({ ptr }) => !!ptr && Math.abs(ptr.y - 118) < 8 },
          { label: 'Faites basculer dans un sens (r × n > 0,04)', test: ({ ptr }) => !!ptr && ptr.y < 90 },
          { label: 'Puis dans l’autre', test: ({ ptr }) => !!ptr && ptr.y > 146 },
        ],
      });
    });

    CH('Les forces de contact', 46, () => {
      SCENE(0, 'stack');
      G(0, 46, 'reaction', undefined, true);
      C(0, 'Les forces de réaction',
        'Posez un livre sur une table : elle le retient en le poussant vers le haut, exactement de son poids. Posez-en un deuxième : elle pousse deux fois plus fort. Personne n’a réglé cette force — elle s’ajuste d’elle-même pour que rien ne traverse. C’est une force de réaction, et toutes les forces de contact sont de ce type.',
        { layers: 3 });
      C(15, 'Des forces inconnues',
        'Le poids se calcule d’avance : m·g. Une force de contact, non : elle vaut ce qu’il faut pour que la contrainte soit respectée, et rien de plus. C’est donc une inconnue du problème, au même titre que les positions à venir. Trouver ces inconnues, c’est le travail du solveur.',
        { note: 'Les mathématiciens appellent ces forces inconnues des multiplicateurs de Lagrange. On les retrouvera sous ce nom — et sous la lettre λ — au cœur d’AVBD.' });
      C(29, 'Des forces couplées',
        'Dans une pile, la force entre les deux caisses du haut dépend du poids de la dernière ; celle de l’étage en dessous, de tout ce qui est au-dessus ; et ainsi de suite jusqu’au sol. Toucher à l’une change toutes les autres. On ne peut pas les calculer une par une : il faut résoudre un système où tout est couplé. Les deux familles de solveurs qui suivent sont deux façons de s’y prendre.',
        { layers: 3 });
      Q(40, 'q-reaction', 'Trois caisses identiques, de poids P chacune, sont empilées sur le sol. Quelle force le sol exerce-t-il sur la caisse du bas ?',
        ['P', '2 P', '3 P'], 2,
        'Le sol porte tout ce qui est au-dessus de lui : les trois caisses, soit 3 P. Entre la première et la deuxième caisse, la force vaut 2 P ; entre la deuxième et la troisième, P. Aucune de ces valeurs n’est écrite nulle part : elles découlent de la seule condition « rien ne se traverse ».');
    });

    PART('Résolution');
    CH('Force et impulsion', 44, () => {
      SCENE(0, 'wrecking');
      G(0, 44, 'impulse', undefined, true);
      C(0, 'L’impulsion',
        'Quand une boule de démolition frappe un mur, la force est énorme mais ne dure que quelques millisecondes. Ce qui compte pour la suite du mouvement n’est ni la force ni la durée séparément, mais leur produit : l’impulsion. Une petite force longtemps, ou une grande force brièvement, changent la vitesse de la même façon.',
        { code: 'impulsion  J  = F × durée     // en N·s\nchangement Δv = J / m' });
      C(14, 'Pourquoi les solveurs calculent des impulsions',
        'Un pas de temps dure de 4 à 16 millisecondes. Un choc entre deux objets durs dure bien moins : il commence et finit à l’intérieur d’un seul pas. Le moteur ne peut pas voir la forme de la force — seulement son effet total. Plutôt que de chercher une force très grande sur une durée inconnue, il calcule directement l’impulsion qui donne la bonne vitesse.',
        { note: 'Sur le schéma, l’aire rose est l’impulsion : elle reste la même quelle que soit la durée du choc, et le saut de vitesse aussi. Les graduations sous l’axe marquent les pas de temps à 60 Hz.' });
      I(26, 32, {
        title: 'Raccourcissez le choc',
        prompt: 'Réduisez la durée du choc : la force grimpe, l’aire reste la même, et le saut de vitesse ne change pas. Descendez jusque sous la durée d’un pas de temps.',
        controls: [{ type: 'range', key: 'pulse', label: 'durée du choc', min: 0.004, max: 0.4, step: 0.002, fmt: (v) => `${(v * 1000).toFixed(0)} ms` }],
        diag: true,
        seq: true,
        goals: [
          { label: 'Passez sous 50 ms : regardez la force', test: ({ v }) => v.pulse <= 0.05 },
          { label: 'Passez sous un pas de temps (16,7 ms)', test: ({ v }) => v.pulse < 1 / 60 },
        ],
      });
      C(33, 'Les contacts au repos',
        'Même une caisse posée reçoit des impulsions : à chaque pas, le sol lui rend exactement celle que la pesanteur lui a donnée vers le bas, m·g·h. C’est la force de réaction du chapitre précédent, comptée pas par pas. Le chapitre suivant calcule ces impulsions, contact après contact.',
        { layers: 4 });
    });

    CH('Les impulsions séquentielles', 54, () => {
      SCENE(0, 'stack', { solver: 1, iterations: 10 });
      G(0, 54, 'solve', 'pgs');
      C(0, 'Le principe',
        'Une méthode très répandue dans les moteurs de jeu résout les contacts par « impulsions séquentielles ». On traite les contacts un par un : pour chacun, on calcule l’impulsion qui annule exactement la vitesse de rapprochement, on l’applique, et on passe au suivant. Puis on recommence, plusieurs fois.',
        { code: 'for (int it = 0; it < iterations; it++)\n  for (Contact c : contacts) {\n    float vn = relativeNormalVelocity(c);\n    float dj = -vn / effectiveMass(c);\n    float old = c.impulse;\n    c.impulse = max(0., old + dj);   // le total reste ≥ 0 : on pousse\n    applyImpulse(c, c.impulse - old);\n  }', layers: 4,
          note: 'On ne borne pas chaque correction, mais l’impulsion cumulée : une itération peut retirer une partie de ce qu’une précédente avait trop poussé, tant que le total reste positif. Et ce total est gardé d’une image à l’autre — c’est le « démarrage à chaud » qu’on retrouvera dans AVBD.' });
      C(17, 'Gauss-Seidel',
        'Traiter les contraintes les unes après les autres, chacune voyant déjà les corrections des précédentes, c’est la méthode de Gauss-Seidel. Elle converge bien plus vite que si l’on calculait toutes les corrections sur l’ancien état avant de les appliquer d’un coup (Jacobi). Nous retrouverons ces deux noms au module 4 : le premier est séquentiel par nature, ce qui posera problème sur une carte graphique.',
        { layers: 4 });
      C(31, 'Le biais de Baumgarte',
        'Les impulsions annulent les vitesses, mais ne réparent pas l’interpénétration déjà installée. On ajoute donc un terme qui pousse les corps un peu plus que nécessaire, proportionnellement à leur chevauchement. Ce « biais » corrige la position… en fabriquant de la vitesse, donc de l’énergie. Trop fort, les objets vibrent ; trop faible, ils s’enfoncent. On tolère en plus quelques millimètres de recouvrement, le « slop », pour que les contacts au repos ne tressautent pas.',
        { code: 'float pen  = max(0., -C - slop);   // slop ≈ 5 mm ici\nfloat bias = {{bias|0|0.6|0.01}} * pen / h;   // Baumgarte\nfloat dj = (-vn + bias) / effectiveMass(c);' });
      Q(45, 'q-pgs', 'Une pile de dix caisses, résolue par impulsions séquentielles avec dix itérations. Que se passe-t-il ?',
        ['elle tient, sans aucun recouvrement', 'elle tient, mais tassée : chaque étage s’enfonce de quelques millimètres', 'elle rebondit indéfiniment'], 1,
        'La caisse du bas doit porter les neuf autres, mais l’information « il y a du poids au-dessus » ne se propage que d’un contact par itération. Avec dix itérations, elle n’a pas fini de parcourir la pile, et le biais de Baumgarte ne rattrape le retard que progressivement. Le résultat est une pile tassée, avec quelques millimètres de recouvrement à chaque étage. Le démarrage à chaud — garder les impulsions de l’image précédente — empêche qu’elle ne s’effondre.');
    });

    CH('Itérations et enfoncement', 48, () => {
      G(0, 48, 'solve', 'compare');
      C(0, 'Mesurer l’enfoncement',
        'Le schéma fait tourner une vraie pile, dans un moteur 2D complet, avec le nombre d’itérations que vous choisissez — et il mesure l’enfoncement maximal. Dans la scène, c’est la même pile dans le moteur 3D, résolue par impulsions séquentielles. Les deux montrent le même comportement.',
        { hud: (v) => `${Math.round(v.iterations)} itérations · ${Math.round(v.substeps)} sous-pas`, layers: 4 });
      C(16, 'Le nombre d’itérations est un budget',
        'Plus d’itérations, moins d’enfoncement — mais le coût est strictement proportionnel. Et la convergence est lente : passer de dix à vingt itérations ne divise pas l’erreur par deux, et une partie de l’enfoncement ne disparaît jamais, puisque le slop la tolère volontairement. Les impulsions séquentielles restent pourtant la méthode de référence des moteurs de jeu : sur une pile ordinaire, elles font très bien leur travail.',
        { layers: 4,
          note: 'Leurs vraies faiblesses sont ailleurs : un objet très lourd posé sur un objet léger (l’impulsion du léger ne suffit jamais à porter le lourd en quelques itérations), des chaînes d’articulations qui s’allongent, et la correction de position qui fabrique de la vitesse. Ce sont ces cas que la méthode du module suivant traite mieux.' });
      I(28, 44, {
        title: 'Comparez les deux solveurs',
        prompt: 'Changez de solveur et faites varier les itérations. Le schéma affiche l’enfoncement réellement mesuré sur la pile 2D ; la scène 3D suit vos réglages (elle se recalcule à chaque changement). « Pénalité » et « AVBD » sont les sujets du module 3 : regardez déjà l’écart.',
        controls: [
          { type: 'choice', key: 'solver', label: 'solveur', options: [{ label: 'aucun', value: 0 }, { label: 'impulsions', value: 1 }, { label: 'pénalité', value: 2 }, { label: 'AVBD', value: 3 }] },
          { type: 'range', key: 'iterations', label: 'itérations', min: 1, max: 40, step: 1, fmt: (v) => String(Math.round(v)) },
        ],
        diag: true,
        seq: true,
        goals: [
          { label: 'Impulsions, 4 itérations : lisez l’enfoncement', test: ({ v }) => v.solver === 1 && v.iterations <= 4 },
          { label: 'Montez à 30 itérations : il ne disparaît pas', test: ({ v }) => v.solver === 1 && v.iterations >= 30 },
          { label: 'Passez à AVBD avec 8 itérations', test: ({ v }) => v.solver === 3 && v.iterations >= 8 && v.iterations <= 12 },
        ],
      });
    });

    CH('Le frottement', 50, () => {
      // the crates' own coefficients are ⅓, 1 and 2 × this value (see scenes.ts)
      SCENE(0, 'slope', { friction: 0.45 });
      G(0, 50, 'friction');
      C(0, 'La loi de Coulomb',
        'Le frottement est une contrainte de plus, tangente au contact : elle s’oppose au glissement. Sa particularité est d’être bornée par la force normale : |f_t| ≤ μ·|f_n|. En dessous de cette limite, le contact est collé — frottement statique. À la limite, il glisse, et la force reste à son maximum.',
        { code: 'float lim = mu * abs(f_n);\nf_t = clamp(f_t, -lim, lim);   // le cône de Coulomb', layers: 4 });
      C(16, 'Le cône',
        'En trois dimensions, les deux composantes tangentielles forment un disque de rayon μ·|f_n| : la force de contact totale doit rester dans un cône. Ce moteur projette sur ce disque : si la force tangente dépasse la limite, il la raccourcit sans changer sa direction. Beaucoup de moteurs simplifient en un carré, en bornant les deux directions séparément — un peu plus simple, très légèrement anisotrope.',
        { note: 'La scène montre trois caisses sur la même pente, avec trois coefficients différents : 0,15, 0,45 et 0,9. La pente fait 18°, dont la tangente vaut 0,32 : seules celles dont μ dépasse cette valeur restent en place. Dans le modèle de Coulomb, le seuil ne dépend ni de la masse ni de la surface de contact : une caisse deux fois plus lourde est retenue deux fois plus fort, mais tirée deux fois plus fort aussi.' });
      C(31, 'Le frottement saturé',
        'Le frottement demande un soin particulier. S’il applique sa force maximale alors qu’une fraction suffirait, il ne se contente plus de freiner : il pousse, et une caisse peut remonter sa propre pente. Dans la descente par blocs du module 3, on l’évite ainsi : quand la force atteint sa limite, la raideur utilisée dans le calcul doit valoir |f| / |glissement|, et non la raideur nominale.');
      I(40, 46, {
        title: 'Trouvez l’angle de glissement',
        prompt: 'Le schéma montre le cône de Coulomb et la force de contact réellement appliquée. Réglez μ et comparez à la tangente de la pente (0,32) : en dessous, le bloc part ; au-dessus, il tient. Dans la scène 3D, recalculée à chaque changement, les trois caisses gardent leurs écarts : la première frotte trois fois moins que le réglage, la troisième deux fois plus.',
        controls: [{ type: 'range', key: 'friction', label: 'μ (frottement)', min: 0, max: 1.2, step: 0.01, fmt: (v) => v.toFixed(2) }],
        diag: true,
        seq: true,
        goals: [
          { label: 'μ = 0,1 : tout glisse', test: ({ v }) => v.friction <= 0.12 },
          { label: 'μ = 0,2 : seule la troisième caisse tient', test: ({ v }) => v.friction >= 0.17 && v.friction <= 0.3 },
          { label: 'μ = 1,1 ou plus : tout tient', test: ({ v }) => v.friction >= 1.08 },
        ],
      });
    });

    CH('Le rebond', 34, () => {
      SCENE(0, 'spheres', { friction: 0.5 });
      G(0, 34, 'restitution');
      C(0, 'La restitution',
        'Jusqu’ici tous nos contacts sont parfaitement mous : un corps qui touche s’arrête. Pour faire rebondir, on ajoute un coefficient de restitution e, et l’on demande à la contrainte non pas d’annuler la vitesse d’approche, mais de la renvoyer multipliée par −e. e = 0 : pas de rebond ; e = 1 : rebond parfait, sans aucune perte — un idéal qu’aucun objet réel n’atteint, puisqu’un choc dissipe toujours un peu d’énergie en chaleur, en son et en vibrations.',
        { code: 'float target = -e * approachVelocity;' });
      C(15, 'Pourquoi ce moteur ne rebondit presque pas',
        'Les solveurs qui travaillent sur les positions, comme celui du module suivant, déduisent la vitesse du déplacement réellement effectué : v ← (x − x_précédent)/h. Un corps arrêté par un contact n’a plus de vitesse, sans qu’aucune règle n’ait eu à le dire. C’est une propriété utile — les piles sont stables et ne vibrent pas — et c’est aussi pourquoi le rebond doit y être rajouté explicitement.',
        { note: 'Dans cette application, les contacts sont quasiment inélastiques. Cela a une conséquence visible sur la planche de Galton du module bonus : sans frottement de l’air, les billes gardent leur élan latéral et l’histogramme obtenu n’est pas une courbe en cloche.' });
      CARD(32, 1, 2);
    });

    // ════════════════════════════════════════════════════════════════════
    // MODULE 3 — AVBD : le pas de temps comme minimisation
    // ════════════════════════════════════════════════════════════════════
    PART('Variationnel');
    CH('Le paysage d’énergie', 46, () => {
      SCENE(0, 'pyramid');
      G(0, 46, 'landscape', undefined, true);
      C(0, 'L’énergie comme une altitude',
        'Une bille dans un bol finit au fond ; un ressort tendu se détend ; une pyramide de briques reste debout parce qu’aucun mouvement ne ferait baisser son énergie. L’énergie se comporte comme une altitude : chaque configuration possible est un point d’un paysage, et l’équilibre est le fond d’une vallée.',
        { note: 'L’énergie de pesanteur vaut m·g·hauteur ; celle d’un ressort, ½·k·(allongement)². Plus le ressort est raide — k grand —, plus la vallée qui lui correspond est étroite et profonde.' });
      C(15, 'La pente et la courbure',
        'Pour trouver le fond sans voir tout le paysage, deux informations locales suffisent. La pente — le gradient — dit de quel côté descendre. La courbure — la hessienne — dit à quelle vitesse la pente change, donc jusqu’où aller : là où la courbure est forte, le fond est tout près. Sur le schéma, la droite rose est la pente, la parabole orange la courbure.');
      C(30, 'La méthode de Newton',
        'La méthode de Newton remplace le paysage, autour du point courant, par la parabole qui a la même pente et la même courbure, et saute à son fond. Si le paysage est lui-même une parabole, un seul saut suffit ; sinon, il en faut quelques-uns. C’est exactement ce que fera AVBD pour chaque corps, quelques chapitres plus loin.',
        { code: 'déplacement = − pente / courbure\n// en plusieurs dimensions : Δ = −H⁻¹·g' });
      Q(40, 'q-landscape', 'À l’endroit où se trouve la bille, la pente est nulle et la courbure positive. Où est-elle ?',
        ['au fond d’une vallée : à l’équilibre', 'au sommet d’une bosse', 'au milieu d’une pente'], 0,
        'Pente nulle : aucun côté ne descend. Courbure positive : le terrain remonte dans les deux sens. C’est un minimum, un équilibre stable. Avec une courbure négative, ce serait un sommet — un équilibre instable, comme une bille posée sur une bosse.');
    });

    CH('Ressorts raides et pas implicite', 50, () => {
      G(0, 50, 'stiff', undefined, true);
      C(0, 'Modéliser un contact par un ressort',
        'Une façon simple de faire respecter un contact est d’y placer un ressort qui repousse les corps quand ils s’enfoncent. Pour que l’enfoncement reste invisible, ce ressort doit être extrêmement raide. Or un ressort raide oscille très vite — et un pas de temps fixe ne peut pas suivre une oscillation plus rapide que lui.',
        { layers: 3 });
      C(15, 'La limite du pas explicite',
        'Avec Euler semi-implicite, tout va bien tant que le pas reste petit devant la période d’oscillation : précisément, tant que h·√(k/m) reste sous 2. Au-delà, chaque pas amplifie l’erreur du précédent, et la simulation diverge en quelques images. Pour un contact assez raide pour être invisible, ce nombre se compte en dizaines.',
        { hud: (v) => `h·√(k/m) = ${v.stiff.toFixed(2)} → ${v.stiff < 2 ? 'stable' : 'le semi-implicite diverge'}`,
          note: 'Exemple : une caisse d’un kilo sur un ressort de 10⁵ N/m, à 60 pas par seconde : h·√(k/m) ≈ 5. Le ressort a le temps de faire presque une oscillation complète pendant un seul pas : le calcul pas à pas n’a plus de sens.' });
      I(28, 36, {
        title: 'Durcissez le ressort',
        prompt: 'Augmentez la raideur, mesurée par h·√(k/m). La courbe rouge (semi-implicite) suit la vraie oscillation, en bleu, tant que la valeur reste sous 2, puis diverge. La verte (implicite) reste toujours stable.',
        controls: [{ type: 'range', key: 'stiff', label: 'h·√(k/m)', min: 0.1, max: 4, step: 0.05, fmt: (v) => v.toFixed(2) }],
        diag: true,
        seq: true,
        goals: [
          { label: 'Restez sous 0,5 : les courbes se suivent', test: ({ v }) => v.stiff <= 0.5 },
          { label: 'Dépassez 2 : la rouge diverge', test: ({ v }) => v.stiff > 2.05 },
        ],
      });
      C(37, 'Euler implicite',
        'Euler implicite calcule les forces non pas à la position de départ, mais à la position d’arrivée — qu’on ne connaît pas encore. Il faut donc résoudre une équation à chaque pas, ce qui coûte plus cher ; mais le résultat ne diverge jamais, quelle que soit la raideur. Il amortit un peu trop les oscillations rapides : pour un contact, qui ne doit surtout pas osciller, c’est une qualité.',
        { note: 'C’est la raison du détour par l’énergie : le chapitre suivant montre que ce pas implicite revient à chercher le fond d’une vallée.' });
    });

    CH('Un pas de temps est une minimisation', 54, () => {
      SCENE(0, 'onebox', { solver: 3, iterations: 10, substeps: 4 });
      G(0, 54, 'minimise', undefined, true);
      C(0, 'Changer de point de vue',
        'Ce chapitre présente l’idée centrale du cours. Au lieu de demander « quelles forces appliquer pour que rien ne se traverse ? », on demande : « parmi toutes les positions possibles à l’instant t + h, laquelle est la meilleure ? ». Le pas de temps devient un problème d’optimisation.',
        { layers: 1 });
      C(15, 'L’énergie incrémentale',
        'La quantité à minimiser comporte deux termes qui se disputent. Le premier punit l’écart à la position inertielle x̃ — là où le corps irait tout seul —, pondéré par sa masse divisée par h². Le second est l’énergie des contraintes : il punit les interpénétrations. Le minimum est le compromis : aussi proche que possible du mouvement libre, tout en respectant les contacts.',
        { code: 'x* = argmin  ½ (x − x̃)ᵀ (M/h²) (x − x̃)  +  E(x)\n            ╰─ inertie ─╯          ╰ contraintes ╯\n\n// x̃ = x + h·v + h²·a   (la prédiction du module 1)', layers: 1 });
      C(30, 'Le lien avec Euler implicite',
        'Il ne s’agit pas d’une approximation : tant que les forces dérivent d’une énergie — ressorts, pesanteur, contacts écrits comme des pénalités —, le minimum de cette énergie est exactement le pas d’Euler implicite. L’intérêt de cette formulation est qu’une minimisation offre des outils qu’une équation n’offre pas : on peut s’arrêter en cours de route avec une solution imparfaite mais raisonnable, et surtout on peut optimiser un bloc de variables à la fois.',
        { note: 'Un solveur par impulsions qui manque d’itérations n’a pas de mesure du « mieux » : il a corrigé certains contacts et pas d’autres. Une descente interrompue, elle, a fait baisser l’énergie à chaque étape : on sait qu’on a amélioré le compromis, même si on ne l’a pas atteint. C’est ce qui rend ces méthodes robustes.' });
      Q(45, 'q-min', 'Dans l’énergie à minimiser, que se passe-t-il si l’on divise h par deux ?',
        ['le terme d’inertie compte quatre fois plus', 'le terme de contrainte compte quatre fois plus', 'rien ne change : les deux sont divisés par h²'], 0,
        'Le terme d’inertie est pondéré par M/h² : diviser h par deux le multiplie par quatre, tandis que l’énergie des contraintes ne dépend pas de h. Plus le pas est court, plus le corps « tient » à sa trajectoire libre : à raideur égale, un ressort de contact paraît plus mou. C’est pour cela que la raideur utile se compte en multiples de M/h². En contrepartie, sur un pas plus court, il y a bien moins de chemin à corriger.');
    });

    PART('Pénalités');
    CH('Descente par blocs', 48, () => {
      G(0, 48, 'block', undefined, true);
      C(0, 'Un corps à la fois',
        'Minimiser sur tous les corps simultanément demanderait de résoudre un grand système linéaire creux à chaque itération. La descente par blocs de sommets — Vertex Block Descent — fait bien plus simple : on prend un corps, on suppose tous les autres figés, et on trouve la position optimale de ce corps-là. Puis le suivant. C’est du Gauss-Seidel, mais sur les corps au lieu des contraintes.',
        { layers: 4 });
      C(15, 'Un système 6×6 par corps',
        'Pour un corps, les inconnues sont ses six degrés de liberté. On accumule le gradient de l’énergie et sa dérivée seconde — la hessienne — sur toutes les contraintes qui le touchent, puis on résout un système 6×6 et on applique le déplacement. Six inconnues : c’est un petit système, résolu directement, sans itération interne. (En 2D, il n’en reste que trois — x, y et l’angle : le mini-moteur du cours résout des systèmes 3×3.)',
        { code: 'H = M/h² + Σ kᵢ JᵢᵀJᵢ          // 6×6, symétrique\ng = M/h²·(x − x̃) + Σ fᵢ·Jᵢ     // 6 composantes\nΔ = −H⁻¹ g;  x += Δ;' });
      C(31, 'Le rôle du terme d’inertie',
        'Le M/h² sur la diagonale rend la hessienne toujours inversible, même sans aucun contact : il n’y a jamais de cas dégénéré à traiter. Et il sert de régularisation naturelle — c’est lui qui borne le déplacement d’une itération quand les contraintes deviennent très raides.',
        { note: 'Ce système est symétrique et, grâce au terme M/h², défini positif : on peut le résoudre directement, sans pivot. Le module 4 montre comment le moteur l’organise sur la carte graphique.' });
      I(42, 46, {
        title: 'Suivez une itération',
        prompt: 'Le schéma montre une itération, corps par corps. Faites défiler : la flèche orange est le gradient (la direction dans laquelle l’énergie décroît), l’ellipse est la hessienne (la forme locale de l’énergie), et le déplacement appliqué combine les deux.',
        controls: [{ type: 'range', key: 'frame', label: 'étape de la descente', min: 0, max: 24, step: 1, fmt: (v) => `${Math.round(v)} / 24` }],
        diag: true,
      });
    });

    CH('Raideur et convergence', 46, () => {
      G(0, 46, 'valley', undefined, true);
      C(0, 'Deux corps, un ressort',
        'Prenons deux corps reliés par un ressort de contact. L’énergie dépend de leurs deux positions : c’est un paysage à deux dimensions, dessiné ici en lignes de niveau. La descente par blocs le parcourt comme un randonneur qui n’aurait le droit de marcher que vers l’est ou vers le nord : elle place au mieux le premier corps, puis le second, puis recommence.',
        { layers: 4 });
      C(15, 'Quand la vallée se resserre',
        'Plus le ressort est raide par rapport à l’inertie, plus la vallée est étroite et oblique. Chaque pas « un corps à la fois » bute alors contre ses flancs, et la descente zigzague vers le fond à tout petits pas. Avec un ressort comparable à l’inertie, une poignée de balayages suffit ; cent fois plus raide, il en faut des centaines.',
        { note: 'Les mathématiciens parlent de mauvais conditionnement : le problème est bien posé, mais très allongé. Ce n’est pas une instabilité — chaque balayage se rapproche du fond —, c’est une lenteur. Et un budget fixe d’itérations s’arrête alors loin du but.' });
      I(28, 40, {
        title: 'Resserrez la vallée',
        prompt: 'Augmentez la raideur du ressort, mesurée en multiples de l’inertie M/h², et comptez les balayages nécessaires pour atteindre le fond.',
        controls: [{ type: 'range', key: 'cond', label: 'raideur (× M/h²)', min: 0.2, max: 200, step: 0.2, fmt: (v) => (v < 10 ? v.toFixed(1).replace('.', ',') : String(Math.round(v))) }],
        diag: true,
        seq: true,
        goals: [
          { label: 'Raideur 1 : quelques balayages', test: ({ v }) => v.cond <= 1.2 },
          { label: 'Raideur 100 : comptez', test: ({ v }) => v.cond >= 100 },
        ],
      });
      C(41, 'Conséquence pour les contacts',
        'Pour un contact, cela veut dire qu’augmenter la raideur a un prix : au-delà d’un certain point, elle ne rend plus le contact plus dur, elle ralentit seulement la descente. Le chapitre suivant le mesure sur une pile.',
        { layers: 4 });
    });

    CH('La pénalité', 54, () => {
      SCENE(0, 'stack', { solver: 2 });
      G(0, 54, 'penalty');
      C(0, 'L’énergie de pénalité',
        'Reprenons le ressort de contact du chapitre « Ressorts raides et pas implicite », écrit cette fois comme une énergie : ½·k·C², active seulement en cas d’interpénétration. C’est ce qu’on appelle une pénalité, et c’est ce que calcule le solveur « pénalité » du schéma.',
        { code: 'E(C) = C < 0 ? 0.5 * {{kPenalty|1e3|1e6|1e3}} * C*C : 0.0;\nf    = k * C;        // la force : proportionnelle à l’enfoncement', layers: 3 });
      C(16, 'L’enfoncement résiduel est inévitable',
        'Un ressort ne pousse que s’il est comprimé : la force vaut k·C, donc un contact qui doit porter une force F s’enfonce nécessairement de F/k. Pour une caisse d’un kilo, avec k = 10⁴, cela fait un millimètre. La caisse du bas d’une pile de dix porte dix fois plus : près de cinq millimètres, même en partageant la charge entre ses deux coins. La pile paraît alors molle.',
        { hud: (v) => `k = ${v.kPenalty.toExponential(1)} N/m · 10 kg sur un seul contact : ${(98.1 / v.kPenalty * 1000).toFixed(2)} mm d’enfoncement` });
      C(31, 'Augmenter k',
        'C’est la solution la plus directe, mais elle se heurte à la limite vue au chapitre précédent : quand k devient grand devant M/h², la descente par blocs ralentit. Au-delà d’un certain k, l’enfoncement cesse donc de baisser : ce n’est plus la raideur qui le fixe, c’est le nombre d’itérations, et la raideur supplémentaire ne sert à rien.',
        { note: 'La pénalité a donc deux limites : une raideur faible donne des contacts mous, une raideur forte un calcul qui ne converge plus. De plus, la bonne raideur dépend de la charge — une enclume demande un ressort bien plus raide qu’une plume —, et cette charge n’est pas connue à l’avance. AVBD est conçu pour lever cette difficulté.' });
      I(42, 50, {
        id: 'Les deux murs',
        title: 'Les deux limites de la pénalité',
        prompt: 'Réglez la raideur du solveur « pénalité » et lisez l’enfoncement mesuré sur la pile. Repérez les deux limites : un contact trop mou, puis le plateau où augmenter k ne sert plus à rien. Changez ensuite le nombre d’itérations : c’est lui qui fixe la hauteur du plateau.',
        controls: [
          { type: 'range', key: 'kPenalty', label: 'k (raideur)', min: 1e3, max: 1e6, step: 1e3, fmt: (v) => v.toExponential(1) },
          { type: 'range', key: 'iterations', label: 'itérations', min: 1, max: 20, step: 1, fmt: (v) => String(Math.round(v)) },
        ],
        diag: true,
        seq: true,
        goals: [
          { label: 'k = 10⁴ ou moins : la pile s’enfonce visiblement', test: ({ v }) => v.kPenalty <= 1e4 },
          { label: 'k ≥ 4·10⁵ : la courbe s’aplatit, l’enfoncement ne baisse presque plus', test: ({ v }) => v.kPenalty >= 4e5 },
          { label: 'Descendez à 2 itérations : le plateau remonte', test: ({ v }) => v.kPenalty >= 4e5 && v.iterations <= 2 },
        ],
      });
    });

    PART('AVBD');
    CH('Le multiplicateur λ', 56, () => {
      SCENE(0, 'stack', { solver: 3 });
      G(0, 56, 'lambda', undefined, true);
      C(0, 'Ajouter un terme de force',
        'L’enfoncement résiduel d’une pénalité vient de ce que le ressort doit être comprimé pour produire sa force. AVBD ajoute donc à l’énergie un terme linéaire, λ·C, où λ est une estimation de la force que le contact doit fournir.',
        { code: 'E(C) = 0.5 * k * C*C  +  λ * C\n//     ╰─ pénalité ─╯     ╰ lagrangien ╯\nf    = k * C + λ;', layers: 5 });
      C(16, 'Lagrangien augmenté',
        'Ce mélange d’un terme de pénalité et d’un multiplicateur porte un nom classique en optimisation : le lagrangien augmenté. λ est le multiplicateur de Lagrange de la contrainte, et il converge vers la vraie force du contact. Quand λ est juste, C peut valoir zéro exactement, quelle que soit la raideur : f = k·0 + λ = λ.',
        { note: 'Autrement dit, on ne demande plus à la raideur de produire la force. La pénalité ne sert plus qu’à guider la descente ; c’est λ qui porte la charge, et l’enfoncement résiduel disparaît.' });
      C(32, 'La mise à jour duale',
        'Reste à trouver λ. On l’estime par essais successifs : après chaque itération, on regarde ce qu’il reste comme violation, et on ajoute k·C au multiplicateur. Si la contrainte est encore enfoncée, λ grossit (il devient plus négatif) et poussera plus fort la fois suivante. Si le contact se sépare, λ remonte vers zéro et le contact se relâche de lui-même. Tant que le contact pousse, la raideur k augmente aussi, d’autant plus vite qu’il reste d’erreur.',
        { code: 'λ ← min(0, λ + k·C);       // ≤ 0 : un contact ne tire pas\nif (λ < 0)                 // tant que le contact pousse,\n  k ← k + {{beta|1e4|1e7|1e4}}·|C|;   // la raideur monte',
          note: 'Pourquoi ajouter k·C ? C’est la part de la force que le ressort fournit encore par sa compression. Une fois cette part reportée dans λ, le ressort peut se détendre à l’itération suivante sans que la force totale diminue.' });
      C(46, 'Le résultat mesuré',
        'Le schéma fait l’expérience sur un seul contact, enfoncé de quatre millimètres : la pénalité seule (k = 2·10⁴) reste bloquée à un demi-millimètre, aussi longtemps qu’on itère. Avec le multiplicateur, le même contact descend sous le micron en cinq itérations : une erreur mille fois plus faible, pour le même nombre d’itérations. Sur la pile de dix caisses, avec huit itérations : moins d’un dixième de millimètre, contre près de trois avec la pénalité seule.',
        { hud: (v) => `${Math.round(v.iterations)} itérations · β = ${v.beta.toExponential(0)}`, layers: 5 });
    });

    CH('Quand mettre λ à jour', 46, () => {
      G(0, 46, 'dualtiming');
      C(0, 'Une fois par sous-pas, ou à chaque itération ?',
        'Ce choix a un effet important. Si l’on ne met λ à jour qu’une fois par sous-pas, il n’a pas le temps de servir : pendant le choc, seule la pénalité arrête le corps, comme un ressort que l’on comprime. Et un ressort comprimé se détend : le corps est renvoyé vers le haut alors qu’on n’a demandé aucun rebond.',
        { note: 'Sur le schéma, une caisse lâchée de deux mètres sur un sol parfaitement mou rebondit de près d’un mètre dans le premier cas. Le symptôme ressemble à un problème de restitution ; la cause est ailleurs, dans le calendrier de la mise à jour duale. Dans un moteur physique, l’effet visible est souvent éloigné de sa cause.' });
      C(15, 'Une mise à jour à chaque itération',
        'En entrelaçant les deux — une descente primale, puis une mise à jour duale, et ainsi de suite —, le multiplicateur a le temps de converger à l’intérieur du sous-pas. La caisse s’arrête net, à la surface, au micron près, et sa vitesse finale est nulle.');
      C(29, 'Pourquoi la raideur a un plafond',
        'La raideur monte tant que le contact pousse. Sans limite, elle finirait par dominer largement M/h², et la descente par blocs ne convergerait plus (chapitre « Raideur et convergence »). Le mini-moteur la plafonne donc à trois fois M/h², en prenant la masse du corps le plus lourd du contact.',
        { code: 'k ← min(kMax, k + β·|C|);\n// kMax = 3 × M/h² du corps le plus lourd' });
      Q(41, 'q-cap', 'Pourquoi le plafond de la raideur dépend-il de la masse des corps en contact ?',
        ['pour économiser des calculs sur les corps légers', 'parce qu’un corps lourd a besoin d’une raideur plus grande pour être porté, alors qu’un plafond trop haut pour sa masse fait diverger la descente', 'parce que les corps lourds tombent plus vite'], 1,
        'La raideur utile se compte en multiples de M/h². Un contact sous un bloc d’une tonne doit pouvoir monter mille fois plus haut que sous une caisse d’un kilo ; mais un plafond fixe assez haut pour la tonne serait, pour la caisse, des milliers de fois trop raide, et la descente par blocs ne convergerait plus. Un plafond relatif à la masse donne à chaque contact la bonne échelle.');
    });

    PART('Réglages');
    CH('β : la montée de la raideur', 42, () => {
      G(0, 42, 'beta');
      C(0, 'La vitesse de montée',
        'La règle a été vue avec la mise à jour duale : à chaque itération où le contact pousse, k gagne β·|C|. La montée est donc forte au moment d’un choc et presque nulle quand le contact est fermé. Avec un β petit, la contrainte se ferme lentement ; avec un β grand, la raideur atteint vite son plafond, et c’est alors le plafond qui détermine le résultat.',
        { code: 'k ← min(kMax, k + {{beta|1e4|1e7|1e4}}·|C|);',
          hud: (v) => `β = ${v.beta.toExponential(0)} : un enfoncement d’un millimètre ajoute ${Math.round(v.beta * 1e-3)} N/m par itération` });
      C(15, 'Les valeurs du vrai moteur',
        'Le moteur de cette application suit la même règle, avec ses propres valeurs : β = 10⁴ pour les contacts et 10⁵ pour les articulations (le chapitre « Articulations et ruptures » explique cet écart). Ces valeurs se règlent dans l’onglet « Scene ».',
        { note: 'Trop haut, β rapproche la raideur de la seconde limite vue au chapitre « La pénalité » : en flottants 32 bits, avec dix itérations, le moteur GPU diverge vers β = 10⁶, et les pièces fines comme les dominos sont les premières à être projetées.' });
      I(28, 38, {
        title: 'Réglez β',
        prompt: 'Le schéma trace l’enfoncement d’un vrai contact au fil des itérations, pour plusieurs valeurs de β. Cherchez un réglage qui le ferme sous le micron. Remarquez qu’au-delà d’un certain β, les courbes ne bougent plus : le plafond a pris le relais.',
        controls: [
          { type: 'range', key: 'beta', label: 'β', min: 1e4, max: 1e7, step: 1e4, fmt: (v) => v.toExponential(1) },
          { type: 'range', key: 'iterations', label: 'itérations', min: 1, max: 30, step: 1, fmt: (v) => String(Math.round(v)) },
        ],
        diag: true,
        goals: [
          { label: 'Fermez la contrainte sous le micron en six itérations au plus', test: ({ v }) => v.beta >= 5e5 && v.iterations >= 5 && v.iterations <= 6 },
        ],
      });
    });

    CH('γ et α : démarrage à chaud et stabilisation', 46, () => {
      G(0, 46, 'warm');
      C(0, 'γ : le démarrage à chaud',
        'Une scène à l’équilibre refait presque le même calcul à chaque sous-pas. Plutôt que de repartir de zéro, chaque contact garde la raideur qu’il avait atteinte, atténuée par un facteur γ légèrement inférieur à 1. La descente part alors d’un contact déjà « dur » : c’est pour cela qu’une pile posée reste immobile au lieu de se tasser à chaque image.',
        { code: 'k ← max(kMin, γ·k_précédent);    // γ ≈ 0.99\n// mini-moteur : λ repart de 0 et se reconstruit en quelques itérations\n// moteur GPU  : λ ← α·γ·λ_précédent, il est conservé lui aussi',
          note: 'Faut-il aussi conserver λ ? L’article d’AVBD le fait, et le moteur GPU aussi. Le mini-moteur, lui, s’en abstient : dans ses petites scènes, un λ hérité qui s’ajoute à une raideur déjà dimensionnée pour la charge pousse trop fort, et un objet lourd posé sur un léger se fait éjecter. Deux bons moteurs peuvent faire des choix différents — c’est la mesure qui tranche.' });
      C(15, 'Apparier les contacts',
        'Pour réutiliser ce qu’un contact a appris, il faut le reconnaître d’un sous-pas à l’autre. Si la phase étroite renumérote ses points, cette mémoire est perdue et le solveur repart de zéro : la pile se remet à vibrer. La stabilité d’une pile dépend donc de la façon dont on retrouve les points d’un manifold d’un pas à l’autre.',
        { note: 'γ trop bas, la mémoire s’efface et les piles se tassent : sur le schéma, sans mémoire, l’enfoncement est quinze fois plus grand. γ égal à 1, rien ne s’oublie : un contact garde longtemps une raideur dont il n’a plus besoin. γ = 0,99 réduit la mémoire de moitié en soixante-neuf sous-pas — avec quatre sous-pas par image, un peu moins d’un tiers de seconde.' });
      C(30, 'α : corriger l’enfoncement progressivement',
        'Quand un pas commence avec des corps déjà enfoncés — après un choc violent, ou parce qu’on vient d’en faire apparaître un —, les ressortir en un seul pas leur donnerait une vitesse énorme : ils seraient éjectés. AVBD vise donc une contrainte adoucie : il ne cherche à effacer, à chaque pas, qu’une fraction 1 − α de l’enfoncement du départ. Avec α = 0,95, valeur de cette application, un recouvrement se résorbe en douceur sur quelques dizaines de sous-pas.',
        { code: 'C̃(x) = C(x) − {{alpha|0.5|1|0.01}} · C(x₀)   // x₀ : la pose au début du pas\n// le solveur pousse C̃ vers 0, pas C',
          note: 'Le revers : tout enfoncement « pardonné » ne disparaît pas tout à fait. Si chaque sous-pas laisse une petite erreur, α en garde l’essentiel, et ces restes s’accumulent. Le mini-moteur du cours, dont les contacts se ferment presque exactement, préfère donc α = 0 : il efface tout l’enfoncement d’un coup. Dans l’atelier, la lettre α désigne autre chose, la part de pesanteur mise dans la prédiction.' });
    });

    CH('Combien d’itérations, combien de sous-pas', 50, () => {
      SCENE(0, 'stack', { solver: 3 });
      G(0, 50, 'converge');
      C(0, 'La courbe de convergence',
        'Voici l’enfoncement maximal d’une pile de dix caisses, mesuré sur quatre secondes de simulation, en fonction du nombre d’itérations. Ce n’est pas un dessin : le schéma lance le mini-moteur. Avec quatre sous-pas, on passe d’un millimètre et demi à une itération à moins d’un dixième à huit, puis à un centième vers vingt-quatre. La décroissance est rapide au début, puis de plus en plus lente.',
        { hud: (v) => `${Math.round(v.iterations)} itérations × ${Math.round(v.substeps)} sous-pas = ${Math.round(v.iterations * v.substeps)} balayages par image`, layers: 6 });
      C(16, 'Itérer plus, ou découper plus fin ?',
        'Le produit itérations × sous-pas mesure le coût. À coût égal, lequel choisir ? Tout dépend de ce qui bouge. Une pile au repos n’a presque rien à corriger d’un pas à l’autre : des itérations suffisent, et la courbe rouge — un seul sous-pas — finit d’ailleurs par rejoindre les autres. Mais dès que les corps vont vite, les sous-pas deviennent indispensables : ils réduisent la distance parcourue entre deux détections et rafraîchissent les normales de contact, ce qu’aucune itération ne sait faire.');
      I(28, 44, {
        id: 'Dépensez votre budget',
        title: 'Répartissez le budget',
        prompt: 'Vous avez un budget de balayages. Répartissez-le entre itérations et sous-pas, et regardez l’enfoncement mesuré sur cette pile au repos. Les deux réglages se valent presque ici : gardez ce résultat en tête pour les dominos du chapitre suivant.',
        controls: [
          { type: 'range', key: 'iterations', label: 'itérations', min: 1, max: 24, step: 1, fmt: (v) => String(Math.round(v)) },
          { type: 'range', key: 'substeps', label: 'sous-pas', min: 1, max: 8, step: 1, fmt: (v) => String(Math.round(v)) },
        ],
        diag: true,
        seq: true,
        goals: [
          { label: '1 sous-pas, 16 itérations : notez l’enfoncement', test: ({ v }) => v.substeps === 1 && v.iterations >= 16 },
          { label: 'Même budget autrement : 4 sous-pas, 4 itérations', test: ({ v }) => v.substeps === 4 && v.iterations === 4 },
        ],
      });
    });

    CH('Les réglages de cette application', 48, () => {
      SCENE(0, 'dominoes', { solver: 3 });
      C(0, 'Les paramètres de l’onglet « Scene »',
        'Dans Loop Lab, l’onglet « Scene » expose exactement les paramètres de ce module : gravité, sous-pas, itérations, α, β contacts, β articulations, γ, frottement, et le nombre de couleurs du module suivant. Vous savez maintenant ce que chacun fait — et pourquoi aucun n’a de valeur universellement bonne.',
        { layers: 6 });
      C(14, 'Le cas des corps fins',
        'Un domino de quatre centimètres et demi d’épaisseur est le cas difficile : sa boîte est très allongée, son inertie faible autour de l’axe où il bascule, et sa tête, qui tombe à trois ou quatre mètres par seconde, parcourt son épaisseur en une douzaine de millisecondes : moins qu’un pas de 16,7 ms. Les présélections de cette application montent à quatre, six, parfois huit sous-pas dès qu’il y a des pièces minces ou des grains.',
        { hud: (v) => `${Math.round(v.substeps)} sous-pas · ${Math.round(v.iterations)} itérations` });
      Q(20, 'q-budget', 'Budget fixe de 16 balayages par image, pour une rangée de dominos très fins. Quel découpage choisir ?',
        ['16 itérations, 1 sous-pas', '4 itérations, 4 sous-pas', 'cela ne change rien : c’est le même coût'], 1,
        'Avec un seul sous-pas, les dominos avancent de plus que leur épaisseur entre deux détections de collision : le contact est vu trop tard, ou pas du tout, et aucune itération ne peut rattraper une contrainte mal posée. Quatre sous-pas divisent le déplacement par quatre et refont la phase étroite quatre fois par image au lieu d’une.');
      I(24, 44, {
        id: 'Cassez la rangée de dominos',
        title: 'Sous-pas et dominos',
        prompt: 'Descendez les sous-pas à 1 : les dominos se traversent ou sont projetés. Remontez-les : la rangée tombe proprement. La scène est recalculée à chaque changement — laissez-la terminer avant de juger.',
        controls: [
          { type: 'range', key: 'substeps', label: 'sous-pas', min: 1, max: 8, step: 1, fmt: (v) => String(Math.round(v)) },
          { type: 'range', key: 'iterations', label: 'itérations', min: 2, max: 20, step: 1, fmt: (v) => String(Math.round(v)) },
          { type: 'range', key: 'gravity', label: 'gravité (m/s²)', min: 4, max: 30, step: 0.5, fmt: (v) => v.toFixed(1) },
        ],
        seq: true,
        goals: [
          { label: 'Un seul sous-pas : observez la rangée', test: ({ v }) => v.substeps === 1 },
          { label: 'Remontez à 4 sous-pas au moins', test: ({ v }) => v.substeps >= 4 },
        ],
      });
    });

    CH('Articulations et ruptures', 42, () => {
      SCENE(0, 'chain');
      G(0, 42, 'joint');
      C(0, 'Une rotule est une contrainte d’égalité',
        'Une articulation s’écrit comme un contact, avec deux différences : elle impose C = 0 au lieu de C ≥ 0 — elle tire autant qu’elle pousse, donc son multiplicateur n’est pas borné à des valeurs négatives —, et elle porte sur les trois directions au lieu d’une seule.',
        { code: 'C = (x_A + R_A·r_A) − (x_B + R_B·r_B)   // trois composantes\n// λ libre : une rotule tire aussi bien qu’elle pousse' });
      C(14, 'Pourquoi les articulations sont plus raides',
        'Une chaîne est une file de contraintes en série, et chaque maillon ne voit que ses deux voisins. Avec une raideur trop faible, l’erreur de chaque maillon s’additionne : la chaîne s’allonge visiblement sous le poids de la boule. D’où un β dix fois plus élevé que pour les contacts.',
        { note: 'Un boulet de démolition pèse quarante fois le bloc qu’il frappe. Les grands rapports de masse sont une autre difficulté pour la descente par blocs : le corps léger reçoit une correction énorme à chaque itération, et il faut plusieurs balayages pour que l’information remonte jusqu’au corps lourd.' });
      C(28, 'La force de rupture',
        'Si l’on mesure la force portée par une articulation — c’est précisément son multiplicateur —, on peut la supprimer au-delà d’un seuil. Cette application appelle cela la « force de rupture » : un mur collé qui se désagrège quand la boule frappe, une chaîne qui lâche. Une ligne de code suffit, parce que λ représente la force réellement transmise par l’articulation.',
        { code: 'if (abs(joint.lambda) > joint.fracture) joint.broken = true;' });
      CARD(40, 2, 3);
    });

    // ════════════════════════════════════════════════════════════════════
    // MODULE 4 — Le calcul sur carte graphique
    // ════════════════════════════════════════════════════════════════════
    PART('Parallèle');
    CH('Comment fonctionne une carte graphique', 52, () => {
      SCENE(0, 'crowd');
      G(0, 52, 'gpu', undefined, true);
      C(0, 'Le même programme sur beaucoup de données',
        'Un processeur exécute quelques programmes très vite, l’un après l’autre. Une carte graphique fait l’inverse : des milliers de voies d’exécution, chacune modeste, qui exécutent le même programme sur des données différentes — une voie par pixel pour afficher une image, une voie par corps pour un moteur physique.',
        { layers: 7, note: 'Dans WebGPU, ce programme s’appelle un « compute shader » ; ce cours dit noyau de calcul.' });
      C(14, 'Les paquets de trente-deux voies',
        'Les voies ne sont pas indépendantes : elles avancent par paquets de trente-deux, qui exécutent la même instruction au même instant. Si certaines voies d’un paquet prennent l’autre branche d’un « if », les autres les attendent. Un ou plusieurs paquets forment un groupe de travail, qui partage une petite mémoire très rapide.',
        { note: 'La taille exacte du paquet dépend du matériel : trente-deux chez Apple et NVIDIA, trente-deux ou soixante-quatre chez AMD.' });
      C(28, 'Masquer l’attente de la mémoire',
        'Lire une donnée en mémoire principale prend des centaines de cycles. Pendant qu’un paquet attend sa donnée, la carte graphique en fait avancer un autre. C’est pour cela qu’il faut beaucoup plus de travail que de voies — et pourquoi une scène de dix corps ne va pas plus vite sur une carte graphique que sur un processeur.');
      C(40, 'Le rôle du processeur',
        'Le processeur ne calcule rien de la simulation : il prépare une liste de lancements — tel noyau, sur tant de corps — et l’envoie d’un coup. Chaque lancement a un coût fixe, et doit finir avant que le suivant puisse lire ses résultats. Le caractère séquentiel de Gauss-Seidel et le coût des lancements sont les deux obstacles que traite la suite du module.',
        { layers: 7 });
    });

    CH('Gauss-Seidel et le parallélisme', 46, () => {
      SCENE(0, 'crowd');
      G(0, 46, 'conflict');
      C(0, 'Un algorithme séquentiel',
        'Tout ce qui précède suppose qu’on traite les corps les uns après les autres, chacun voyant les corrections des précédents. Sur une carte graphique, traiter les corps l’un après l’autre est le cas le moins favorable : on dispose de milliers de voies d’exécution, et on n’en utiliserait qu’une.',
        { layers: 7 });
      C(14, 'Pourquoi ne pas tout faire en même temps',
        'Dans AVBD, chaque voie résout un corps : elle lit la position de ses voisins, calcule la sienne, l’écrit. Si deux corps en contact sont résolus en même temps, chacun se place par rapport à la position périmée de l’autre : les deux font tout le chemin chacun, et se retrouvent trop loin — ou se chevauchent encore. Le résultat n’est plus du Gauss-Seidel mais la méthode de Jacobi, qui converge bien plus lentement — et parfois pas du tout.',
        { layers: 7,
          note: 'Les solveurs par impulsions ont le même problème sous une autre forme : deux contraintes traitées en même temps sur un corps commun écrivent toutes deux sa vitesse, et l’une efface la correction de l’autre.' });
      C(28, 'Le conflit est local',
        'La bonne nouvelle : deux corps ne se gênent que s’ils se touchent. Dans une scène de mille corps, chacun n’a que quelques voisins, et l’immense majorité des paires de corps sont parfaitement indépendantes. Il reste à les regrouper en ensembles indépendants.',
        { layers: 7 });
      Q(42, 'q-jacobi', 'Pourquoi la version parallèle naïve (Jacobi) converge-t-elle moins vite que Gauss-Seidel ?',
        ['parce qu’elle fait plus de calculs', 'parce que chaque corps se place par rapport à des voisins qui n’ont pas encore bougé', 'parce que les additions atomiques sont lentes'], 1,
        'Le nombre de calculs est le même. Ce qui change, c’est l’information disponible : dans Gauss-Seidel, le dixième corps voit déjà où se sont placés les neuf premiers. En Jacobi, tous partent du même état, et leurs corrections se contrarient. Il faut davantage d’itérations pour propager une même information.');
    });

    CH('La coloration de graphe', 48, () => {
      G(0, 48, 'colouring', undefined, true);
      C(0, 'Des groupes sans conflit',
        'Construisons un graphe : un sommet par corps, une arête entre deux corps qui se touchent. Colorions-le de sorte que deux voisins n’aient jamais la même couleur. Alors tous les corps d’une même couleur peuvent être résolus exactement en même temps — aucun ne dépend d’un autre de sa couleur —, et l’on obtient du vrai Gauss-Seidel, couleur après couleur.',
        { layers: 7 });
      C(15, 'Un algorithme glouton suffit',
        'Trouver le nombre minimal de couleurs est un problème difficile, mais on n’en a pas besoin. Un parcours glouton — pour chaque corps, la plus petite couleur qu’aucun de ses voisins n’utilise — garantit au pire « nombre maximal de voisins + 1 » couleurs, ce qui est amplement suffisant. C’est le défi n°8 de l’atelier.',
        { code: 'for (int i = 0; i < n; i++) {\n  used.clear();\n  for (int j : neighbours[i]) if (colour[j] >= 0) used.add(colour[j]);\n  int c = 0; while (used.has(c)) c++;\n  colour[i] = c;\n}' });
      C(30, 'Choisir le nombre de couleurs',
        'Chaque couleur coûte un lancement de noyau de calcul. Si l’on impose moins de couleurs que le graphe n’en demande, des voisins se retrouvent dans la même couleur et repassent en Jacobi : la convergence se dégrade. Si l’on en autorise plus que nécessaire, rien ne s’améliore, mais les lancements se multiplient et la carte graphique attend. Cette application expose ce plafond dans l’onglet « Scene » et le laisse à huit : assez pour la plupart des empilements.',
        { hud: (v) => `${Math.round(v.colors)} couleurs → ${Math.round(v.colors)} lancements par itération, ${Math.round(v.colors * v.iterations * v.substeps)} par image` });
      I(38, 44, {
        title: 'Coloriez',
        prompt: 'Le schéma colorie un graphe de contacts avec l’algorithme glouton, et compte les lancements que cela coûterait. Regardez ce que donne un nombre de couleurs imposé trop petit : les arêtes rouges sont des conflits, deux corps en contact résolus en même temps.',
        controls: [{ type: 'range', key: 'colors', label: 'couleurs autorisées', min: 2, max: 16, step: 1, fmt: (v) => String(Math.round(v)) }],
        diag: true,
        goals: [
          { label: 'Descendez à 2 couleurs : comptez les conflits', test: ({ v }) => v.colors <= 2 },
          { label: 'Remontez jusqu’à ce qu’il n’y ait plus aucun conflit', test: ({ v }) => v.colors >= 5 },
        ],
      });
    });

    CH('Un groupe de travail par corps', 46, () => {
      G(0, 46, 'workgroup', undefined, true);
      C(0, 'Une voie par corps',
        'L’idée naturelle : une voie d’exécution par corps, qui parcourt ses contacts et accumule son système 6×6. Sur un corps qui en a quarante, cette voie fait quarante lectures mémoire en série, chacune attendant la précédente. Le temps est passé à attendre la mémoire, pas à calculer.',
        { layers: 7 });
      C(15, 'Trente-deux voies, un corps',
        'La solution retenue par ce moteur : confier un corps entier à un groupe de trente-deux voies. Chaque voie prend un contact sur trente-deux, calcule sa part de gradient et de hessienne, puis le groupe additionne les trente-deux contributions en mémoire partagée — une réduction en cinq étages. Les lectures se font toutes en même temps.',
        { code: '// une « wide body solve » : 32 voies pour un corps\nlet lane = localId.x;\nfor (var c = lane; c < n; c += 32u) { accumulate(c); }\nworkgroupBarrier();\n// réduction en arbre : 32 → 16 → 8 → 4 → 2 → 1' });
      C(30, 'La mémoire, facteur limitant',
        'Cette organisation, avec le système 6×6 découpé en blocs 3×3, rend le calcul d’une pyramide de dix secondes plus de dix fois plus rapide que la version « une voie par corps ». Le facteur limitant n’est ni l’algorithme ni le nombre d’opérations : c’est l’attente de la mémoire, et la place que prennent les données dans les registres.',
        { note: 'C’est un constat fréquent en optimisation GPU : le code le plus lent n’est presque jamais celui qui calcule le plus. Il faut mesurer — ici, des horodatages par noyau de calcul — avant de toucher à quoi que ce soit.' });
    });

    CH('Le coût des lancements', 44, () => {
      G(0, 44, 'dispatch');
      C(0, 'Le prix d’un lancement',
        'On a vu que chaque lancement a un coût fixe, même s’il ne fait rien. Sur un ordinateur portable récent, ce coût est de l’ordre de six microsecondes. Or un seul pas de temps lance entre deux cents et trois cent cinquante noyaux : détection, construction de l’arbre, tri, une par couleur, par itération, par sous-pas.',
        { hud: (v) => `≈ ${Math.round(v.colors * v.iterations * v.substeps + 40)} lancements par image → ${((v.colors * v.iterations * v.substeps + 40) * 6 / 1000).toFixed(1)} ms de frais fixes` });
      C(15, 'Un moteur limité par les lancements',
        'Multipliez : trois cents lancements à six microsecondes font près de deux millisecondes par image uniquement en frais de lancement, avant tout calcul utile. C’est le régime dans lequel se trouve ce moteur : il est limité par le nombre de lancements, pas par la puissance de calcul. Les gains suivants viendront de listes compactes par couleur et de lancements indirects — pas d’arithmétique plus fine.',
        { code: '// tous les lancements d’une image en un seul envoi\nbatcher.flush();   // ~300 passes compute, 1 command buffer' });
      Q(32, 'q-dispatch2', 'Une scène passe de 1 000 à 2 000 corps, avec les mêmes couleurs, itérations et sous-pas. Dans un moteur limité par les lancements, quel est l’effet le plus probable sur le temps d’une image ?',
        ['il double : deux fois plus de corps à résoudre', 'il augmente peu : le nombre de lancements ne change pas', 'il diminue : chaque lancement est mieux rempli'], 1,
        'Le nombre de lancements dépend des couleurs, des itérations et des sous-pas, pas du nombre de corps. Tant que la carte graphique a des voies inoccupées, chaque lancement traite simplement plus de corps en même temps, pour un coût presque identique. Ce n’est plus vrai quand les lancements deviennent assez gros pour occuper toute la carte : le temps se met alors à croître avec le nombre de corps.');
    });

    CH('Les flottants 32 bits', 46, () => {
      G(0, 46, 'float', undefined, true);
      C(0, 'Sept chiffres significatifs',
        'Le moteur calcule en flottants de 32 bits : des nombres en notation scientifique, avec environ sept chiffres significatifs. Près de 1, on distingue des écarts d’un dix-millionième ; près de mille, d’un dix-millième seulement. C’est la précision relative qui est constante, pas la précision absolue.',
        { note: 'Le mini-moteur du cours, écrit en JavaScript, calcule en 64 bits — environ seize chiffres. C’est l’une des raisons pour lesquelles il supporte des raideurs que le moteur GPU ne supporte pas.' });
      C(14, 'Additionner petits et grands nombres',
        'Ajouter un très petit nombre à un très grand revient souvent à ne rien ajouter du tout : le résultat, arrondi à sept chiffres, retombe sur le grand. Un corps à un kilomètre de l’origine ne peut plus bouger d’un centième de millimètre. Et dans un solveur où une raideur de 10⁶ côtoie des enfoncements de 10⁻⁶ mètre, les termes qui comptent se perdent dans l’arrondi.');
      C(28, 'L’ordre des opérations compte',
        'Conséquence plus surprenante : (a + b) + c et a + (b + c) ne donnent pas toujours le même résultat. Sur le schéma, les deux dernières lignes font le même calcul dans deux ordres différents — calculé à l’instant, en vrais flottants 32 bits —, et n’arrondissent pas au même endroit. Le chapitre suivant en montre une conséquence.');
      Q(38, 'q-float', 'En flottants 32 bits, que vaut 100 000 000 + 1 − 100 000 000, calculé de gauche à droite ?',
        ['1', '0', 'une erreur'], 1,
        'Près de cent millions, deux flottants voisins sont séparés de 8 : ajouter 1 ne change rien, et 100 000 000 + 1 vaut encore 100 000 000. La soustraction donne alors 0. Dans l’autre ordre — (100 000 000 − 100 000 000) + 1 —, on obtient bien 1.');
    });

    CH('Déterminisme', 36, () => {
      G(0, 36, 'determinism');
      C(0, 'L’ordre des additions',
        'Sur une carte graphique, les additions atomiques s’exécutent dans un ordre qui dépend de l’ordonnancement du matériel. Comme on l’a vu au chapitre précédent, changer l’ordre des additions change l’arrondi. Deux exécutions identiques du même pas de temps donnent donc des résultats très légèrement différents.',
        { note: 'Ce n’est pas un bug, et on ne peut pas s’en débarrasser sans abandonner les atomiques — donc le parallélisme. Un moteur qui a besoin de déterminisme bit à bit (un jeu en réseau, un replay) doit organiser ses réductions en arbre à ordre fixe, et payer pour cela.' });
      C(15, 'Tester un moteur non déterministe',
        'Si la somme de contrôle change d’une exécution à l’autre, elle ne peut pas servir de test de non-régression. Il faut valider sur des grandeurs macroscopiques et stables : l’enfoncement maximal, la hauteur du sommet d’une pile, le nombre de dominos tombés, la forme d’un histogramme. Ce cours fait exactement cela : son mini-moteur est couvert par dix vérifications de ce type.',
        { code: '// src/course/mini.selftest.ts — miniSelfTest() dans la console\n✓ l’enfoncement décroît de façon monotone avec les itérations\n✓ une caisse glisse à g(sin θ − μ cos θ)\n✓ un corps lâché ne rebondit pas avec e = 0\n✓ un bloc d’une tonne tient sur une caisse d’un kilo\n✓ aucune scène ne gagne d’énergie' });
      CARD(34, 3, 4);
    });

    // ════════════════════════════════════════════════════════════════════
    // BONUS
    // ════════════════════════════════════════════════════════════════════
    PART('Liquides');
    CH('Simuler un liquide', 48, () => {
      SCENE(0, 'fluid');
      G(0, 48, 'mpm');
      C(0, 'Particules et grille',
        'Un liquide n’a pas de forme : le décrire par des solides reliés par des ressorts marche mal. Cette application utilise MLS-MPM, une méthode « matériau-point » : la matière est portée par des particules, mais les forces se calculent sur une grille fixe. On fait l’aller-retour entre les deux à chaque sous-pas.');
      C(15, 'Un aller-retour à chaque sous-pas',
        'Les particules transportent la masse, la vitesse et la déformation. À chaque sous-pas, on les projette sur la grille — les particules deviennent des nœuds —, on y calcule la pression et la viscosité, où le voisinage est trivial à trouver, puis on rend la vitesse corrigée aux particules. Les particules suivent la matière ; la grille facilite le calcul des forces.',
        { code: '1. P2G  particules → grille : masse et quantité de mouvement\n2. P2G  pression (Tait) et viscosité\n3. grille : intégration et conditions aux limites\n4. G2P  grille → particules : nouvelle vitesse' });
      C(31, 'Les conditions aux limites',
        'Les conditions aux limites doivent couvrir tous les nœuds de grille qui pilotent les particules au repos contre une paroi ; sinon elles s’aplatissent dedans, le liquide perd du volume et des jets grimpent le long des murs. Et une carte de collision qui ne regarde qu’un nœud fuit dans les coins : il faut consulter les huit nœuds voisins.',
        { note: 'Dans la scène, cinquante mille particules s’effondrent sur un pilier et emportent des cubes. Les cubes sont des corps AVBD ; l’eau est un solveur MPM. Ils partagent le même matériel et le même pas de temps.' });
    });

    CH('Couplage entre liquide et solides', 36, () => {
      G(0, 36, 'coupling');
      C(0, 'Des solides vers le liquide',
        'C’est le sens le plus simple : les corps rigides sont rastérisés dans une carte de collision, et la grille du liquide traite ces nœuds comme des obstacles mobiles, avec la vitesse du corps. Le décor fixe n’est rastérisé qu’une fois ; les corps mobiles le sont à chaque image, directement depuis les tampons du moteur.');
      C(13, 'Du liquide vers les solides',
        'Ce sens est plus délicat, et c’est lui qui permet aux corps de flotter. À chaque sous-pas, on mesure la quantité de mouvement que le liquide perd contre un corps, et on la lui donne. Il faut le faire *entre* les sous-pas et mettre à jour la vitesse du collisionneur : sinon un corps lourd rebondit sur la surface au lieu de s’enfoncer.',
        { code: '// chaque sous-pas : l’impulsion perdue par le liquide\n// devient une impulsion sur le corps, puis la carte de\n// collision est refaite avec la nouvelle vitesse du corps' });
      C(26, 'Le coût du couplage',
        'Ce couplage doit être fait à chaque sous-pas du liquide, lequel a besoin de bien plus de sous-pas que les solides pour respecter sa condition de stabilité. C’est là que part l’essentiel du temps d’une scène avec de l’eau — et c’est pourquoi les scènes liquides de cette application sont plus petites que les scènes de solides.');
    });

    PART('Boucles');
    CH('Pourquoi tout est précalculé', 46, () => {
      SCENE(0, 'hourglass');
      G(0, 46, 'bake');
      C(0, 'Simuler une fois, puis rejouer',
        'Cette application ne simule pas en direct : elle précalcule la totalité du clip, image par image, et enregistre la pose de chaque corps. Seize octets par corps et par image — une position en flottants, et une orientation compressée sur trente-deux bits par la technique des « trois plus petits ».',
        { code: '// 16 octets par corps et par image\nposition : 3 × f32\norientation : 10:10:10:2  (les 3 plus petites composantes\n                           du quaternion + l’indice du max)' });
      C(15, 'Ce que cela permet',
        'Un enregistrement rend possible ce qu’une simulation en direct interdit : se déplacer librement dans le temps, lire le clip à l’envers, exporter une vidéo image par image sans dépendre de la vitesse de la machine, et surtout garantir que deux lectures sont identiques — indispensable pour une boucle. Rien ne repasse jamais par le processeur : l’enregistrement est écrit et relu sur la carte graphique.',
        { note: 'C’est aussi ce qui permet au cours de recalculer une scène entière dès que vous bougez un curseur : la simulation de cinq secondes prend une fraction de seconde, et la lecture qui suit est parfaitement fluide.' });
      C(30, 'Fermer la boucle',
        'Pour qu’un clip tourne en rond, la dernière image doit ressembler à la première. Plusieurs transitions sont possibles : les corps reviennent à leur pose initiale, tout disparaît puis repousse, le sol devient perméable, ou la seconde moitié est la première à l’envers. Le sablier, lui, profite de sa symétrie : retourné, il est identique à lui-même, donc le verre basculé de la fin est indiscernable du verre droit du début.');
    });

    CH('Conclusion', 34, () => {
      G(0, 34, 'roadmap');
      C(0, 'Ce que vous savez maintenant',
        'Vous pouvez suivre un pas de temps du début à la fin : prédire où chaque corps irait seul, trouver les contacts avec un arbre reconstruit à chaque image, écrire ce que chacun interdit, descendre l’énergie corps par corps en laissant les multiplicateurs porter les forces, en déduire les vitesses, et faire tout cela par couleurs sur des milliers de corps.',
        { layers: 7 });
      C(14, 'Et ce qui reste',
        'Un moteur de production ajoute à cela des corps déformables, du tissu, des véhicules, du sommeil pour les corps immobiles, des formes concaves décomposées en convexes, et beaucoup de réglages exposés à qui fabrique le contenu. Mais le squelette est celui que vous venez de parcourir — et AVBD n’a été publié qu’en 2025 : c’est un domaine où il se passe encore beaucoup de choses.',
        { note: 'L’atelier vous attend si vous ne l’avez pas encore ouvert : huit fonctions à écrire, de l’intégrateur à la coloration de graphe, vérifiées contre une référence. C’est le meilleur moyen de vérifier ce que vous avez compris.' });
      CARD(32, 4, null);
    });
  }
}
