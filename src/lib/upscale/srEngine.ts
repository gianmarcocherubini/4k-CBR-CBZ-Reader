import type { PageSize, SrLevel, SrScale } from '../../types'
import { Anime4KUpscaler } from './anime4k'
import { type Anime4KLevel, cacheBudgetBytes, LEVEL_COST, MAX_OUTPUT_PIXELS, RESTORE_COST, type Size, type UpscaleBackend } from './backend'
import { WebGL2Backend } from './webgl2Backend'

export type SrBackendPreference = 'auto' | 'webgpu' | 'webgl2'

export interface SrResult {
  bitmap: ImageBitmap
  level: Anime4KLevel | 'GAN'
  /** Upscale factor applied by the network (2 or 4) before resampling to the target. */
  factor: number
  /** Wall time of the GPU passes + readback, ms. */
  ms: number
  /** The Anime4K plan this result was computed with (absent for Real-ESRGAN results). */
  plan?: SrPlan
  /** Real-ESRGAN: number of self-ensemble passes averaged into this result. */
  ensemble?: number
}

export interface SrOptions {
  level: SrLevel
  scale: SrScale
  restore: boolean
  clean: boolean
}

/** What will be done for one page: the network passes and the output size. */
export interface SrPlan {
  level: Anime4KLevel
  /** 1 = x2, 2 = x4 (second pass at level M, as Anime4K recommends). */
  passes: 1 | 2
  restore: boolean
  clean: boolean
  /** Output size: the factor times the source, unless capped by texture/canvas limits. */
  target: Size
}

/** 'too-big': the page does not fit the strip pipeline of this GPU even at 2x. */
export type SrDecision = SrPlan | 'too-big'

interface Task {
  key: string
  index: number
  promise: Promise<SrResult>
}

/**
 * Budget per page for the automatic level (ms). A spread of two pages plus the fit must stay well
 * under two seconds, so the strongest level that fits here is chosen.
 */
const AUTO_BUDGET_MS = 800
/** A page slower than this (× budget) at the automatic level makes the level step down. */
const AUTO_DOWNGRADE_FACTOR = 1.5
/**
 * Evicted bitmaps are closed a little later: React may still be painting them (or the ghost of a
 * page turn). A closed ImageBitmap paints nothing, which is what a page going blank looks like.
 */
const CLOSE_DELAY_MS = 1200

/** Bytes of an RGBA bitmap. */
const bytesOf = (b: { width: number; height: number }) => b.width * b.height * 4

export class SrAborted extends Error {
  constructor() {
    super('aborted')
    this.name = 'SrAborted'
  }
}

/** Relative cost of a plan, in units of "Upscale VL over one megapixel". */
export function planUnits(level: Anime4KLevel, restore: boolean, passes: 1 | 2): number {
  return LEVEL_COST[level] + (restore ? RESTORE_COST[level] : 0) + (passes === 2 ? 4 * LEVEL_COST.M : 0)
}

/**
 * Runs Anime4K on the GPU for the pages on screen, one at a time, keeps an LRU of enhanced bitmaps
 * and picks the automatic level from measured throughput. There is no read-ahead and no queue:
 * the reader asks for the visible pages and cancels whatever left the screen.
 *
 * The output is always a fixed factor of the source (x2 or x4), never the size of the screen:
 * the view fits the result into its box afterwards. One result per page therefore serves every
 * zoom level, orientation and layout, and downsampling a x4 result is what gives clean lines.
 *
 * The automatic level is decided once, from the first measured page, and afterwards can only
 * step down (a page far over budget). A page that already has a result under the current settings
 * is never enhanced again because the level moved: re-deciding after every timing sample made the
 * level flip around the budget threshold, and every flip re-enhanced the visible pages while the
 * LRU closed the bitmaps still on screen — pages and the HD badge blinked on and off.
 */
export class SrEngine {
  readonly upscaler: UpscaleBackend
  private readonly cache = new Map<string, SrResult>()
  private cacheBytes = 0
  private readonly budget = cacheBudgetBytes()
  private readonly tasks = new Map<string, Task>()
  private chain: Promise<unknown> = Promise.resolve()
  private wanted = new Set<number>()
  private options: SrOptions = { level: 'auto', scale: 'auto', restore: false, clean: false }
  /** EMA of ms per (megapixel × plan unit). */
  private msPerUnit: number | undefined
  /** Level chosen by `auto` after the probe page; undefined until then. */
  private autoLevel: Anime4KLevel | undefined
  /** Size (megapixels) and passes of the last measured page, for re-selecting the level on option changes. */
  private lastMp = 1
  private lastPasses: 1 | 2 = 2
  private readonly pendingCloses = new Set<ReturnType<typeof setTimeout>>()
  private disposed = false
  onChange: (() => void) | null = null

  private constructor(upscaler: UpscaleBackend) {
    this.upscaler = upscaler
    upscaler.onLost = () => {
      this.disposed = true
      this.onChange?.()
    }
  }

  /** An engine over a given backend (tests inject a fake one). */
  static withBackend(upscaler: UpscaleBackend): SrEngine {
    return new SrEngine(upscaler)
  }

  /** WebGPU when available (iPadOS 26+), otherwise the WebGL2 runner of the same shaders. */
  static async create(prefer: SrBackendPreference = 'auto'): Promise<SrEngine | null> {
    let backend: UpscaleBackend | null = null
    if (prefer !== 'webgl2') backend = await Anime4KUpscaler.create()
    // Explicitly requested WebGL2 (?sr=webgl2) may run on a software renderer, for testing.
    if (!backend && prefer !== 'webgpu') backend = await WebGL2Backend.create(prefer === 'webgl2')
    return backend ? new SrEngine(backend) : null
  }

  get available(): boolean {
    return !this.disposed && !this.upscaler.isLost
  }

  get backend(): 'webgpu' | 'webgl2' {
    return this.upscaler.kind
  }

  get adapterName(): string {
    return this.upscaler.info.adapter
  }

  setOptions(next: SrOptions): void {
    const o = this.options
    if (o.level === next.level && o.scale === next.scale && o.restore === next.restore && o.clean === next.clean) return
    this.options = { ...next }
    // New settings change the cost per page: re-select the automatic level from the throughput
    // already measured (no new probe); before any measurement the next page probes as usual.
    if (o.scale !== next.scale || o.restore !== next.restore) this.autoLevel = this.select(next.restore, this.passesFor(next.scale))
    this.onChange?.()
  }

  /** Passes the current scale setting implies (auto: whatever the last page needed). */
  private passesFor(scale: SrScale): 1 | 2 {
    return scale === 'x2' ? 1 : scale === 'x4' ? 2 : this.lastPasses
  }

  /** Strongest level whose estimated time for a page like the last one fits the budget. */
  private select(restore: boolean, passes: 1 | 2): Anime4KLevel | undefined {
    if (this.msPerUnit === undefined) return undefined
    const order: Anime4KLevel[] = ['M', 'VL', 'UL']
    let best: Anime4KLevel = 'M'
    for (const l of order) if (this.msPerUnit * planUnits(l, restore, passes) * this.lastMp <= AUTO_BUDGET_MS) best = l
    return best
  }

  /** The level `auto` currently stands for (undefined before the first measured page). */
  get currentAutoLevel(): Anime4KLevel | undefined {
    return this.autoLevel
  }

  /** Maximum level allowed by device memory (rough jetsam guard). */
  private memoryCap(): Anime4KLevel {
    const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
    if (mem !== undefined && mem <= 2) return 'M'
    if (mem !== undefined && mem <= 4) return 'VL'
    return 'UL'
  }

  /**
   * Level for a page under the current options: the manual one, the sticky automatic one, or VL
   * for the probe page (M on small-memory devices). `size` is unused: the automatic level is a
   * property of the device, not of the page, so consecutive pages look the same.
   */
  resolveLevel(_size?: PageSize, _passes: 1 | 2 = 1): Anime4KLevel {
    const cap = this.memoryCap()
    const order: Anime4KLevel[] = ['M', 'VL', 'UL']
    const capIdx = order.indexOf(cap)
    const { level } = this.options
    if (level !== 'auto') return order[Math.min(order.indexOf(level), capIdx)]!
    if (this.autoLevel !== undefined) return order[Math.min(order.indexOf(this.autoLevel), capIdx)]!
    return capIdx >= 1 ? 'VL' : 'M' // probe with VL first
  }

  /**
   * Folds one measured page into the throughput estimate and settles the automatic level: chosen
   * once from the probe (the strongest level within the budget for that page), stepped down when a
   * page at that level ran far over budget, never stepped up again in this session.
   */
  private observe(plan: SrPlan, mp: number, ms: number): void {
    const sample = ms / (mp * planUnits(plan.level, plan.restore, plan.passes))
    this.msPerUnit = this.msPerUnit === undefined ? sample : this.msPerUnit * 0.6 + sample * 0.4
    this.lastMp = mp
    this.lastPasses = plan.passes
    if (this.options.level !== 'auto') return
    if (this.autoLevel === undefined) {
      this.autoLevel = this.select(plan.restore, plan.passes)
      return
    }
    const order: Anime4KLevel[] = ['M', 'VL', 'UL']
    const idx = order.indexOf(this.autoLevel)
    if (plan.level === this.autoLevel && idx > 0 && ms > AUTO_BUDGET_MS * AUTO_DOWNGRADE_FACTOR) this.autoLevel = order[idx - 1]!
  }

  /** Measured cost estimate for the UI, ms per page (undefined before the probe). */
  estimateMs(size: PageSize): number | undefined {
    if (this.msPerUnit === undefined) return undefined
    const plan = this.plan(size)
    const passes = typeof plan !== 'string' ? plan.passes : 1
    const level = typeof plan !== 'string' ? plan.level : this.resolveLevel(size)
    return this.msPerUnit * planUnits(level, this.options.restore, passes) * ((size.w * size.h) / 1e6)
  }

  /** Whether a x4 result of this page fits the canvas limit, the GPU textures and the memory budget. */
  private x4Fits(size: PageSize): boolean {
    const px = size.w * size.h * 16
    return px <= MAX_OUTPUT_PIXELS && size.w * 4 <= this.upscaler.info.maxTextureDimension && px * 4 <= this.budget / 3
  }

  /**
   * Decides the work for a page: x2 or x4 of the source, independent of how large it is shown.
   * Auto takes x4 whenever it fits (canvas cap, textures, memory): the second pass runs at level M
   * and costs about as much as one VL pass, and the automatic level keeps the total within the
   * time budget. x4 is what makes lines clean once fitted to the screen.
   */
  plan(size: PageSize): SrDecision {
    if (!this.upscaler.canUpscale(size)) return 'too-big'
    const maxTex = this.upscaler.info.maxTextureDimension
    const { scale, restore, clean } = this.options
    let passes: 1 | 2 = 1
    if (scale === 'x4') passes = size.w * 4 <= maxTex ? 2 : 1
    else if (scale === 'auto' && this.x4Fits(size)) passes = 2
    let f = passes === 2 ? 4 : 2
    // Keep the output within canvas/texture limits: a x4 that does not fit becomes an exact x2
    // (integer factors are rendered as texel copies, without resampling blur); only pages too
    // large even for x2 get a fractional factor.
    const cap = Math.min(Math.sqrt(MAX_OUTPUT_PIXELS / (size.w * size.h)), maxTex / size.w, maxTex / size.h)
    if (f > cap) {
      passes = 1
      f = Math.min(2, cap)
    }
    const target = { w: Math.max(1, Math.round(size.w * f)), h: Math.max(1, Math.round(size.h * f)) }
    return { level: this.resolveLevel(size, passes), passes, restore, clean, target }
  }

  private key(index: number, plan: SrPlan): string {
    return `${index}:${plan.level}:${plan.passes}:${plan.restore ? 'r' : '-'}:${plan.clean ? 'c' : '-'}:${plan.target.w}x${plan.target.h}`
  }

  private indexOf(key: string): number {
    return Number(key.split(':')[0])
  }

  /**
   * Whether an existing result satisfies `plan` under the current settings. With the automatic
   * level any level does: the level is the engine's business, not a reason to redo a page.
   */
  private compatible(result: SrResult, plan: SrPlan): boolean {
    const p = result.plan
    if (!p) return false
    if (p.passes !== plan.passes || p.restore !== plan.restore || p.clean !== plan.clean) return false
    if (p.target.w !== plan.target.w || p.target.h !== plan.target.h) return false
    return this.options.level === 'auto' || p.level === plan.level
  }

  private touch(key: string, result: SrResult): void {
    this.cache.delete(key)
    this.cache.set(key, result)
  }

  /** A cached result for this page that satisfies `plan` (see `compatible`), most recent first. */
  peek(index: number, plan: SrPlan): SrResult | undefined {
    const exact = this.key(index, plan)
    const hit = this.cache.get(exact)
    if (hit) {
      this.touch(exact, hit)
      return hit
    }
    for (const [key, result] of [...this.cache].reverse()) {
      if (this.indexOf(key) === index && this.compatible(result, plan)) {
        this.touch(key, result)
        return result
      }
    }
    return undefined
  }

  /** Pages currently on screen; work not yet started for other pages is dropped. */
  setWanted(indices: Iterable<number>): void {
    this.wanted = new Set(indices)
    this.evict()
  }

  /** Enhances one page, after whatever is already running; the same plan in flight is shared. */
  enhance(index: number, plan: SrPlan, source: () => Promise<ImageBitmap>): Promise<SrResult> {
    if (!this.available) return Promise.reject(new Error('SR non disponibile'))
    const key = this.key(index, plan)
    const hit = this.peek(index, plan)
    if (hit) return Promise.resolve(hit)
    const existing = this.tasks.get(key)
    if (existing) return existing.promise
    const run = async (): Promise<SrResult> => {
      if (!this.wanted.has(index) || !this.available) throw new SrAborted()
      // Decided when the work starts, not when it was requested: the probe may have settled meanwhile.
      const again = this.peek(index, plan)
      if (again) return again
      const result = await this.run(plan, source)
      if (this.disposed) {
        result.bitmap.close()
        throw new SrAborted()
      }
      // One result per page: an older variant (other settings) is replaced, not kept alongside.
      for (const [k, r] of this.cache) if (this.indexOf(k) === index) this.drop(k, r)
      this.cache.set(key, result)
      this.cacheBytes += bytesOf(result.bitmap)
      this.evict()
      this.onChange?.()
      return result
    }
    const promise = this.chain.then(run, run).finally(() => this.tasks.delete(key))
    this.chain = promise.catch(() => undefined)
    this.tasks.set(key, { key, index, promise })
    return promise
  }

  /** LRU eviction by bytes; results of the pages on screen are never evicted. */
  private evict(): void {
    for (const [key, r] of this.cache) {
      if (this.cacheBytes <= this.budget) break
      if (this.wanted.has(this.indexOf(key))) continue
      this.drop(key, r)
    }
  }

  private drop(key: string, r: SrResult): void {
    this.cache.delete(key)
    this.cacheBytes -= bytesOf(r.bitmap)
    const timer = setTimeout(() => {
      this.pendingCloses.delete(timer)
      r.bitmap.close()
    }, CLOSE_DELAY_MS)
    this.pendingCloses.add(timer)
  }

  /** Bytes currently held by enhanced bitmaps (for the settings status line). */
  get cacheSizeBytes(): number {
    return this.cacheBytes
  }

  private async run(plan: SrPlan, load: () => Promise<ImageBitmap>): Promise<SrResult> {
    const source = await load()
    let intermediate: ImageBitmap | null = null
    try {
      // The one-off pipeline build (shader compile) must not pollute the throughput estimate.
      const built1 = await this.upscaler.prepare(plan.level, plan.restore, source.width)
      const built2 = plan.passes === 2 ? await this.upscaler.prepare('M', false, source.width * 2) : false
      const t0 = performance.now()
      let result
      if (plan.passes === 1) {
        result = await this.upscaler.upscale(source, { level: plan.level, restore: plan.restore, clean: plan.clean, target: plan.target })
      } else {
        // x4: an exact 2x pass at the chosen level, then a second 2x pass at level M resampled to the target.
        const first = await this.upscaler.upscale(source, {
          level: plan.level,
          restore: plan.restore,
          clean: false,
          target: { w: source.width * 2, h: source.height * 2 },
        })
        intermediate = await createImageBitmap(new ImageData(first.data, first.width, first.height))
        result = await this.upscaler.upscale(intermediate, { level: 'M', restore: false, clean: plan.clean, target: plan.target })
      }
      const ms = performance.now() - t0
      if (!built1 && !built2) this.observe(plan, (source.width * source.height) / 1e6, ms)
      const bitmap = await createImageBitmap(new ImageData(result.data, result.width, result.height))
      return { bitmap, level: plan.level, factor: plan.passes === 2 ? 4 : 2, ms, plan }
    } finally {
      source.close()
      intermediate?.close()
    }
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.pendingCloses) clearTimeout(timer)
    this.pendingCloses.clear()
    // The view may still hold these bitmaps for a frame: close them a moment later.
    const bitmaps = [...this.cache.values()].map((r) => r.bitmap)
    setTimeout(() => {
      for (const b of bitmaps) b.close()
    }, CLOSE_DELAY_MS)
    this.cache.clear()
    this.cacheBytes = 0
    this.upscaler.dispose()
  }
}
