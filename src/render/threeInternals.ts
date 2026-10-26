// Every reach into three.js private state, in one place. Written against
// three r183: re-check each of these when upgrading three.

import type { TransformControls } from 'three/addons/controls/TransformControls.js';

/** Frees an attribute's GPU buffer now instead of at garbage collection. */
export function releaseAttribute(renderer: unknown, attr: object): void {
  try { (renderer as any)._attributes?.delete(attr); } catch { /* already gone */ }
}

/**
 * Advances the node frame. Pass nodes render once per frame id, which only
 * moves in three's own rAF loop: offscreen captures must bump it themselves.
 */
export function advanceNodeFrame(renderer: unknown): void {
  (renderer as any)._nodes?.nodeFrame?.update();
}

/** The GPUBuffer behind a storage attribute, once uploaded. */
export function gpuBufferOf(renderer: unknown, attr: object): GPUBuffer | undefined {
  return (renderer as any).backend.get(attr)?.buffer as GPUBuffer | undefined;
}

/** Makes an attribute use a buffer allocated by hand (its array is never uploaded). */
export function adoptGpuBuffer(renderer: unknown, attr: object, buffer: GPUBuffer): void {
  (renderer as any).backend.get(attr).buffer = buffer;
}

/** Removes the free-rotation trackball sphere of a rotate gizmo. */
export function removeTrackball(gizmo: TransformControls): void {
  const gz = (gizmo as any)._gizmo;
  for (const group of [gz.picker.rotate, gz.gizmo.rotate]) {
    for (const c of [...group.children]) if (c.name === 'XYZE') c.removeFromParent();
  }
}

/** Runs the gizmo's own hover test for a pointer event (sets its `axis`). */
export function hoverGizmo(gizmo: TransformControls, ev: PointerEvent): void {
  const g = gizmo as any;
  g.pointerHover(g._getPointer(ev));
}
