/// <reference types="@webgpu/types" />
import type { PageSize } from '../../../types'
import { MAX_OUTPUT_PIXELS, type UpscaleResult } from '../backend'
import { canvasMatrix, type Dihedral, type EnsembleSize, ensembleTransforms, transformedSize } from './transforms'
import { CONTEXT, f16ArrayToF32, type SrvggWeights } from './weights'
import {
  BODY_BLOCK_H,
  BODY_BLOCK_W,
  convBodyWgsl,
  convFirstWgsl,
  finalizeWgsl,
  type KernelOptions,
  SHUFFLE_PARAMS_BYTES,
  shuffleWgsl,
} from './wgsl'

export type EsrganFactor = 2 | 4

export interface EsrganInfo {
  adapter: string
  precision: 'f16' | 'f32'
}

/** Largest activation buffer (one of the two ping-pong buffers) we are willing to allocate. */
const MAX_ACT_BYTES = 48 * 1024 * 1024
/**
 * Core rows of a band: pages are processed in horizontal bands of at most this many source rows.
 * Kept small so no single command buffer runs for long (iOS kills GPU work that exceeds its
 * watchdog); the context overhead is (rows + 2·CONTEXT) / rows ≈ 1.3.
 */
const MAX_BAND_ROWS = 160
const MIN_BAND_ROWS = 8

export class EsrganAborted extends Error {
  constructor() {
    super('aborted')
    this.name = 'EsrganAborted'
  }
}

/** Factor of the result for a page: x4 (native) when it stays within the canvas cap, else x2, else none. */
export function esrganFactor(size: PageSize): EsrganFactor | null {
  if (size.w * size.h * 16 <= MAX_OUTPUT_PIXELS) return 4
  if (size.w * size.h * 4 <= MAX_OUTPUT_PIXELS) return 2
  return null
}

export interface BandPlan {
  /** Padded band width (page width plus context on both sides). */
  bw: number
  /** Core source rows per band (the last band may be shorter). */
  coreRows: number
  bands: number
}

/** How a page is cut into bands under the activation-memory limit; null when even one band is too wide. */
export function planBands(size: PageSize, bytesPerPixel: number, maxActBytes = MAX_ACT_BYTES): BandPlan | null {
  const bw = size.w + 2 * CONTEXT
  const maxPaddedRows = Math.floor(maxActBytes / (bytesPerPixel * bw))
  const coreRows = Math.min(MAX_BAND_ROWS, maxPaddedRows - 2 * CONTEXT, size.h)
  if (coreRows < Math.min(MIN_BAND_ROWS, size.h)) return null
  return { bw, coreRows, bands: Math.ceil(size.h / coreRows) }
}

/** Source pixels the network processes for one pass over a page (context included): the cost unit. */
export function workPixels(size: PageSize, bytesPerPixel: number): number {
  const plan = planBands(size, bytesPerPixel)
  if (!plan) return size.w * size.h
  let px = 0
  for (let k = 0; k < plan.bands; k++) {
    const rows = Math.min(plan.coreRows, size.h - k * plan.coreRows)
    px += plan.bw * (rows + 2 * CONTEXT)
  }
  return px
}

interface LayerGpu {
  pipeline: GPUComputePipeline
  /** Bind group reading the normal band texture, and the one reading the transposed texture (layer 0 only differs). */
  bindGroup: GPUBindGroup
  bindGroupT: GPUBindGroup
}

interface BandBuffers {
  bw: number
  paddedRows: number
  a: GPUBuffer
  b: GPUBuffer
  /** Band input as drawn (bw × paddedRows) and transposed (paddedRows × bw), for the swapped passes. */
  input: GPUTexture
  inputT: GPUTexture
  inputView: GPUTextureView
  inputViewT: GPUTextureView
  layers: LayerGpu[]
  /** Activation buffer written by conv_last (read by the shuffle kernel). */
  lastAct: GPUBuffer
}

/**
 * Replicate-padded copy of the page (CONTEXT pixels on every side), drawn from the bitmap in nine
 * pieces: centre, four edges stretched from a one-pixel strip, four corners from a corner pixel.
 */
export function padPage(source: ImageBitmap): OffscreenCanvas {
  const W = source.width
  const H = source.height
  const c = CONTEXT
  const canvas = new OffscreenCanvas(W + 2 * c, H + 2 * c)
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(source, c, c)
  ctx.drawImage(source, 0, 0, W, 1, c, 0, W, c)
  ctx.drawImage(source, 0, H - 1, W, 1, c, c + H, W, c)
  ctx.drawImage(source, 0, 0, 1, H, 0, c, c, H)
  ctx.drawImage(source, W - 1, 0, 1, H, c + W, c, c, H)
  ctx.drawImage(source, 0, 0, 1, 1, 0, 0, c, c)
  ctx.drawImage(source, W - 1, 0, 1, 1, c + W, 0, c, c)
  ctx.drawImage(source, 0, H - 1, 1, 1, 0, c + H, c, c)
  ctx.drawImage(source, W - 1, H - 1, 1, 1, c + W, c + H, c, c)
  return canvas
}

export interface RunOptions {
  signal?: AbortSignal
  /** Progress in (band, pass) steps. */
  onProgress?: (done: number, total: number) => void
  /** Geometric self-ensemble: passes over transformed copies of each band, averaged (default 1). */
  ensemble?: EnsembleSize
}

/**
 * Real-ESRGAN "anime video v3" (SRVGGNetCompact: 3→64, 16 × (64→64 + PReLU), 64→48, pixel shuffle
 * x4) on WebGPU compute shaders. The page is processed in horizontal bands so the two activation
 * buffers stay small; results are stitched on the GPU and read back once. With an ensemble, every
 * band is run once per symmetry of the rectangle (flips, transpositions) and the outputs are
 * averaged on the GPU before being written to the page.
 */
export class EsrganUpscaler {
  readonly device: GPUDevice
  readonly info: EsrganInfo
  readonly bytesPerPixel: number
  private readonly options: KernelOptions
  private readonly weights: SrvggWeights
  private readonly pipelines: {
    first: GPUComputePipeline
    body: GPUComputePipeline
    last: GPUComputePipeline
    shuffle: GPUComputePipeline
    shuffleAccumulate: GPUComputePipeline
    finalize: GPUComputePipeline
  }
  private readonly layerBuffers: Array<{ weight: GPUBuffer; bias: GPUBuffer; prelu: GPUBuffer | null }>
  private readonly bandParams: GPUBuffer
  private readonly shuffleParams: GPUBuffer
  private buffers: BandBuffers | null = null
  private acc: { bytes: number; buffer: GPUBuffer } | null = null
  private scratch: { w: number; h: number; canvas: OffscreenCanvas }[] = []
  private lost = false
  onLost: (() => void) | null = null
  /** Activation-buffer cap used to cut bands (tests lower it to exercise multi-band seams on tiny images). */
  maxActBytes = MAX_ACT_BYTES

  private constructor(
    device: GPUDevice,
    info: EsrganInfo,
    weights: SrvggWeights,
    options: KernelOptions,
    pipelines: EsrganUpscaler['pipelines'],
  ) {
    this.device = device
    this.info = info
    this.weights = weights
    this.options = options
    this.pipelines = pipelines
    this.bytesPerPixel = 16 * (options.f16 ? 8 : 16)
    this.layerBuffers = weights.layers.map((layer) => ({
      weight: this.upload(layer.weight, `esrgan-${layer.name}-w`),
      bias: this.upload(layer.bias, `esrgan-${layer.name}-b`),
      prelu: layer.prelu ? this.upload(layer.prelu, `esrgan-${layer.name}-p`) : null,
    }))
    this.bandParams = device.createBuffer({ label: 'esrgan-band', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.shuffleParams = device.createBuffer({
      label: 'esrgan-shuffle',
      size: SHUFFLE_PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    void device.lost.then(() => {
      this.lost = true
      this.onLost?.()
    })
  }

  private upload(f16: Uint16Array, label: string): GPUBuffer {
    const data = this.options.f16 ? f16 : f16ArrayToF32(f16)
    const buffer = this.device.createBuffer({ label, size: Math.ceil(data.byteLength / 4) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength)
    return buffer
  }

  /** Resolves null without WebGPU; throws when the device or the shaders cannot be created. */
  static async create(weights: SrvggWeights): Promise<EsrganUpscaler | null> {
    if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) return null
    const adapter = (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })) ?? (await navigator.gpu.requestAdapter())
    if (!adapter) return null
    const f16 = adapter.features.has('shader-f16')
    const device = await adapter.requestDevice({
      requiredFeatures: f16 ? ['shader-f16'] : [],
      requiredLimits: {
        maxStorageBufferBindingSize: Math.min(256 * 1024 * 1024, adapter.limits.maxStorageBufferBindingSize),
        maxBufferSize: Math.min(512 * 1024 * 1024, adapter.limits.maxBufferSize),
      },
    })
    const adapterInfo = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info
    const name = adapterInfo ? [adapterInfo.vendor, adapterInfo.architecture, adapterInfo.description].filter(Boolean).join(' ') : ''
    const compile = async (options: KernelOptions) => {
      const pipeline = (label: string, code: string) =>
        device.createComputePipelineAsync({
          label,
          layout: 'auto',
          compute: { module: device.createShaderModule({ label, code }), entryPoint: 'main' },
        })
      const [first, body, last, shuffle, shuffleAccumulate, finalize] = await Promise.all([
        pipeline('esrgan-conv-first', convFirstWgsl(options)),
        pipeline('esrgan-conv-body', convBodyWgsl(options, 64, true)),
        pipeline('esrgan-conv-last', convBodyWgsl(options, 48, false)),
        pipeline('esrgan-shuffle', shuffleWgsl(options, false)),
        pipeline('esrgan-shuffle-accumulate', shuffleWgsl(options, true)),
        pipeline('esrgan-finalize', finalizeWgsl()),
      ])
      return { first, body, last, shuffle, shuffleAccumulate, finalize }
    }
    try {
      let options: KernelOptions = { f16 }
      let pipelines: EsrganUpscaler['pipelines']
      try {
        pipelines = await compile(options)
      } catch (e) {
        // A driver may advertise shader-f16 and still reject the half-precision kernels: the f32
        // kernels are the same network, only slower.
        if (!f16) throw e
        console.warn('Real-ESRGAN: kernel f16 rifiutati, uso f32.', e)
        options = { f16: false }
        pipelines = await compile(options)
      }
      return new EsrganUpscaler(device, { adapter: name || 'WebGPU', precision: options.f16 ? 'f16' : 'f32' }, weights, options, pipelines)
    } catch (e) {
      device.destroy()
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  get isLost(): boolean {
    return this.lost
  }

  /** Factor of the result, or null when the page cannot be processed on this device. */
  canUpscale(size: PageSize): EsrganFactor | null {
    const factor = esrganFactor(size)
    if (!factor) return null
    if (!planBands(size, this.bytesPerPixel, this.maxActBytes)) return null
    const outBytes = size.w * size.h * factor * factor * 4
    const limits = this.device.limits
    if (outBytes > limits.maxStorageBufferBindingSize || outBytes > limits.maxBufferSize) return null
    if (size.w + 2 * CONTEXT > limits.maxTextureDimension2D) return null
    return factor
  }

  private bandBuffers(bw: number, paddedRows: number): BandBuffers {
    const cur = this.buffers
    if (cur && cur.bw === bw && cur.paddedRows === paddedRows) return cur
    if (cur) {
      cur.a.destroy()
      cur.b.destroy()
      cur.input.destroy()
      cur.inputT.destroy()
    }
    const device = this.device
    const bytes = bw * paddedRows * this.bytesPerPixel
    const a = device.createBuffer({ label: 'esrgan-act-a', size: bytes, usage: GPUBufferUsage.STORAGE })
    const b = device.createBuffer({ label: 'esrgan-act-b', size: bytes, usage: GPUBufferUsage.STORAGE })
    const texture = (label: string, w: number, h: number) =>
      device.createTexture({
        label,
        size: [w, h, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      })
    const input = texture('esrgan-band-input', bw, paddedRows)
    const inputT = texture('esrgan-band-input-t', paddedRows, bw)
    const inputView = input.createView()
    const inputViewT = inputT.createView()
    const layers: LayerGpu[] = this.weights.layers.map((layer, i) => {
      const bufs = this.layerBuffers[i]!
      const isFirst = i === 0
      const isLast = i === this.weights.layers.length - 1
      const pipeline = isFirst ? this.pipelines.first : isLast ? this.pipelines.last : this.pipelines.body
      // Layer i reads a when i is odd, b when even (layer 0 reads the texture and writes a).
      const src = i % 2 === 1 ? a : b
      const dst = i % 2 === 1 ? b : a
      const entries = (view: GPUTextureView): GPUBindGroupEntry[] => {
        const list: GPUBindGroupEntry[] = [
          isFirst ? { binding: 0, resource: view } : { binding: 0, resource: { buffer: src } },
          { binding: 1, resource: { buffer: bufs.weight } },
          { binding: 2, resource: { buffer: bufs.bias } },
          { binding: 4, resource: { buffer: dst } },
          { binding: 5, resource: { buffer: this.bandParams } },
        ]
        if (bufs.prelu) list.push({ binding: 3, resource: { buffer: bufs.prelu } })
        return list
      }
      const layout = pipeline.getBindGroupLayout(0)
      const bindGroup = device.createBindGroup({ label: `esrgan-${layer.name}`, layout, entries: entries(inputView) })
      const bindGroupT = isFirst ? device.createBindGroup({ label: `esrgan-${layer.name}-t`, layout, entries: entries(inputViewT) }) : bindGroup
      return { pipeline, bindGroup, bindGroupT }
    })
    // conv_last is layer 17 (odd): it writes b, which the shuffle reads.
    const lastAct = (this.weights.layers.length - 1) % 2 === 1 ? b : a
    this.buffers = { bw, paddedRows, a, b, input, inputT, inputView, inputViewT, layers, lastAct }
    return this.buffers
  }

  /** Float accumulator for one band of output (ensemble), grown on demand. */
  private accumulator(bytes: number): GPUBuffer {
    if (this.acc && this.acc.bytes >= bytes) return this.acc.buffer
    this.acc?.buffer.destroy()
    this.acc = { bytes, buffer: this.device.createBuffer({ label: 'esrgan-ensemble-acc', size: bytes, usage: GPUBufferUsage.STORAGE }) }
    return this.acc.buffer
  }

  /**
   * The band's padded region of the page, transformed by `t`, as an ImageBitmap of the transformed
   * size. Drawn through the canvas matrix: a pure permutation of pixels, no resampling.
   */
  private transformedBand(padded: ImageBitmap, y0: number, bw: number, bh: number, t: Dihedral): ImageBitmap {
    const { w, h } = transformedSize(bw, bh, t)
    let scratch = this.scratch.find((s) => s.w === w && s.h === h)
    if (!scratch) {
      scratch = { w, h, canvas: new OffscreenCanvas(w, h) }
      this.scratch.push(scratch)
      while (this.scratch.length > 4) this.scratch.shift()
    }
    const ctx = scratch.canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    ctx.setTransform(...canvasMatrix(bw, bh, t))
    ctx.drawImage(padded, 0, y0, bw, bh, 0, 0, bw, bh)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    return scratch.canvas.transferToImageBitmap()
  }

  /**
   * Runs the network over `source` and returns RGBA8 pixels at `factor` times the source
   * (the caller checked `canUpscale`). Cancellable between passes through `opts.signal`.
   */
  async upscale(source: ImageBitmap, factor: EsrganFactor, opts: RunOptions = {}): Promise<UpscaleResult> {
    if (this.lost) throw new Error('WebGPU device lost')
    const W = source.width
    const H = source.height
    const plan = planBands({ w: W, h: H }, this.bytesPerPixel, this.maxActBytes)
    if (!plan) throw new Error(`Pagina ${W}×${H} troppo larga per il modello`)
    const transforms = ensembleTransforms(opts.ensemble ?? 1)
    const passes = transforms.length
    const outW = W * factor
    const outH = H * factor
    const outBytes = outW * outH * 4
    const device = this.device
    // An ImageBitmap is the copy source every WebGPU implementation accepts (canvases are not).
    const padded = padPage(source).transferToImageBitmap()
    const paddedRows = Math.min(plan.coreRows, H) + 2 * CONTEXT
    const buffers = this.bandBuffers(plan.bw, paddedRows)
    const page = device.createBuffer({ label: 'esrgan-page', size: outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
    const readback = device.createBuffer({ label: 'esrgan-readback', size: outBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    const accW = outW
    const accBuffer = passes > 1 ? this.accumulator(accW * Math.min(plan.coreRows, H) * factor * 16) : null
    const shuffleLayout = (passes > 1 ? this.pipelines.shuffleAccumulate : this.pipelines.shuffle).getBindGroupLayout(0)
    const shuffleGroups = [buffers.inputView, buffers.inputViewT].map((view) =>
      device.createBindGroup({
        label: 'esrgan-shuffle',
        layout: shuffleLayout,
        entries: [
          { binding: 0, resource: { buffer: buffers.lastAct } },
          { binding: 1, resource: view },
          { binding: 2, resource: { buffer: accBuffer ?? page } },
          { binding: 3, resource: { buffer: this.shuffleParams } },
        ],
      }),
    )
    const finalizeGroup = accBuffer
      ? device.createBindGroup({
          label: 'esrgan-finalize',
          layout: this.pipelines.finalize.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: accBuffer } },
            { binding: 1, resource: { buffer: page } },
            { binding: 2, resource: { buffer: this.shuffleParams } },
          ],
        })
      : null
    const total = plan.bands * passes
    let done = 0
    try {
      for (let k = 0; k < plan.bands; k++) {
        const y0 = k * plan.coreRows
        const rows = Math.min(plan.coreRows, H - y0)
        const bh = rows + 2 * CONTEXT
        for (let pass = 0; pass < passes; pass++) {
          if (opts.signal?.aborted) throw new EsrganAborted()
          const t = transforms[pass]!
          const { w: tw, h: th } = transformedSize(plan.bw, bh, t)
          const band = t.swap || t.flipX || t.flipY ? this.transformedBand(padded, y0, plan.bw, bh, t) : null
          const texture = t.swap ? buffers.inputT : buffers.input
          if (band) {
            device.queue.copyExternalImageToTexture({ source: band }, { texture }, [tw, th])
            band.close()
          } else {
            device.queue.copyExternalImageToTexture({ source: padded, origin: { x: 0, y: y0 } }, { texture }, [tw, th])
          }
          device.queue.writeBuffer(this.bandParams, 0, new Uint32Array([tw, th, 0, 0]))
          device.queue.writeBuffer(
            this.shuffleParams,
            0,
            new Uint32Array([
              tw,
              th,
              CONTEXT,
              W,
              y0,
              rows,
              outW,
              outH,
              factor,
              t.swap ? 1 : 0,
              t.flipX ? 1 : 0,
              t.flipY ? 1 : 0,
              pass === 0 ? 1 : 0,
              accW,
              passes,
              0,
            ]),
          )
          const lastPass = pass === passes - 1
          // Two command buffers per pass (first half of the layers, second half + shuffle): each
          // stays well under the GPU watchdog even on a slow device.
          const half = Math.ceil(buffers.layers.length / 2)
          const commands: GPUCommandBuffer[] = []
          for (const [from, to] of [
            [0, half],
            [half, buffers.layers.length],
          ] as const) {
            const encoder = device.createCommandEncoder({ label: `esrgan-band-${k}-${pass}-${from}` })
            const computePass = encoder.beginComputePass()
            for (let i = from; i < to; i++) {
              const layer = buffers.layers[i]!
              computePass.setPipeline(layer.pipeline)
              computePass.setBindGroup(0, t.swap ? layer.bindGroupT : layer.bindGroup)
              if (i === 0) computePass.dispatchWorkgroups(Math.ceil(tw / 8), Math.ceil(th / 8))
              else computePass.dispatchWorkgroups(Math.ceil(tw / BODY_BLOCK_W), Math.ceil(th / BODY_BLOCK_H))
            }
            if (to === buffers.layers.length) {
              computePass.setPipeline(passes > 1 ? this.pipelines.shuffleAccumulate : this.pipelines.shuffle)
              computePass.setBindGroup(0, shuffleGroups[t.swap ? 1 : 0]!)
              computePass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(rows / 8))
              if (finalizeGroup && lastPass) {
                computePass.setPipeline(this.pipelines.finalize)
                computePass.setBindGroup(0, finalizeGroup)
                computePass.dispatchWorkgroups(Math.ceil(accW / 8), Math.ceil((rows * factor) / 8))
              }
            }
            computePass.end()
            if (to === buffers.layers.length && lastPass && k === plan.bands - 1) encoder.copyBufferToBuffer(page, 0, readback, 0, outBytes)
            commands.push(encoder.finish())
          }
          device.queue.submit(commands)
          // One sync per pass: a cancellation point, and no pile-up of GPU work for a page nobody looks at.
          await device.queue.onSubmittedWorkDone()
          done++
          opts.onProgress?.(done, total)
        }
      }
      if (opts.signal?.aborted) throw new EsrganAborted()
      await readback.mapAsync(GPUMapMode.READ)
      const data = new Uint8ClampedArray(readback.getMappedRange().slice(0))
      readback.unmap()
      return { data, width: outW, height: outH }
    } finally {
      padded.close()
      readback.destroy()
      page.destroy()
    }
  }

  dispose(): void {
    const b = this.buffers
    if (b) {
      b.a.destroy()
      b.b.destroy()
      b.input.destroy()
      b.inputT.destroy()
      this.buffers = null
    }
    this.acc?.buffer.destroy()
    this.acc = null
    for (const l of this.layerBuffers) {
      l.weight.destroy()
      l.bias.destroy()
      l.prelu?.destroy()
    }
    this.bandParams.destroy()
    this.shuffleParams.destroy()
    this.device.destroy()
  }
}
