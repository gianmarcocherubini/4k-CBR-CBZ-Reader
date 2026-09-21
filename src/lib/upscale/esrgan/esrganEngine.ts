import type { MaxQualityModel, PageSize } from '../../../types'
import { cacheBudgetBytes } from '../backend'
import type { SrResult } from '../srEngine'
import { createUpscaler, EsrganAborted, type EsrganFactor, type EsrganInfo, type Upscaler } from './esrganUpscaler'
import type { ConvVariant } from './wgsl'
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
/** Winograd is kept only when its probe output matches the direct kernel this closely (8-bit). */
const WINOGRAD_MIN_PSNR = 44
const WINOGRAD_MAX_DIFF = 4

/** Winograd probe against the direct 4×1 kernel (PSNR, largest 8-bit difference), whether it passed the quality gate, and both probe times, ms. */
export interface WinogradCheck {
  psnr: number
  maxDiff: number
  passed: boolean
  ms: number
  directMs: number
}

/**
 * The kernel benchmark's outcome, remembered per device, model, precision and app version
 * (localStorage): later sessions probe only the chosen kernel instead of warming and timing all
 * three (and transforming the Winograd weights) at every activation. A new app version, whose
 * kernels may differ, benchmarks again.
 */
interface KernelChoice {
  variant: ConvVariant
  check?: WinogradCheck
}
const KERNEL_CACHE_KEY = 'reader.esrgan-kernel.v1'
const KERNEL_CACHE_MAX = 12
const appVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'

function kernelCacheId(model: MaxQualityModel, info: EsrganInfo): string {
  return `${appVersion}|${model}|${info.adapter}|${info.precision}`
}

function readKernelCache(): Record<string, KernelChoice> {
  try {
    const raw = localStorage.getItem(KERNEL_CACHE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, KernelChoice>) : {}
  } catch {
    return {}
  }
}

function loadKernelChoice(id: string): KernelChoice | undefined {
  const choice = readKernelCache()[id]
  if (!choice || !(choice.variant === 1 || choice.variant === 2 || choice.variant === 'w')) return undefined
  if (choice.check && typeof choice.check.passed !== 'boolean') return undefined
  return choice
}

function saveKernelChoice(id: string, choice: KernelChoice): void {
  try {
    const cache = readKernelCache()
    delete cache[id]
    const kept = Object.entries(cache).slice(-(KERNEL_CACHE_MAX - 1))
    localStorage.setItem(KERNEL_CACHE_KEY, JSON.stringify(Object.fromEntries([...kept, [id, choice]])))
  } catch {
    // Private mode / quota: the benchmark simply runs again next time.
  }
}

function compareRgba(a: Uint8ClampedArray, b: Uint8ClampedArray): { psnr: number; maxDiff: number } {
  let se = 0
  let maxDiff = 0
  let n = 0
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[i + c]! - b[i + c]!)
      se += d * d
      if (d > maxDiff) maxDiff = d
      n++
    }
  }
  const mse = se / Math.max(1, n)
  return { psnr: mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse), maxDiff }
}

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

  /** Convolution kernel the benchmark selected. */
  get kernelVariant(): ConvVariant {
    return this.upscaler.variant
  }

  /** Short name of the selected kernel for the status line. */
  get kernelLabel(): string {
    return this.upscaler.variant === 'w' ? 'Winograd' : `4×${this.upscaler.variant}`
  }

  /**
   * Picks the convolution kernel for this GPU and seeds the throughput estimate: each kernel is
   * warmed up on a tiny image (first-use compilation must not be measured) and timed on one
   * band-sized image; the fastest stays. The direct variants compute identical numbers; Winograd
   * goes through transforms whose f16 rounding differs, so it is kept only when its probe output
   * matches the direct one within a visually irrelevant margin. The outcome is remembered for
   * this device and app version; later sessions probe the chosen kernel only.
   */
  private async benchmark(): Promise<void> {
    const id = kernelCacheId(this.model.id, this.info)
    const remembered = loadKernelChoice(id)
    if (remembered) {
      this.upscaler.variant = remembered.variant
      this.winogradCheck = remembered.check
      if (remembered.variant !== 'w') this.upscaler.releaseWinograd()
      await this.warm()
      this.observeProbe((await this.timeProbe()).ms)
      return
    }
    let best: { variant: ConvVariant; ms: number } | undefined
    let direct: { ms: number; data: Uint8ClampedArray } | undefined
    for (const variant of this.upscaler.variants) {
      this.upscaler.variant = variant
      await this.warm()
      const probe = await this.timeProbe()
      if (variant === 1) direct = probe
      if (variant === 'w' && direct) {
        const { psnr, maxDiff } = compareRgba(direct.data, probe.data)
        const passed = psnr >= WINOGRAD_MIN_PSNR && maxDiff <= WINOGRAD_MAX_DIFF
        this.winogradCheck = { psnr, maxDiff, passed, ms: probe.ms, directMs: direct.ms }
        if (!passed) continue
      }
      if (!best || probe.ms < best.ms) best = { variant, ms: probe.ms }
    }
    if (best) {
      this.upscaler.variant = best.variant
      this.observeProbe(best.ms)
    }
    if (this.upscaler.variant !== 'w') this.upscaler.releaseWinograd()
    saveKernelChoice(id, { variant: this.upscaler.variant, ...(this.winogradCheck ? { check: this.winogradCheck } : {}) })
  }

  /** One tiny run so first-use pipeline compilation never lands in a timing. */
  private async warm(): Promise<void> {
    const warm = synthetic(64, 64)
    try {
      await this.upscaler.upscale(warm, 4)
    } finally {
      warm.close()
    }
  }

  /** Winograd probe against the direct kernel; undefined when it was never tried on this device. */
  winogradCheck: WinogradCheck | undefined

  /** Wall time of the probe image, ms, and its pixels. */
  private async timeProbe(): Promise<{ ms: number; data: Uint8ClampedArray }> {
    const probe = synthetic(PROBE.w, PROBE.h)
    try {
      const t0 = performance.now()
      const out = await this.upscaler.upscale(probe, 4)
      return { ms: performance.now() - t0, data: out.data }
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
    this.observeProbe((await this.timeProbe()).ms)
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
