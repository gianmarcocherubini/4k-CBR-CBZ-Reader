import type { MaxQualityModel, PageSize } from '../../../types'
import { cacheBudgetBytes } from '../backend'
import type { SrResult } from '../srEngine'
import { createUpscaler, EsrganAborted, type EsrganFactor, type EsrganInfo, type Upscaler } from './esrganUpscaler'
import type { ConvRows } from './wgsl'
import weightsUrl6b from './realesrgan-x4plus-anime-6b.f16.bin?url'
import weightsUrlV3 from './realesr-animevideov3.f16.bin?url'
import type { EnsembleSize } from './transforms'
import { type ModelWeights, parseWeights } from './weights'

export { EsrganAborted } from './esrganUpscaler'
export type { EnsembleSize } from './transforms'

/** Time not covered by the per-pixel cost: readback, bitmap creation, scheduling (ms per page). */
const FIXED_MS_PER_PAGE = 80
/** Each extra ensemble pass also redraws and re-uploads the band: a little more than its GPU time. */
const ENSEMBLE_PASS_OVERHEAD = 1.06
export const ENSEMBLE_SIZES: readonly EnsembleSize[] = [8, 4, 2, 1]
/** Probe image: one band of a typical page, enough work for a meaningful timing. */
const PROBE = { w: 256, h: 160 }
const REPROBE_INTERVAL_MS = 8000
/** Evicted bitmaps are closed a little later: React may still be painting them. */
const CLOSE_DELAY_MS = 1200

export interface ModelInfo {
  id: MaxQualityModel
  /** Short name for the settings and the badge. */
  label: string
  url: string
  /** Weight file size, for the download message. */
  megabytes: number
  /**
   * Whether the self-ensemble is offered for this network. The GPU runner supports it for both;
   * the 6B costs seconds per pass, so averaging passes would mean a minute per page.
   */
  ensemble: boolean
}

export const MODELS: Record<MaxQualityModel, ModelInfo> = {
  v3: { id: 'v3', label: 'Real-ESRGAN anime v3', url: weightsUrlV3, megabytes: 1.2, ensemble: true },
  '6b': { id: '6b', label: 'Real-ESRGAN x4plus anime 6B', url: weightsUrl6b, megabytes: 8.9, ensemble: false },
}

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

const weightsPromises = new Map<MaxQualityModel, Promise<ModelWeights>>()

/**
 * Weight files ship with the app: the small one is precached by the service worker, the 6B one is
 * fetched (and runtime-cached) the first time that model is selected. Parsed once per session.
 */
export function loadWeights(model: MaxQualityModel): Promise<ModelWeights> {
  let promise = weightsPromises.get(model)
  if (!promise) {
    promise = fetch(MODELS[model].url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`Pesi del modello non disponibili (${r.status})`)
        return parseWeights(await r.arrayBuffer())
      })
      .catch((e: unknown) => {
        weightsPromises.delete(model)
        throw e
      })
    weightsPromises.set(model, promise)
  }
  return promise
}

/**
 * "Qualità massima": Real-ESRGAN at x4 on WebGPU, for the pages on screen only. Work is run one
 * page at a time, anything no longer wanted is cancelled, results are kept in a byte-bounded LRU.
 * The throughput measured on this device (ms per processed megapixel) tells the reader up front
 * whether a spread fits the time budget and how many self-ensemble passes it can afford.
 */
export class EsrganEngine {
  readonly model: ModelInfo
  readonly upscaler: Upscaler
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
  private readonly pendingCloses = new Set<ReturnType<typeof setTimeout>>()
  private lastProbeAt = 0
  private reprobing = false
  private disposed = false

  private constructor(model: ModelInfo, upscaler: Upscaler) {
    this.model = model
    this.upscaler = upscaler
    this.info = upscaler.info
    upscaler.onLost = () => {
      this.disposed = true
      this.onChange?.()
    }
  }

  /** Resolves null when WebGPU is absent; rejects with a readable message on any other failure. */
  static async create(model: MaxQualityModel, onStatus?: (message: string) => void): Promise<EsrganEngine | null> {
    onStatus?.(`Caricamento dei pesi (${MODELS[model].megabytes.toLocaleString('it-IT')} MB)…`)
    const weights = await loadWeights(model)
    onStatus?.('Compilazione degli shader…')
    const upscaler = await createUpscaler(weights)
    if (!upscaler) return null
    const engine = new EsrganEngine(MODELS[model], upscaler)
    try {
      onStatus?.('Misura della GPU…')
      await engine.benchmark()
    } catch (e) {
      engine.dispose()
      throw e
    }
    return engine
  }

  /** Whether the self-ensemble is available: the runner must support it and the model must be cheap enough per pass. */
  get supportsEnsemble(): boolean {
    return this.upscaler.supportsEnsemble && this.model.ensemble
  }

  /** Convolution kernel variant the benchmark selected (output rows per thread). */
  get kernelVariant(): ConvRows {
    return this.upscaler.variant
  }

  /**
   * Picks the convolution kernel variant for this GPU and seeds the throughput estimate: each
   * variant is warmed up on a tiny image (first-use compilation must not be measured) and timed on
   * one band-sized image; the fastest stays. All variants compute the same numbers.
   */
  private async benchmark(): Promise<void> {
    let best: { variant: ConvRows; ms: number } | undefined
    for (const variant of this.upscaler.variants) {
      this.upscaler.variant = variant
      const warm = synthetic(64, 64)
      try {
        await this.upscaler.upscale(warm, 4)
      } finally {
        warm.close()
      }
      const ms = await this.timeProbe()
      if (!best || ms < best.ms) best = { variant, ms }
    }
    if (best) {
      this.upscaler.variant = best.variant
      this.observeProbe(best.ms)
    }
  }

  /** Wall time of the probe image, ms. */
  private async timeProbe(): Promise<number> {
    const probe = synthetic(PROBE.w, PROBE.h)
    try {
      const t0 = performance.now()
      await this.upscaler.upscale(probe, 4)
      return performance.now() - t0
    } finally {
      probe.close()
    }
  }

  private observeProbe(ms: number): void {
    const sample = Math.max(0.01, ms - FIXED_MS_PER_PAGE / 4) / (this.upscaler.workPixels(PROBE) / 1e6)
    this.msPerWorkMegapixel = this.msPerWorkMegapixel === undefined ? sample : this.msPerWorkMegapixel * 0.5 + sample * 0.5
    this.lastProbeAt = performance.now()
  }

  /** Times the probe image and folds the sample into the throughput estimate. */
  private async probe(): Promise<void> {
    this.observeProbe(await this.timeProbe())
  }

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

  /** Predicted wall time for these pages with an ensemble of `ensemble` passes, ms (undefined before the probe). */
  estimateMs(sizes: readonly PageSize[], ensemble: EnsembleSize = 1): number | undefined {
    const rate = this.msPerWorkMegapixel
    if (rate === undefined) return undefined
    const passes = ensemble === 1 || !this.supportsEnsemble ? 1 : ensemble * ENSEMBLE_PASS_OVERHEAD
    let ms = 0
    for (const size of sizes) ms += FIXED_MS_PER_PAGE + (rate * this.upscaler.workPixels(size) * passes) / 1e6
    return ms
  }

  /** The largest ensemble whose predicted time for these pages fits `budgetMs` (1 when none does). */
  ensembleFor(sizes: readonly PageSize[], budgetMs: number): EnsembleSize {
    if (!this.supportsEnsemble) return 1
    for (const n of ENSEMBLE_SIZES) {
      const est = this.estimateMs(sizes, n)
      if (est !== undefined && est <= budgetMs) return n
    }
    return 1
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

  /**
   * Processes one page (serialised with the others); the same key in flight is shared, and a cached
   * result is returned whatever ensemble it was computed with (a page already on screen is never
   * redone because the budget moved).
   */
  enhance(key: string, size: PageSize, source: () => Promise<ImageBitmap>, ensemble: EnsembleSize = 1): Promise<SrResult> {
    if (!this.available) return Promise.reject(new Error('Real-ESRGAN non disponibile'))
    const hit = this.peek(key)
    if (hit) return Promise.resolve(hit)
    const existing = this.tasks.get(key)
    if (existing) return existing.promise
    const factor = this.factorFor(size)
    if (!factor) return Promise.reject(new Error(`Pagina ${size.w}×${size.h} troppo grande per Real-ESRGAN`))
    const controller = new AbortController()
    const passes = this.supportsEnsemble ? ensemble : 1
    const run = async (): Promise<SrResult> => {
      if (controller.signal.aborted || !this.available) throw new EsrganAborted()
      const bitmap = await source()
      try {
        if (controller.signal.aborted) throw new EsrganAborted()
        const t0 = performance.now()
        const out = await this.upscaler.upscale(bitmap, factor, { signal: controller.signal, ensemble: passes })
        const result = await createImageBitmap(new ImageData(out.data, out.width, out.height))
        const ms = performance.now() - t0
        const passCost = passes === 1 ? 1 : passes * ENSEMBLE_PASS_OVERHEAD
        const sample = Math.max(0.01, ms - FIXED_MS_PER_PAGE) / ((this.upscaler.workPixels(size) * passCost) / 1e6)
        this.msPerWorkMegapixel = this.msPerWorkMegapixel === undefined ? sample : this.msPerWorkMegapixel * 0.5 + sample * 0.5
        if (this.disposed) {
          result.close()
          throw new EsrganAborted()
        }
        const sr: SrResult = { bitmap: result, level: 'GAN', factor, ms, ensemble: passes }
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

  /** LRU eviction by bytes; results of the pages on screen are never evicted. */
  private evict(): void {
    for (const [key, r] of this.cache) {
      if (this.cacheBytes <= this.budget) break
      if (this.wanted.has(key)) continue
      this.cache.delete(key)
      this.cacheBytes -= r.bitmap.width * r.bitmap.height * 4
      this.closeLater(r.bitmap)
    }
  }

  /** The view (or the ghost of a page turn) may still paint an evicted bitmap for a moment. */
  private closeLater(bitmap: ImageBitmap): void {
    const timer = setTimeout(() => {
      this.pendingCloses.delete(timer)
      bitmap.close()
    }, CLOSE_DELAY_MS)
    this.pendingCloses.add(timer)
  }

  get cacheSizeBytes(): number {
    return this.cacheBytes
  }

  dispose(): void {
    this.disposed = true
    for (const task of this.tasks.values()) task.controller.abort()
    for (const timer of this.pendingCloses) clearTimeout(timer)
    this.pendingCloses.clear()
    const bitmaps = [...this.cache.values()].map((r) => r.bitmap)
    setTimeout(() => {
      for (const b of bitmaps) b.close()
    }, CLOSE_DELAY_MS)
    this.cache.clear()
    this.cacheBytes = 0
    this.upscaler.dispose()
  }
}
