// The animated shot camera of playback and export: the document's camera,
// moved periodically over the loop (orbit, sway, dolly, crane) or following
// the action read from the machine check.

import * as THREE from 'three/webgpu';
import type { BuiltScene } from '../scene/build';
import type { SceneDoc } from '../scene/doc';
import type { MachineReport } from '../sim/analysis';
import { followAt, followDistance, followRaw, followTrack, type FollowRaw, type FollowTrack } from '../sim/follow';

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);

export class ShotCamera {
  /** where the camera looks this frame (focus distance) */
  readonly target = new THREE.Vector3();
  /** activity read from the last report, and its smoothed path */
  private raw: FollowRaw | null = null;
  private track: FollowTrack | null = null;
  private smooth = -1;

  /** Re-reads where the action is (after a bake, or when objects stop or start drawing the camera). */
  refresh(report: MachineReport | null, built: BuiltScene, doc: SceneDoc): void {
    this.raw = report ? followRaw(report, built, doc) : null;
    this.track = null;
    this.smooth = -1;
  }

  private followTrack(doc: SceneDoc): FollowTrack | null {
    if (!this.raw) return null;
    const smooth = doc.camera.followSmooth ?? 0.8;
    if (!this.track || this.smooth !== smooth) { this.track = followTrack(this.raw, smooth); this.smooth = smooth; }
    return this.track;
  }

  /** Poses `cam` at video time t; `simT` is the simulated time shown then. */
  apply(doc: SceneDoc, t: number, simT: number, cam: THREE.PerspectiveCamera): void {
    const c = doc.camera;
    const target = new THREE.Vector3(...c.target);
    const off = new THREE.Vector3(...c.position).sub(target);
    const track = c.motion === 'follow' ? this.followTrack(doc) : null;
    if (track) {
      // the shot's angle, closer, aimed at the action of the simulated moment
      // (so a boomerang's rewind brings the camera back along its path)
      const lead = c.followLead ?? 0.3;
      let f = followAt(track, simT + lead);
      if (doc.loop.mode !== 'boomerang') {
        // other loops restart from the first shot: glide back to it
        const D = doc.duration, blend = Math.min(2, D * 0.15);
        const u = Math.min(1, Math.max(0, (t - (D - blend)) / blend));
        if (u > 0) {
          const s = u * u * (3 - 2 * u), g = followAt(track, lead);
          f = {
            target: [0, 1, 2].map((i) => f.target[i] + (g.target[i] - f.target[i]) * s) as [number, number, number],
            radius: f.radius + (g.radius - f.radius) * s,
          };
        }
      }
      const d = followDistance(c, f.radius, off.length());
      off.normalize().multiplyScalar(d);
      target.set(...f.target);
    }
    // Whole cycles only: anything else would jump at the loop point.
    const cycles = Math.max(1, Math.round(c.cycles));
    const u = (t / doc.duration) * cycles;
    switch (c.motion) {
      // full turns (a partial orbit cannot loop); `amount` adds a gentle
      // vertical bob, in degrees of elevation
      case 'orbit': {
        off.applyAxisAngle(UP, TAU * u);
        const bob = Math.min(c.amount, 30) * Math.PI / 180 * Math.sin(TAU * u * 2);
        if (bob !== 0) {
          const side = UP.clone().cross(off).normalize();
          off.applyAxisAngle(side, -bob * 0.5);
        }
        break;
      }
      case 'follow':
      case 'sway': off.applyAxisAngle(UP, Math.sin(TAU * u) * c.amount * Math.PI / 180); break;
      case 'dolly': off.multiplyScalar(1 - (c.amount / 100) * 0.5 * (1 - Math.cos(TAU * u))); break;
      case 'crane': {
        const s = Math.sin(TAU * u);
        off.applyAxisAngle(UP, s * c.amount * 0.4 * Math.PI / 180);
        off.y += s * off.length() * c.amount / 200;
        break;
      }
      default: break;
    }
    cam.fov = c.fov;
    cam.position.copy(target).add(off);
    cam.lookAt(target);
    this.target.copy(target);
    cam.updateProjectionMatrix();
  }
}
