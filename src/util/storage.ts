// Local storage, in one place: every key the app persists, and reads / writes
// that never throw (private windows, blocked site data and full quotas just
// lose the value).

export const KEYS = {
  doc: 'looplab.doc.v1',
  clipboard: 'looplab.clipboard.v1',
  gadgets: 'looplab.gadgets.v1',
  addCollapsed: 'looplab.addCollapsed',
  tutorial: 'looplab.tutorial',
  tutorialBackup: 'looplab.tutorial.backup',
  course: 'avbd.course.v1',
} as const;

export type StorageKey = typeof KEYS[keyof typeof KEYS];

export function readText(key: StorageKey): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** False when the value could not be stored. */
export function writeText(key: StorageKey, value: string): boolean {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

export function readJSON<T>(key: StorageKey, fallback: T): T {
  const s = readText(key);
  if (s === null) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export function writeJSON(key: StorageKey, value: unknown): boolean {
  return writeText(key, JSON.stringify(value));
}

export function removeKey(key: StorageKey): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
