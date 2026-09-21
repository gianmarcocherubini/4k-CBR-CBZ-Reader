/// <reference types="@webgpu/types" />
import type { PageSize } from '../../../types'
import { MAX_OUTPUT_PIXELS, type UpscaleResult } from '../backend'
import { canvasMatrix, type Dihedral, type EnsembleSize, ensembleTransforms, IDENTITY, transformedSize } from './transforms'
import { CONTEXT, f16ArrayToF32, type Layer, type ModelWeights } from './weights'
import {
  BAND_PARAMS_BYTES,
  BODY_BLOCK_W,
  bodyBlockH,
  CONV_VARIANTS,
  convFirstWgsl,
  type ConvRows,
  type ConvSpec,
  type ConvVariant,
  convWgsl,
  finalizeWgsl,
  KERNEL_VARIANTS,
  type KernelOptions,
  LAYER_PARAMS_BYTES,
  layerParams,
  RGB_OUT_PARAMS_BYTES,
  rgbOutWgsl,
  SHUFFLE_PARAMS_BYTES,
  shuffleWgsl,
  untransformWgsl,
  WINO_PARAMS_BYTES,
  WINO_SLOT_BYTES,
  WINO_TILES_PER_GROUP,
  WINO_TRANSFORM_WG,
  winogradGemmWgsl,
  winogradTransformWgsl,
  winoParams,
} from './wgsl'
import { f32ToF16, winogradWeights } from './winograd'

export type EsrganFactor = 2 | 4

export interface EsrganInfo {
  adapter: string
  precision: 'f16' | 'f32'
  /** Why the f16 kernels were rejected when the f32 fallback is in use on a device that has shader-f16. */
  f16Error?: string
}

/**
 * Core rows of a band: pages are processed in horizontal bands of at most this many source rows.
 * Kept small so no single command buffer runs for long (iOS kills GPU work that exceeds its
 * watchdog); the context overhead is (rows + 2·CONTEXT) / rows ≈ 1.3.
 */
const MAX_BAND_ROWS = 160
const MIN_BAND_ROWS = 8
/**
 * Source rows per strip of the RRDB tail (the x4 stage is too large to hold for a whole band).
 * 16 rows plus 2 of context each side: 25% overhead instead of 50% with 8, for ~30 MB more of
 * tail buffers on a typical page. The context is exact, so the strip height never changes a pixel.
 */
const TAIL_ROWS = 16
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
  /**
   * Convolution kernel in use: direct with 1 or 2 output rows per thread, or Winograd. The direct
   * variants compute identical numbers; Winograd the same maths through transforms (in f16 with
   * its own rounding). The engine times them on the device and keeps the fastest that matches.
   */
  variant: ConvVariant
  readonly variants: readonly ConvVariant[]
  /**
   * Frees the Winograd buffers (transformed tiles, parameter slots, transformed weights) and pins
   * the direct kernels for the rest of this runner's life (`variant = 'w'` has no effect afterwards).
   */
  releaseWinograd(): void
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
 * A convolution compiled in every kernel: the direct variants (bind groups made with `layout` fit
 * both) and the Winograd multiply for this spec (`gemm`, bind groups with `gemmLayout`).
 */
export interface ConvPipelines {
  spec: ConvSpec
  layout: GPUBindGroupLayout
  byRows: Record<ConvRows, GPUComputePipeline>
  gemm: GPUComputePipeline
  gemmLayout: GPUBindGroupLayout
}

/** Winograd input transform, shared by every convolution of a program (one per input arrangement). */
interface WinoTransforms {
  plain: { pipeline: GPUComputePipeline; layout: GPUBindGroupLayout }
  split: { pipeline: GPUComputePipeline; layout: GPUBindGroupLayout }
}

// GPUShaderStage.COMPUTE; spelled out so the module also loads where WebGPU globals are absent (unit tests).
const VISIBILITY = 4
const ro = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: VISIBILITY, buffer: { type: 'read-only-storage' } })
const rw = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: VISIBILITY, buffer: { type: 'storage' } })
const uniformEntry = (binding: number, dynamic = false): GPUBindGroupLayoutEntry => ({
  binding,
  visibility: VISIBILITY,
  buffer: { type: 'uniform', hasDynamicOffset: dynamic },
})

/** Explicit layout of the direct conv kernel bindings (shared by the variants, which 'auto' layouts would not guarantee). */
function convLayout(device: GPUDevice, spec: ConvSpec): GPUBindGroupLayout {
  const entries: GPUBindGroupLayoutEntry[] = [ro(0), ro(1), ro(2)]
  if (spec.activation === 'prelu') entries.push(ro(3))
  entries.push(rw(4), uniformEntry(5), uniformEntry(6))
  if (spec.split) entries.push(ro(7))
  if (spec.residual >= 1) entries.push(ro(8))
  if (spec.residual === 2) entries.push(ro(9))
  return device.createBindGroupLayout({ entries })
}

/** Winograd multiply bindings: transformed tiles, transformed weights, bias, [prelu], dst, slot, [res1], [res2]. */
function winoGemmLayout(device: GPUDevice, spec: ConvSpec): GPUBindGroupLayout {
  const entries: GPUBindGroupLayoutEntry[] = [ro(0), ro(1), ro(2)]
  if (spec.activation === 'prelu') entries.push(ro(3))
  entries.push(rw(4), uniformEntry(5, true))
  if (spec.residual >= 1) entries.push(ro(8))
  if (spec.residual === 2) entries.push(ro(9))
  return device.createBindGroupLayout({ entries })
}

/** Winograd transform bindings: source, transformed tiles, slot, [second source]. */
function winoTransformLayout(device: GPUDevice, split: boolean): GPUBindGroupLayout {
  const entries: GPUBindGroupLayoutEntry[] = [ro(0), rw(1), uniformEntry(5, true)]
  if (split) entries.push(ro(7))
  return device.createBindGroupLayout({ entries })
}

type PipelineFn = (label: string, code: string) => Promise<GPUComputePipeline>
type ConvFn = (label: string, spec: ConvSpec) => Promise<ConvPipelines>

/**
 * Compiles the kernels of a program, preferring f16 and falling back to f32 when a driver that
 * advertises shader-f16 still rejects the half-precision kernels. Convolutions are compiled in
 * every kernel variant (direct rows and Winograd).
 */
async function compileProgram<T>(
  device: GPUDevice,
  f16: boolean,
  build: (options: KernelOptions, pipeline: PipelineFn, conv: ConvFn) => Promise<T>,
): Promise<{ options: KernelOptions; pipelines: T; wino: WinoTransforms; f16Error?: string }> {
  const pipeline: PipelineFn = (label, code) =>
    device.createComputePipelineAsync({
      label,
      layout: 'auto',
      compute: { module: device.createShaderModule({ label, code }), entryPoint: 'main' },
    })
  const withLayout = (label: string, code: string, layout: GPUBindGroupLayout) =>
    device.createComputePipelineAsync({
      label,
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: device.createShaderModule({ label, code }), entryPoint: 'main' },
    })
  const convFor =
    (options: KernelOptions): ConvFn =>
    async (label, spec) => {
      const layout = convLayout(device, spec)
      const gemmLayout = winoGemmLayout(device, spec)
      const [gemm, ...built] = await Promise.all([
        withLayout(`${label}-winograd`, winogradGemmWgsl(options, spec), gemmLayout),
        ...CONV_VARIANTS.map((rows) => withLayout(`${label}-x${rows}`, convWgsl(options, spec, rows), layout)),
      ])
      const byRows = Object.fromEntries(CONV_VARIANTS.map((rows, i) => [rows, built[i]!])) as Record<ConvRows, GPUComputePipeline>
      return { spec, layout, byRows, gemm, gemmLayout }
    }
  const transformsFor = async (options: KernelOptions): Promise<WinoTransforms> => {
    const plainLayout = winoTransformLayout(device, false)
    const splitLayout = winoTransformLayout(device, true)
    const [plain, split] = await Promise.all([
      withLayout('winograd-transform', winogradTransformWgsl(options, false), plainLayout),
      withLayout('winograd-transform-split', winogradTransformWgsl(options, true), splitLayout),
    ])
    return { plain: { pipeline: plain, layout: plainLayout }, split: { pipeline: split, layout: splitLayout } }
  }
  let options: KernelOptions = { f16 }
  try {
    const [pipelines, wino] = await Promise.all([build(options, pipeline, convFor(options)), transformsFor(options)])
    return { options, pipelines, wino }
  } catch (e) {
    if (!f16) throw e
    const message = e instanceof Error ? e.message : String(e)
    console.warn('Real-ESRGAN: kernel f16 rifiutati, uso f32.', e)
    options = { f16: false }
    const [pipelines, wino] = await Promise.all([build(options, pipeline, convFor(options)), transformsFor(options)])
    return { options, pipelines, wino, f16Error: message.slice(0, 300) }
  }
}

/** Layer constants a convolution instance needs for its per-dispatch Winograd parameters. */
export interface ConvLayerParams {
  cin: number
  cout: number
  inScale?: 1 | 2
  srcX0?: number
  srcY0?: number
  splitPlane?: number
  dstPlane?: number
  res1Scale?: number
  res2Scale?: number
}

/** Output and source geometry of one convolution dispatch (the direct kernels read it from a Band uniform). */
export interface ConvGeometry {
  bw: number
  bh: number
  srcW: number
  srcH: number
}

/** Buffers a convolution reads and writes (the Winograd bind groups are built from these on demand). */
export interface ConvIo {
  name: string
  src: GPUBuffer
  src1?: GPUBuffer
  dst: GPUBuffer
  res1?: GPUBuffer
  res2?: GPUBuffer
}

/**
 * One convolution of a program: the direct bind group, and the Winograd transform/multiply pair
 * built the first time that kernel runs (so a device that keeps the direct kernels never pays for
 * the transformed weights or the tile buffer).
 */
export interface ConvInstance {
  pipelines: ConvPipelines
  direct: GPUBindGroup
  layer: ConvLayerParams
  io: ConvIo
  winoGroups?: { transform: GPUBindGroup; transformPipeline: GPUComputePipeline; gemm: GPUBindGroup }
}

/** Memory for the transformed tiles of one Winograd chunk (16 quads per tile and input quad). */
const WINO_V_BUDGET_BYTES = 32 * 1024 * 1024
/** Parameter slots per band pass (trunk chunks plus tail strips × their chunks). */
const WINO_MAX_SLOTS = 4096

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
  variant: ConvVariant = 1
  readonly variants = KERNEL_VARIANTS
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
  // ---- Winograd state (allocated on first use, released when the kernel is not kept) ----
  protected readonly winoTransforms: WinoTransforms
  private wino: { tiles: GPUBuffer; slots: GPUBuffer; weights: Map<string, GPUBuffer> } | null = null
  private winoReleased = false
  private readonly slotData = new Uint8Array(WINO_MAX_SLOTS * WINO_SLOT_BYTES)
  private slotCount = 0
  private slotsExhausted = false

  protected constructor(dev: DeviceInfo, weights: ModelWeights, options: KernelOptions, maxActBytes: number, wino: WinoTransforms, f16Error?: string) {
    this.device = dev.device
    this.info = { adapter: dev.name, precision: options.f16 ? 'f16' : 'f32', ...(f16Error ? { f16Error } : {}) }
    this.weights = weights
    this.options = options
    this.maxActBytes = maxActBytes
    this.winoTransforms = wino
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

  /** Transformed-tile buffer, parameter slots and transformed weights, created the first time Winograd runs. */
  private winoState(): { tiles: GPUBuffer; slots: GPUBuffer; weights: Map<string, GPUBuffer> } {
    if (!this.wino) {
      this.wino = {
        tiles: this.storage('winograd-tiles', WINO_V_BUDGET_BYTES),
        slots: this.device.createBuffer({ label: 'winograd-slots', size: WINO_MAX_SLOTS * WINO_SLOT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        weights: new Map(),
      }
    }
    return this.wino
  }

  /** Transformed (G g Gᵀ) weights of a layer, computed and uploaded on first use, in the kernels' precision. */
  private winoWeights(name: string): GPUBuffer {
    const state = this.winoState()
    let buffer = state.weights.get(name)
    if (!buffer) {
      const u = winogradWeights(this.layer(name))
      const data = this.options.f16 ? Uint16Array.from(u, f32ToF16) : u
      buffer = this.device.createBuffer({ label: `${name}-winograd`, size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
      this.device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength)
      state.weights.set(name, buffer)
    }
    return buffer
  }

  releaseWinograd(): void {
    if (this.wino) {
      for (const buffer of this.wino.weights.values()) buffer.destroy()
      this.wino.tiles.destroy()
      this.wino.slots.destroy()
      this.wino = null
    }
    this.winoReleased = true
    if (this.variant === 'w') this.variant = 1
  }

  /** Binds one convolution's direct kernel (Band uniform `band`, layer uniform `lp`); the Winograd pair follows on demand. */
  protected makeConv(
    pipelines: ConvPipelines,
    name: string,
    io: { src: GPUBuffer; src1?: GPUBuffer; dst: GPUBuffer; res1?: GPUBuffer; res2?: GPUBuffer; band: GPUBuffer; lp: GPUBuffer },
    layer: ConvLayerParams,
  ): ConvInstance {
    const w = this.weightsOf(name)
    const spec = pipelines.spec
    const entries: Array<[number, GPUBindingResource]> = [
      [0, { buffer: io.src }],
      [1, { buffer: w.weight }],
      [2, { buffer: w.bias }],
      [4, { buffer: io.dst }],
      [5, { buffer: io.band }],
      [6, { buffer: io.lp }],
    ]
    if (w.prelu) entries.push([3, { buffer: w.prelu }])
    if (spec.split) entries.push([7, { buffer: io.src1! }])
    if (spec.residual >= 1) entries.push([8, { buffer: io.res1! }])
    if (spec.residual === 2) entries.push([9, { buffer: io.res2! }])
    return {
      pipelines,
      direct: bindGroup(this.device, name, pipelines.layout, entries),
      layer,
      io: { name, src: io.src, src1: io.src1, dst: io.dst, res1: io.res1, res2: io.res2 },
    }
  }

  /** Winograd bind groups of a convolution (transform and multiply share the tile buffer and the slots). */
  private winoGroupsOf(inst: ConvInstance): NonNullable<ConvInstance['winoGroups']> {
    if (inst.winoGroups) return inst.winoGroups
    const state = this.winoState()
    const { io } = inst
    const w = this.weightsOf(io.name)
    const spec = inst.pipelines.spec
    const slot: GPUBindingResource = { buffer: state.slots, offset: 0, size: WINO_PARAMS_BYTES }
    const transform = spec.split ? this.winoTransforms.split : this.winoTransforms.plain
    const transformEntries: Array<[number, GPUBindingResource]> = [[0, { buffer: io.src }], [1, { buffer: state.tiles }], [5, slot]]
    if (spec.split) transformEntries.push([7, { buffer: io.src1! }])
    const gemmEntries: Array<[number, GPUBindingResource]> = [
      [0, { buffer: state.tiles }],
      [1, { buffer: this.winoWeights(io.name) }],
      [2, { buffer: w.bias }],
      [4, { buffer: io.dst }],
      [5, slot],
    ]
    if (w.prelu) gemmEntries.push([3, { buffer: w.prelu }])
    if (spec.residual >= 1) gemmEntries.push([8, { buffer: io.res1! }])
    if (spec.residual === 2) gemmEntries.push([9, { buffer: io.res2! }])
    inst.winoGroups = {
      transform: bindGroup(this.device, `${io.name}-wt`, transform.layout, transformEntries),
      transformPipeline: transform.pipeline,
      gemm: bindGroup(this.device, `${io.name}-wg`, inst.pipelines.gemmLayout, gemmEntries),
    }
    return inst.winoGroups
  }

  /** Called before a band pass is encoded: the parameter slots are refilled from the start. */
  protected beginSlots(): void {
    this.slotCount = 0
    this.slotsExhausted = false
  }

  /** Uploads the slots a band pass allocated (before its command buffers are submitted). */
  protected flushSlots(): void {
    if (this.slotCount > 0 && this.wino) this.device.queue.writeBuffer(this.wino.slots, 0, this.slotData, 0, this.slotCount * WINO_SLOT_BYTES)
  }

  /**
   * Records one convolution on the compute pass: the direct kernel of the current variant, or the
   * Winograd transform + multiply over chunks of tile rows that fit the transformed-tile budget.
   * `over` adjusts the layer's source offset for this dispatch (tail strips).
   */
  protected dispatchConv(pass: GPUComputePassEncoder, inst: ConvInstance, geom: ConvGeometry, over?: { srcY0?: number }): void {
    const direct = () => {
      const rows: ConvRows = this.variant === 2 ? 2 : 1
      pass.setPipeline(inst.pipelines.byRows[rows])
      pass.setBindGroup(0, inst.direct)
      pass.dispatchWorkgroups(Math.ceil(geom.bw / BODY_BLOCK_W), Math.ceil(geom.bh / bodyBlockH(rows)))
    }
    if (this.variant !== 'w' || this.winoReleased) return direct()
    const groups = this.winoGroupsOf(inst)
    const cin4 = inst.layer.cin / 4
    const tilesW = Math.ceil(geom.bw / 2)
    const tilesH = Math.ceil(geom.bh / 2)
    const maxTiles = Math.floor(WINO_V_BUDGET_BYTES / (16 * cin4 * quadBytes(this.options)))
    const rowsPerChunk = Math.floor(maxTiles / tilesW)
    const chunks = rowsPerChunk >= 1 ? Math.ceil(tilesH / rowsPerChunk) : 0
    if (chunks === 0 || this.slotCount + chunks > WINO_MAX_SLOTS) {
      // Too wide for the tile budget, or out of parameter slots: this convolution runs direct.
      if (!this.slotsExhausted && chunks > 0) console.warn('Winograd: slot dei parametri esauriti, convoluzione diretta')
      this.slotsExhausted = true
      return direct()
    }
    for (let r0 = 0; r0 < tilesH; r0 += rowsPerChunk) {
      const rows = Math.min(rowsPerChunk, tilesH - r0)
      const tilesChunk = rows * tilesW
      const params = winoParams({
        tilesW,
        tilesChunk,
        tileRow0: r0,
        bw: geom.bw,
        bh: geom.bh,
        srcW: geom.srcW,
        srcH: geom.srcH,
        cin: inst.layer.cin,
        cout: inst.layer.cout,
        inScale: inst.layer.inScale,
        srcX0: inst.layer.srcX0,
        srcY0: over?.srcY0 ?? inst.layer.srcY0,
        splitPlane: inst.layer.splitPlane,
        dstPlane: inst.layer.dstPlane,
        res1Scale: inst.layer.res1Scale,
        res2Scale: inst.layer.res2Scale,
      })
      const offset = this.slotCount * WINO_SLOT_BYTES
      this.slotData.set(new Uint8Array(params), offset)
      this.slotCount++
      pass.setPipeline(groups.transformPipeline)
      pass.setBindGroup(0, groups.transform, [offset])
      pass.dispatchWorkgroups(Math.ceil(tilesChunk / WINO_TRANSFORM_WG), cin4)
      pass.setPipeline(inst.pipelines.gemm)
      pass.setBindGroup(0, groups.gemm, [offset])
      pass.dispatchWorkgroups(Math.ceil(tilesChunk / WINO_TILES_PER_GROUP))
    }
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
          this.beginSlots()
          const commands = this.encodeBand({ tw, th, y0, rows, W, factor, outW, outH, transform: t, pass, passes, swap: t.swap, page })
          this.flushSlots()
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
    if (this.wino) {
      for (const buffer of this.wino.weights.values()) buffer.destroy()
      this.wino.tiles.destroy()
      this.wino.slots.destroy()
      this.wino = null
    }
    this.bandParams.destroy()
    this.device.destroy()
  }

  protected abstract disposeBuffers(): void
}

const bindGroup = (device: GPUDevice, label: string, target: GPUComputePipeline | GPUBindGroupLayout, entries: Array<[number, GPUBindingResource]>) =>
  device.createBindGroup({
    label,
    layout: 'getBindGroupLayout' in target ? target.getBindGroupLayout(0) : target,
    entries: entries.map(([binding, resource]) => ({ binding, resource })),
  })

/** Bytes of one vec4 activation (4 channels). */
const quadBytes = (o: KernelOptions) => (o.f16 ? 8 : 16)

// ---- SRVGG (realesr-animevideov3) -------------------------------------------------------------

/** Largest of the two ping-pong activation buffers (16 planes) we are willing to allocate. */
const SRVGG_MAX_ACT_BYTES = 48 * 1024 * 1024

interface SrvggPipelines {
  first: GPUComputePipeline
  body: ConvPipelines
  last: ConvPipelines
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
  private buffers: {
    a: GPUBuffer
    b: GPUBuffer
    /** conv_first (texture input) in the two orientations, then one instance per body/last layer. */
    first: GPUBindGroup
    firstT: GPUBindGroup
    layers: ConvInstance[]
    lastAct: GPUBuffer
  } | null = null
  private acc: { bytes: number; buffer: GPUBuffer } | null = null
  private run: { shuffleGroups: GPUBindGroup[]; finalizeGroup: GPUBindGroup | null; accW: number } | null = null

  private constructor(dev: DeviceInfo, weights: ModelWeights, options: KernelOptions, pipelines: SrvggPipelines, wino: WinoTransforms, f16Error?: string) {
    super(dev, weights, options, SRVGG_MAX_ACT_BYTES, wino, f16Error)
    this.pipelines = pipelines
    this.bytesPerPixel = 16 * quadBytes(options)
    this.lpFirst = this.layerUniform('lp-first', { cin: 3 })
    this.lp64 = this.layerUniform('lp-64', { cin: 64 })
    this.shuffleParams = this.uniform('shuffle', SHUFFLE_PARAMS_BYTES)
  }

  static async create(dev: DeviceInfo, weights: ModelWeights): Promise<SrvggUpscaler> {
    const { options, pipelines, wino, f16Error } = await compileProgram(dev.device, dev.f16, async (o, pipeline, conv) => {
      const [first, body, last, shuffle, shuffleAccumulate, finalize] = await Promise.all([
        pipeline('srvgg-conv-first', convFirstWgsl(o, 'prelu')),
        conv('srvgg-conv-body', { cout: 64, activation: 'prelu', residual: 0, split: false }),
        conv('srvgg-conv-last', { cout: 48, activation: 'none', residual: 0, split: false }),
        pipeline('srvgg-shuffle', shuffleWgsl(o, false)),
        pipeline('srvgg-shuffle-accumulate', shuffleWgsl(o, true)),
        pipeline('srvgg-finalize', finalizeWgsl()),
      ])
      return { first, body, last, shuffle, shuffleAccumulate, finalize }
    })
    return new SrvggUpscaler(dev, weights, options, pipelines, wino, f16Error)
  }

  protected onBandGeometry(bw: number, paddedRows: number): void {
    this.disposeBuffers()
    const device = this.device
    const bytes = bw * paddedRows * this.bytesPerPixel
    const a = this.storage('srvgg-act-a', bytes)
    const b = this.storage('srvgg-act-b', bytes)
    const { view, viewT } = this.textures!
    const wFirst = this.weightsOf(this.weights.layers[0]!.name)
    const firstEntries = (texture: GPUTextureView): Array<[number, GPUBindingResource]> => [
      [0, texture],
      [1, { buffer: wFirst.weight }],
      [2, { buffer: wFirst.bias }],
      [3, { buffer: wFirst.prelu! }],
      [4, { buffer: a }],
      [5, { buffer: this.bandParams }],
      [6, { buffer: this.lpFirst }],
    ]
    const first = bindGroup(device, 'srvgg-first', this.pipelines.first, firstEntries(view))
    const firstT = bindGroup(device, 'srvgg-first-t', this.pipelines.first, firstEntries(viewT))
    // Layer i reads a when i is odd, b when even (layer 0 reads the texture and writes a).
    const layers = this.weights.layers.slice(1).map((layer, k) => {
      const i = k + 1
      const isLast = i === this.weights.layers.length - 1
      const src = i % 2 === 1 ? a : b
      const dst = i % 2 === 1 ? b : a
      return this.makeConv(isLast ? this.pipelines.last : this.pipelines.body, layer.name, { src, dst, band: this.bandParams, lp: this.lp64 }, { cin: 64, cout: layer.cout })
    })
    const lastAct = (this.weights.layers.length - 1) % 2 === 1 ? b : a
    this.buffers = { a, b, first, firstT, layers, lastAct }
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
    const total = buffers.layers.length + 1
    const half = Math.ceil(total / 2)
    const geom: ConvGeometry = { bw: tw, bh: th, srcW: tw, srcH: th }
    const commands: GPUCommandBuffer[] = []
    for (const [from, to] of [
      [0, half],
      [half, total],
    ] as const) {
      const encoder = device.createCommandEncoder({ label: `srvgg-band-${from}` })
      const computePass = encoder.beginComputePass()
      for (let i = from; i < to; i++) {
        if (i === 0) {
          computePass.setPipeline(this.pipelines.first)
          computePass.setBindGroup(0, t.swap ? buffers.firstT : buffers.first)
          computePass.dispatchWorkgroups(Math.ceil(tw / 8), Math.ceil(th / 8))
        } else this.dispatchConv(computePass, buffers.layers[i - 1]!, geom)
      }
      if (to === total) {
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
 * 192 MB buys ~160-row bands on a typical page (8 bands instead of 11: less context recomputed).
 */
const RRDB_MAX_ACT_BYTES = 192 * 1024 * 1024
const RRDB_PLANES = 16 * 4 + 32 + 8 + 16

interface RrdbPipelines {
  first: GPUComputePipeline
  conv1: ConvPipelines
  convDense: ConvPipelines
  conv5: ConvPipelines
  conv5Last: ConvPipelines
  body: ConvPipelines
  up: ConvPipelines
  rgb: GPUComputePipeline
  rgbToBuffer: GPUComputePipeline
  untransform: GPUComputePipeline
  finalize: GPUComputePipeline
}

interface TrunkConv {
  inst: ConvInstance
  /** Growth block (0..3) the output is copied into after the dispatch, for conv1–conv4. */
  growth?: number
}

interface TailStrip {
  lpUp1: GPUBuffer
  rgbParams: GPUBuffer
  up1: ConvInstance
  up2: ConvInstance
  hr: ConvInstance
}

/** The core of a band as the network sees it after the pass's transform (see `transformedCore`). */
interface TransformedCore {
  x0: number
  y0: number
  w: number
  h: number
}

/**
 * Where the page rows of a band (its core, without context) land once the padded band of
 * `bw` x `bh` pixels is transformed by `t`. The band is padded by CONTEXT on top and bottom
 * exactly, but on the right by `bw - CONTEXT - W` (the width is rounded up to a multiple of 4),
 * so a flip along the band's width moves the core by that asymmetry.
 */
export function transformedCore(t: Dihedral, bw: number, W: number, rows: number): TransformedCore {
  const right = bw - CONTEXT - W
  if (!t.swap) return { x0: t.flipX ? right : CONTEXT, y0: CONTEXT, w: W, h: rows }
  return { x0: CONTEXT, y0: t.flipY ? right : CONTEXT, w: rows, h: W }
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
 *
 * Self-ensemble: the trunk and the convolutions are orientation-agnostic, so a transformed band
 * (flipped, transposed) goes through unchanged; the tail strips walk the transformed core and
 * conv_last writes float colours into a transformed-core buffer, which `untransform` maps back
 * to the original orientation and accumulates; `finalize` averages the passes into the page.
 */
class RrdbUpscaler extends GpuUpscaler {
  readonly supportsEnsemble = true
  readonly bytesPerPixel: number
  private readonly pipelines: RrdbPipelines
  private readonly lp: Record<'first' | 'conv1' | 'conv5' | 'conv5Last' | 'body' | 'up2' | 'hr', GPUBuffer>
  private readonly lpDense = new Map<number, GPUBuffer>()
  private readonly bandUp1: GPUBuffer
  private readonly bandUp2: GPUBuffer
  private readonly bandHr: GPUBuffer
  private readonly shuffleParams: GPUBuffer
  private buffers: {
    bw: number
    rows: number
    x: GPUBuffer[]
    g: GPUBuffer
    s: GPUBuffer
    f: GPUBuffer
    feat2: GPUBuffer
    u1: GPUBuffer
    u2: GPUBuffer
    u3: GPUBuffer
    first: GPUBindGroup
    firstT: GPUBindGroup
    blocks: TrunkConv[][]
    body: TrunkConv
    strips: TailStrip[]
  } | null = null
  /** Transformed-core output and accumulator of the self-ensemble, grown on demand. */
  private ensembleBuffers: { bytes: number; tout: GPUBuffer; acc: GPUBuffer } | null = null
  private run: { rgbGroups: GPUBindGroup[]; untransformGroup: GPUBindGroup | null; finalizeGroup: GPUBindGroup | null } | null = null

  private constructor(dev: DeviceInfo, weights: ModelWeights, options: KernelOptions, pipelines: RrdbPipelines, wino: WinoTransforms, f16Error?: string) {
    super(dev, weights, options, RRDB_MAX_ACT_BYTES, wino, f16Error)
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
    this.shuffleParams = this.uniform('rrdb-ensemble', SHUFFLE_PARAMS_BYTES)
  }

  static async create(dev: DeviceInfo, weights: ModelWeights): Promise<RrdbUpscaler> {
    const { options, pipelines, wino, f16Error } = await compileProgram(dev.device, dev.f16, async (o, pipeline, conv) => {
      const [first, conv1, convDense, conv5, conv5Last, body, up, rgb, rgbToBuffer, untransform, finalize] = await Promise.all([
        pipeline('rrdb-conv-first', convFirstWgsl(o, 'none')),
        conv('rrdb-conv1', { cout: 32, activation: 'lrelu', residual: 0, split: false }),
        conv('rrdb-conv-dense', { cout: 32, activation: 'lrelu', residual: 0, split: true }),
        conv('rrdb-conv5', { cout: 64, activation: 'none', residual: 1, split: true }),
        conv('rrdb-conv5-last', { cout: 64, activation: 'none', residual: 2, split: true }),
        conv('rrdb-conv-body', { cout: 64, activation: 'none', residual: 1, split: false }),
        conv('rrdb-conv-up', { cout: 64, activation: 'lrelu', residual: 0, split: false }),
        pipeline('rrdb-rgb-out', rgbOutWgsl(o, false)),
        pipeline('rrdb-rgb-out-buffer', rgbOutWgsl(o, true)),
        pipeline('rrdb-untransform', untransformWgsl()),
        pipeline('rrdb-finalize', finalizeWgsl()),
      ])
      return { first, conv1, convDense, conv5, conv5Last, body, up, rgb, rgbToBuffer, untransform, finalize }
    })
    return new RrdbUpscaler(dev, weights, options, pipelines, wino, f16Error)
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
    // Tail strips span the transformed band's width: the band's width, or its height when transposed.
    const maxW = Math.max(bw, rows)
    const u1 = this.storage('rrdb-u1', 16 * maxW * 2 * tailRows * 2 * q)
    const u2 = this.storage('rrdb-u2', 16 * maxW * 4 * tailRows * 4 * q)
    const u3 = this.storage('rrdb-u3', 16 * maxW * 4 * tailRows * 4 * q)
    const wFirst = this.weightsOf('conv_first')
    const firstEntries = (view: GPUTextureView): Array<[number, GPUBindingResource]> => [
      [0, view],
      [1, { buffer: wFirst.weight }],
      [2, { buffer: wFirst.bias }],
      [4, { buffer: f }],
      [5, { buffer: this.bandParams }],
      [6, { buffer: this.lp.first }],
    ]
    const first = bindGroup(device, 'rrdb-first', this.pipelines.first, firstEntries(this.textures!.view))
    const firstT = bindGroup(device, 'rrdb-first-t', this.pipelines.first, firstEntries(this.textures!.viewT))
    const band = this.bandParams
    const blocks: TrunkConv[][] = []
    let cur = 0
    for (let i = 0; i < (this.weights.header.numBlock ?? 0); i++) {
      const block: TrunkConv[] = []
      const input = cur
      for (let j = 1; j <= 3; j++) {
        const p = `body.${i}.rdb${j}`
        const xin = x[cur]!
        const xout = x[(cur + 1) % 4]!
        block.push({ inst: this.makeConv(this.pipelines.conv1, `${p}.conv1`, { src: xin, dst: scratch, band, lp: this.lp.conv1 }, { cin: 64, cout: 32 }), growth: 0 })
        for (const k of [2, 3, 4]) {
          const cin = 64 + 32 * (k - 1)
          block.push({
            inst: this.makeConv(this.pipelines.convDense, `${p}.conv${k}`, { src: xin, src1: g, dst: scratch, band, lp: this.lpDense.get(cin)! }, { cin, cout: 32, splitPlane: 16 }),
            growth: k - 1,
          })
        }
        if (j < 3) {
          block.push({
            inst: this.makeConv(this.pipelines.conv5, `${p}.conv5`, { src: xin, src1: g, dst: xout, res1: xin, band, lp: this.lp.conv5 }, { cin: 192, cout: 64, splitPlane: 16, res1Scale: 0.2 }),
          })
        } else {
          block.push({
            inst: this.makeConv(
              this.pipelines.conv5Last,
              `${p}.conv5`,
              { src: xin, src1: g, dst: xout, res1: x[input]!, res2: xin, band, lp: this.lp.conv5Last },
              { cin: 192, cout: 64, splitPlane: 16, res1Scale: 0.2, res2Scale: 0.2 },
            ),
          })
        }
        cur = (cur + 1) % 4
      }
      blocks.push(block)
    }
    const feat2 = x[(cur + 1) % 4]!
    const body: TrunkConv = { inst: this.makeConv(this.pipelines.body, 'conv_body', { src: x[cur]!, dst: feat2, res1: f, band, lp: this.lp.body }, { cin: 64, cout: 64, res1Scale: 1 }) }
    this.buffers = { bw, rows, x, g, s: scratch, f, feat2, u1, u2, u3, first, firstT, blocks, body, strips: [] }
    this.ensureStrips(Math.ceil((rows - 2 * CONTEXT) / TAIL_ROWS))
  }

  /** Tail strips (uniforms and bind groups) for at least `count` strips of the transformed core. */
  private ensureStrips(count: number): void {
    const buffers = this.buffers!
    for (let k = buffers.strips.length; k < count; k++) {
      const lpUp1 = this.layerUniform(`lp-up1-${k}`, { cin: 64, inScale: 2, srcY0: CONTEXT + k * TAIL_ROWS - TAIL_CONTEXT })
      buffers.strips.push({
        lpUp1,
        rgbParams: this.uniform(`rgb-${k}`, RGB_OUT_PARAMS_BYTES),
        // The strip's source offset is set per pass (transformed cores start at other rows).
        up1: this.makeConv(this.pipelines.up, 'conv_up1', { src: buffers.feat2, dst: buffers.u1, band: this.bandUp1, lp: lpUp1 }, { cin: 64, cout: 64, inScale: 2 }),
        up2: this.makeConv(this.pipelines.up, 'conv_up2', { src: buffers.u1, dst: buffers.u2, band: this.bandUp2, lp: this.lp.up2 }, { cin: 64, cout: 64, inScale: 2 }),
        hr: this.makeConv(this.pipelines.up, 'conv_hr', { src: buffers.u2, dst: buffers.u3, band: this.bandHr, lp: this.lp.hr }, { cin: 64, cout: 64 }),
      })
    }
  }

  protected beginRun(page: GPUBuffer, factor: EsrganFactor, passes: number, W: number, H: number): void {
    const buffers = this.buffers!
    const device = this.device
    const coreRows = Math.min(buffers.rows - 2 * CONTEXT, H)
    // Transposed passes walk the page's width as rows: as many strips as that needs.
    const swaps = ensembleTransforms(passes as EnsembleSize).some((t) => t.swap)
    this.ensureStrips(Math.max(Math.ceil(coreRows / TAIL_ROWS), swaps ? Math.ceil(W / TAIL_ROWS) : 0))
    const wLast = this.weightsOf('conv_last')
    let tout: GPUBuffer | null = null
    let acc: GPUBuffer | null = null
    if (passes > 1) {
      const bytes = W * factor * coreRows * factor * 16
      if (!this.ensembleBuffers || this.ensembleBuffers.bytes < bytes) {
        this.ensembleBuffers?.tout.destroy()
        this.ensembleBuffers?.acc.destroy()
        this.ensembleBuffers = { bytes, tout: this.storage('rrdb-ensemble-out', bytes), acc: this.storage('rrdb-ensemble-acc', bytes) }
      }
      tout = this.ensembleBuffers.tout
      acc = this.ensembleBuffers.acc
    }
    const rgbPipeline = tout ? this.pipelines.rgbToBuffer : this.pipelines.rgb
    this.run = {
      rgbGroups: buffers.strips.map((s, k) =>
        bindGroup(device, `rrdb-rgb-${k}`, rgbPipeline, [
          [0, { buffer: buffers.u3 }],
          [1, { buffer: wLast.weight }],
          [2, { buffer: wLast.bias }],
          [3, { buffer: tout ?? page }],
          [4, { buffer: s.rgbParams }],
        ]),
      ),
      untransformGroup:
        tout && acc
          ? bindGroup(device, 'rrdb-untransform', this.pipelines.untransform, [
              [0, { buffer: tout }],
              [1, { buffer: acc }],
              [2, { buffer: this.shuffleParams }],
            ])
          : null,
      finalizeGroup: acc
        ? bindGroup(device, 'rrdb-finalize', this.pipelines.finalize, [
            [0, { buffer: acc }],
            [1, { buffer: page }],
            [2, { buffer: this.shuffleParams }],
          ])
        : null,
    }
  }

  protected encodeBand(job: BandJob): GPUCommandBuffer[] {
    const device = this.device
    const buffers = this.buffers!
    const run = this.run!
    const { tw, th, rows, W, factor, outW, outH, y0, transform: t, pass, passes } = job
    const q = quadBytes(this.options)
    const planeBytes = tw * th * q
    const tailRows = TAIL_ROWS + 2 * TAIL_CONTEXT
    // The core in the transformed band: the tail walks its rows in strips.
    const core = transformedCore(t, t.swap ? th : tw, W, rows)
    device.queue.writeBuffer(this.bandParams, 0, new Uint32Array([tw, th, tw, th]))
    device.queue.writeBuffer(this.bandUp1, 0, new Uint32Array([tw * 2, tailRows * 2, tw, th]))
    device.queue.writeBuffer(this.bandUp2, 0, new Uint32Array([tw * 4, tailRows * 4, tw * 2, tailRows * 2]))
    device.queue.writeBuffer(this.bandHr, 0, new Uint32Array([tw * 4, tailRows * 4, tw * 4, tailRows * 4]))
    const stripCount = Math.ceil(core.h / TAIL_ROWS)
    for (let k = 0; k < stripCount; k++) {
      const strip = buffers.strips[k]!
      const stripY0 = core.y0 + k * TAIL_ROWS
      device.queue.writeBuffer(strip.lpUp1, 0, layerParams({ cin: 64, inScale: 2, srcY0: stripY0 - TAIL_CONTEXT }))
      device.queue.writeBuffer(
        strip.rgbParams,
        0,
        new Uint32Array([tw * 4, tailRows * 4, (stripY0 - TAIL_CONTEXT) * 4, core.x0 * 4, core.y0 * 4, core.w * 4, core.h * 4, stripY0 * 4, y0 * 4, outW, outH, factor]),
      )
    }
    if (passes > 1) {
      device.queue.writeBuffer(
        this.shuffleParams,
        0,
        new Uint32Array([tw, th, CONTEXT, W, y0, rows, outW, outH, factor, t.swap ? 1 : 0, t.flipX ? 1 : 0, t.flipY ? 1 : 0, pass === 0 ? 1 : 0, W * factor, passes, 0]),
      )
    }
    const commands: GPUCommandBuffer[] = []
    const trunkGeom: ConvGeometry = { bw: tw, bh: th, srcW: tw, srcH: th }
    const trunkDispatch = (encoder: GPUCommandEncoder, d: TrunkConv) => {
      const pass = encoder.beginComputePass()
      this.dispatchConv(pass, d.inst, trunkGeom)
      pass.end()
      if (d.growth !== undefined) encoder.copyBufferToBuffer(buffers.s, 0, buffers.g, d.growth * 8 * planeBytes, 8 * planeBytes)
    }
    // conv_first → F, then the first feature buffer starts as a copy of F.
    {
      const encoder = device.createCommandEncoder({ label: 'rrdb-first' })
      const pass = encoder.beginComputePass()
      pass.setPipeline(this.pipelines.first)
      pass.setBindGroup(0, t.swap ? buffers.firstT : buffers.first)
      pass.dispatchWorkgroups(Math.ceil(tw / 8), Math.ceil(th / 8))
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
    const rgbPipeline = passes > 1 ? this.pipelines.rgbToBuffer : this.pipelines.rgb
    for (let k0 = 0; k0 < stripCount; k0 += 4) {
      const encoder = device.createCommandEncoder({ label: `rrdb-tail-${k0}` })
      const pass = encoder.beginComputePass()
      for (let k = k0; k < Math.min(stripCount, k0 + 4); k++) {
        const strip = buffers.strips[k]!
        const stripY0 = core.y0 + k * TAIL_ROWS
        this.dispatchConv(pass, strip.up1, { bw: tw * 2, bh: tailRows * 2, srcW: tw, srcH: th }, { srcY0: stripY0 - TAIL_CONTEXT })
        this.dispatchConv(pass, strip.up2, { bw: tw * 4, bh: tailRows * 4, srcW: tw * 2, srcH: tailRows * 2 })
        this.dispatchConv(pass, strip.hr, { bw: tw * 4, bh: tailRows * 4, srcW: tw * 4, srcH: tailRows * 4 })
        pass.setPipeline(rgbPipeline)
        pass.setBindGroup(0, run.rgbGroups[k]!)
        pass.dispatchWorkgroups(Math.ceil((core.w * factor) / 8), Math.ceil((TAIL_ROWS * factor) / 8))
      }
      pass.end()
      commands.push(encoder.finish())
    }
    // Self-ensemble: put this pass back into the original orientation and accumulate; average on the last.
    if (passes > 1 && run.untransformGroup && run.finalizeGroup) {
      const encoder = device.createCommandEncoder({ label: 'rrdb-ensemble' })
      const computePass = encoder.beginComputePass()
      computePass.setPipeline(this.pipelines.untransform)
      computePass.setBindGroup(0, run.untransformGroup)
      computePass.dispatchWorkgroups(Math.ceil((W * factor) / 8), Math.ceil((rows * factor) / 8))
      if (pass === passes - 1) {
        computePass.setPipeline(this.pipelines.finalize)
        computePass.setBindGroup(0, run.finalizeGroup)
        computePass.dispatchWorkgroups(Math.ceil((W * factor) / 8), Math.ceil((rows * factor) / 8))
      }
      computePass.end()
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
    this.ensembleBuffers?.tout.destroy()
    this.ensembleBuffers?.acc.destroy()
    this.ensembleBuffers = null
  }

  dispose(): void {
    super.dispose()
    for (const buffer of Object.values(this.lp)) buffer.destroy()
    for (const buffer of this.lpDense.values()) buffer.destroy()
    this.bandUp1.destroy()
    this.bandUp2.destroy()
    this.bandHr.destroy()
    this.shuffleParams.destroy()
  }
}
