// Settings that modes like the course and the tutorial override while they
// run. Each pushes a layer and pops it when done; the values underneath come
// back on their own, whatever order the layers leave in.

export interface AppSettings {
  /**
   * Document changes are written to local storage and the undo history. The
   * course swaps the document behind the user's back: its scenes must not
   * replace the one they were working on.
   */
  persist: boolean;
  /**
   * A finished bake leaves the editor in edit mode instead of starting
   * playback (the tutorial keeps the learner in the editor while they place parts).
   */
  holdEdit: boolean;
  /** re-bake automatically after each physics edit */
  autoBake: boolean;
  /** pace the bake on rendered frames so the streamed preview stays fluid */
  pacedBake: boolean;
}

export interface SettingsLayer {
  /** Changes this layer's overrides. */
  set(patch: Partial<AppSettings>): void;
  /** Removes the layer (once). */
  pop(): void;
}

export class SettingsStack {
  private layers: Partial<AppSettings>[] = [];
  private cached: AppSettings;

  constructor(private base: AppSettings, private onChange: (s: AppSettings) => void = () => {}) {
    this.cached = { ...base };
  }

  get value(): AppSettings { return this.cached; }

  /** The user's own settings, under every layer. */
  setBase(patch: Partial<AppSettings>): void {
    Object.assign(this.base, patch);
    this.update();
  }

  push(patch: Partial<AppSettings> = {}): SettingsLayer {
    const layer = { ...patch };
    this.layers.push(layer);
    this.update();
    return {
      set: (p) => { if (this.layers.includes(layer)) { Object.assign(layer, p); this.update(); } },
      pop: () => {
        const i = this.layers.indexOf(layer);
        if (i >= 0) { this.layers.splice(i, 1); this.update(); }
      },
    };
  }

  /** Re-announces the current values (e.g. once their consumers exist). */
  update(): void {
    this.cached = Object.assign({ ...this.base }, ...this.layers.map(defined));
    this.onChange(this.cached);
  }
}

/** A layer's overrides without the keys it left undefined. */
function defined(o: Partial<AppSettings>): Partial<AppSettings> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
