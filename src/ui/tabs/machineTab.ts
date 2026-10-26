// Machine tab: the machine check of the last bake (what moved, when, where a
// row stopped), and robustness trials.

import { ENTITY_DEFS } from '../../scene/entities';
import { h } from '../../util/dom';
import { toast } from '../kit';
import type { TabCtx, TabView } from './tab';

const fmtT = (t: number | null) => (t === null ? '—' : `${t.toFixed(2)} s`);

export function renderMachineTab(ctx: TabCtx): TabView {
  const { app, body } = ctx;
  const r = app.report;
  const box = h('div', { class: 'machine' });
  body.append(box);
  const t = app.trials;
  if (!r) {
    box.append(h('div', { class: 'empty' }, app.analyzing ? 'Checking the machine…' : app.baking ? 'Baking… the check runs when the bake ends.' : 'Bake the scene: every object that is set in motion, when, and where a chain breaks will show up here.'));
    if (!app.baking && !app.analyzing) box.append(h('div', { class: 'mrow-actions' }, h('button', { class: 'btn primary', onclick: () => void app.bake() }, 'Bake & check')));
    return {};
  }
  const bad = r.issues.filter((x) => x.level === 'bad').length;
  const warn = r.issues.filter((x) => x.level === 'warn').length;
  box.append(h('div', { class: `verdict ${r.ok && !warn ? 'good' : r.ok ? 'warn' : 'bad'}` },
    h('b', {}, r.entities.every((x) => !x.expected) && r.sensors.length === 0 ? 'No step to check' : r.ok ? (warn ? 'The machine runs — with warnings' : 'The machine runs end to end') : bad ? `${bad} step${bad > 1 ? 's' : ''} failed` : 'Check'),
    h('span', {}, app.reportStale ? 'from the previous bake — the scene changed since' : `chain ends ${fmtT(r.chainEnd)} · still at ${fmtT(r.motionEnd)}${r.outroStart !== null ? ` · loop transition ${fmtT(r.outroStart)}` : ''}`)));

  for (const is of r.issues) {
    const row = h('div', { class: `issue ${is.level}` }, h('span', {}, is.text));
    if (is.fix === 'duration' && is.value) row.append(h('button', { class: 'btn', onclick: () => { app.doc.duration = is.value!; app.commit('physics'); toast(`Duration ${is.value} s`); } }, `Use ${is.value} s`));
    if (is.fix === 'boomerang') row.append(h('button', { class: 'btn', onclick: () => { app.doc.loop.mode = 'boomerang'; app.commit('loop'); } }, 'Boomerang'));
    box.append(row);
  }

  // the chain, in the order things were set in motion
  box.append(h('div', { class: 'section-title' }, 'Chain of events', h('span', { class: 'kbd' }, 'click = see it')));
  const D = Math.max(r.simEnd, 1e-3);
  const list = h('div', { class: 'chain' });
  const trialRate = (id: string) => {
    if (!t || t.done === 0) return null;
    const n = t.results.filter((m) => m.get(id)).length;
    return n / t.done;
  };
  for (const e of r.entities) {
    const ent = app.doc.entities.find((x) => x.id === e.id);
    const icon = ent ? ENTITY_DEFS[ent.type].icon : '•';
    const st = e.status;
    const rate = trialRate(e.id);
    const bar = h('div', { class: 'cbar' });
    if (e.first !== null) {
      const a = (e.first / D) * 100, b = (Math.max(e.last ?? e.first, e.first) / D) * 100;
      bar.append(h('i', { class: st, style: `left:${a}%;width:${Math.max(1.2, b - a)}%` }));
    }
    const row = h('div', { class: `crow ${st}${ent && app.selectedIds.includes(ent.id) ? ' sel' : ''}`, onclick: () => {
      if (!ent) return;
      app.select(ent.id, { single: true });
      const at = e.breakAt?.t ?? e.first;
      if (at !== null && app.result) { app.seek(Math.max(0, at - 0.3)); app.playing = false; }
    } },
      h('span', { class: 'ct' }, e.first === null ? '—' : e.first.toFixed(2)),
      h('span', { class: 'ic' }, icon),
      h('span', { class: 'cn' }, e.name, h('small', {}, st === 'idle' ? 'never moved' : st === 'decor' ? (e.activated ? `decor · moved` : 'decor') : e.chain || st === 'partial' ? `${e.activated}/${e.bodies}` : `${e.activated}/${e.bodies} moved`)),
      rate !== null ? h('span', { class: `rate ${rate === 1 ? 'good' : rate >= 0.6 ? 'warn' : 'bad'}`, title: `Worked in ${Math.round(rate * 100)} % of the ${t!.done} trial runs` }, `${Math.round(rate * 100)}%`) : null,
      h('button', { class: 'cx', title: e.expected ? 'Expected to move — click if it is only decor' : 'Decor — click if it must move', onclick: (ev: Event) => {
        ev.stopPropagation();
        if (!ent) return;
        ent.expect = ent.expect === false ? undefined : false;
        app.commit('meta');
        // re-judge without baking again
        app.rejudge();
      } }, e.expected ? '⚑' : '○'),
      bar,
    );
    list.append(row);
  }
  for (const sn of r.sensors) {
    const rate = trialRate(sn.id);
    const ent = app.doc.entities.find((x) => x.id === sn.id);
    list.append(h('div', { class: `crow sensor ${sn.triggered !== null ? 'ok' : 'idle'}`, onclick: () => { if (ent) app.select(ent.id); if (sn.triggered !== null) { app.seek(Math.max(0, sn.triggered - 0.3)); app.playing = false; } } },
      h('span', { class: 'ct' }, sn.triggered === null ? '—' : sn.triggered.toFixed(2)),
      h('span', { class: 'ic' }, '◫'),
      h('span', { class: 'cn' }, sn.name, h('small', {}, `${sn.watch} · ${sn.reached}/${sn.needed}`)),
      rate !== null ? h('span', { class: `rate ${rate === 1 ? 'good' : rate >= 0.6 ? 'warn' : 'bad'}` }, `${Math.round(rate * 100)}%`) : null,
      h('span', { class: 'cx' }),
      h('div', { class: 'cbar' }, sn.triggered !== null ? h('i', { class: 'ok', style: `left:${(sn.triggered / D) * 100}%;width:1.2%` }) : null)));
  }
  if (r.entities.length === 0 && r.sensors.length === 0) list.append(h('div', { class: 'hint' }, 'No moving parts in this scene.'));
  box.append(list);
  box.append(h('div', { class: 'hint' }, '⚑ = must move. Rows (dominoes, drawn rows) must fall to the last piece; a red ring marks where one stopped. Add a Sensor (Testing) to check that a ball reaches its target.'));

  // robustness
  box.append(h('div', { class: 'section-title' }, 'Reliability'));
  const runs = h('div', { class: 'trials' });
  if (t) {
    const pct = t.done ? Math.round((t.okRuns / t.done) * 100) : 0;
    runs.append(h('div', { class: `verdict small ${t.done === 0 ? '' : pct === 100 ? 'good' : pct >= 60 ? 'warn' : 'bad'}` },
      h('b', {}, t.running ? `Run ${Math.min(t.done + 1, t.total)} of ${t.total}…` : t.untilSuccess ? (t.kept >= 0 ? `Worked on run ${t.kept + 1} — that bake is kept` : `No run worked out of ${t.done}`) : `${t.okRuns} / ${t.done} runs worked (${pct} %)`),
      h('span', {}, t.untilSuccess ? 'each run nudges the parts by < 1 mm' : 'each run nudges the parts by < 1 mm: a machine that only works for one exact layout will break')));
  }
  runs.append(h('div', { class: 'mrow-actions' },
    h('button', { class: 'btn', title: 'Bake 5 times with tiny differences and count which steps hold', onclick: () => void app.runTrials(5, false) }, t?.running && !t.untilSuccess ? 'Stop' : 'Test ×5'),
    h('button', { class: 'btn', title: 'Re-bake (nudged) until every step works, up to 8 runs, and keep that bake for export', onclick: () => void app.runTrials(8, true) }, t?.running && t.untilSuccess ? 'Stop' : 'Bake until it works'),
    h('label', { class: 'toggle', title: 'Trajectories of the selected objects (from the check)' }, (() => { const c = h('input', { type: 'checkbox' }) as HTMLInputElement; c.checked = app.view.showTraces; c.onchange = () => { app.view.showTraces = c.checked; app.view.updateAnalysisVisuals(); }; return c; })(), 'paths')));
  box.append(runs);
  if (app.solo) box.append(h('div', { class: 'issue warn' }, h('span', {}, `Solo: only ${app.solo.size} object(s) are baked.`), h('button', { class: 'btn', onclick: () => app.setSolo(null) }, 'Leave solo')));
  return {};
}
