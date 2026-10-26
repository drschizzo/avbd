// Analytic studio softboxes, shared by glass and water. The PMREM studio
// environment is soft (great for diffuse light, mushy in a mirror); these
// crisp panels give clear, readable reflections on smooth transparent surfaces.

import * as TSLTyped from 'three/tsl';

const TSL: any = TSLTyped;
const { Fn, vec3, smoothstep, abs, max, float } = TSL;

/** Radiance of the studio panels seen along world direction r. */
export const studioLights = Fn(([r]: any[]) => {
  // large overhead panel
  const top = smoothstep(0.62, 0.86, r.y).mul(1.8);
  // two tall side strips (left/right), soft-edged
  const side = smoothstep(0.9, 0.975, abs(r.x)).mul(smoothstep(-0.05, 0.25, r.y)).mul(smoothstep(0.75, 0.45, abs(r.z))).mul(1.4);
  // a back strip behind the scene
  const back = smoothstep(0.93, 0.985, r.z.negate()).mul(smoothstep(0.0, 0.3, r.y)).mul(0.9);
  return vec3(max(top.add(side).add(back), float(0)));
});
