// Tweakpane bindings for document values (each change commits) and the help
// tooltips of every labelled row (texts in help.ts).

import type { App, ChangeKind } from '../app';
import type { Vec3 } from '../scene/doc';
import type { ParamSpec } from '../scene/entities';
import { h } from '../util/dom';
import { PARAM_HELP } from './help';

/** Select options from a list of values. */
export const opts = (list: readonly string[]) => Object.fromEntries(list.map((o) => [o, o]));

/** A Vec3 field edited as one x/y/z row; returns the proxy (assign `.v` to show new values). */
export function bindVec(app: App, folder: any, target: any, key: string, label: string, o: any, kind: ChangeKind): { v: { x: number; y: number; z: number } } {
  const arr = target[key] as Vec3;
  const proxy = { v: { x: arr[0], y: arr[1], z: arr[2] } };
  const spec: any = { label };
  for (const c of ['x', 'y', 'z']) spec[c] = { ...o };
  folder.addBinding(proxy, 'v', spec).on('change', (ev: any) => {
    target[key] = [ev.value.x, ev.value.y, ev.value.z];
    app.commit(kind);
  });
  return proxy;
}

/** The control of one entity parameter, from its spec; returns the blade. */
export function addParam(app: App, folder: any, params: Record<string, any>, spec: ParamSpec, kind: ChangeKind, selfId = ''): any {
  switch (spec.kind) {
    case 'entity': {
      const options: Record<string, string> = { '(any moving body)': '' };
      for (const x of app.doc.entities) if (x.id !== selfId && x.type !== 'sensor') options[x.name] = x.id;
      if (!Object.values(options).includes(params[spec.key])) params[spec.key] = '';
      return folder.addBinding(params, spec.key, { label: spec.label, options }).on('change', () => app.commit(kind));
    }
    case 'vec3': bindVec(app, folder, params, spec.key, spec.label, { min: spec.min, max: spec.max, step: spec.step }, kind); return folder.children[folder.children.length - 1];
    case 'bool': return folder.addBinding(params, spec.key, { label: spec.label }).on('change', () => app.commit(kind));
    case 'select': return folder.addBinding(params, spec.key, { label: spec.label, options: opts(spec.options!) }).on('change', () => app.commit(kind));
    case 'int': return folder.addBinding(params, spec.key, { label: spec.label, min: spec.min, max: spec.max, step: 1 }).on('change', () => app.commit(kind));
    default: return folder.addBinding(params, spec.key, { label: spec.label, min: spec.min, max: spec.max, step: spec.step }).on('change', () => app.commit(kind));
  }
}

/** Tags every labelled row of a pane with its help text (see help.ts). */
export function annotate(host: HTMLElement, tab: string): void {
  for (const row of host.querySelectorAll<HTMLElement>('.tp-lblv')) {
    if (row.dataset.tip) continue;
    const label = row.querySelector('.tp-lblv_l')?.textContent?.trim() ?? '';
    const folder = row.parentElement?.closest('.tp-fldv')?.querySelector('.tp-fldv_t')?.textContent?.trim() ?? '';
    const text = PARAM_HELP[`${folder}/${label}`] ?? PARAM_HELP[`${tab}/${label}`] ?? PARAM_HELP[label];
    if (text) row.dataset.tip = text;
  }
}

/** Shows `data-tip` texts after a short hover; returns the function that hides the tip. */
export function installTooltips(): () => void {
  const tipPop = h('div', { class: 'tip-pop' });
  document.body.append(tipPop);
  let tipTimer = 0;
  let tipFor: HTMLElement | null = null;
  const hideTip = () => { clearTimeout(tipTimer); tipFor = null; tipPop.classList.remove('on'); };
  document.addEventListener('pointerover', (ev) => {
    const el = (ev.target as HTMLElement)?.closest?.<HTMLElement>('[data-tip]') ?? null;
    if (el === tipFor) return;
    hideTip();
    if (!el || ev.pointerType === 'touch') return;
    tipFor = el;
    tipTimer = window.setTimeout(() => {
      if (tipFor !== el || !el.isConnected) return;
      tipPop.textContent = el.dataset.tip!;
      tipPop.classList.add('on');
      // beside the row, on the side with room (the panel sits at the edge)
      const r = el.getBoundingClientRect(), t = tipPop.getBoundingClientRect();
      const left = r.left - t.width - 10 >= 8 ? r.left - t.width - 10 : Math.min(window.innerWidth - t.width - 8, r.right + 10);
      const top = Math.max(8, Math.min(window.innerHeight - t.height - 8, r.top + r.height / 2 - t.height / 2));
      tipPop.style.left = `${left}px`;
      tipPop.style.top = `${top}px`;
    }, 280);
  });
  document.addEventListener('pointerdown', hideTip, true);
  document.addEventListener('wheel', hideTip, { capture: true, passive: true });
  return hideTip;
}
