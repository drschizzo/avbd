// Batches many `renderer.compute()` calls into a single command buffer.
//
// three.js creates and submits one command encoder per compute call; the AVBD
// engine issues ~200–350 dispatches per frame, so the CPU cost of encoding and
// submitting dominates the bake. While a batch is open:
//   - every compute call records into one shared encoder / compute pass;
//   - queue.writeBuffer (uniform + attribute uploads, which three performs
//     between dispatches) is redirected through a staging ring and replayed as
//     an in-order copyBufferToBuffer, preserving per-dispatch semantics;
//   - any foreign queue.submit first flushes the batch, keeping global order.

export class ComputeBatcher {
  private batching = false;
  private encoder: GPUCommandEncoder | null = null;
  private pass: GPUComputePassEncoder | null = null;
  private staging: GPUBuffer;
  private ringSize = 32 * 1024 * 1024;
  private ringOffset = 0;
  private readonly origWrite: GPUQueue['writeBuffer'];
  private readonly origSubmit: GPUQueue['submit'];
  dispatches = 0;

  // GPU profiling (dev): every dispatch gets its own pass with timestamps,
  // aggregated per kernel name in `profileTotals` (ns).
  profile = false;
  profileTotals = new Map<string, { ns: number; n: number }>();
  private querySet: GPUQuerySet | null = null;
  private queryNames: string[] = [];
  private readonly maxQueries = 4096;

  constructor(private device: GPUDevice, private backend: any) {
    this.staging = device.createBuffer({ size: this.ringSize, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, label: 'batch-staging' });
    const queue = device.queue;
    this.origWrite = queue.writeBuffer.bind(queue);
    this.origSubmit = queue.submit.bind(queue);

    (queue as any).writeBuffer = (buffer: GPUBuffer, offset: number, data: BufferSource | SharedArrayBuffer, dataOffset?: number, size?: number) => {
      if (!this.batching) return this.origWrite(buffer, offset, data as any, dataOffset, size);
      this.stagedWrite(buffer, offset, data, dataOffset, size);
    };
    (queue as any).submit = (buffers: Iterable<GPUCommandBuffer>) => {
      if (this.batching) this.flush(true);
      return this.origSubmit(buffers);
    };

    const origBegin = backend.beginCompute.bind(backend);
    const origCompute = backend.compute.bind(backend);
    const origFinish = backend.finishCompute.bind(backend);
    backend.beginCompute = (group: any) => {
      if (!this.batching) return origBegin(group);
      const data = backend.get(group);
      data.cmdEncoderGPU = this.ensureEncoder();
      data.passEncoderGPU = this.ensurePass();
    };
    backend.compute = (group: any, node: any, bindings: any, pipeline: any, dispatchSize: any) => {
      if (this.batching) {
        const data = backend.get(group);
        data.cmdEncoderGPU = this.ensureEncoder();
        data.passEncoderGPU = this.ensurePass();
        this.dispatches++;
        if (this.profile && this.queryNames.length * 2 < this.maxQueries) {
          if (this.pass) { this.pass.end(); this.pass = null; }
          const q = this.queryNames.length * 2;
          this.queryNames.push(node?.name || node?.computeNode?.name || `#${node?.id}`);
          this.pass = this.ensureEncoder().beginComputePass({ timestampWrites: { querySet: this.ensureQuerySet(), beginningOfPassWriteIndex: q, endOfPassWriteIndex: q + 1 } });
          data.passEncoderGPU = this.pass;
          const r = origCompute(group, node, bindings, pipeline, dispatchSize);
          this.pass.end(); this.pass = null;
          return r;
        }
      }
      return origCompute(group, node, bindings, pipeline, dispatchSize);
    };
    backend.finishCompute = (group: any) => {
      if (!this.batching) return origFinish(group);
    };
  }

  begin(): void {
    this.batching = true;
  }

  end(): void {
    this.flush(false);
    this.batching = false;
  }

  /** Submits everything recorded so far. */
  flush(keepBatching = true): void {
    if (this.pass) { this.pass.end(); this.pass = null; }
    if (this.encoder) {
      if (this.queryNames.length) this.resolveProfile();
      const cb = this.encoder.finish();
      this.encoder = null;
      this.origSubmit([cb]);
    }
    this.ringOffset = 0;
    this.batching = keepBatching && this.batching;
  }

  private ensureQuerySet(): GPUQuerySet {
    if (!this.querySet) this.querySet = this.device.createQuerySet({ type: 'timestamp', count: this.maxQueries });
    return this.querySet;
  }

  private resolveProfile(): void {
    const names = this.queryNames;
    this.queryNames = [];
    const bytes = names.length * 16;
    const resolve = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    const read = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.encoder!.resolveQuerySet(this.querySet!, 0, names.length * 2, resolve, 0);
    this.encoder!.copyBufferToBuffer(resolve, 0, read, 0, bytes);
    queueMicrotask(() => {
      void read.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigInt64Array(read.getMappedRange());
        names.forEach((name, i) => {
          const ns = Number(t[i * 2 + 1] - t[i * 2]);
          const e = this.profileTotals.get(name) ?? { ns: 0, n: 0 };
          e.ns += ns; e.n++;
          this.profileTotals.set(name, e);
        });
        read.unmap(); read.destroy(); resolve.destroy();
      });
    });
  }

  private ensureEncoder(): GPUCommandEncoder {
    if (!this.encoder) this.encoder = this.device.createCommandEncoder({ label: 'batched-compute' });
    return this.encoder;
  }

  private ensurePass(): GPUComputePassEncoder {
    if (!this.pass) this.pass = this.ensureEncoder().beginComputePass({ label: 'batched-compute-pass' });
    return this.pass;
  }

  private stagedWrite(buffer: GPUBuffer, offset: number, data: any, dataOffset?: number, size?: number): void {
    // Resolve the byte range of the source like GPUQueue.writeBuffer does.
    let bytes: Uint8Array;
    if (ArrayBuffer.isView(data)) {
      const bpe = (data as any).BYTES_PER_ELEMENT ?? 1;
      const start = data.byteOffset + (dataOffset ?? 0) * bpe;
      const len = size !== undefined ? size * bpe : data.byteLength - (dataOffset ?? 0) * bpe;
      bytes = new Uint8Array(data.buffer, start, len);
    } else {
      const start = dataOffset ?? 0;
      const len = size !== undefined ? size : (data as ArrayBuffer).byteLength - start;
      bytes = new Uint8Array(data as ArrayBuffer, start, len);
    }
    const len = bytes.byteLength;
    if (len === 0) return;
    if (len % 4 !== 0 || offset % 4 !== 0 || len > this.ringSize) {
      // Unaligned or huge: flush and write directly (rare).
      this.flush(true);
      this.origWrite(buffer, offset, bytes as any);
      return;
    }
    if (this.ringOffset + len > this.ringSize) this.flush(true);
    const at = this.ringOffset;
    this.ringOffset = (at + len + 255) & ~255;
    this.origWrite(this.staging, at, bytes as any);
    if (this.pass) { this.pass.end(); this.pass = null; }
    this.ensureEncoder().copyBufferToBuffer(this.staging, at, buffer, offset, len);
  }
}
