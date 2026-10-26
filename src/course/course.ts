// Course structure: modules, saved progress, home page and module cards.

import type { Tour } from './tour';

export interface ModuleDef {
  id: string;
  title: string;
  parts: string[];
  bonus?: boolean;
  pitch: string;
  goals: string[];
}

export const MODULES: ModuleDef[] = [
  {
    id: 'm1', title: 'Mouvement et intégration', parts: ['Introduction', 'L’état', 'Intégration'],
    pitch: 'Ce qu’un moteur garde en mémoire, et comment il fait avancer un corps libre d’un instant au suivant.',
    goals: [
      'Voir un pas de temps comme quatre boucles emboîtées, et savoir ce que coûte chacune',
      'Décrire l’état d’un solide : position, orientation, vitesses, masse, inertie',
      'Relier force, accélération, vitesse et position',
      'Écrire un pas d’intégration et mesurer l’erreur qu’il commet',
      'Expliquer pourquoi tous les moteurs utilisent Euler semi-implicite',
    ],
  },
  {
    id: 'm2', title: 'Contacts et impulsions', parts: ['Le problème', 'Détection', 'Contraintes', 'Résolution'],
    pitch: 'Trouver qui touche qui, écrire ce que le contact interdit, puis le faire respecter par des impulsions.',
    goals: [
      'Séparer phase large et phase étroite, et dire ce que chacune coûte',
      'Écrire une contrainte C(x) ≥ 0 et son jacobien',
      'Comprendre pourquoi une force de contact est une inconnue, et ce qu’est une impulsion',
      'Comprendre pourquoi une pile de caisses se tasse quand on manque d’itérations',
    ],
  },
  {
    id: 'm3', title: 'AVBD : le pas de temps comme minimisation', parts: ['Variationnel', 'Pénalités', 'AVBD', 'Réglages'],
    pitch: 'La partie centrale du cours : voir un pas de temps comme une minimisation, et faire converger les contacts sans raideur infinie.',
    goals: [
      'Voir l’énergie comme un paysage, et comprendre pourquoi un ressort raide exige un pas implicite',
      'Reformuler un pas implicite comme la minimisation d’une énergie',
      'Expliquer le rôle de la pénalité k, du multiplicateur λ et de la montée β',
      'Régler α, β, γ, sous-pas et itérations en sachant ce que chacun fait',
    ],
  },
  {
    id: 'm4', title: 'Le calcul sur carte graphique', parts: ['Parallèle'],
    pitch: 'Pourquoi Gauss-Seidel résiste au parallélisme, et ce qu’il faut changer pour occuper une carte graphique.',
    goals: [
      'Savoir comment une carte graphique exécute un programme : voies, paquets, lancements',
      'Expliquer le conflit entre corps voisins et la coloration de graphe',
      'Décrire l’organisation « un groupe de travail par corps »',
      'Mesurer où part vraiment le temps : les lancements de noyaux',
      'Comprendre les arrondis des flottants 32 bits et leurs conséquences',
    ],
  },
  {
    id: 'bonus', title: 'Bonus : liquides et boucles', parts: ['Liquides', 'Boucles'], bonus: true,
    pitch: 'Pour aller plus loin : un liquide qui partage la scène avec les solides, et la fabrication d’une boucle sans couture.',
    goals: [
      'Comprendre MLS-MPM : particules et grille, à tour de rôle',
      'Voir comment liquide et solides échangent de la quantité de mouvement',
      'Savoir pourquoi la simulation est précalculée image par image',
    ],
  },
];

export const CORE = MODULES.filter((m) => !m.bonus).length;

// ------------------------------------------------------------- progression

const KEY = 'avbd.course.v1';

/** former chapter titles → current ones */
const RENAMED: Record<string, string> = {
  'Un pas de temps, vu d’avion': 'Vue d’ensemble d’un pas de temps',
  'Ce qui fait bouger': 'Forces et mouvement',
  'Avancer d’un pas': 'Intégrer pas à pas',
  'Tourner': 'La rotation',
  'Rien ne l’interdit': 'Le problème des contacts',
  'Trier pour construire l’arbre': 'Construire l’arbre en parallèle',
  'Les forces que personne ne connaît': 'Les forces de contact',
  'Résoudre par impulsions': 'Les impulsions séquentielles',
  'La pile qui mollit': 'Itérations et enfoncement',
  'L’énergie, un paysage': 'Le paysage d’énergie',
  'Les ressorts raides': 'Ressorts raides et pas implicite',
  'Les vallées étroites': 'Raideur et convergence',
  'Un détail qui change tout : quand mettre λ à jour': 'Quand mettre λ à jour',
  'β, la montée de pénalité': 'β : la montée de la raideur',
  'γ et α : la mémoire et la prudence': 'γ et α : démarrage à chaud et stabilisation',
  'Comment pense une carte graphique': 'Comment fonctionne une carte graphique',
  'Gauss-Seidel contre le parallélisme': 'Gauss-Seidel et le parallélisme',
  'Colorier le graphe': 'La coloration de graphe',
  'Où part vraiment le temps': 'Le coût des lancements',
  'Des nombres à sept chiffres': 'Les flottants 32 bits',
  'Un liquide dans la même scène': 'Simuler un liquide',
  'Le couplage dans les deux sens': 'Couplage entre liquide et solides',
};

interface ProgressData {
  lastT: number;
  maxT: number;
  seen: Record<string, 1>;
  quiz: Record<string, 0 | 1>;
  missions: Record<string, 1>;
  done: Record<string, 1>;
  code: Record<string, { done?: boolean; src?: string }>;
}

const empty = (): ProgressData => ({ lastT: 0, maxT: 0, seen: {}, quiz: {}, missions: {}, done: {}, code: {} });

export class Progress {
  d: ProgressData = empty();

  constructor() {
    try { Object.assign(this.d, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* storage off */ }
    // chapters are remembered by title: carry progress over renamed ones
    for (const [old, cur] of Object.entries(RENAMED)) if (this.d.seen[old]) { this.d.seen[cur] = 1; delete this.d.seen[old]; }
  }
  save(): void { try { localStorage.setItem(KEY, JSON.stringify(this.d)); } catch { /* quota */ } }
  reset(): void { this.d = empty(); this.save(); }
  get started(): boolean { return this.d.maxT > 5; }
  setT(t: number): void { this.d.lastT = t; this.d.maxT = Math.max(this.d.maxT, t); }
  seen(title: string): void { if (!this.d.seen[title]) { this.d.seen[title] = 1; this.save(); } }
  /** only the first answer is kept: that is the one that measures what you knew */
  quiz(id: string, ok: boolean): void { if (!(id in this.d.quiz)) { this.d.quiz[id] = ok ? 1 : 0; this.save(); } }
  mission(id: string): void { if (!this.d.missions[id]) { this.d.missions[id] = 1; this.save(); } }
  done(id: string): void { if (!this.d.done[id]) { this.d.done[id] = 1; this.save(); } }
  code(id: string, patch: { done?: boolean; src?: string }): void {
    this.d.code[id] = { ...this.d.code[id], ...patch };
    this.save();
  }
}

export interface ModuleStats {
  chapters: number; seen: number;
  quiz: number; answered: number; right: number;
  missions: number; missDone: number;
  code: number; codeDone: number;
}

export function moduleStats(tour: Tour, prog: Progress, i: number, challenges: { id: string; module: number }[]): ModuleStats {
  const m = tour.modules[i];
  const chs = m.chapters.map((k) => tour.chapters[k]);
  const quiz = tour.stops.filter((s) => s.kind === 'quiz' && tour.chapters[tour.chapterAt(s.t)].module === i);
  const miss = tour.stops.filter((s) => s.kind === 'try' && s.goals && tour.chapters[tour.chapterAt(s.t)].module === i);
  const code = challenges.filter((c) => c.module === i);
  return {
    chapters: chs.length, seen: chs.filter((c) => prog.d.seen[c.title]).length,
    quiz: quiz.length, answered: quiz.filter((s) => s.id in prog.d.quiz).length, right: quiz.filter((s) => prog.d.quiz[s.id] === 1).length,
    missions: miss.length, missDone: miss.filter((s) => prog.d.missions[s.id]).length,
    code: code.length, codeDone: code.filter((c) => prog.d.code[c.id]?.done).length,
  };
}
