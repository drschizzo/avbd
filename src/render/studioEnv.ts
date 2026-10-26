// A soft photographic studio used as the environment map: a vertical gradient
// dome plus a few large softboxes kept off the zenith, so up-facing glossy
// surfaces keep their colour instead of mirroring a blown-out ceiling.

import * as THREE from 'three/webgpu';

export function createStudioScene(): THREE.Scene {
  const scene = new THREE.Scene();
  const dome = new THREE.SphereGeometry(40, 48, 24);
  const col = new Float32Array(dome.attributes.position.count * 3);
  // The lower hemisphere stands in for the studio floor, which is a pale sweep
  // in every palette, so it is kept close to that brightness. Leaving it
  // near-black made every downward reflection a dark smear - most visible on
  // glass seen at an angle, where Fresnel hands the pixel almost entirely to
  // the reflection and a tank then looked like it cast hard shadows inside
  // itself. It barely moves the diffuse ambient (checked against the pale
  // presets), but it is what keeps grazing glass bright.
  const top = new THREE.Color(0.55, 0.57, 0.62), horizon = new THREE.Color(0.85, 0.85, 0.88), ground = new THREE.Color(0.58, 0.56, 0.54);
  const c = new THREE.Color();
  for (let i = 0; i < dome.attributes.position.count; i++) {
    const y = dome.attributes.position.getY(i) / 40;
    if (y >= 0) c.copy(horizon).lerp(top, Math.pow(y, 0.7));
    else c.copy(horizon).lerp(ground, Math.min(1, Math.pow(-y, 0.5) * 1.2));
    col.set([c.r, c.g, c.b], i * 3);
  }
  dome.setAttribute('color', new THREE.BufferAttribute(col, 3));
  scene.add(new THREE.Mesh(dome, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));

  const box = (w: number, h: number, intensity: number, pos: [number, number, number], tint = 0xffffff) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(tint).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    scene.add(m);
  };
  box(16, 9, 2.4, [-20, 13, 14]);           // key
  box(12, 12, 1.2, [24, 9, -6], 0xfff2e6);  // warm fill
  box(26, 5, 1.6, [0, 15, -24], 0xe6f0ff);  // cool rim strip
  box(9, 20, 0.9, [8, 4, 26]);              // front kicker
  return scene;
}
