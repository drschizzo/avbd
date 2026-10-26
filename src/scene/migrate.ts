// Documents saved by older versions (local storage, shared links): fill what
// they lack from today's defaults, drop entity types that no longer exist.

import { defaultDoc, type SceneDoc } from './doc';
import { ENTITY_DEFS } from './entities';

export function migrateDoc(d: any): SceneDoc | null {
  if (!d || d.version !== 1 || !Array.isArray(d.entities)) return null;
  const base = defaultDoc();
  // entity params gain new keys over time: fill them from the current defaults
  const entities = d.entities
    .filter((e: any) => ENTITY_DEFS[e.type as keyof typeof ENTITY_DEFS])
    .map((e: any) => ({ ...e, params: { ...structuredClone(ENTITY_DEFS[e.type as keyof typeof ENTITY_DEFS].defaults), ...e.params } }));
  return { ...base, ...d, entities, physics: { ...base.physics, ...d.physics }, loop: { ...base.loop, ...d.loop }, camera: { ...base.camera, ...d.camera }, render: { ...base.render, ...d.render }, fluid: { ...base.fluid, ...(d.fluid ?? {}) } };
}
