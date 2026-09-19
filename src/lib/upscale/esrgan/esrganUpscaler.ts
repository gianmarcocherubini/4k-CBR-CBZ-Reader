/// <reference types="@webgpu/types" />
import type { PageSize } from '../../../types'
import { MAX_OUTPUT_PIXELS, type UpscaleResult } from '../backend'
import { CONTEXT, f16ArrayToF32, type SrvggWeights } from './weights'
import { BODY_BLOCK_H, BODY_BLOCK_W, convBodyWgsl, convFirstWgsl, type KernelOptions, shuffleWgsl } from './wgsl'

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

/** Source pixels the network actually processes for a page (context included): the cost unit. */
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
  bindGroup: GPUBindGroup
  pipeline: GPUComputePipeline
}

interface BandBuffers {
  bw: number
  paddedRows: number
  a: GPUBuffer
  b: GPUBuffer
  input: GPUTexture
  inputView: GPUTextureView
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
  onProgress?: (done: number, total: number) => void
}

/**
 * Real-ESRGAN "anime video v3" (SRVGGNetCompact: 3→64, 16 × (64→64 + PReLU), 64→48, pixel shuffle
 * x4) on WebGPU compute shaders. The page is processed in horizontal bands so the two activation
 * buffers stay small; results are stitched on the GPU and read back once.
 */
export class EsrganUpscaler {
  readonly device: GPUDevice
  readonly info: EsrganInfo
  readonly bytesPerPixel: number
  private readonly options: KernelOptions
  private readonly weights: SrvggWeights
  private readonly pipelines: { first: GPUComputePipeline; body: GPUComputePipeline; last: GPUComputePipeline; shuffle: GPUComputePipeline }
  private readonly layerBuffers: Array<{ weight: GPUBuffer; bias: GPUBuffer; prelu: GPUBuffer | null }>
  private readonly bandParams: GPUBuffer
  private readonly shuffleParams: GPUBuffer
  private buffers: BandBuffers | null = null
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
    this.shuffleParams = device.createBuffer({ label: 'esrgan-shuffle', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
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
      const [first, body, last, shuffle] = await Promise.all([
        pipeline('esrgan-conv-first', convFirstWgsl(options)),
        pipeline('esrgan-conv-body', convBodyWgsl(options, 64, true)),
        pipeline('esrgan-conv-last', convBodyWgsl(options, 48, false)),
        pipeline('esrgan-shuffle', shuffleWgsl(options)),
      ])
      return { first, body, last, shuffle }
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
    }
    const device = this.device
    const bytes = bw * paddedRows * this.bytesPerPixel
    const a = device.createBuffer({ label: 'esrgan-act-a', size: bytes, usage: GPUBufferUsage.STORAGE })
    const b = device.createBuffer({ label: 'esrgan-act-b', size: bytes, usage: GPUBufferUsage.STORAGE })
    const input = device.createTexture({
      label: 'esrgan-band-input',
      size: [bw, paddedRows, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    const view = input.createView()
    const layers: LayerGpu[] = this.weights.layers.map((layer, i) => {
      const bufs = this.layerBuffers[i]!
      const isFirst = i === 0
      const isLast = i === this.weights.layers.length - 1
      const pipeline = isFirst ? this.pipelines.first : isLast ? this.pipelines.last : this.pipelines.body
      // Layer i reads a when i is odd, b when even (layer 0 reads the texture and writes a).
      const src = i % 2 === 1 ? a : b
      const dst = i % 2 === 1 ? b : a
      const entries: GPUBindGroupEntry[] = [
        isFirst ? { binding: 0, resource: view } : { binding: 0, resource: { buffer: src } },
        { binding: 1, resource: { buffer: bufs.weight } },
        { binding: 2, resource: { buffer: bufs.bias } },
        { binding: 4, resource: { buffer: dst } },
        { binding: 5, resource: { buffer: this.bandParams } },
      ]
      if (bufs.prelu) entries.push({ binding: 3, resource: { buffer: bufs.prelu } })
      return { pipeline, bindGroup: device.createBindGroup({ label: `esrgan-${layer.name}`, layout: pipeline.getBindGroupLayout(0), entries }) }
    })
    // conv_last is layer 17 (odd): it writes b, which the shuffle reads.
    const lastAct = (this.weights.layers.length - 1) % 2 === 1 ? b : a
    this.buffers = { bw, paddedRows, a, b, input, inputView: view, layers, lastAct }
    return this.buffers
  }

  /**
   * Runs the network over `source` and returns RGBA8 pixels at `factor` times the source
   * (the caller checked `canUpscale`). Cancellable between bands through `opts.signal`.
   */
  async upscale(source: ImageBitmap, factor: EsrganFactor, opts: RunOptions = {}): Promise<UpscaleResult> {
    if (this.lost) throw new Error('WebGPU device lost')
    const W = source.width
    const H = source.height
    const plan = planBands({ w: W, h: H }, this.bytesPerPixel, this.maxActBytes)
    if (!plan) throw new Error(`Pagina ${W}×${H} troppo larga per il modello`)
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
    const shuffleBindGroup = device.createBindGroup({
      label: 'esrgan-shuffle',
      layout: this.pipelines.shuffle.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: buffers.lastAct } },
        { binding: 1, resource: buffers.inputView },
        { binding: 2, resource: { buffer: page } },
        { binding: 3, resource: { buffer: this.shuffleParams } },
      ],
    })
    try {
      for (let k = 0; k < plan.bands; k++) {
        if (opts.signal?.aborted) throw new EsrganAborted()
        const y0 = k * plan.coreRows
        const rows = Math.min(plan.coreRows, H - y0)
        const bh = rows + 2 * CONTEXT
        device.queue.copyExternalImageToTexture({ source: padded, origin: { x: 0, y: y0 } }, { texture: buffers.input }, [plan.bw, bh])
        device.queue.writeBuffer(this.bandParams, 0, new Uint32Array([plan.bw, bh, 0, 0]))
        device.queue.writeBuffer(this.shuffleParams, 0, new Uint32Array([plan.bw, bh, CONTEXT, W, y0, rows, outW, outH, factor, 0, 0, 0]))
        // Two command buffers per band (first half of the layers, second half + shuffle): each
        // stays well under the GPU watchdog even on a slow device.
        const half = Math.ceil(buffers.layers.length / 2)
        const encoders: GPUCommandBuffer[] = []
        for (const [from, to] of [
          [0, half],
          [half, buffers.layers.length],
        ] as const) {
          const encoder = device.createCommandEncoder({ label: `esrgan-band-${k}-${from}` })
          const pass = encoder.beginComputePass()
          for (let i = from; i < to; i++) {
            const layer = buffers.layers[i]!
            pass.setPipeline(layer.pipeline)
            pass.setBindGroup(0, layer.bindGroup)
            if (i === 0) pass.dispatchWorkgroups(Math.ceil(plan.bw / 8), Math.ceil(bh / 8))
            else pass.dispatchWorkgroups(Math.ceil(plan.bw / BODY_BLOCK_W), Math.ceil(bh / BODY_BLOCK_H))
          }
          if (to === buffers.layers.length) {
            pass.setPipeline(this.pipelines.shuffle)
            pass.setBindGroup(0, shuffleBindGroup)
            pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(rows / 8))
          }
          pass.end()
          if (to === buffers.layers.length && k === plan.bands - 1) encoder.copyBufferToBuffer(page, 0, readback, 0, outBytes)
          encoders.push(encoder.finish())
        }
        device.queue.submit(encoders)
        // One sync per band: a cancellation point, and no pile-up of GPU work for a page nobody looks at.
        await device.queue.onSubmittedWorkDone()
        opts.onProgress?.(k + 1, plan.bands)
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
      this.buffers = null
    }
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
