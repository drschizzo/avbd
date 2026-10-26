// Small pieces shared by the editor's panels: toasts, downloads, modals and
// the output frame's dimensions.

import type { SceneDoc } from '../scene/doc';
import { h } from '../util/dom';

export function toast(msg: string): void {
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** File name from a scene name. */
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'loop';

export const ASPECTS: Record<string, [number, number]> = { '1:1': [1, 1], '9:16': [9, 16], '4:5': [4, 5], '16:9': [16, 9] };

/** Output size for a short side of `short` pixels (even dimensions, for the encoder). */
export function exportDims(doc: SceneDoc, short: number): [number, number] {
  const [aw, ah] = ASPECTS[doc.render.aspect] ?? [1, 1];
  return aw >= ah ? [Math.round((short * aw) / ah / 2) * 2, short] : [short, Math.round((short * ah) / aw / 2) * 2];
}

/** Shows `content` over a dimmed page (a click outside closes it); returns the close function. */
export function modal(content: HTMLElement, onClose?: () => void): () => void {
  const bg = h('div', { class: 'modal-bg' }, content);
  bg.addEventListener('pointerdown', (ev) => { if (ev.target === bg) { bg.remove(); onClose?.(); } });
  document.body.append(bg);
  return () => bg.remove();
}
