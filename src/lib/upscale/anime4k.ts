/// <reference types="@webgpu/types" />
import type { Anime4KPipeline, Anime4KPipelineDescriptor } from 'anime4k-webgpu'
import type { PageSize } from '../../types'
import {
  type Anime4KLevel,
  type BackendInfo,
  CORE,
  fitsLimits,
  OVERLAP,
  padForStrips,
  STRIP_ROWS,
  type UpscaleBackend,
  type UpscaleResult,
} from './backend'

export type { Anime4KLevel } from './backend'
export { LEVEL_COST, MAX_OUTPUT_PIXELS } from './backend'

/** The 3.4 MB shader library is loaded on demand, only when a WebGPU device exists. */
type Anime4KModule = {
  CNNx2M: new (d: Anime4KPipelineDescriptor) => Anime4KPipeline
  CNNx2VL: new (d: Anime4KPipelineDescriptor) => Anime4KPipeline
  CNNx2UL: new (d: Anime4KPipelineDescriptor) => Anime4KPipeline
}

const BLIT_WGSL = /* wgsl */ `
struct Params { offsetY: i32, pad0: i32, pad1: i32, pad2: i32 }
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: Params;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = vec2i(i32(pos.x), i32(pos.y) - params.offsetY);
  let c = textureLoad(src, p, 0);
  return vec4f(clamp(c.rgb, vec3f(0.0), vec3f(1.0)), 1.0);
}
`

interface StripPipeline {
  input: GPUTexture
  pipeline: Anime4KPipeline
  bindGroup: GPUBindGroup
}

export type Anime4KInfo = BackendInfo

/**
 * Anime4K Upscale_CNN_x2 on WebGPU, processed in horizontal strips so a page needs tens of MB
 * of GPU memory instead of hundreds. One pipeline (and one set of rgba16float intermediates)
 * per (level, page width) is built once and reused for every strip and page.
 */
export class Anime4KUpscaler implements UpscaleBackend {
  readonly kind = 'webgpu' as const
  readonly device: GPUDevice
  readonly info: Anime4KInfo
  private readonly lib: Anime4KModule
  private readonly blitPipeline: GPURenderPipeline
  private readonly blitLayout: GPUBindGroupLayout
  private readonly paramsBuffer: GPUBuffer
  private readonly strips = new Map<string, StripPipeline>()
  private lost = false
  onLost: (() => void) | null = null

  private constructor(device: GPUDevice, info: Anime4KInfo, lib: Anime4KModule) {
    this.device = device
    this.info = info
    this.lib = lib
    const module = device.createShaderModule({ label: 'a4k-blit', code: BLIT_WGSL })
    this.blitLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    })
    this.blitPipeline = device.createRenderPipeline({
      label: 'a4k-blit',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.blitLayout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    })
    this.paramsBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
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

  /** Whether a page of this size can be upscaled 2x within canvas/texture limits. */
  canUpscale(size: PageSize): boolean {
    return fitsLimits(size, this.info.maxTextureDimension)
  }

  /** Builds the pipeline for (level, width) if needed. Resolves true when it had to be built (shader compile). */
  async prepare(level: Anime4KLevel, width: number): Promise<boolean> {
    const key = `${level}:${width}`
    if (this.strips.has(key)) return false
    this.strip(level, width)
    return true
  }

  private strip(level: Anime4KLevel, width: number): StripPipeline {
    const key = `${level}:${width}`
    let s = this.strips.get(key)
    if (s) return s
    const input = this.device.createTexture({
      label: `a4k-input-${key}`,
      size: [width, STRIP_ROWS, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    const desc = { device: this.device, inputTexture: input }
    const { CNNx2M, CNNx2VL, CNNx2UL } = this.lib
    const pipeline: Anime4KPipeline = level === 'M' ? new CNNx2M(desc) : level === 'UL' ? new CNNx2UL(desc) : new CNNx2VL(desc)
    const bindGroup = this.device.createBindGroup({
      layout: this.blitLayout,
      entries: [
        { binding: 0, resource: pipeline.getOutputTexture().createView() },
        { binding: 1, resource: { buffer: this.paramsBuffer } },
      ],
    })
    s = { input, pipeline, bindGroup }
    this.strips.set(key, s)
    return s
  }

  /**
   * Upscales `source` 2x. Returns RGBA8 pixels of size (2w, 2h). The caller turns them into an
   * ImageBitmap/canvas; keeping the GPU path free of canvas contexts avoids device loss seen
   * with WebGPU canvases on some drivers.
   */
  async upscale(source: ImageBitmap, level: Anime4KLevel): Promise<UpscaleResult> {
    if (this.lost) throw new Error('WebGPU device lost')
    const W = source.width
    const H = source.height
    const { canvas: padded, strips: nStrips } = padForStrips(source)

    const device = this.device
    const s = this.strip(level, W)
    const outW = W * 2
    const outH = H * 2
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
        device.queue.copyExternalImageToTexture({ source: padded, origin: { x: 0, y: y0 } }, { texture: s.input }, [W, STRIP_ROWS])
        // Strip output row r corresponds to padded row y0 + r/2; output row = 2*(y0 - OVERLAP) + r.
        device.queue.writeBuffer(this.paramsBuffer, 0, new Int32Array([2 * (y0 - OVERLAP), 0, 0, 0]))
        const encoder = device.createCommandEncoder()
        s.pipeline.pass(encoder)
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: output.createView(), loadOp: k === 0 ? 'clear' : 'load', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        })
        pass.setPipeline(this.blitPipeline)
        pass.setBindGroup(0, s.bindGroup)
        const validStart = 2 * y0
        const validEnd = Math.min(outH, 2 * (y0 + CORE))
        pass.setScissorRect(0, validStart, outW, validEnd - validStart)
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
