// Home page (contents, objectives, progress) and the card shown between modules.

import { CORE, MODULES, moduleStats, type Progress } from './course';
import type { Stop, Tour } from './tour';
import { h } from './tourUI';

const mins = (s: number) => `≈ ${Math.max(1, Math.round(s / 60))} min`;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export interface HomeHooks {
  onStart(t: number): void;
  onClose(): void;
  onQuit(): void;
  onLab(): void;
  challenges: { id: string; module: number; title: string }[];
}

export class HomeUI {
  root: HTMLElement;
  card: HTMLElement;
  open = false;
  private inTour = false;

  constructor(private tour: Tour, private prog: Progress, private hooks: HomeHooks) {
    this.root = h('div', 'c-home hidden');
    this.card = h('div', 'c-card hidden');
  }

  // --------------------------------------------------------------- summary

  openHome(inTour: boolean): void {
    this.inTour = inTour;
    this.open = true;
    const { tour, prog } = this;
    this.root.replaceChildren();
    const inner = h('div', 'home-inner');
    const total = tour.modules.filter((m) => !m.bonus).reduce((s, m) => s + m.t1 - m.t0, 0);

    const hero = h('header', 'home-hero');
    hero.append(
      h('div', 'kicker', inTour ? 'Sommaire' : `Cours interactif · ${CORE} modules · ${mins(total)}`),
      h('h1', undefined, 'Anatomie d’un moteur physique'),
      h('p', 'lead', 'Comment un programme décide-t-il, soixante fois par seconde, où se trouvent mille corps qui s’entrechoquent&nbsp;? Suivez un pas de temps du début à la fin, et manipulez chaque étape — dans des schémas vivants et dans le vrai moteur de cette application.'),
      h('p', 'who', '<b>Pour qui ?</b> Vous savez programmer (variables, fonctions, boucles). Aucune connaissance en physique ni en mathématiques avancées n’est nécessaire : tout est repris depuis le début, schémas à l’appui.'),
    );
    const cta = h('div', 'home-cta');
    const resumeT = prog.d.lastT > 5 && prog.d.lastT < tour.duration - 5 ? prog.d.lastT : 0;
    const go = h('button', 'c-btn go big') as HTMLButtonElement;
    if (inTour) { go.textContent = 'Reprendre la visite ▶'; go.onclick = () => this.hooks.onClose(); } else if (resumeT) {
      const ch = tour.chapters[tour.chapterAt(resumeT)];
      go.innerHTML = `Reprendre ▶ <small>${esc(tour.modules[ch.module].title)} · ${esc(ch.title)}</small>`;
      go.onclick = () => this.hooks.onStart(resumeT);
    } else { go.textContent = 'Commencer le parcours ▶'; go.onclick = () => this.hooks.onStart(0); }
    const lab = h('button', 'c-btn big', '&lt;/&gt; Aller à l’atelier') as HTMLButtonElement;
    lab.title = 'Écrire vous-même l’intégrateur, un contact, la mise à jour AVBD';
    lab.onclick = () => this.hooks.onLab();
    cta.append(go, lab);
    if (resumeT && !inTour) {
      const restart = h('button', 'c-link', 'Recommencer depuis le début') as HTMLButtonElement;
      restart.onclick = () => this.hooks.onStart(0);
      cta.append(restart);
    }
    hero.append(cta);

    if (prog.started) {
      let q = 0, qr = 0, mi = 0, md = 0, mods = 0;
      tour.modules.forEach((m, i) => {
        const s = moduleStats(tour, prog, i, this.hooks.challenges);
        q += s.quiz; qr += s.right; mi += s.missions; md += s.missDone;
        if (!m.bonus && prog.d.done[m.id]) mods++;
      });
      hero.append(h('div', 'home-stats',
        `<span><b>${mods}</b> / ${CORE} modules terminés</span><span><b>${qr}</b> / ${q} bonnes réponses</span><span><b>${md}</b> / ${mi} missions accomplies</span>`));
    }
    inner.append(hero);

    const grid = h('div', 'home-mods');
    tour.modules.forEach((m, i) => grid.append(this.moduleCard(i)));
    inner.append(grid);

    const foot = h('footer', 'home-foot');
    if (prog.started) {
      const rst = h('button', 'c-link', 'Effacer ma progression') as HTMLButtonElement;
      rst.onclick = () => {
        if (confirm('Effacer votre progression (chapitres vus, réponses, missions, code de l’atelier) ?')) { this.prog.reset(); this.openHome(this.inTour); }
      };
      foot.append(rst);
    }
    foot.append(h('span', undefined, 'Espace : pause · ← → : ±5 s · M : sommaire · L : atelier · progression enregistrée dans ce navigateur'));
    inner.append(foot);
    this.root.append(inner);

    if (inTour) {
      const x = h('button', 'home-x', '✕') as HTMLButtonElement;
      x.title = 'Fermer (Échap)';
      x.onclick = () => this.hooks.onClose();
      this.root.append(x);
    } else {
      const q = h('button', 'home-x', '✕') as HTMLButtonElement;
      q.title = 'Quitter le cours (Échap)';
      q.onclick = () => this.hooks.onQuit();
      this.root.append(q);
    }
    this.root.classList.remove('hidden');
  }

  private moduleCard(i: number): HTMLElement {
    const { tour, prog } = this;
    const m = tour.modules[i];
    const def = MODULES[i];
    const s = moduleStats(tour, prog, i, this.hooks.challenges);
    const el = h('section', `mod${m.bonus ? ' bonus' : ''}${prog.d.done[m.id] ? ' done' : ''}`);
    const head = h('div', 'mod-head');
    head.append(
      h('span', 'mod-n', m.bonus ? '★' : String(i + 1)),
      h('div', 'mod-t', `<b>${esc(def.title)}</b><small>${clock(m.t1 - m.t0)} · ${s.chapters} chapitres</small>`),
    );
    el.append(head);
    el.append(h('p', 'mod-pitch', esc(def.pitch)));
    const ul = h('ul', 'mod-goals');
    for (const g of def.goals) ul.append(h('li', undefined, esc(g)));
    el.append(ul);
    const bar = h('div', 'mod-bar');
    const fill = h('i');
    fill.style.width = `${s.chapters ? (s.seen / s.chapters) * 100 : 0}%`;
    bar.append(fill);
    el.append(bar);
    const stats = h('div', 'mod-stats');
    stats.append(
      h('span', undefined, `${s.seen}/${s.chapters} chapitres`),
      h('span', undefined, `${s.right}/${s.quiz} réponses`),
      h('span', undefined, `${s.missDone}/${s.missions} missions`),
      h('span', undefined, `${s.codeDone}/${s.code} défis`),
    );
    el.append(stats);
    const btn = h('button', 'c-btn', s.seen ? 'Reprendre ce module ▶' : 'Commencer ce module ▶') as HTMLButtonElement;
    btn.onclick = () => this.hooks.onStart(m.t0 + 0.01);
    el.append(btn);
    return el;
  }

  closeHome(): void { this.open = false; this.root.classList.add('hidden'); }

  // ------------------------------------------------------------ module card

  showCard(st: Stop): void {
    const from = st.from ?? -1, to = st.to ?? null;
    const el = this.card;
    el.replaceChildren();
    const inner = h('div', 'card-inner');
    if (from >= 0) {
      const m = this.tour.modules[from];
      const s = moduleStats(this.tour, this.prog, from, this.hooks.challenges);
      this.prog.done(m.id);
      inner.append(
        h('div', 'kicker', 'Module terminé'),
        h('h2', undefined, esc(MODULES[from].title)),
        h('div', 'card-stats',
          `<span><b>${s.seen}</b>/${s.chapters} chapitres</span><span><b>${s.right}</b>/${s.quiz} bonnes réponses</span><span><b>${s.missDone}</b>/${s.missions} missions</span>`),
      );
    }
    if (to != null && this.tour.modules[to]) {
      const def = MODULES[to];
      inner.append(h('div', 'card-next'));
      const nx = inner.lastElementChild as HTMLElement;
      nx.append(
        h('div', 'kicker', from >= 0 ? 'Module suivant' : 'On commence par'),
        h('h3', undefined, esc(def.title)),
        h('p', undefined, esc(def.pitch)),
      );
      const ul = h('ul', 'mod-goals');
      for (const g of def.goals) ul.append(h('li', undefined, esc(g)));
      nx.append(ul);
    } else if (from >= 0 && to == null) {
      inner.append(h('p', 'card-end', 'Vous avez suivi le cours en entier. L’atelier vous attend si ce n’est pas déjà fait : c’est là qu’on écrit le moteur soi-même.'));
    }
    const foot = h('div', 'card-foot');
    const go = h('button', 'c-btn go big', 'Continuer ▶') as HTMLButtonElement;
    go.onclick = () => this.hooks.onClose();
    const menu = h('button', 'c-btn', '☰ Sommaire') as HTMLButtonElement;
    menu.onclick = () => { this.hideCard(); this.openHome(true); };
    foot.append(menu, go);
    inner.append(foot);
    el.append(inner);
    el.classList.remove('hidden');
    setTimeout(() => go.focus(), 30);
  }

  hideCard(): void { this.card.classList.add('hidden'); }
}

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
