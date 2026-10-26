// The document outside the page: local storage (autosave) and share links.

import type { SceneDoc } from '../scene/doc';
import { migrateDoc } from '../scene/migrate';
import { KEYS, readText, writeJSON } from '../util/storage';

const SHARE_PREFIX = '#scene=';
const AUTOSAVE_MS = 600;

/** A shared link's scene if the URL carries one, else the autosaved one. */
export function loadSavedDoc(): SceneDoc | null {
  try {
    const hash = location.hash.startsWith(SHARE_PREFIX) ? location.hash.slice(SHARE_PREFIX.length) : '';
    if (hash) return migrateDoc(JSON.parse(decodeURIComponent(escape(atob(hash)))));
    const s = readText(KEYS.doc);
    return s ? migrateDoc(JSON.parse(s)) : null;
  } catch {
    return null;
  }
}

export function saveDoc(doc: SceneDoc): void {
  writeJSON(KEYS.doc, doc);
}

let timer = 0;
/** Autosave once edits pause (whatever `current` holds by then). */
export function saveDocSoon(current: () => SceneDoc): void {
  clearTimeout(timer);
  timer = window.setTimeout(() => saveDoc(current()), AUTOSAVE_MS);
}

export function shareUrl(doc: SceneDoc): string {
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(doc))));
  return `${location.origin}${location.pathname}${SHARE_PREFIX}${b64}`;
}
