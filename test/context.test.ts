import { describe, expect, it } from 'vitest';
import { SettingsStack } from '../src/core/context';

const base = () => ({ persist: true, holdEdit: false, autoBake: true, pacedBake: true });

describe('SettingsStack', () => {
  it('layers override and give back the values underneath', () => {
    const st = new SettingsStack(base());
    const course = st.push({ persist: false, pacedBake: false });
    expect(st.value).toMatchObject({ persist: false, pacedBake: false, autoBake: true });
    course.pop();
    expect(st.value).toEqual(base());
  });

  it('pops out of order and only once', () => {
    const st = new SettingsStack(base());
    const tut = st.push({ holdEdit: true });
    const course = st.push({ persist: false });
    tut.pop();
    expect(st.value).toMatchObject({ holdEdit: false, persist: false });
    tut.pop();
    course.pop();
    expect(st.value).toEqual(base());
  });

  it('the user setting survives a layer that overrode it', () => {
    const seen: boolean[] = [];
    const st = new SettingsStack(base(), (s) => seen.push(s.autoBake));
    const course = st.push({ autoBake: true });
    st.setBase({ autoBake: false }); // user toggles while the course runs
    expect(st.value.autoBake).toBe(true);
    course.pop();
    expect(st.value.autoBake).toBe(false);
    expect(seen.at(-1)).toBe(false);
  });

  it('a layer can change its overrides, not after it is gone', () => {
    const st = new SettingsStack(base());
    const tut = st.push();
    tut.set({ holdEdit: true });
    expect(st.value.holdEdit).toBe(true);
    tut.pop();
    tut.set({ holdEdit: true });
    expect(st.value.holdEdit).toBe(false);
  });
});
