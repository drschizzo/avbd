// Frame-exact offline export. Each frame is rendered deterministically from
// the baked history into an offscreen target (supersampled), downsampled on
// the GPU, read back as RGBA and fed to WebCodecs; frames are muxed to MP4.
// The canvas is never read, so the output does not depend on presentation.

import * as THREE from 'three/webgpu';
import * as TSLTyped from 'three/tsl';
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { App } from '../app';

const TSL: any = TSLTyped;

export interface ExportOptions {
  width: number;
  height: number;
  fps: 30 | 60;
  supersample: 1 | 2;
  bitrateMbps: number;
  loops: number;
}

export interface ExportProgress { frame: number; total: number; phase: 'render' | 'finalize' }

/** Renders the stage's post pipeline offscreen and reads back RGBA8 pixels. */
class OffscreenCapture {
  private big: THREE.RenderTarget;
  private small: THREE.RenderTarget | null = null;
  private quad: THREE.QuadMesh | null = null;
  private prevPixelRatio: number;
  private prevSize = new THREE.Vector2();
  private prevAspect: number;

  constructor(private app: App, readonly width: number, readonly height: number, ss: number) {
    const { stage } = app;
    const r = stage.renderer;
    this.prevPixelRatio = r.getPixelRatio();
    r.getSize(this.prevSize);
    this.prevAspect = stage.camera.aspect;
    r.setPixelRatio(1);
    r.setSize(width * ss, height * ss, false);
    stage.camera.aspect = width / height;
    stage.camera.updateProjectionMatrix();
    this.big = new THREE.RenderTarget(width * ss, height * ss, { type: THREE.UnsignedByteType, depthBuffer: false });
    this.big.texture.minFilter = THREE.LinearFilter;
    this.big.texture.magFilter = THREE.LinearFilter;
    if (ss > 1) {
      this.small = new THREE.RenderTarget(width, height, { type: THREE.UnsignedByteType, depthBuffer: false });
      // Sampling a 2x target at the small target's pixel centres with bilinear
      // filtering averages exactly 2x2 source pixels (box downsample).
      const mat = new THREE.NodeMaterial();
      mat.fragmentNode = TSL.texture(this.big.texture, TSL.uv());
      this.quad = new THREE.QuadMesh(mat);
    }
  }

  private primed = false;

  async capture(): Promise<Uint8Array> {
    // The post pipeline resizes its internal targets lazily on the first render
    // at a new size: render and discard one frame so frame 0 is never stale.
    if (!this.primed) { this.primed = true; await this.capture(); }
    const r = this.app.stage.renderer;
    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(this.big);
    this.app.stage.renderOffscreen();
    let target = this.big;
    if (this.quad && this.small) {
      r.setRenderTarget(this.small);
      this.quad.render(r);
      target = this.small;
    }
    r.setRenderTarget(prevTarget);
    const data = await r.readRenderTargetPixelsAsync(target, 0, 0, this.width, this.height);
    const raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const row = this.width * 4;
    const aligned = Math.ceil(row / 256) * 256;
    const stride = raw.byteLength >= aligned * (this.height - 1) + row && raw.byteLength < row * this.height + 1 ? row
      : raw.byteLength >= aligned * (this.height - 1) + row ? aligned : row;
    if (stride === row) return raw.slice(0, row * this.height);
    // WebGPU pads rows to 256 bytes: repack tightly.
    const out = new Uint8Array(row * this.height);
    for (let y = 0; y < this.height; y++) out.set(raw.subarray(y * stride, y * stride + row), y * row);
    return out;
  }

  dispose(): void {
    const { stage } = this.app;
    const r = stage.renderer;
    this.big.dispose();
    this.small?.dispose();
    (this.quad as any)?.material?.dispose();
    r.setPixelRatio(this.prevPixelRatio);
    r.setSize(this.prevSize.x, this.prevSize.y, false);
    stage.camera.aspect = this.prevAspect;
    stage.camera.updateProjectionMatrix();
  }
}

async function pickCodec(w: number, h: number, fps: number, bitrate: number): Promise<{ codec: string; mux: 'avc' | 'vp9' }> {
  const candidates: { codec: string; mux: 'avc' | 'vp9' }[] = [
    { codec: 'avc1.640034', mux: 'avc' },
    { codec: 'avc1.640033', mux: 'avc' },
    { codec: 'avc1.4d0034', mux: 'avc' },
    { codec: 'vp09.00.51.08', mux: 'vp9' },
    { codec: 'vp09.00.41.08', mux: 'vp9' },
  ];
  for (const c of candidates) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec: c.codec, width: w, height: h, bitrate, framerate: fps });
      if (r.supported) return c;
    } catch { /* try next */ }
  }
  throw new Error('No supported video encoder for this resolution.');
}

export function setFrame(app: App, t: number, seed: number): void {
  const { stage } = app;
  const pb = app.playbackAt(t);
  app.bodies.setPlayback(pb);
  app.fluid.setPlayback(pb);
  app.shotCamera(t, stage.camera);
  const focus = app.doc.render.focus > 0 ? app.doc.render.focus : stage.camera.position.distanceTo(app.shotTarget);
  stage.setFocus(focus);
  stage.uFrameSeed.value = seed;
}

export async function exportVideo(
  app: App, opts: ExportOptions, onProgress: (p: ExportProgress) => void, isCancelled: () => boolean,
): Promise<Blob | null> {
  if (!('VideoEncoder' in window)) throw new Error('WebCodecs (VideoEncoder) is not available in this browser.');
  if (!app.result) throw new Error('Bake the simulation first.');
  const w = opts.width & ~1, h = opts.height & ~1;
  const bitrate = Math.round(opts.bitrateMbps * 1e6);
  const { codec, mux } = await pickCodec(w, h, opts.fps, bitrate);

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: mux, width: w, height: h, frameRate: opts.fps }, fastStart: 'in-memory' });
  let encodeError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encodeError = e as Error; },
  });
  encoder.configure({ codec, width: w, height: h, bitrate, framerate: opts.fps, latencyMode: 'quality', bitrateMode: 'variable' } as VideoEncoderConfig);

  app.exporting = true;
  const cap = new OffscreenCapture(app, w, h, opts.supersample);
  try {
    const perLoop = Math.round(app.doc.duration * opts.fps);
    const total = perLoop * Math.max(1, opts.loops);
    for (let i = 0; i < total; i++) {
      if (isCancelled()) { encoder.close(); return null; }
      if (encodeError) throw encodeError;
      const t = (i % perLoop) / opts.fps;
      setFrame(app, t, i % perLoop);
      const rgba = await cap.capture();
      const frame = new VideoFrame(rgba, {
        format: 'RGBA', codedWidth: w, codedHeight: h,
        timestamp: Math.round((i * 1e6) / opts.fps), duration: Math.round(1e6 / opts.fps),
      } as any);
      encoder.encode(frame, { keyFrame: i % (opts.fps * 2) === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
      if (i % 4 === 0) onProgress({ frame: i + 1, total, phase: 'render' });
    }
    onProgress({ frame: total, total, phase: 'finalize' });
    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
    encoder.close();
    return new Blob([target.buffer], { type: 'video/mp4' });
  } finally {
    cap.dispose();
    app.exporting = false;
  }
}

/** Renders the current frame at a given resolution (2x supersampled) as PNG. */
export async function snapshotPNG(app: App, width: number, height: number): Promise<Blob> {
  app.exporting = true;
  const cap = new OffscreenCapture(app, width, height, 2);
  try {
    if (app.mode === 'play') setFrame(app, app.time, 0);
    const rgba = await cap.capture();
    const c = new OffscreenCanvas(width, height);
    const ctx = c.getContext('2d')!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba) as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
    return await c.convertToBlob({ type: 'image/png' });
  } finally {
    cap.dispose();
    app.exporting = false;
  }
}
