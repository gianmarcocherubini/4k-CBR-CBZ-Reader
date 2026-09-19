import type { PageSize } from '../../../types'
import { cacheBudgetBytes } from '../backend'
import type { SrResult } from '../srEngine'
import { EsrganAborted, type EsrganFactor, type EsrganInfo, EsrganUpscaler, workPixels } from './esrganUpscaler'
import weightsUrl from './realesr-animevideov3.f16.bin?url'
import { parseWeights, type SrvggWeights } from './weights'

export { EsrganAborted } from './esrganUpscaler'

/** Time not covered by the per-pixel cost: readback, bitmap creation, scheduling (ms per page). */
const FIXED_MS_PER_PAGE = 80
/** Probe image: one band of a typical page, enough work for a meaningful timing. */
const PROBE = { w: 256, h: 160 }
const REPROBE_INTERVAL_MS = 8000

function synthetic(w: number, h: number): ImageBitmap {
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, w, h)
  g.addColorStop(0, '#ffffff')
  g.addColorStop(1, '#202020')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#000'
  for (let i = 0; i < 12; i++) ctx.fillRect((i * 37) % w, (i * 53) % h, 3, h / 3)
  return canvas.transferToImageBitmap()
}

interface Task {
  key: string
  controller: AbortController
  promise: Promise<SrResult>
}

let weightsPromise: Promise<SrvggWeights> | null = null

/** The 1.2 MB weight file ships with the app (precached by the service worker); parsed once per session. */
function loadWeights(): Promise<SrvggWeights> {
  if (!weightsPromise) {
    weightsPromise = fetch(weightsUrl)
      .then(async (r) => {
        if (!r.ok) throw new Error(`Pesi del modello non disponibili (${r.status})`)
        return parseWeights(await r.arrayBuffer())
      })
      .catch((e: unknown) => {
        weightsPromise = null
        throw e
      })
  }
  return weightsPromise
}

/**
 * "Qualità massima": Real-ESRGAN (anime video v3) at x4 on WebGPU, for the pages on screen only.
 * Work is run one page at a time, anything no longer wanted is cancelled, results are kept in a
 * byte-bounded LRU. The throughput measured on this device (ms per processed megapixel) tells the
 * reader up front whether a spread fits the time budget.
 */
export class EsrganEngine {
  readonly upscaler: EsrganUpscaler
  readonly info: EsrganInfo
  /** EMA of the cost on this device, ms per megapixel of processed source (context included). */
  msPerWorkMegapixel: number | undefined
  onChange: (() => void) | null = null
  private readonly cache = new Map<string, SrResult>()
  private cacheBytes = 0
  private readonly budget = cacheBudgetBytes()
  private readonly tasks = new Map<string, Task>()
  private wanted = new Set<string>()
  private chain: Promise<unknown> = Promise.resolve()
  private disposed = false

  private constructor(upscaler: EsrganUpscaler) {
    this.upscaler = upscaler
    this.info = upscaler.info
    upscaler.onLost = () => {
      this.disposed = true
      this.onChange?.()
    }
  }

  /** Resolves null when WebGPU is absent; rejects with a readable message on any other failure. */
  static async create(): Promise<EsrganEngine | null> {
    const weights = await loadWeights()
    const upscaler = await EsrganUpscaler.create(weights)
    if (!upscaler) return null
    const engine = new EsrganEngine(upscaler)
    try {
      await engine.benchmark()
    } catch (e) {
      engine.dispose()
      throw e
    }
    return engine
  }

  /**
   * Warms the pipelines up on a tiny image (first-use compilation must not be measured), then times
   * one band-sized image so the first real page already has an estimate.
   */
  private async benchmark(): Promise<void> {
    const warm = synthetic(64, 64)
    try {
      await this.upscaler.upscale(warm, 4)
    } finally {
      warm.close()
    }
    await this.probe()
  }

  /** Times the probe image and folds the sample into the throughput estimate. */
  private async probe(): Promise<void> {
    const probe = synthetic(PROBE.w, PROBE.h)
    try {
      const t0 = performance.now()
      await this.upscaler.upscale(probe, 4)
      const ms = performance.now() - t0
      const sample = Math.max(0.01, ms - FIXED_MS_PER_PAGE / 4) / (workPixels(PROBE, this.upscaler.bytesPerPixel) / 1e6)
      this.msPerWorkMegapixel = this.msPerWorkMegapixel === undefined ? sample : this.msPerWorkMegapixel * 0.5 + sample * 0.5
      this.lastProbeAt = performance.now()
    } finally {
      probe.close()
    }
  }

  private lastProbeAt = 0
  private reprobing = false

  /**
   * Measures the GPU again (at most every few seconds, after any page in flight). Called when a
   * spread is skipped for time: a probe taken while another engine was busy must not lock the
   * whole session out of the model.
   */
  reprobe(): void {
    if (!this.available || this.reprobing || performance.now() - this.lastProbeAt < REPROBE_INTERVAL_MS) return
    this.reprobing = true
    const run = async () => {
      if (!this.available) return
      await this.probe()
      this.onChange?.()
    }
    const promise = this.chain.then(run, run).finally(() => {
      this.reprobing = false
    })
    this.chain = promise.catch(() => undefined)
  }

  get available(): boolean {
    return !this.disposed && !this.upscaler.isLost
  }

  factorFor(size: PageSize): EsrganFactor | null {
    return this.upscaler.canUpscale(size)
  }

  /** Predicted wall time for these pages, ms (undefined before the probe). */
  estimateMs(sizes: readonly PageSize[]): number | undefined {
    const rate = this.msPerWorkMegapixel
    if (rate === undefined) return undefined
    let ms = 0
    for (const size of sizes) ms += FIXED_MS_PER_PAGE + (rate * workPixels(size, this.upscaler.bytesPerPixel)) / 1e6
    return ms
  }

  peek(key: string): SrResult | undefined {
    const hit = this.cache.get(key)
    if (hit) {
      this.cache.delete(key)
      this.cache.set(key, hit)
    }
    return hit
  }

  /** Keys currently worth having (the visible spread); everything else in flight is cancelled. */
  setWanted(keys: Iterable<string>): void {
    this.wanted = new Set(keys)
    for (const [key, task] of this.tasks) if (!this.wanted.has(key)) task.controller.abort()
    this.evict()
  }

  /** Processes one page (serialised with the others); the same key in flight is shared. */
  enhance(key: string, size: PageSize, source: () => Promise<ImageBitmap>): Promise<SrResult> {
    if (!this.available) return Promise.reject(new Error('Real-ESRGAN non disponibile'))
    const hit = this.peek(key)
    if (hit) return Promise.resolve(hit)
    const existing = this.tasks.get(key)
    if (existing) return existing.promise
    const factor = this.factorFor(size)
    if (!factor) return Promise.reject(new Error(`Pagina ${size.w}×${size.h} troppo grande per Real-ESRGAN`))
    const controller = new AbortController()
    const run = async (): Promise<SrResult> => {
      if (controller.signal.aborted || !this.available) throw new EsrganAborted()
      const bitmap = await source()
      try {
        if (controller.signal.aborted) throw new EsrganAborted()
        const t0 = performance.now()
        const out = await this.upscaler.upscale(bitmap, factor, { signal: controller.signal })
        const result = await createImageBitmap(new ImageData(out.data, out.width, out.height))
        const ms = performance.now() - t0
        const sample = Math.max(0.01, ms - FIXED_MS_PER_PAGE) / (workPixels(size, this.upscaler.bytesPerPixel) / 1e6)
        this.msPerWorkMegapixel = this.msPerWorkMegapixel === undefined ? sample : this.msPerWorkMegapixel * 0.5 + sample * 0.5
        if (this.disposed) {
          result.close()
          throw new EsrganAborted()
        }
        const sr: SrResult = { bitmap: result, level: 'GAN', factor, ms }
        this.cache.set(key, sr)
        this.cacheBytes += result.width * result.height * 4
        this.evict()
        this.onChange?.()
        return sr
      } finally {
        bitmap.close()
      }
    }
    const promise = this.chain.then(run, run).finally(() => this.tasks.delete(key))
    this.chain = promise.catch(() => undefined)
    this.tasks.set(key, { key, controller, promise })
    return promise
  }

  /** LRU eviction by bytes; results still wanted are spared unless the cache is far over budget. */
  private evict(): void {
    for (const [key, r] of this.cache) {
      if (this.cacheBytes <= this.budget) break
      if (this.wanted.has(key) && this.cacheBytes <= this.budget * 1.5) continue
      this.cache.delete(key)
      this.cacheBytes -= r.bitmap.width * r.bitmap.height * 4
      r.bitmap.close()
    }
  }

  get cacheSizeBytes(): number {
    return this.cacheBytes
  }

  dispose(): void {
    this.disposed = true
    for (const task of this.tasks.values()) task.controller.abort()
    for (const r of this.cache.values()) r.bitmap.close()
    this.cache.clear()
    this.cacheBytes = 0
    this.upscaler.dispose()
  }
}
