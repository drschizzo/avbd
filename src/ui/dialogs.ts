// The editor's dialogs: presets, opening a scene file, MP4 export, and the
// first-visit invitation to the tutorial.

import type { App } from '../app';
import { exportVideo } from '../export/video';
import { PRESETS } from '../scene/presets';
import { h } from '../util/dom';
import { ASPECTS, download, exportDims, modal, slug, toast } from './kit';

export function openPresets(app: App): void {
  const list = h('div', { class: 'presets' });
  let close = () => {};
  for (const p of PRESETS) {
    list.append(h('button', { class: 'preset', onclick: () => { close(); app.loadPreset(p.key); } }, h('b', {}, p.name), h('span', {}, p.blurb), ...(p.warn ? [h('em', {}, `⚠ ${p.warn}`)] : [])));
  }
  close = modal(h('div', { class: 'modal', style: 'width:560px' },
    h('h3', {}, 'Presets'), h('p', {}, 'Curated loops — load one, then tweak everything.'), list,
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => { close(); app.pushUndo(); const d = PRESETS[0].make(); d.entities = []; d.name = 'Empty scene'; app.setDoc(d); } }, 'Empty scene'),
      h('button', { class: 'btn', onclick: () => close() }, 'Close'))));
}

export function openFile(app: App): void {
  const input = h('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement;
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    try { app.pushUndo(); app.setDoc(JSON.parse(await f.text())); toast(`Loaded ${f.name}`); } catch { toast('Invalid scene file'); }
  };
  input.click();
}

/** `refit` puts the viewport back once the export has resized the renderer. */
export function openExport(app: App, refit: () => void): void {
  const [aw, ah] = ASPECTS[app.doc.render.aspect] ?? [1, 1];
  const resSel = h('select', { class: 'sel' }, ...[720, 1080, 1440, 2160].map((s) => {
    const [w, hh] = exportDims(app.doc, s);
    return h('option', { value: String(s), selected: s === 1080 }, `${w} × ${hh}`);
  })) as HTMLSelectElement;
  const fpsSel = h('select', { class: 'sel' }, h('option', { value: '60', selected: true }, '60 fps'), h('option', { value: '30' }, '30 fps')) as HTMLSelectElement;
  const ssSel = h('select', { class: 'sel' }, h('option', { value: '2', selected: true }, '2× supersampling'), h('option', { value: '1' }, 'Off (faster)')) as HTMLSelectElement;
  const loopsSel = h('select', { class: 'sel' }, ...[1, 2, 3, 6].map((n) => h('option', { value: String(n) }, `${n}× (${(n * app.doc.duration).toFixed(0)} s)`))) as HTMLSelectElement;
  const brSel = h('select', { class: 'sel' }, ...[12, 24, 40, 60].map((n) => h('option', { value: String(n), selected: n === 24 }, `${n} Mbps`))) as HTMLSelectElement;
  const bar = h('div');
  const status = h('p', { style: 'margin:10px 0 0' });
  let cancelled = false;
  const go = h('button', { class: 'btn primary' }, 'Render');
  const close = modal(h('div', { class: 'modal' },
    h('h3', {}, 'Export seamless loop'),
    h('p', {}, `Offline, frame-exact render of the baked simulation (${aw}:${ah}). Loops perfectly when played on repeat.`),
    h('div', { class: 'field' }, h('label', {}, 'Resolution'), resSel),
    h('div', { class: 'field' }, h('label', {}, 'Frame rate'), fpsSel),
    h('div', { class: 'field' }, h('label', {}, 'Quality'), ssSel),
    h('div', { class: 'field' }, h('label', {}, 'Bitrate'), brSel),
    h('div', { class: 'field' }, h('label', {}, 'Length'), loopsSel),
    h('div', { class: 'progress' }, bar), status,
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => { cancelled = true; close(); } }, 'Close'), go)), () => { cancelled = true; });
  go.onclick = async () => {
    if (!app.result) { status.textContent = app.baking ? 'Wait for the bake to finish…' : 'Bake the scene first.'; return; }
    go.setAttribute('disabled', '');
    const [w, hh] = exportDims(app.doc, Number(resSel.value));
    const t0 = performance.now();
    try {
      const blob = await exportVideo(app, {
        width: w, height: hh, fps: Number(fpsSel.value) as 30 | 60, supersample: Number(ssSel.value) as 1 | 2,
        bitrateMbps: Number(brSel.value), loops: Number(loopsSel.value),
      }, (p) => {
        bar.style.width = `${(p.frame / p.total) * 100}%`;
        status.textContent = p.phase === 'finalize' ? 'Finalizing MP4…' : `Rendering frame ${p.frame} / ${p.total}`;
      }, () => cancelled);
      refit();
      if (blob) {
        download(blob, `${slug(app.doc.name)}-${w}x${hh}.mp4`);
        status.textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s · ${(blob.size / 1048576).toFixed(1)} MB`;
      }
    } catch (err: any) {
      refit();
      status.textContent = `Export failed: ${err?.message ?? err}`;
    }
    go.removeAttribute('disabled');
  };
}

/** First visit: a card under the tutorial button; returns the function that removes it. */
export function showInvite(anchor: HTMLElement, start: () => void): () => void {
  const r = anchor.getBoundingClientRect();
  let invite: HTMLElement | null = null;
  const remove = () => { invite?.remove(); invite = null; };
  const later = h('button', { class: 'btn ghost', onclick: remove }, 'Plus tard');
  const go = h('button', { class: 'btn primary', onclick: () => { remove(); start(); } }, 'Commencer');
  invite = h('div', { class: 'tut-invite', style: `left:${Math.max(8, r.left - 14)}px;top:${r.bottom + 12}px` },
    h('b', {}, 'Première visite ?'),
    'Le tutoriel fait le tour des fonctions principales, puis vous guide pour construire une petite machine en chaîne. Une quinzaine de minutes.',
    h('div', { class: 'row' }, later, go));
  document.body.append(invite);
  return remove;
}
