// The bottom bar: play button, time code, the track (baked span, loop
// transition, machine-check marks, playhead; drag to scrub) and the bake box.

import type { App } from '../app';
import { boomerangSpans } from '../sim/loopTime';
import { h } from '../util/dom';

export class Timeline {
  readonly el: HTMLElement;
  private playBtn: HTMLButtonElement;
  private tc = h('div', { class: 'tc' });
  private trackCanvas = h('canvas');
  private track = h('div', { class: 'track', 'data-tut': 'track' }, this.trackCanvas);
  private bakeBtn: HTMLButtonElement;
  private bakeStatus = h('div', { class: 'bakestatus' });

  constructor(private app: App) {
    this.playBtn = h('button', { class: 'playbtn', title: 'Play / pause (Space)', onclick: () => app.togglePlay() }, '▶');
    this.bakeBtn = h('button', { class: 'btn', onclick: () => { if (app.baking) app.cancelBake(); else void app.bake(); } }, 'Bake');
    const autoToggle = h('input', { type: 'checkbox' }) as HTMLInputElement;
    autoToggle.checked = app.autoBake;
    autoToggle.onchange = () => { app.autoBake = autoToggle.checked; };
    this.el = h('div', { class: 'time', 'data-tut': 'timeline' }, this.playBtn, this.tc, this.track,
      h('div', { class: 'bakebox' }, h('div', { class: 'row2' }, this.bakeBtn, h('label', { class: 'toggle' }, autoToggle, 'auto-bake')), this.bakeStatus));

    let scrubbing = false;
    const scrubAt = (ev: PointerEvent) => {
      const r = this.track.getBoundingClientRect();
      app.seek(((ev.clientX - r.left) / r.width) * app.doc.duration);
    };
    this.track.addEventListener('pointerdown', (ev) => { scrubbing = true; this.track.setPointerCapture(ev.pointerId); app.playing = false; scrubAt(ev); });
    this.track.addEventListener('pointermove', (ev) => { if (scrubbing) scrubAt(ev); });
    this.track.addEventListener('pointerup', () => { scrubbing = false; });
  }

  frame(): void {
    this.updateLabels();
    this.drawTrack();
  }

  private updateLabels(): void {
    const app = this.app;
    this.playBtn.textContent = app.mode === 'play' && app.playing ? '❚❚' : '▶';
    const f = Math.floor(app.time * app.doc.fps);
    this.tc.innerHTML = `${app.time.toFixed(2)}s<br><small>frame ${f}</small>`;
    this.bakeBtn.textContent = app.baking ? 'Cancel' : app.stale ? 'Bake' : 'Re-bake';
    this.bakeBtn.classList.toggle('primary', app.stale && !app.baking);
    const status = this.bakeStatus;
    status.classList.toggle('err', !!app.bakeError);
    if (app.bakeError) status.textContent = app.bakeError;
    else if (app.baking) {
      const p = app.bakeProgress;
      status.textContent = `frame ${p.frame}/${p.total} · ${p.msPerFrame.toFixed(1)} ms/frame`;
    } else if (app.result) {
      const s = app.baker.lastStats;
      status.textContent = `${s.bodies} bodies · ${(s.totalMs / 1000).toFixed(1)}s bake`;
    } else status.textContent = app.stale ? 'needs bake' : '';
  }

  private drawTrack(): void {
    const app = this.app, trackCanvas = this.trackCanvas;
    const dpr = window.devicePixelRatio;
    const r = this.track.getBoundingClientRect();
    if (trackCanvas.width !== Math.round(r.width * dpr) || trackCanvas.height !== Math.round(r.height * dpr)) {
      trackCanvas.width = Math.round(r.width * dpr);
      trackCanvas.height = Math.round(r.height * dpr);
    }
    const ctx = trackCanvas.getContext('2d')!;
    const W = trackCanvas.width, H = trackCanvas.height;
    ctx.clearRect(0, 0, W, H);
    const D = app.doc.duration;
    const y0 = H * 0.32, bh = H * 0.36;
    ctx.fillStyle = '#20242d';
    roundRect(ctx, 0, y0, W, bh, 6 * dpr); ctx.fill();
    // baked portion
    const every = app.bakes.current?.recordEvery ?? 1;
    const boom = app.doc.loop.mode === 'boomerang' ? boomerangSpans(app.doc) : null;
    const bakedSim = ((app.availableFrames - 1) * every) / app.doc.fps;
    const bakedT = app.result ? D : app.baking ? Math.min(D, boom ? (bakedSim / Math.max(boom.sim, 1e-3)) * D : bakedSim) : 0;
    if (bakedT > 0) {
      const grad = ctx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, '#3a4a8a'); grad.addColorStop(1, '#5a3f8f');
      ctx.fillStyle = grad;
      roundRect(ctx, 0, y0, (bakedT / D) * W, bh, 6 * dpr); ctx.fill();
    }
    // outro zone (boomerang: the rewind)
    if (app.doc.loop.mode !== 'none') {
      const x = ((D - (boom ? boom.rewind : app.doc.loop.outro)) / D) * W;
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y0, W - x, bh); ctx.clip();
      ctx.strokeStyle = '#ffffff22'; ctx.lineWidth = 2 * dpr;
      for (let i = -H; i < W; i += 8 * dpr) { ctx.beginPath(); ctx.moveTo(x + i, y0 + bh); ctx.lineTo(x + i + bh, y0); ctx.stroke(); }
      ctx.restore();
      ctx.fillStyle = '#ffffff55'; ctx.font = `${9 * dpr}px JetBrains Mono`;
      ctx.fillText(boom ? `REWIND ×${app.doc.loop.rewind}` : app.doc.loop.mode.toUpperCase(), x + 5 * dpr, y0 - 4 * dpr);
    }
    // machine check: when each object was set in motion (red: a broken row)
    const rep = app.report;
    if (rep && !app.reportStale) {
      for (const e of rep.entities) {
        if (e.first === null || !e.expected) continue;
        const x = (e.first / D) * W;
        ctx.fillStyle = e.status === 'partial' ? '#ff6b7a' : '#ffffffaa';
        ctx.fillRect(x - dpr * 0.5, y0 + bh * 0.2, dpr * 1.5, bh * 0.6);
        if (e.breakAt) {
          const xb = (e.breakAt.t / D) * W;
          ctx.fillStyle = '#ff6b7a';
          ctx.beginPath(); ctx.moveTo(xb, y0 - 1 * dpr); ctx.lineTo(xb - 4 * dpr, y0 - 7 * dpr); ctx.lineTo(xb + 4 * dpr, y0 - 7 * dpr); ctx.fill();
        }
      }
      for (const sn of rep.sensors) {
        if (sn.triggered === null) continue;
        const x = (sn.triggered / D) * W;
        ctx.fillStyle = '#5ee0a0';
        ctx.beginPath(); ctx.arc(x, y0 + bh / 2, 2.6 * dpr, 0, Math.PI * 2); ctx.fill();
      }
      if (rep.motionEnd !== null) {
        const x = Math.min(W - dpr, (rep.motionEnd / D) * W);
        ctx.strokeStyle = rep.outroStart !== null && app.doc.loop.mode !== 'boomerang' && rep.motionEnd > rep.outroStart ? '#ffb35c' : '#5ee0a088';
        ctx.lineWidth = 1.5 * dpr;
        ctx.setLineDash([3 * dpr, 3 * dpr]);
        ctx.beginPath(); ctx.moveTo(x, y0 - 2 * dpr); ctx.lineTo(x, y0 + bh + 2 * dpr); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // ticks
    ctx.fillStyle = '#5b6172'; ctx.font = `${9 * dpr}px JetBrains Mono`;
    for (let s = 0; s <= D; s++) {
      const x = (s / D) * W;
      ctx.fillRect(Math.min(W - dpr, x), y0 + bh + 3 * dpr, dpr, (s % 5 === 0 ? 6 : 3) * dpr);
      if (s % (D > 15 ? 5 : 1) === 0 && s < D) ctx.fillText(`${s}s`, x + 3 * dpr, H - 1 * dpr);
    }
    // playhead
    const px = (app.time / D) * W;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(px - dpr, y0 - 6 * dpr, 2 * dpr, bh + 12 * dpr);
    ctx.beginPath(); ctx.arc(px, y0 - 6 * dpr, 4 * dpr, 0, Math.PI * 2); ctx.fill();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(0, w), h, Math.min(r, w / 2));
}
