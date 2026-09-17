import type { PageSize, SrLevel, SrScale } from '../../types'
import { Anime4KUpscaler } from './anime4k'
import { type Anime4KLevel, LEVEL_COST, MAX_OUTPUT_PIXELS, RESTORE_COST, type Size, type UpscaleBackend } from './backend'
import { WebGL2Backend } from './webgl2Backend'

export type SrBackendPreference = 'auto' | 'webgpu' | 'webgl2'

export interface SrResult {
  bitmap: ImageBitmap
  level: Anime4KLevel | 'CUNet' | 'GAN'
  /** Upscale factor applied by the network (2 or 4) before resampling to the target. */
  factor: number
  /** Wall time of the GPU passes + readback, ms. */
  ms: number
}

export interface SrOptions {
  level: SrLevel
  scale: SrScale
  restore: boolean
  clean: boolean
  always: boolean
}

/** What will be done for one page: the network passes and the output size. */
export interface SrPlan {
  level: Anime4KLevel
  /** 1 = x2, 2 = x4 (second pass at level M, as Anime4K recommends). */
  passes: 1 | 2
  restore: boolean
  clean: boolean
  target: Size
}

export type SrDecision = SrPlan | 'native' | 'too-big'

interface Task {
  key: string
  index: number
  plan: SrPlan
  source: () => Promise<ImageBitmap>
  priority: number
  resolve: (r: SrResult) => void
  reject: (e: unknown) => void
}

/** Budget per page for the automatic level (ms). */
const AUTO_BUDGET_MS = 100
const CACHE_CAPACITY = 4
/** Displayed/native ratio under which a page is left alone (unless "always"). */
const NATIVE_TOLERANCE = 1.1

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
 * Serialises Anime4K work on the GPU with a priority queue (current spread first), keeps an LRU
 * of enhanced bitmaps and picks the automatic level from measured throughput.
 */
export class SrEngine {
  readonly upscaler: UpscaleBackend
  private readonly cache = new Map<string, SrResult>()
  private queue: Task[] = []
  private running = false
  private wanted = new Set<number>()
  private options: SrOptions = { level: 'auto', scale: 'auto', restore: false, clean: false, always: false }
  /** EMA of ms per (megapixel × plan unit). */
  private msPerUnit: number | undefined
  private disposed = false
  onChange: (() => void) | null = null

  private constructor(upscaler: UpscaleBackend) {
    this.upscaler = upscaler
    upscaler.onLost = () => {
      this.disposed = true
      this.onChange?.()
    }
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
    if (o.level === next.level && o.scale === next.scale && o.restore === next.restore && o.clean === next.clean && o.always === next.always) return
    this.options = { ...next }
    this.onChange?.()
  }

  /** Maximum level allowed by device memory (rough jetsam guard). */
  private memoryCap(): Anime4KLevel {
    const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
    if (mem !== undefined && mem <= 2) return 'M'
    if (mem !== undefined && mem <= 4) return 'VL'
    return 'UL'
  }

  /** Level for a page of `size` under the current options (auto = strongest within the budget). */
  resolveLevel(size: PageSize, passes: 1 | 2 = 1): Anime4KLevel {
    const cap = this.memoryCap()
    const order: Anime4KLevel[] = ['M', 'VL', 'UL']
    const capIdx = order.indexOf(cap)
    const { level, restore } = this.options
    if (level !== 'auto') return order[Math.min(order.indexOf(level), capIdx)]!
    if (this.msPerUnit === undefined) return capIdx >= 1 ? 'VL' : 'M' // probe with VL first
    const mp = (size.w * size.h) / 1e6
    let best: Anime4KLevel = 'M'
    for (const l of order.slice(0, capIdx + 1)) if (this.msPerUnit * planUnits(l, restore, passes) * mp <= AUTO_BUDGET_MS) best = l
    return best
  }

  /** Measured cost estimate for the UI, ms per page (undefined before the probe). */
  estimateMs(size: PageSize, displayedDevicePx?: Size): number | undefined {
    if (this.msPerUnit === undefined) return undefined
    const plan = displayedDevicePx ? this.plan(size, displayedDevicePx) : null
    const passes = plan && typeof plan !== 'string' ? plan.passes : 1
    const level = plan && typeof plan !== 'string' ? plan.level : this.resolveLevel(size)
    return this.msPerUnit * planUnits(level, this.options.restore, passes) * ((size.w * size.h) / 1e6)
  }

  /**
   * Decides what to do for a page displayed at `displayedDevicePx`: nothing when it is already at
   * native resolution (unless "always"), otherwise a plan whose output is exactly the displayed
   * size (quantised in 1/16 steps so small zoom changes reuse the cache), capped at x2 or x4.
   */
  plan(size: PageSize, displayedDevicePx: Size): SrDecision {
    if (!this.upscaler.canUpscale(size)) return 'too-big'
    const needed = Math.max(displayedDevicePx.w / size.w, displayedDevicePx.h / size.h)
    if (!this.options.always && needed <= NATIVE_TOLERANCE) return 'native'
    const maxTex = this.upscaler.info.maxTextureDimension
    let passes: 1 | 2 = this.options.scale === 'x4' || (this.options.scale === 'auto' && needed > 2) ? 2 : 1
    // The second pass runs the strip pipeline on the 2x image: its width must fit too.
    if (passes === 2 && size.w * 4 > maxTex) passes = 1
    const maxFactor = passes === 2 ? 4 : 2
    let f = Math.min(Math.ceil(Math.max(needed, 0.5) * 16) / 16, maxFactor)
    // Fixed factors render at that factor even when the display needs less (sharper downsampling).
    if (this.options.scale === 'x2') f = 2
    if (this.options.scale === 'x4' && passes === 2) f = 4
    // Keep the output within canvas/texture limits.
    const area = size.w * size.h * f * f
    if (area > MAX_OUTPUT_PIXELS) f = Math.sqrt(MAX_OUTPUT_PIXELS / (size.w * size.h))
    if (size.w * f > maxTex || size.h * f > maxTex) f = Math.min(maxTex / size.w, maxTex / size.h)
    const target = { w: Math.max(1, Math.round(size.w * f)), h: Math.max(1, Math.round(size.h * f)) }
    return { level: this.resolveLevel(size, passes), passes, restore: this.options.restore, clean: this.options.clean, target }
  }

  private key(index: number, plan: SrPlan): string {
    return `${index}:${plan.level}:${plan.passes}:${plan.restore ? 'r' : '-'}:${plan.clean ? 'c' : '-'}:${plan.target.w}x${plan.target.h}`
  }

  peek(index: number, plan: SrPlan): SrResult | undefined {
    const k = this.key(index, plan)
    const hit = this.cache.get(k)
    if (hit) {
      this.cache.delete(k)
      this.cache.set(k, hit)
    }
    return hit
  }

  /** Pages currently worth enhancing; queued work for other pages is dropped. */
  setWanted(indices: Iterable<number>): void {
    this.wanted = new Set(indices)
    const keep: Task[] = []
    for (const t of this.queue) {
      if (this.wanted.has(t.index)) keep.push(t)
      else t.reject(new SrAborted())
    }
    this.queue = keep
  }

  enhance(index: number, plan: SrPlan, source: () => Promise<ImageBitmap>, priority: number): Promise<SrResult> {
    if (!this.available) return Promise.reject(new Error('SR non disponibile'))
    const key = this.key(index, plan)
    const hit = this.peek(index, plan)
    if (hit) return Promise.resolve(hit)
    const existing = this.queue.find((t) => t.key === key)
    if (existing) {
      existing.priority = Math.min(existing.priority, priority)
      return new Promise((resolve, reject) => {
        const { resolve: r0, reject: j0 } = existing
        existing.resolve = (v) => {
          r0(v)
          resolve(v)
        }
        existing.reject = (e) => {
          j0(e)
          reject(e)
        }
      })
    }
    return new Promise<SrResult>((resolve, reject) => {
      this.queue.push({ key, index, plan, source, priority, resolve, reject })
      this.queue.sort((a, b) => a.priority - b.priority)
      void this.pump()
    })
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0 && this.available) {
        const task = this.queue.shift()!
        if (!this.wanted.has(task.index)) {
          task.reject(new SrAborted())
          continue
        }
        try {
          const result = await this.run(task)
          this.cache.set(task.key, result)
          while (this.cache.size > CACHE_CAPACITY) {
            const oldest = this.cache.keys().next().value
            if (oldest === undefined) break
            if (this.wanted.has(Number(oldest.split(':')[0])) && this.cache.size <= CACHE_CAPACITY + 2) break
            this.cache.get(oldest)?.bitmap.close()
            this.cache.delete(oldest)
          }
          task.resolve(result)
          this.onChange?.()
        } catch (e) {
          task.reject(e)
        }
      }
    } finally {
      this.running = false
    }
  }

  private async run(task: Task): Promise<SrResult> {
    const { plan } = task
    const source = await task.source()
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
      if (!built1 && !built2) {
        const mp = (source.width * source.height) / 1e6
        const sample = ms / (mp * planUnits(plan.level, plan.restore, plan.passes))
        this.msPerUnit = this.msPerUnit === undefined ? sample : this.msPerUnit * 0.6 + sample * 0.4
      }
      const bitmap = await createImageBitmap(new ImageData(result.data, result.width, result.height))
      return { bitmap, level: plan.level, factor: plan.passes === 2 ? 4 : 2, ms }
    } finally {
      source.close()
      intermediate?.close()
    }
  }

  dispose(): void {
    this.disposed = true
    for (const t of this.queue) t.reject(new SrAborted())
    this.queue = []
    for (const r of this.cache.values()) r.bitmap.close()
    this.cache.clear()
    this.upscaler.dispose()
  }
}
