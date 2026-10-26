import { describe, expect, it } from 'vitest';
import { buildPath, pathLength, simplify, FILL_DEFAULTS } from '../src/scene/path';
import * as THREE from 'three';

describe('drawn paths', () => {
  it('measures a straight polyline', () => {
    expect(pathLength([[0, 0, 0], [3, 0, 0], [3, 0, 4]], false, false)).toBeCloseTo(7, 6);
  });

  it('spaces dominoes evenly along the path (spacing in domino heights)', () => {
    const size = FILL_DEFAULTS.dominoes.size;
    const spacing = 0.5;
    const bodies = buildPath({ fill: 'dominoes', points: [[0, 0, 0], [5, 0, 0]], smooth: false, closed: false, size, spacing, push: 0 });
    const step = spacing * size[1];
    expect(bodies.length).toBe(Math.floor(5 / step) + 1);
    for (let i = 1; i < bodies.length; i++) expect(bodies[i].p[0] - bodies[i - 1].p[0]).toBeCloseTo(step, 6);
  });

  it('simplify keeps both ends of a stroke', () => {
    const pts = Array.from({ length: 50 }, (_, i) => new THREE.Vector3(i * 0.1, Math.sin(i * 0.3) * 0.001, 0));
    const s = simplify(pts, 0.01);
    expect(s[0].equals(pts[0])).toBe(true);
    expect(s[s.length - 1].equals(pts[49])).toBe(true);
    expect(s.length).toBeLessThan(pts.length);
  });
});
