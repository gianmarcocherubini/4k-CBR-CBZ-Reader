/// <reference types="@webgpu/types" />
import type { Anime4KPipeline, Anime4KPipelineDescriptor } from 'anime4k-webgpu'
import type { PageSize } from '../../types'
import {
  type Anime4KLevel,
  type BackendInfo,
  COMPOSITE_WGSL,
  CORE,
  fitsLimits,
  OVERLAP,
  padForStrips,
  STRIP_ROWS,
  stripOutputRows,
  type UpscaleBackend,
  type UpscaleOptions,
  type UpscaleResult,
} from './backend'

export type { Anime4KLevel } from './backend'
export { LEVEL_COST, MAX_OUTPUT_PIXELS } from './backend'

type PipelineCtor = new (d: Anime4KPipelineDescriptor) => Anime4KPipeline

/** The 3.4 MB shader library is loaded on demand, only when a WebGPU device exists. */
type Anime4KModule = {
  CNNx2M: PipelineCtor
  CNNx2VL: PipelineCtor
  CNNx2UL: PipelineCtor
  CNNSoftM: PipelineCtor
  CNNSoftVL: PipelineCtor
}

interface StripPipeline {
  input: GPUTexture
  /** Restore (optional) then upscale; `pass()` is called on each in order. */
  pipelines: Anime4KPipeline[]
  /** Output of the last pipeline: 2W x 2*STRIP_ROWS, rgba16float. */
  output: GPUTexture
  bindGroup: GPUBindGroup
}

export type Anime4KInfo = BackendInfo

/**
 * Anime4K on WebGPU, processed in horizontal strips so a page needs tens of MB of GPU memory
 * instead of hundreds. One pipeline chain (and one set of rgba16float intermediates) per
 * (level, restore, page width) is built once and reused for every strip and page. Strips are
 * composited into the output at the requested size with 2x2 supersampling.
 */
export class Anime4KUpscaler implements UpscaleBackend {
  readonly kind = 'webgpu' as const
  readonly device: GPUDevice
  readonly info: Anime4KInfo
  private readonly lib: Anime4KModule
  private readonly compositePipeline: GPURenderPipeline
  private readonly compositeLayout: GPUBindGroupLayout
  private readonly sampler: GPUSampler
  private readonly paramsBuffer: GPUBuffer
  private readonly strips = new Map<string, StripPipeline>()
  private lost = false
  onLost: (() => void) | null = null

  private constructor(device: GPUDevice, info: Anime4KInfo, lib: Anime4KModule) {
    this.device = device
    this.info = info
    this.lib = lib
    const module = device.createShaderModule({ label: 'a4k-composite', code: COMPOSITE_WGSL })
    this.compositeLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    })
    this.compositePipeline = device.createRenderPipeline({
      label: 'a4k-composite',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.compositeLayout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    })
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' })
    this.paramsBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    void device.lost.then(() => {
      this.lost = true
      this.onLost?.()
    })
  }

  static async create(): Promise<Anime4KUpscaler | null> {
    if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) return null
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
      if (!adapter) return null
      const device = await adapter.requestDevice({
        requiredLimits: {
          maxTextureDimension2D: Math.min(8192, adapter.limits.maxTextureDimension2D),
          maxBufferSize: Math.min(1024 * 1024 * 1024, adapter.limits.maxBufferSize),
          maxStorageBufferBindingSize: Math.min(1024 * 1024 * 1024, adapter.limits.maxStorageBufferBindingSize),
        },
      })
      const adapterInfo = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info
      const name = adapterInfo ? [adapterInfo.vendor, adapterInfo.architecture, adapterInfo.description].filter(Boolean).join(' ') : 'WebGPU'
      const lib = (await import('anime4k-webgpu')) as unknown as Anime4KModule
      return new Anime4KUpscaler(device, { adapter: name || 'WebGPU', maxTextureDimension: device.limits.maxTextureDimension2D }, lib)
    } catch {
      return null
    }
  }

  get isLost(): boolean {
    return this.lost
  }

  canUpscale(size: PageSize): boolean {
    return fitsLimits(size, this.info.maxTextureDimension)
  }

  async prepare(level: Anime4KLevel, restore: boolean, width: number): Promise<boolean> {
    const key = `${level}:${restore ? 'r' : '-'}:${width}`
    if (this.strips.has(key)) return false
    this.strip(level, restore, width)
    return true
  }

  private strip(level: Anime4KLevel, restore: boolean, width: number): StripPipeline {
    const key = `${level}:${restore ? 'r' : '-'}:${width}`
    let s = this.strips.get(key)
    if (s) return s
    const input = this.device.createTexture({
      label: `a4k-input-${key}`,
      size: [width, STRIP_ROWS, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    const { CNNx2M, CNNx2VL, CNNx2UL, CNNSoftM, CNNSoftVL } = this.lib
    const pipelines: Anime4KPipeline[] = []
    let inputTexture: GPUTexture = input
    if (restore) {
      // Restore Soft: M for the M level, VL otherwise (there is no Soft UL in the library).
      const Restore = level === 'M' ? CNNSoftM : CNNSoftVL
      const r = new Restore({ device: this.device, inputTexture })
      pipelines.push(r)
      inputTexture = r.getOutputTexture()
    }
    const Upscale = level === 'M' ? CNNx2M : level === 'UL' ? CNNx2UL : CNNx2VL
    const up = new Upscale({ device: this.device, inputTexture })
    pipelines.push(up)
    const output = up.getOutputTexture()
    const bindGroup = this.device.createBindGroup({
      layout: this.compositeLayout,
      entries: [
        { binding: 0, resource: output.createView() },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.paramsBuffer } },
      ],
    })
    s = { input, pipelines, output, bindGroup }
    this.strips.set(key, s)
    return s
  }

  /**
   * Runs the network over `source` and composites the strips into an RGBA8 image of
   * `opts.target` pixels. The caller turns them into an ImageBitmap/canvas; keeping the GPU path
   * free of canvas contexts avoids device loss seen with WebGPU canvases on some drivers.
   */
  async upscale(source: ImageBitmap, opts: UpscaleOptions): Promise<UpscaleResult> {
    if (this.lost) throw new Error('WebGPU device lost')
    const W = source.width
    const H = source.height
    const { canvas: padded, strips: nStrips } = padForStrips(source)
    const outW = Math.max(1, Math.round(opts.target.w))
    const outH = Math.max(1, Math.round(opts.target.h))
    const scale = outW / W
    const exact = outW === W * 2 && outH === H * 2

    const device = this.device
    const s = this.strip(opts.level, opts.restore, W)
    const output = device.createTexture({
      label: 'a4k-output',
      size: [outW, outH, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    })
    const bytesPerRow = Math.ceil((outW * 4) / 256) * 256
    const readback = device.createBuffer({ size: bytesPerRow * outH, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
    try {
      // Queue operations execute in issue order, so copy → params → commands per strip can be
      // issued back to back without waiting: the next copy only lands after the previous strip ran.
      for (let k = 0; k < nStrips; k++) {
        const y0 = k * CORE // first source row covered by this strip's core
        const rows = stripOutputRows(k, H, scale, outH)
        if (rows.end <= rows.start) continue
        device.queue.copyExternalImageToTexture({ source: padded, origin: { x: 0, y: y0 } }, { texture: s.input }, [W, STRIP_ROWS])
        device.queue.writeBuffer(
          this.paramsBuffer,
          0,
          new Float32Array([scale, y0 - OVERLAP, exact ? 1 : 0, opts.clean ? 1 : 0, s.output.width, s.output.height, 0, 0]),
        )
        const encoder = device.createCommandEncoder()
        for (const p of s.pipelines) p.pass(encoder)
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: output.createView(), loadOp: k === 0 ? 'clear' : 'load', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        })
        pass.setPipeline(this.compositePipeline)
        pass.setBindGroup(0, s.bindGroup)
        pass.setScissorRect(0, rows.start, outW, rows.end - rows.start)
        pass.draw(3)
        pass.end()
        if (k === nStrips - 1) {
          encoder.copyTextureToBuffer({ texture: output }, { buffer: readback, bytesPerRow, rowsPerImage: outH }, [outW, outH])
        }
        device.queue.submit([encoder.finish()])
      }
      await readback.mapAsync(GPUMapMode.READ)
      const mapped = new Uint8Array(readback.getMappedRange())
      const data = new Uint8ClampedArray(new ArrayBuffer(outW * outH * 4))
      if (bytesPerRow === outW * 4) {
        data.set(mapped)
      } else {
        for (let y = 0; y < outH; y++) data.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + outW * 4), y * outW * 4)
      }
      readback.unmap()
      return { data, width: outW, height: outH }
    } finally {
      readback.destroy()
      output.destroy()
    }
  }

  dispose(): void {
    for (const s of this.strips.values()) s.input.destroy()
    this.strips.clear()
    this.paramsBuffer.destroy()
    this.device.destroy()
  }
}
