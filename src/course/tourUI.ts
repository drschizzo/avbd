// DOM of the running tour: captions, draggable code values, diagram canvas,
// questions, hands-on pauses with missions, and the chapter timeline.

import { drawDiagram, type DiagEnv } from './diagrams';
import { DH, DW } from './draw';
import { LAYERS, type Control, type Stop, type Tour, type Vals } from './tour';

export const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html != null) el.innerHTML = html;
  return el;
};

const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ------------------------------------------------------------ code colours

export function highlight(src: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const re = /(\/\/[^\n]*)|(\b(?:for|if|else|return|break|continue|const|let|var|function|struct|float|vec2|vec3|vec4|quat|mat3|int|bool|void|fn|var<storage>|workgroup)\b)|(\b[a-zA-Z_]\w*(?=\s*\())|((?:\b\d+\.?\d*|\.\d+)(?:e-?\d+)?)/g;
  let out = '', last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    const cls = m[1] ? 'c' : m[2] ? 'k' : m[3] ? 'f' : 'n';
    out += `<span class="tk-${cls}">${esc(m[0])}</span>`;
    last = re.lastIndex;
  }
  return out + esc(src.slice(last));
}

const LIVE = /\{\{(\w+)\|([-\d.e]+)\|([-\d.e]+)\|([\d.e]+)\}\}/g;
const decimals = (step: number) => Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));

function highlightLive(src: string): string {
  let out = '', last = 0, m: RegExpExecArray | null;
  LIVE.lastIndex = 0;
  while ((m = LIVE.exec(src))) {
    out += highlight(src.slice(last, m.index));
    out += `<span class="tk-live" tabindex="0" data-key="${m[1]}" data-min="${m[2]}" data-max="${m[3]}" data-step="${m[4]}"></span>`;
    last = LIVE.lastIndex;
  }
  return out + highlight(src.slice(last));
}

// ------------------------------------------------------------------- hooks

export interface TourHooks {
  onSeek(t: number): void;
  onStop(st: Stop): void;
  onToggle(): void;
  onResume(): void;
  onPauses(on: boolean): void;
  onLive(key: string, v: number, until: number): void;
  onCard(st: Stop): void;
  onQuiz(id: string, ok: boolean): void;
  onMission(id: string): void;
  onMenu(): void;
  onLab(): void;
  onQuit(): void;
  /** back to the scene's own camera after the learner orbited it */
  onCamReset(): void;
}

interface LiveVal { el: HTMLElement; key: string; min: number; max: number; step: number; dec: number; busy: boolean; v?: number }

export class TourUI {
  root: HTMLElement;
  private cap: HTMLElement;
  private kicker: HTMLElement;
  private title: HTMLElement;
  private body: HTMLElement;
  private note: HTMLElement;
  private codeEl: HTMLElement;
  private hudEl: HTMLElement;
  private layersEl: HTMLElement;
  private liveHint: HTMLElement;
  private tryEl: HTMLElement;
  private diagEl: HTMLElement;
  private ctx: CanvasRenderingContext2D;
  private chapterEl: HTMLElement;
  private clockEl: HTMLElement;
  private playBtn: HTMLButtonElement;
  private pausesBtn: HTMLButtonElement;
  private badge: HTMLElement;
  private camEl: HTMLButtonElement;
  private segs: { el: HTMLElement; fill: HTMLElement; t0: number; t1: number }[] = [];
  private marks: HTMLElement[] = [];

  private capIdx = -1;
  private capTok = 0;
  private cv!: HTMLCanvasElement;
  private cssW = 0;
  /** undefined = unknown: forces the next update to set the panel's state */
  private diagKey: string | null | undefined = undefined;
  private shownStop: Stop | null | undefined;
  private lives: LiveVal[] = [];
  private ctlSync: Record<string, (v: number) => void> = {};
  private goalEls: HTMLElement[] | null = null;
  private goBtn!: HTMLButtonElement;
  private tagEl!: HTMLElement;
  private quizAnswer: ((i: number) => void) | null = null;
  private hud: ((v: Vals) => string) | null = null;

  constructor(private tour: Tour, private hooks: TourHooks) {
    this.root = h('div', 'course hidden');

    const top = h('div', 'c-top');
    this.chapterEl = h('span', 'c-where');
    this.clockEl = h('span', 'c-clock');
    top.append(this.chapterEl, this.clockEl);

    const actions = h('div', 'c-actions');
    this.pausesBtn = h('button', 'c-chip on') as HTMLButtonElement;
    this.pausesBtn.innerHTML = '<span class="sw"><i></i></span>Questions et missions';
    this.pausesBtn.title = 'La visite s’arrête pour une question ou une mission (repères sur la frise)';
    this.pausesBtn.onclick = () => hooks.onPauses(!tour.pauses);
    const menu = h('button', 'c-chip', '☰ Sommaire') as HTMLButtonElement;
    menu.title = 'Modules, chapitres et progression (M)';
    menu.onclick = () => hooks.onMenu();
    const lab = h('button', 'c-chip', '&lt;/&gt; Atelier') as HTMLButtonElement;
    lab.title = 'Écrire vous-même le moteur (L)';
    lab.onclick = () => hooks.onLab();
    const quit = h('button', 'c-chip c-quit', 'Quitter le cours ⏎') as HTMLButtonElement;
    quit.onclick = () => hooks.onQuit();
    actions.append(this.pausesBtn, menu, lab, quit);

    this.kicker = h('div', 'kicker');
    this.title = h('h2');
    this.body = h('p', 'c-text');
    this.note = h('p', 'c-note');
    this.layersEl = h('div', 'c-layers');
    this.hudEl = h('div', 'c-hud');
    this.codeEl = h('pre', 'c-code');
    this.liveHint = h('div', 'c-livehint hidden', '↔ Les valeurs soulignées sont modifiables : glissez-les, ou cliquez pour taper un nombre.');
    this.tryEl = h('div', 'c-try hidden');
    this.cap = h('div', 'c-cap panel');
    this.cap.append(this.kicker, this.title, this.body, this.note, this.layersEl, this.hudEl, this.codeEl, this.liveHint, this.tryEl);

    const cv = h('canvas');
    this.cv = cv;
    this.ctx = cv.getContext('2d')!;
    this.diagEl = h('div', 'c-diag panel out');
    this.diagEl.append(cv);
    this.sizeCanvas();

    this.playBtn = h('button', 'c-play', '❚❚') as HTMLButtonElement;
    this.playBtn.title = 'Pause (Espace)';
    this.playBtn.onclick = () => hooks.onToggle();
    const mods = h('div', 'c-mods');
    const chaps = h('div', 'c-chaps');
    const timeline = h('div', 'c-timeline');
    timeline.title = 'Cliquer pour naviguer (← → : ±5 s)';
    timeline.append(mods, chaps);
    timeline.onclick = (ev) => {
      const r = chaps.getBoundingClientRect();
      hooks.onSeek(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * tour.duration);
    };
    const bar = h('div', 'c-bar');
    bar.append(this.playBtn, timeline);

    this.badge = h('div', 'c-badge');
    // the 3D view can be orbited; this says so, then offers the way back
    this.camEl = h('button', 'c-cam') as HTMLButtonElement;
    this.camEl.onclick = () => hooks.onCamReset();
    this.setCamFree(false);

    this.root.append(top, actions, this.cap, this.diagEl, bar, this.badge, this.camEl);

    // one segment per chapter
    tour.chapters.forEach((ch, i) => {
      const end = i + 1 < tour.chapters.length ? tour.chapters[i + 1].t : tour.duration;
      const el = h('div', 'c-seg');
      el.style.flex = String(end - ch.t);
      el.innerHTML = `<i></i><span>${ch.part === ch.title ? ch.title : `${ch.part} · ${ch.title}`}</span>`;
      if (i && ch.module !== tour.chapters[i - 1].module) el.classList.add('mod-start');
      if (tour.modules[ch.module]?.bonus) el.classList.add('bonus');
      chaps.append(el);
      this.segs.push({ el, fill: el.firstChild as HTMLElement, t0: ch.t, t1: end });
    });
    tour.modules.forEach((m, i) => {
      const l = h('span');
      l.style.left = `${(m.t0 / tour.duration) * 100}%`;
      l.style.width = `${((m.t1 - m.t0) / tour.duration) * 100}%`;
      l.textContent = m.bonus ? 'Bonus' : `${i + 1} · ${m.title}`;
      mods.append(l);
    });
    this.marks = tour.stops.filter((s) => s.kind !== 'card').map((st) => {
      const m = h('b', `stop-mark ${st.kind}`);
      m.style.left = `${(st.t / tour.duration) * 100}%`;
      m.title = st.kind === 'quiz' ? 'Question' : `À vous : ${st.title}`;
      m.onclick = (ev) => { ev.stopPropagation(); hooks.onStop(st); };
      timeline.append(m);
      return m;
    });

    // the diagram reacts to the pointer during a hands-on pause
    const toDiag = (ev: PointerEvent | MouseEvent) => {
      const r = cv.getBoundingClientRect();
      return { x: ((ev.clientX - r.left) / r.width) * DW, y: ((ev.clientY - r.top) / r.height) * DH };
    };
    cv.addEventListener('pointermove', (ev) => { if (tour.stop?.diag) tour.ptr = toDiag(ev); });
    cv.addEventListener('pointerleave', () => { if (tour.stop?.diag) tour.ptr = null; });
    cv.addEventListener('pointerdown', (ev) => {
      if (!tour.stop?.diag) return;
      const p = toDiag(ev);
      tour.ptr = p;
      tour.hits.add(`${Math.floor(p.x / 20)},${Math.floor(p.y / 20)}`);
    });
  }

  /**
   * The drawing space stays DW x DH whatever the panel's size: the backing
   * store follows the CSS size so an enlarged diagram is sharp, not stretched.
   */
  private sizeCanvas(): void {
    const w = this.cv.clientWidth || DW;
    if (w === this.cssW) return;
    this.cssW = w;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const scale = (w / DW) * dpr;
    this.cv.width = Math.round(DW * scale);
    this.cv.height = Math.round(DH * scale);
    this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
  }

  show(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
    if (on) { this.capIdx = -1; this.diagKey = undefined; this.shownStop = undefined; }
  }

  setPauses(on: boolean): void {
    this.pausesBtn.classList.toggle('on', on);
    for (const m of this.marks) m.classList.toggle('off', !on);
  }

  setCamFree(free: boolean): void {
    this.camEl.classList.toggle('free', free);
    this.camEl.textContent = free ? '⟲ Revenir au plan de la scène' : 'Glissez sur la scène pour tourner autour';
    this.camEl.disabled = !free;
  }

  setBadge(txt: string, cls = ''): void {
    this.badge.textContent = txt;
    this.badge.className = `c-badge ${cls}`;
  }

  // --------------------------------------------------------------- caption

  private setCaption(i: number): void {
    const c = this.tour.caps[i];
    const tok = ++this.capTok;
    const fill = () => {
      if (tok !== this.capTok) return;
      this.kicker.textContent = c.kicker;
      this.title.textContent = c.title;
      this.body.textContent = c.text;
      this.note.textContent = c.note;
      this.note.classList.toggle('hidden', !c.note);
      this.codeEl.innerHTML = c.code ? highlightLive(c.code) : '';
      this.codeEl.classList.toggle('hidden', !c.code);
      this.bindLive(i);
      this.layersEl.replaceChildren();
      this.layersEl.classList.toggle('hidden', !c.layers);
      if (c.layers) {
        LAYERS.forEach((n, k) => {
          const s = h('span', k < c.layers ? 'on' : undefined);
          s.textContent = n;
          this.layersEl.append(s);
        });
      }
      this.hud = c.hud;
      this.cap.classList.remove('out');
    };
    this.cap.classList.add('out');
    if (this.capIdx < 0) fill(); else setTimeout(fill, 240);
    this.capIdx = i;
  }

  /** Draggable numbers inside the displayed code. */
  private bindLive(i: number): void {
    const tour = this.tour;
    const end = i + 1 < tour.caps.length ? tour.caps[i + 1].t : tour.duration;
    this.lives = [...this.codeEl.querySelectorAll<HTMLElement>('.tk-live')].map((el) => {
      const L: LiveVal = { el, key: el.dataset.key!, min: +el.dataset.min!, max: +el.dataset.max!, step: +el.dataset.step!, dec: 0, busy: false };
      L.dec = decimals(L.step);
      const set = (v: number) => {
        v = Math.min(L.max, Math.max(L.min, Math.round(v / L.step) * L.step));
        L.v = v;
        el.textContent = v.toFixed(L.dec);
        this.hooks.onLive(L.key, v, end);
        this.ctlSync[L.key]?.(v);
      };
      el.title = `${L.key} : glisser pour modifier (${L.min} à ${L.max})`;
      el.addEventListener('pointerdown', (ev) => {
        if (el.isContentEditable) return;
        ev.preventDefault();
        try { el.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
        const x0 = ev.clientX, v0 = L.v ?? +el.textContent!;
        let moved = false;
        L.busy = true; el.classList.add('drag');
        const move = (e2: PointerEvent) => {
          const dx = e2.clientX - x0;
          if (Math.abs(dx) > 2) moved = true;
          if (moved) set(v0 + (dx / 220) * (L.max - L.min));
        };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          el.classList.remove('drag'); L.busy = false;
          if (!moved) {
            L.busy = true; el.contentEditable = 'true'; el.focus();
            const r = document.createRange(); r.selectNodeContents(el);
            const sel = getSelection(); sel?.removeAllRanges(); sel?.addRange(r);
          }
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      });
      el.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (el.isContentEditable) { if (ev.key === 'Enter' || ev.key === 'Escape') { ev.preventDefault(); el.blur(); } return; }
        const k = ev.key === 'ArrowUp' || ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowDown' || ev.key === 'ArrowLeft' ? -1 : 0;
        if (k) { ev.preventDefault(); set((L.v ?? +el.textContent!) + k * L.step * (ev.shiftKey ? 10 : 1)); }
      });
      el.addEventListener('blur', () => {
        if (!el.isContentEditable) return;
        el.contentEditable = 'false'; L.busy = false;
        const v = parseFloat((el.textContent ?? '').replace(',', '.'));
        if (Number.isFinite(v)) set(v);
      });
      el.addEventListener('wheel', (ev) => { ev.preventDefault(); set((L.v ?? +el.textContent!) - Math.sign(ev.deltaY) * L.step); }, { passive: false });
      return L;
    });
    this.liveHint.classList.toggle('hidden', !this.lives.length);
  }

  // ------------------------------------------------------------------ stop

  private showStop(st: Stop | null): void {
    this.ctlSync = {}; this.goalEls = null; this.quizAnswer = null;
    this.diagEl.classList.toggle('live', !!st?.diag);
    this.root.classList.toggle('in-card', st?.kind === 'card');
    if (!st || st.kind === 'card') {
      this.tryEl.classList.add('hidden');
      this.tryEl.replaceChildren();
      if (st) this.hooks.onCard(st);
      return;
    }
    if (st.kind === 'quiz') { this.showQuiz(st); return; }
    const el = this.tryEl;
    el.replaceChildren();
    const head = h('div', 'try-head', `<span class="try-tag">${st.goals ? 'Mission' : 'À vous'}</span>`);
    head.append(st.title);
    this.tagEl = head.firstChild as HTMLElement;
    const p = h('p');
    p.textContent = st.prompt ?? '';
    el.append(head, p);
    if (st.goals) {
      st.reached ||= st.goals.map(() => false);
      const ul = h('ul', 'try-goals');
      this.goalEls = st.goals.map((g, i) => {
        const li = h('li');
        li.textContent = g.label;
        li.classList.toggle('ok', !!st.reached![i]);
        ul.append(li);
        return li;
      });
      el.append(ul);
    }
    for (const c of st.controls) el.append(this.control(st, c));
    const foot = h('div', 'try-foot');
    const hint = h('small');
    const hints: string[] = [];
    if (st.diag) hints.push('le schéma réagit à la souris');
    hint.textContent = hints.join(' · ');
    const go = h('button', 'c-btn go', 'Continuer ▶') as HTMLButtonElement;
    go.title = 'Reprendre la visite (Espace)';
    go.onclick = () => this.hooks.onResume();
    this.goBtn = go;
    if (st.goals && st.reached!.every(Boolean)) this.missionDone(st, false);
    foot.append(hint, go);
    el.append(foot);
    el.classList.remove('hidden');
    this.updateGoals();
    // bring the pause into view without scrolling the chapter title away
    el.scrollIntoView({ block: 'nearest' });
  }

  private control(st: Stop, c: Control): HTMLElement {
    const row = h('label', `try-row ${c.type}`);
    const name = h('span', 'try-name');
    name.textContent = c.label;
    if (c.help) row.title = c.help;
    if (c.type === 'range') {
      const out = h('output');
      const inp = h('input') as HTMLInputElement;
      Object.assign(inp, { type: 'range', min: String(c.min), max: String(c.max), step: String(c.step) });
      inp.value = String(st.ov[c.key]);
      const sync = () => { st.ov[c.key] = +inp.value; out.textContent = c.fmt ? c.fmt(+inp.value) : inp.value; };
      inp.addEventListener('input', sync);
      sync();
      this.ctlSync[c.key] = (v) => { inp.value = String(v); out.textContent = c.fmt ? c.fmt(v) : String(v); };
      row.append(name, inp, out);
    } else if (c.type === 'choice') {
      const seg = h('div', 'try-seg');
      const paint = () => {
        [...seg.children].forEach((b, i) => b.classList.toggle('on', st.ov[c.key] === c.options![i].value));
      };
      for (const o of c.options ?? []) {
        const b = h('button', undefined, o.label);
        b.onclick = (ev) => { ev.preventDefault(); st.ov[c.key] = o.value; paint(); };
        seg.append(b);
      }
      paint();
      this.ctlSync[c.key] = () => paint();
      row.append(name, seg);
    } else {
      const sw = h('button', 'try-sw') as HTMLButtonElement;
      sw.type = 'button';
      sw.innerHTML = '<span class="sw"><i></i></span>';
      const on = () => Math.abs(st.ov[c.key] - (c.on ?? 1)) < Math.abs(st.ov[c.key] - (c.off ?? 0));
      const sync = () => sw.classList.toggle('on', on());
      sw.onclick = (ev) => { ev.preventDefault(); st.ov[c.key] = on() ? (c.off ?? 0) : (c.on ?? 1); sync(); };
      sync();
      row.append(sw, name);
    }
    return row;
  }

  updateGoals(): void {
    const st = this.tour.stop;
    if (!st || !st.goals || !this.goalEls) return;
    const x = { v: st.ov, ptr: this.tour.ptr, hits: this.tour.hits };
    let hit = false;
    st.goals.forEach((g, i) => {
      const open = !st.seq || i === 0 || st.reached![i - 1];
      this.goalEls![i].classList.toggle('locked', !open && !st.reached![i]);
      if (st.reached![i] || !open) return;
      let ok = false;
      try { ok = !!g.test(x); } catch { /* pointer missing */ }
      if (ok) { st.reached![i] = true; this.goalEls![i].classList.add('ok'); hit = true; }
    });
    if (hit && st.reached!.every(Boolean)) this.missionDone(st, true);
  }

  private missionDone(st: Stop, fresh: boolean): void {
    this.goBtn.classList.add('ready');
    this.goBtn.textContent = 'Mission accomplie · Continuer ▶';
    this.tagEl.textContent = 'Réussi ✓';
    this.tagEl.classList.add('ok');
    if (fresh) this.hooks.onMission(st.id);
  }

  private showQuiz(st: Stop): void {
    const el = this.tryEl, q = st.quiz!;
    el.replaceChildren();
    const head = h('div', 'try-head', '<span class="try-tag quiz">Question</span>');
    head.append('Qu’en pensez-vous ?');
    const p = h('p', 'quiz-q');
    p.textContent = q.question;
    const list = h('div', 'quiz-choices');
    const fb = h('p', 'quiz-fb hidden');
    const foot = h('div', 'try-foot');
    const hint = h('small');
    hint.textContent = 'Répondez (ou touches 1, 2, 3) pour voir l’explication';
    const go = h('button', 'c-btn ghost', 'Passer') as HTMLButtonElement;
    go.onclick = () => this.hooks.onResume();
    const btns = q.choices.map((txt, i) => {
      const b = h('button', 'quiz-choice', `<kbd>${i + 1}</kbd>`) as HTMLButtonElement;
      b.append(txt);
      b.onclick = () => this.quizAnswer?.(i);
      list.append(b);
      return b;
    });
    this.quizAnswer = (i: number) => {
      this.quizAnswer = null;
      const ok = i === q.answer;
      btns.forEach((b, k) => { b.disabled = true; if (k === q.answer) b.classList.add('is-right'); else if (k === i) b.classList.add('is-wrong'); });
      fb.innerHTML = `<b>${ok ? 'Exact.' : 'Pas tout à fait.'}</b> `;
      fb.append(q.explain);
      fb.classList.remove('hidden');
      hint.textContent = ok ? 'Bien vu !' : 'La bonne réponse est en vert.';
      go.className = 'c-btn go ready';
      go.textContent = 'Continuer ▶';
      go.focus();
      this.hooks.onQuiz(st.id, ok);
    };
    foot.append(hint, go);
    el.append(head, p, list, fb, foot);
    el.classList.remove('hidden');
    el.scrollIntoView({ block: 'nearest' });
  }

  answer(i: number): void { this.quizAnswer?.(i); }

  // ----------------------------------------------------------------- frame

  update(t: number, v: Vals, playing: boolean): void {
    const tour = this.tour;
    const ci = tour.capAt(t);
    if (ci !== this.capIdx) this.setCaption(ci);
    this.hudEl.textContent = this.hud ? this.hud(v) : '';
    this.hudEl.classList.toggle('hidden', !this.hudEl.textContent);

    const dg = tour.diagAt(t);
    const key = dg ? `${dg.name}:${dg.arg ?? ''}:${dg.big ? 1 : 0}` : null;
    if (key !== this.diagKey) {
      this.diagKey = key;
      this.diagEl.classList.toggle('out', !key);
      this.diagEl.classList.toggle('big', !!dg?.big);
    }
    if (dg) {
      this.sizeCanvas();
      const env: DiagEnv = { t: t - dg.t0 + tour.extra, v, ptr: tour.stop?.diag ? tour.ptr : null, hits: tour.hits, arg: dg.arg };
      drawDiagram(dg.name, this.ctx, env);
    }

    if (tour.stop !== this.shownStop) { this.shownStop = tour.stop; this.showStop(tour.stop); }
    this.updateGoals();

    for (const s of this.segs) s.fill.style.width = `${Math.min(1, Math.max(0, (t - s.t0) / (s.t1 - s.t0))) * 100}%`;
    const c = tour.chapters[tour.chapterAt(t)];
    const m = tour.modules[c.module];
    const where = c.part === c.title ? c.title : `${c.part} · ${c.title}`;
    const nCore = tour.modules.filter((x) => !x.bonus).length;
    this.chapterEl.textContent = `${m.bonus ? 'Bonus' : `Module ${c.module + 1}/${nCore}`} · ${where}`;
    this.clockEl.textContent = `${fmtClock(t)} / ${fmtClock(tour.duration)}`;
    this.playBtn.textContent = playing ? '❚❚' : '▶';
    this.root.classList.toggle('in-stop', !!tour.stop);

    for (const L of this.lives) {
      if (L.busy) continue;
      const x = v[L.key];
      if (typeof x !== 'number') continue;
      if (x !== L.v) { L.v = x; L.el.textContent = x.toFixed(L.dec); }
    }
  }
}
