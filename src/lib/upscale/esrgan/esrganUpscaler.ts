/// <reference types="@webgpu/types" />
import type { PageSize } from '../../../types'
import { MAX_OUTPUT_PIXELS, type UpscaleResult } from '../backend'
import { canvasMatrix, type Dihedral, type EnsembleSize, ensembleTransforms, IDENTITY, transformedSize } from './transforms'
import { CONTEXT, f16ArrayToF32, type Layer, type ModelWeights } from './weights'
import {
  BAND_PARAMS_BYTES,
  BODY_BLOCK_H,
  BODY_BLOCK_W,
  convFirstWgsl,
  convWgsl,
  finalizeWgsl,
  type KernelOptions,
  LAYER_PARAMS_BYTES,
  layerParams,
  RGB_OUT_PARAMS_BYTES,
  rgbOutWgsl,
  SHUFFLE_PARAMS_BYTES,
  shuffleWgsl,
} from './wgsl'

export type EsrganFactor = 2 | 4

export interface EsrganInfo {
  adapter: string
  precision: 'f16' | 'f32'
}

/**
 * Core rows of a band: pages are processed in horizontal bands of at most this many source rows.
 * Kept small so no single command buffer runs for long (iOS kills GPU work that exceeds its
 * watchdog); the context overhead is (rows + 2·CONTEXT) / rows ≈ 1.3.
 */
const MAX_BAND_ROWS = 160
const MIN_BAND_ROWS = 8
/** Source rows per strip of the RRDB tail (the x4 stage is too large to hold for a whole band). */
const TAIL_ROWS = 8
const TAIL_CONTEXT = 2

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

/**
 * How a page is cut into bands under the activation-memory limit; null when even one band is too
 * wide. The band width is rounded up to a multiple of 4 so that plane-sized sub-ranges of the
 * activation buffers stay 256-byte aligned (extra columns replicate the right edge).
 */
export function planBands(size: PageSize, bytesPerPixel: number, maxActBytes: number): BandPlan | null {
  const bw = Math.ceil((size.w + 2 * CONTEXT) / 4) * 4
  const maxPaddedRows = Math.floor(maxActBytes / (bytesPerPixel * bw))
  const coreRows = Math.min(MAX_BAND_ROWS, maxPaddedRows - 2 * CONTEXT, size.h)
  if (coreRows < Math.min(MIN_BAND_ROWS, size.h)) return null
  return { bw, coreRows, bands: Math.ceil(size.h / coreRows) }
}

/** Source pixels the network processes for one pass over a page (context included): the cost unit. */
export function workPixels(size: PageSize, bytesPerPixel: number, maxActBytes: number): number {
  const plan = planBands(size, bytesPerPixel, maxActBytes)
  if (!plan) return size.w * size.h
  let px = 0
  for (let k = 0; k < plan.bands; k++) {
    const rows = Math.min(plan.coreRows, size.h - k * plan.coreRows)
    px += plan.bw * (rows + 2 * CONTEXT)
  }
  return px
}

/**
 * Replicate-padded copy of the page (CONTEXT pixels on every side, `bw` columns in total), drawn
 * from the bitmap in nine pieces: centre, four edges stretched from a one-pixel strip, four
 * corners from a corner pixel.
 */
export function padPage(source: ImageBitmap, bw = source.width + 2 * CONTEXT): OffscreenCanvas {
  const W = source.width
  const H = source.height
  const c = CONTEXT
  const right = bw - c - W
  const canvas = new OffscreenCanvas(bw, H + 2 * c)
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(source, c, c)
  ctx.drawImage(source, 0, 0, W, 1, c, 0, W, c)
  ctx.drawImage(source, 0, H - 1, W, 1, c, c + H, W, c)
  ctx.drawImage(source, 0, 0, 1, H, 0, c, c, H)
  ctx.drawImage(source, W - 1, 0, 1, H, c + W, c, right, H)
  ctx.drawImage(source, 0, 0, 1, 1, 0, 0, c, c)
  ctx.drawImage(source, W - 1, 0, 1, 1, c + W, 0, right, c)
  ctx.drawImage(source, 0, H - 1, 1, 1, 0, c + H, c, c)
  ctx.drawImage(source, W - 1, H - 1, 1, 1, c + W, c + H, right, c)
  return canvas
}

export interface RunOptions {
  signal?: AbortSignal
  /** Progress in (band, pass) steps. */
  onProgress?: (done: number, total: number) => void
  /** Geometric self-ensemble: passes over transformed copies of each band, averaged (default 1). */
  ensemble?: EnsembleSize
}

/** What the engine needs from a network runner. */
export interface Upscaler {
  readonly device: GPUDevice
  readonly info: EsrganInfo
  readonly isLost: boolean
  onLost: (() => void) | null
  /** Whether `upscale` honours `ensemble` (the RRDB tail is not transform-aware). */
  readonly supportsEnsemble: boolean
  /** Activation-memory cap used to cut bands (tests lower it to exercise multi-band seams on tiny images). */
  maxActBytes: number
  /** Activation bytes per band pixel that the cap applies to. */
  readonly bytesPerPixel: number
  canUpscale(size: PageSize): EsrganFactor | null
  workPixels(size: PageSize): number
  upscale(source: ImageBitmap, factor: EsrganFactor, opts?: RunOptions): Promise<UpscaleResult>
  dispose(): void
}

/** One band of one pass, as seen by a program. */
interface BandJob {
  /** Padded band size as the network sees it (transformed). */
  tw: number
  th: number
  /** Page row of the band's first core row and its core rows. */
  y0: number
  rows: number
  W: number
  factor: EsrganFactor
  outW: number
  outH: number
  transform: Dihedral
  pass: number
  passes: number
  swap: boolean
  page: GPUBuffer
}

interface DeviceInfo {
  device: GPUDevice
  f16: boolean
  name: string
}

async function requestDevice(): Promise<DeviceInfo | null> {
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
  return { device, f16, name: name || 'WebGPU' }
}

/**
 * Compiles the kernels of a program, preferring f16 and falling back to f32 when a driver that
 * advertises shader-f16 still rejects the half-precision kernels.
 */
async function compileProgram<T>(
  device: GPUDevice,
  f16: boolean,
  build: (options: KernelOptions, pipeline: (label: string, code: string) => Promise<GPUComputePipeline>) => Promise<T>,
): Promise<{ options: KernelOptions; pipelines: T }> {
  const pipeline = (label: string, code: string) =>
    device.createComputePipelineAsync({
      label,
      layout: 'auto',
      compute: { module: device.createShaderModule({ label, code }), entryPoint: 'main' },
    })
  let options: KernelOptions = { f16 }
  try {
    return { options, pipelines: await build(options, pipeline) }
  } catch (e) {
    if (!f16) throw e
    console.warn('Real-ESRGAN: kernel f16 rifiutati, uso f32.', e)
    options = { f16: false }
    return { options, pipelines: await build(options, pipeline) }
  }
}

/** Creates the runner matching the architecture of `weights`; null without WebGPU. */
export async function createUpscaler(weights: ModelWeights): Promise<Upscaler | null> {
  const dev = await requestDevice()
  if (!dev) return null
  try {
    return weights.header.arch === 'rrdb' ? await RrdbUpscaler.create(dev, weights) : await SrvggUpscaler.create(dev, weights)
  } catch (e) {
    dev.device.destroy()
    throw e instanceof Error ? e : new Error(String(e))
  }
}

/**
 * Shared machinery of the two networks: page padding, bands, per-pass band textures (normal and
 * transposed), uniform/weight buffers, the submit loop with a sync per pass, the final readback.
 */
abstract class GpuUpscaler implements Upscaler {
  readonly device: GPUDevice
  readonly info: EsrganInfo
  abstract readonly supportsEnsemble: boolean
  /** Bytes of activation memory per band pixel that the band planner must keep under `maxActBytes`. */
  abstract readonly bytesPerPixel: number
  maxActBytes: number
  protected readonly options: KernelOptions
  protected readonly weights: ModelWeights
  protected readonly layerBuffers = new Map<string, { weight: GPUBuffer; bias: GPUBuffer; prelu: GPUBuffer | null }>()
  protected readonly bandParams: GPUBuffer
  protected textures: { bw: number; rows: number; input: GPUTexture; inputT: GPUTexture; view: GPUTextureView; viewT: GPUTextureView } | null = null
  private scratch: { w: number; h: number; canvas: OffscreenCanvas }[] = []
  private lost = false
  onLost: (() => void) | null = null

  protected constructor(dev: DeviceInfo, weights: ModelWeights, options: KernelOptions, maxActBytes: number) {
    this.device = dev.device
    this.info = { adapter: dev.name, precision: options.f16 ? 'f16' : 'f32' }
    this.weights = weights
    this.options = options
    this.maxActBytes = maxActBytes
    for (const layer of weights.layers) {
      this.layerBuffers.set(layer.name, {
        weight: this.upload(layer.weight, `${layer.name}-w`),
        bias: this.upload(layer.bias, `${layer.name}-b`),
        prelu: layer.prelu ? this.upload(layer.prelu, `${layer.name}-p`) : null,
      })
    }
    this.bandParams = this.uniform('band', BAND_PARAMS_BYTES)
    void this.device.lost.then(() => {
      this.lost = true
      this.onLost?.()
    })
  }

  get isLost(): boolean {
    return this.lost
  }

  protected upload(f16: Uint16Array, label: string): GPUBuffer {
    const data = this.options.f16 ? f16 : f16ArrayToF32(f16)
    const buffer = this.device.createBuffer({ label, size: Math.ceil(data.byteLength / 4) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength)
    return buffer
  }

  protected uniform(label: string, size: number, data?: ArrayBuffer): GPUBuffer {
    const buffer = this.device.createBuffer({ label, size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    if (data) this.device.queue.writeBuffer(buffer, 0, data)
    return buffer
  }

  protected layerUniform(label: string, p: Parameters<typeof layerParams>[0]): GPUBuffer {
    return this.uniform(label, LAYER_PARAMS_BYTES, layerParams(p))
  }

  protected storage(label: string, size: number, copyable = false): GPUBuffer {
    return this.device.createBuffer({ label, size, usage: GPUBufferUsage.STORAGE | (copyable ? GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST : 0) })
  }

  protected layer(name: string): Layer {
    const l = this.weights.byName.get(name)
    if (!l) throw new Error(`Livello mancante: ${name}`)
    return l
  }

  protected weightsOf(name: string) {
    const b = this.layerBuffers.get(name)
    if (!b) throw new Error(`Pesi mancanti: ${name}`)
    return b
  }

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

  workPixels(size: PageSize): number {
    return workPixels(size, this.bytesPerPixel, this.maxActBytes)
  }

  /** Band input textures for the current band geometry (allocated on change). */
  protected bandTextures(bw: number, rows: number) {
    const cur = this.textures
    if (cur && cur.bw === bw && cur.rows === rows) return cur
    if (cur) {
      cur.input.destroy()
      cur.inputT.destroy()
    }
    const texture = (label: string, w: number, h: number) =>
      this.device.createTexture({
        label,
        size: [w, h, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      })
    const input = texture('esrgan-band-input', bw, rows)
    const inputT = texture('esrgan-band-input-t', rows, bw)
    this.textures = { bw, rows, input, inputT, view: input.createView(), viewT: inputT.createView() }
    this.onBandGeometry(bw, rows)
    return this.textures
  }

  /** Programs (re)build their band-sized buffers and bind groups here. */
  protected abstract onBandGeometry(bw: number, paddedRows: number): void

  /** Records the GPU work of one band of one pass; returns the command buffers to submit. */
  protected abstract encodeBand(job: BandJob): GPUCommandBuffer[]

  /** Called once per run before the bands (e.g. bind groups that reference the page buffer). */
  protected abstract beginRun(page: GPUBuffer, factor: EsrganFactor, passes: number, W: number, H: number): void

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

  async upscale(source: ImageBitmap, factor: EsrganFactor, opts: RunOptions = {}): Promise<UpscaleResult> {
    if (this.lost) throw new Error('WebGPU device lost')
    const W = source.width
    const H = source.height
    const plan = planBands({ w: W, h: H }, this.bytesPerPixel, this.maxActBytes)
    if (!plan) throw new Error(`Pagina ${W}×${H} troppo larga per il modello`)
    const transforms = this.supportsEnsemble ? ensembleTransforms(opts.ensemble ?? 1) : [IDENTITY]
    const passes = transforms.length
    const outW = W * factor
    const outH = H * factor
    const outBytes = outW * outH * 4
    const device = this.device
    // An ImageBitmap is the copy source every WebGPU implementation accepts (canvases are not).
    const padded = padPage(source, plan.bw).transferToImageBitmap()
    const paddedRows = Math.min(plan.coreRows, H) + 2 * CONTEXT
    const textures = this.bandTextures(plan.bw, paddedRows)
    const page = device.createBuffer({ label: 'esrgan-page', size: outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
    const readback = device.createBuffer({ label: 'esrgan-readback', size: outBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    this.beginRun(page, factor, passes, W, H)
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
          const texture = t.swap ? textures.inputT : textures.input
          if (band) {
            device.queue.copyExternalImageToTexture({ source: band }, { texture }, [tw, th])
            band.close()
          } else {
            device.queue.copyExternalImageToTexture({ source: padded, origin: { x: 0, y: y0 } }, { texture }, [tw, th])
          }
          const commands = this.encodeBand({ tw, th, y0, rows, W, factor, outW, outH, transform: t, pass, passes, swap: t.swap, page })
          if (pass === passes - 1 && k === plan.bands - 1) {
            const encoder = device.createCommandEncoder({ label: 'esrgan-readback' })
            encoder.copyBufferToBuffer(page, 0, readback, 0, outBytes)
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
    this.disposeBuffers()
    if (this.textures) {
      this.textures.input.destroy()
      this.textures.inputT.destroy()
      this.textures = null
    }
    for (const l of this.layerBuffers.values()) {
      l.weight.destroy()
      l.bias.destroy()
      l.prelu?.destroy()
    }
    this.bandParams.destroy()
    this.device.destroy()
  }

  protected abstract disposeBuffers(): void
}

const bindGroup = (device: GPUDevice, label: string, pipeline: GPUComputePipeline, entries: Array<[number, GPUBindingResource]>) =>
  device.createBindGroup({ label, layout: pipeline.getBindGroupLayout(0), entries: entries.map(([binding, resource]) => ({ binding, resource })) })

/** Bytes of one vec4 activation (4 channels). */
const quadBytes = (o: KernelOptions) => (o.f16 ? 8 : 16)

// ---- SRVGG (realesr-animevideov3) -------------------------------------------------------------

/** Largest of the two ping-pong activation buffers (16 planes) we are willing to allocate. */
const SRVGG_MAX_ACT_BYTES = 48 * 1024 * 1024

interface SrvggPipelines {
  first: GPUComputePipeline
  body: GPUComputePipeline
  last: GPUComputePipeline
  shuffle: GPUComputePipeline
  shuffleAccumulate: GPUComputePipeline
  finalize: GPUComputePipeline
}

/**
 * SRVGGNetCompact: 3→64, 16 × (64→64 + PReLU), 64→48, pixel shuffle x4. Two ping-pong buffers of
 * 16 planes; with an ensemble, every band is run once per symmetry of the rectangle and the
 * outputs are averaged on the GPU before being written to the page.
 */
class SrvggUpscaler extends GpuUpscaler {
  readonly supportsEnsemble = true
  readonly bytesPerPixel: number
  private readonly pipelines: SrvggPipelines
  private readonly lpFirst: GPUBuffer
  private readonly lp64: GPUBuffer
  private readonly shuffleParams: GPUBuffer
  private buffers: { a: GPUBuffer; b: GPUBuffer; layers: Array<{ pipeline: GPUComputePipeline; bindGroup: GPUBindGroup; bindGroupT: GPUBindGroup }>; lastAct: GPUBuffer } | null = null
  private acc: { bytes: number; buffer: GPUBuffer } | null = null
  private run: { shuffleGroups: GPUBindGroup[]; finalizeGroup: GPUBindGroup | null; accW: number } | null = null

  private constructor(dev: DeviceInfo, weights: ModelWeights, options: KernelOptions, pipelines: SrvggPipelines) {
    super(dev, weights, options, SRVGG_MAX_ACT_BYTES)
    this.pipelines = pipelines
    this.bytesPerPixel = 16 * quadBytes(options)
    this.lpFirst = this.layerUniform('lp-first', { cin: 3 })
    this.lp64 = this.layerUniform('lp-64', { cin: 64 })
    this.shuffleParams = this.uniform('shuffle', SHUFFLE_PARAMS_BYTES)
  }

  static async create(dev: DeviceInfo, weights: ModelWeights): Promise<SrvggUpscaler> {
    const { options, pipelines } = await compileProgram(dev.device, dev.f16, async (o, pipeline) => {
      const [first, body, last, shuffle, shuffleAccumulate, finalize] = await Promise.all([
        pipeline('srvgg-conv-first', convFirstWgsl(o, 'prelu')),
        pipeline('srvgg-conv-body', convWgsl(o, { cout: 64, activation: 'prelu', residual: 0, split: false })),
        pipeline('srvgg-conv-last', convWgsl(o, { cout: 48, activation: 'none', residual: 0, split: false })),
        pipeline('srvgg-shuffle', shuffleWgsl(o, false)),
        pipeline('srvgg-shuffle-accumulate', shuffleWgsl(o, true)),
        pipeline('srvgg-finalize', finalizeWgsl()),
      ])
      return { first, body, last, shuffle, shuffleAccumulate, finalize }
    })
    return new SrvggUpscaler(dev, weights, options, pipelines)
  }

  protected onBandGeometry(bw: number, paddedRows: number): void {
    this.disposeBuffers()
    const device = this.device
    const bytes = bw * paddedRows * this.bytesPerPixel
    const a = this.storage('srvgg-act-a', bytes)
    const b = this.storage('srvgg-act-b', bytes)
    const { view, viewT } = this.textures!
    const layers = this.weights.layers.map((layer, i) => {
      const bufs = this.weightsOf(layer.name)
      const isFirst = i === 0
      const isLast = i === this.weights.layers.length - 1
      const pipeline = isFirst ? this.pipelines.first : isLast ? this.pipelines.last : this.pipelines.body
      // Layer i reads a when i is odd, b when even (layer 0 reads the texture and writes a).
      const src = i % 2 === 1 ? a : b
      const dst = i % 2 === 1 ? b : a
      const entries = (texture: GPUTextureView): Array<[number, GPUBindingResource]> => {
        const list: Array<[number, GPUBindingResource]> = [
          [0, isFirst ? texture : { buffer: src }],
          [1, { buffer: bufs.weight }],
          [2, { buffer: bufs.bias }],
          [4, { buffer: dst }],
          [5, { buffer: this.bandParams }],
          [6, { buffer: isFirst ? this.lpFirst : this.lp64 }],
        ]
        if (bufs.prelu) list.push([3, { buffer: bufs.prelu }])
        return list
      }
      const group = bindGroup(device, `srvgg-${layer.name}`, pipeline, entries(view))
      return { pipeline, bindGroup: group, bindGroupT: isFirst ? bindGroup(device, `srvgg-${layer.name}-t`, pipeline, entries(viewT)) : group }
    })
    const lastAct = (this.weights.layers.length - 1) % 2 === 1 ? b : a
    this.buffers = { a, b, layers, lastAct }
  }

  protected beginRun(page: GPUBuffer, factor: EsrganFactor, passes: number, W: number, H: number): void {
    const device = this.device
    const buffers = this.buffers!
    const textures = this.textures!
    const accW = W * factor
    let accBuffer: GPUBuffer | null = null
    if (passes > 1) {
      const bytes = accW * Math.min(textures.rows - 2 * CONTEXT, H) * factor * 16
      if (!this.acc || this.acc.bytes < bytes) {
        this.acc?.buffer.destroy()
        this.acc = { bytes, buffer: this.storage('srvgg-ensemble-acc', bytes) }
      }
      accBuffer = this.acc.buffer
    }
    const shufflePipeline = passes > 1 ? this.pipelines.shuffleAccumulate : this.pipelines.shuffle
    const shuffleGroups = [textures.view, textures.viewT].map((view) =>
      bindGroup(device, 'srvgg-shuffle', shufflePipeline, [
        [0, { buffer: buffers.lastAct }],
        [1, view],
        [2, { buffer: accBuffer ?? page }],
        [3, { buffer: this.shuffleParams }],
      ]),
    )
    const finalizeGroup = accBuffer
      ? bindGroup(device, 'srvgg-finalize', this.pipelines.finalize, [
          [0, { buffer: accBuffer }],
          [1, { buffer: page }],
          [2, { buffer: this.shuffleParams }],
        ])
      : null
    this.run = { shuffleGroups, finalizeGroup, accW }
  }

  protected encodeBand(job: BandJob): GPUCommandBuffer[] {
    const device = this.device
    const buffers = this.buffers!
    const run = this.run!
    const { tw, th, rows, W, factor, outW, outH, transform: t, pass, passes } = job
    device.queue.writeBuffer(this.bandParams, 0, new Uint32Array([tw, th, tw, th]))
    device.queue.writeBuffer(
      this.shuffleParams,
      0,
      new Uint32Array([tw, th, CONTEXT, W, job.y0, rows, outW, outH, factor, t.swap ? 1 : 0, t.flipX ? 1 : 0, t.flipY ? 1 : 0, pass === 0 ? 1 : 0, run.accW, passes, 0]),
    )
    const lastPass = pass === passes - 1
    // Two command buffers per pass (first half of the layers, second half + shuffle): each stays
    // well under the GPU watchdog even on a slow device.
    const half = Math.ceil(buffers.layers.length / 2)
    const commands: GPUCommandBuffer[] = []
    for (const [from, to] of [
      [0, half],
      [half, buffers.layers.length],
    ] as const) {
      const encoder = device.createCommandEncoder({ label: `srvgg-band-${from}` })
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
        computePass.setBindGroup(0, run.shuffleGroups[t.swap ? 1 : 0]!)
        computePass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(rows / 8))
        if (run.finalizeGroup && lastPass) {
          computePass.setPipeline(this.pipelines.finalize)
          computePass.setBindGroup(0, run.finalizeGroup)
          computePass.dispatchWorkgroups(Math.ceil(run.accW / 8), Math.ceil((rows * factor) / 8))
        }
      }
      computePass.end()
      commands.push(encoder.finish())
    }
    return commands
  }

  protected disposeBuffers(): void {
    if (this.buffers) {
      this.buffers.a.destroy()
      this.buffers.b.destroy()
      this.buffers = null
    }
    this.acc?.buffer.destroy()
    this.acc = null
  }

  dispose(): void {
    super.dispose()
    this.lpFirst.destroy()
    this.lp64.destroy()
    this.shuffleParams.destroy()
  }
}

// ---- RRDB (RealESRGAN_x4plus_anime_6B) ---------------------------------------------------------

/**
 * Trunk activation memory per band: four rotating 64-channel feature buffers (block input and
 * the outputs of the three dense blocks), the 128-channel growth buffer of a dense block plus the
 * 32-channel scratch its convolutions write, and the conv_first features kept for the skip.
 */
const RRDB_MAX_ACT_BYTES = 128 * 1024 * 1024
const RRDB_PLANES = 16 * 4 + 32 + 8 + 16

interface RrdbPipelines {
  first: GPUComputePipeline
  conv1: GPUComputePipeline
  convDense: GPUComputePipeline
  conv5: GPUComputePipeline
  conv5Last: GPUComputePipeline
  body: GPUComputePipeline
  up: GPUComputePipeline
  rgb: GPUComputePipeline
}

interface Dispatch {
  pipeline: GPUComputePipeline
  group: GPUBindGroup
  /** Growth block (0..3) the output is copied into after the dispatch, for conv1–conv4. */
  growth?: number
}

interface TailStrip {
  lpUp1: GPUBuffer
  rgbParams: GPUBuffer
  up1: GPUBindGroup
  up2: GPUBindGroup
  hr: GPUBindGroup
}

/**
 * RRDBNet with 6 residual-in-residual dense blocks, at 64 features with 32 growth channels.
 *
 * Per band: conv_first → F (kept for the skip), copied into the first feature buffer. Feature
 * buffers rotate: a dense block reads its input X and the growth buffer G (x1..x4); conv1–conv4
 * write the scratch S, copied into the next 8-plane block of G between dispatches (a buffer may
 * not be read and written by one dispatch); conv5 writes X + 0.2·out into the next feature
 * buffer, and the third block also folds the RRDB skip in (Xout = Xin0 + 0.2·(X + 0.2·out)).
 * conv_body adds F. The x4 tail (two nearest upsamples with convolutions, conv_hr, conv_last)
 * runs on strips of TAIL_ROWS source rows with TAIL_CONTEXT rows of context, because 64 channels
 * at 4x for a whole band would not fit.
 */
class RrdbUpscaler extends GpuUpscaler {
  readonly supportsEnsemble = false
  readonly bytesPerPixel: number
  private readonly pipelines: RrdbPipelines
  private readonly lp: Record<'first' | 'conv1' | 'conv5' | 'conv5Last' | 'body' | 'up2' | 'hr', GPUBuffer>
  private readonly lpDense = new Map<number, GPUBuffer>()
  private readonly bandUp1: GPUBuffer
  private readonly bandUp2: GPUBuffer
  private readonly bandHr: GPUBuffer
  private buffers: {
    bw: number
    rows: number
    x: GPUBuffer[]
    g: GPUBuffer
    s: GPUBuffer
    f: GPUBuffer
    u1: GPUBuffer
    u2: GPUBuffer
    u3: GPUBuffer
    first: GPUBindGroup
    blocks: Dispatch[][]
    body: Dispatch
    strips: TailStrip[]
  } | null = null
  private run: { rgbGroups: GPUBindGroup[] } | null = null

  private constructor(dev: DeviceInfo, weights: ModelWeights, options: KernelOptions, pipelines: RrdbPipelines) {
    super(dev, weights, options, RRDB_MAX_ACT_BYTES)
    this.pipelines = pipelines
    this.bytesPerPixel = RRDB_PLANES * quadBytes(options)
    this.lp = {
      first: this.layerUniform('lp-first', { cin: 3 }),
      conv1: this.layerUniform('lp-conv1', { cin: 64 }),
      conv5: this.layerUniform('lp-conv5', { cin: 192, res1Scale: 0.2 }),
      conv5Last: this.layerUniform('lp-conv5-last', { cin: 192, res1Scale: 0.2, res2Scale: 0.2 }),
      body: this.layerUniform('lp-body', { cin: 64, res1Scale: 1 }),
      up2: this.layerUniform('lp-up2', { cin: 64, inScale: 2 }),
      hr: this.layerUniform('lp-hr', { cin: 64 }),
    }
    for (const cin of [96, 128, 160]) this.lpDense.set(cin, this.layerUniform(`lp-dense-${cin}`, { cin }))
    this.bandUp1 = this.uniform('band-up1', BAND_PARAMS_BYTES)
    this.bandUp2 = this.uniform('band-up2', BAND_PARAMS_BYTES)
    this.bandHr = this.uniform('band-hr', BAND_PARAMS_BYTES)
  }

  static async create(dev: DeviceInfo, weights: ModelWeights): Promise<RrdbUpscaler> {
    const { options, pipelines } = await compileProgram(dev.device, dev.f16, async (o, pipeline) => {
      const [first, conv1, convDense, conv5, conv5Last, body, up, rgb] = await Promise.all([
        pipeline('rrdb-conv-first', convFirstWgsl(o, 'none')),
        pipeline('rrdb-conv1', convWgsl(o, { cout: 32, activation: 'lrelu', residual: 0, split: false })),
        pipeline('rrdb-conv-dense', convWgsl(o, { cout: 32, activation: 'lrelu', residual: 0, split: true })),
        pipeline('rrdb-conv5', convWgsl(o, { cout: 64, activation: 'none', residual: 1, split: true })),
        pipeline('rrdb-conv5-last', convWgsl(o, { cout: 64, activation: 'none', residual: 2, split: true })),
        pipeline('rrdb-conv-body', convWgsl(o, { cout: 64, activation: 'none', residual: 1, split: false })),
        pipeline('rrdb-conv-up', convWgsl(o, { cout: 64, activation: 'lrelu', residual: 0, split: false })),
        pipeline('rrdb-rgb-out', rgbOutWgsl(o)),
      ])
      return { first, conv1, convDense, conv5, conv5Last, body, up, rgb }
    })
    return new RrdbUpscaler(dev, weights, options, pipelines)
  }

  protected onBandGeometry(bw: number, rows: number): void {
    this.disposeBuffers()
    const device = this.device
    const q = quadBytes(this.options)
    const planeBytes = bw * rows * q
    const x = [0, 1, 2, 3].map((i) => this.storage(`rrdb-x${i}`, 16 * planeBytes, true))
    const g = this.storage('rrdb-g', 32 * planeBytes, true)
    const scratch = this.storage('rrdb-s', 8 * planeBytes, true)
    const f = this.storage('rrdb-f', 16 * planeBytes, true)
    const tailRows = TAIL_ROWS + 2 * TAIL_CONTEXT
    const u1 = this.storage('rrdb-u1', 16 * bw * 2 * tailRows * 2 * q)
    const u2 = this.storage('rrdb-u2', 16 * bw * 4 * tailRows * 4 * q)
    const u3 = this.storage('rrdb-u3', 16 * bw * 4 * tailRows * 4 * q)
    device.queue.writeBuffer(this.bandUp2, 0, new Uint32Array([bw * 4, tailRows * 4, bw * 2, tailRows * 2]))
    device.queue.writeBuffer(this.bandHr, 0, new Uint32Array([bw * 4, tailRows * 4, bw * 4, tailRows * 4]))
    const wFirst = this.weightsOf('conv_first')
    const first = bindGroup(device, 'rrdb-first', this.pipelines.first, [
      [0, this.textures!.view],
      [1, { buffer: wFirst.weight }],
      [2, { buffer: wFirst.bias }],
      [4, { buffer: f }],
      [5, { buffer: this.bandParams }],
      [6, { buffer: this.lp.first }],
    ])
    const conv = (pipeline: GPUComputePipeline, name: string, entries: Array<[number, GPUBindingResource]>, growth?: number): Dispatch => {
      const w = this.weightsOf(name)
      return {
        pipeline,
        group: bindGroup(device, `rrdb-${name}`, pipeline, [[1, { buffer: w.weight }], [2, { buffer: w.bias }], [5, { buffer: this.bandParams }], ...entries]),
        growth,
      }
    }
    const blocks: Dispatch[][] = []
    let cur = 0
    for (let i = 0; i < (this.weights.header.numBlock ?? 0); i++) {
      const block: Dispatch[] = []
      const input = cur
      for (let j = 1; j <= 3; j++) {
        const p = `body.${i}.rdb${j}`
        const xin = x[cur]!
        const xout = x[(cur + 1) % 4]!
        block.push(conv(this.pipelines.conv1, `${p}.conv1`, [[0, { buffer: xin }], [4, { buffer: scratch }], [6, { buffer: this.lp.conv1 }]], 0))
        for (const k of [2, 3, 4]) {
          block.push(
            conv(
              this.pipelines.convDense,
              `${p}.conv${k}`,
              [[0, { buffer: xin }], [7, { buffer: g }], [4, { buffer: scratch }], [6, { buffer: this.lpDense.get(64 + 32 * (k - 1))! }]],
              k - 1,
            ),
          )
        }
        if (j < 3) {
          block.push(conv(this.pipelines.conv5, `${p}.conv5`, [[0, { buffer: xin }], [7, { buffer: g }], [4, { buffer: xout }], [8, { buffer: xin }], [6, { buffer: this.lp.conv5 }]]))
        } else {
          block.push(
            conv(this.pipelines.conv5Last, `${p}.conv5`, [
              [0, { buffer: xin }],
              [7, { buffer: g }],
              [4, { buffer: xout }],
              [8, { buffer: x[input]! }],
              [9, { buffer: xin }],
              [6, { buffer: this.lp.conv5Last }],
            ]),
          )
        }
        cur = (cur + 1) % 4
      }
      blocks.push(block)
    }
    const feat2 = x[(cur + 1) % 4]!
    const body = conv(this.pipelines.body, 'conv_body', [[0, { buffer: x[cur]! }], [4, { buffer: feat2 }], [8, { buffer: f }], [6, { buffer: this.lp.body }]])
    const strips: TailStrip[] = []
    const stripCount = Math.ceil((rows - 2 * CONTEXT) / TAIL_ROWS)
    const wUp1 = this.weightsOf('conv_up1')
    const wUp2 = this.weightsOf('conv_up2')
    const wHr = this.weightsOf('conv_hr')
    for (let k = 0; k < stripCount; k++) {
      const lpUp1 = this.layerUniform(`lp-up1-${k}`, { cin: 64, inScale: 2, srcY0: CONTEXT + k * TAIL_ROWS - TAIL_CONTEXT })
      strips.push({
        lpUp1,
        rgbParams: this.uniform(`rgb-${k}`, RGB_OUT_PARAMS_BYTES),
        up1: bindGroup(device, `rrdb-up1-${k}`, this.pipelines.up, [
          [0, { buffer: feat2 }],
          [1, { buffer: wUp1.weight }],
          [2, { buffer: wUp1.bias }],
          [4, { buffer: u1 }],
          [5, { buffer: this.bandUp1 }],
          [6, { buffer: lpUp1 }],
        ]),
        up2: bindGroup(device, 'rrdb-up2', this.pipelines.up, [
          [0, { buffer: u1 }],
          [1, { buffer: wUp2.weight }],
          [2, { buffer: wUp2.bias }],
          [4, { buffer: u2 }],
          [5, { buffer: this.bandUp2 }],
          [6, { buffer: this.lp.up2 }],
        ]),
        hr: bindGroup(device, 'rrdb-hr', this.pipelines.up, [
          [0, { buffer: u2 }],
          [1, { buffer: wHr.weight }],
          [2, { buffer: wHr.bias }],
          [4, { buffer: u3 }],
          [5, { buffer: this.bandHr }],
          [6, { buffer: this.lp.hr }],
        ]),
      })
    }
    this.buffers = { bw, rows, x, g, s: scratch, f, u1, u2, u3, first, blocks, body, strips }
  }

  protected beginRun(page: GPUBuffer): void {
    const buffers = this.buffers!
    const wLast = this.weightsOf('conv_last')
    this.run = {
      rgbGroups: buffers.strips.map((s, k) =>
        bindGroup(this.device, `rrdb-rgb-${k}`, this.pipelines.rgb, [
          [0, { buffer: buffers.u3 }],
          [1, { buffer: wLast.weight }],
          [2, { buffer: wLast.bias }],
          [3, { buffer: page }],
          [4, { buffer: s.rgbParams }],
        ]),
      ),
    }
  }

  protected encodeBand(job: BandJob): GPUCommandBuffer[] {
    const device = this.device
    const buffers = this.buffers!
    const run = this.run!
    const { tw: bw, th: bh, rows, W, factor, outW, outH, y0 } = job
    const q = quadBytes(this.options)
    const planeBytes = bw * bh * q
    const tailRows = TAIL_ROWS + 2 * TAIL_CONTEXT
    device.queue.writeBuffer(this.bandParams, 0, new Uint32Array([bw, bh, bw, bh]))
    device.queue.writeBuffer(this.bandUp1, 0, new Uint32Array([bw * 2, tailRows * 2, bw, bh]))
    const stripCount = Math.ceil(rows / TAIL_ROWS)
    for (let k = 0; k < stripCount; k++) {
      const stripY0 = CONTEXT + k * TAIL_ROWS
      device.queue.writeBuffer(
        buffers.strips[k]!.rgbParams,
        0,
        new Uint32Array([bw * 4, tailRows * 4, (stripY0 - TAIL_CONTEXT) * 4, CONTEXT * 4, W * 4, rows * 4, y0 * 4, outW, outH, factor, stripY0 * 4, 0]),
      )
    }
    const commands: GPUCommandBuffer[] = []
    const trunkDispatch = (encoder: GPUCommandEncoder, d: Dispatch) => {
      const pass = encoder.beginComputePass()
      pass.setPipeline(d.pipeline)
      pass.setBindGroup(0, d.group)
      pass.dispatchWorkgroups(Math.ceil(bw / BODY_BLOCK_W), Math.ceil(bh / BODY_BLOCK_H))
      pass.end()
      if (d.growth !== undefined) encoder.copyBufferToBuffer(buffers.s, 0, buffers.g, d.growth * 8 * planeBytes, 8 * planeBytes)
    }
    // conv_first → F, then the first feature buffer starts as a copy of F.
    {
      const encoder = device.createCommandEncoder({ label: 'rrdb-first' })
      const pass = encoder.beginComputePass()
      pass.setPipeline(this.pipelines.first)
      pass.setBindGroup(0, buffers.first)
      pass.dispatchWorkgroups(Math.ceil(bw / 8), Math.ceil(bh / 8))
      pass.end()
      encoder.copyBufferToBuffer(buffers.f, 0, buffers.x[0]!, 0, 16 * planeBytes)
      commands.push(encoder.finish())
    }
    // One command buffer per residual-in-residual block keeps each well under the GPU watchdog.
    for (const block of buffers.blocks) {
      const encoder = device.createCommandEncoder({ label: 'rrdb-block' })
      for (const d of block) trunkDispatch(encoder, d)
      commands.push(encoder.finish())
    }
    {
      const encoder = device.createCommandEncoder({ label: 'rrdb-body' })
      trunkDispatch(encoder, buffers.body)
      commands.push(encoder.finish())
    }
    // The x4 tail, strip by strip; four strips per command buffer.
    for (let k0 = 0; k0 < stripCount; k0 += 4) {
      const encoder = device.createCommandEncoder({ label: `rrdb-tail-${k0}` })
      const pass = encoder.beginComputePass()
      for (let k = k0; k < Math.min(stripCount, k0 + 4); k++) {
        const strip = buffers.strips[k]!
        pass.setPipeline(this.pipelines.up)
        pass.setBindGroup(0, strip.up1)
        pass.dispatchWorkgroups(Math.ceil((bw * 2) / BODY_BLOCK_W), Math.ceil((tailRows * 2) / BODY_BLOCK_H))
        pass.setBindGroup(0, strip.up2)
        pass.dispatchWorkgroups(Math.ceil((bw * 4) / BODY_BLOCK_W), Math.ceil((tailRows * 4) / BODY_BLOCK_H))
        pass.setBindGroup(0, strip.hr)
        pass.dispatchWorkgroups(Math.ceil((bw * 4) / BODY_BLOCK_W), Math.ceil((tailRows * 4) / BODY_BLOCK_H))
        pass.setPipeline(this.pipelines.rgb)
        pass.setBindGroup(0, run.rgbGroups[k]!)
        pass.dispatchWorkgroups(Math.ceil((W * factor) / 8), Math.ceil((TAIL_ROWS * factor) / 8))
      }
      pass.end()
      commands.push(encoder.finish())
    }
    return commands
  }

  protected disposeBuffers(): void {
    const b = this.buffers
    if (!b) return
    for (const buf of [...b.x, b.g, b.s, b.f, b.u1, b.u2, b.u3]) buf.destroy()
    for (const s of b.strips) {
      s.lpUp1.destroy()
      s.rgbParams.destroy()
    }
    this.buffers = null
  }

  dispose(): void {
    super.dispose()
    for (const buffer of Object.values(this.lp)) buffer.destroy()
    for (const buffer of this.lpDense.values()) buffer.destroy()
    this.bandUp1.destroy()
    this.bandUp2.destroy()
    this.bandHr.destroy()
  }
}
