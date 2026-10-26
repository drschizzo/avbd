// Editor keyboard shortcuts (ignored while typing in a field).

import type { App } from '../app';
import type { PlaneAxis } from '../edit/tools';
import { toast } from './kit';

/** `onCamera`: the free / shot camera switch changed. */
export function installShortcuts(app: App, onCamera: () => void): void {
  window.addEventListener('keydown', (ev) => {
    const tag = (ev.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const mod = ev.metaKey || ev.ctrlKey;
    const key = ev.key.toLowerCase();
    if (mod && key === 'z') { ev.preventDefault(); if (ev.shiftKey) app.redo(); else app.undo(); return; }
    if (mod && key === 'y') { ev.preventDefault(); app.redo(); return; }
    if (mod && key === 'd') { ev.preventDefault(); if (app.selectedIds.length) app.duplicateEntities([...app.selectedIds]); return; }
    if (mod && key === 'c') { if (app.selectedIds.length) { ev.preventDefault(); toast(`${app.tools.copySelection()} object(s) copied`); } return; }
    if (mod && key === 'x') { if (app.selectedIds.length) { ev.preventDefault(); toast(`${app.tools.cutSelection()} object(s) cut`); } return; }
    if (mod && key === 'v') { ev.preventDefault(); if (!app.tools.paste()) toast('Nothing to paste'); return; }
    if (mod && key === 'a') { ev.preventDefault(); app.selectAll(); return; }
    if (mod && key === 'g') { ev.preventDefault(); app.groupSelection(ev.shiftKey ? null : ''); return; }
    if (mod) return;
    switch (ev.key) {
      case 'v': case 'V': app.tools.setTool('select'); return;
      case 'd': case 'D': app.tools.setTool(app.tools.tool === 'draw' ? 'select' : 'draw'); return;
      case 'p': case 'P': {
        const order: PlaneAxis[] = ['off', 'xy', 'zy', 'xz'];
        app.tools.setPlane(order[(order.indexOf(app.tools.plane.axis) + 1) % order.length]);
        return;
      }
      case '[': app.tools.nudgePlane(-0.25); return;
      case ']': app.tools.nudgePlane(0.25); return;
      case 'End': ev.preventDefault(); app.tools.dropSelection(); return;
      case 'f': case 'F': app.tools.frameSelection(); onCamera(); return;
    }
    switch (ev.key) {
      case ' ': ev.preventDefault(); app.togglePlay(); break;
      case 'q': case 'Q': app.view.setGizmoMode('all'); break;
      case 'w': case 'W': app.view.setGizmoMode('translate'); break;
      case 'e': case 'E': app.view.setGizmoMode('rotate'); break;
      case 'Escape': app.select(null); if (app.mode === 'play') app.setMode('edit'); break;
      case 'Delete': case 'Backspace':
        if (app.tools.deleteHandle()) break;
        if (app.selectedIds.length) app.removeEntities([...app.selectedIds]);
        break;
      case 'b': case 'B': void app.bake(); break;
      case 'Home': app.seek(0); break;
      case 'ArrowRight': app.seek(app.time + 1 / app.doc.fps); app.playing = false; break;
      case 'ArrowLeft': app.seek(app.time - 1 / app.doc.fps); app.playing = false; break;
    }
  });
}
