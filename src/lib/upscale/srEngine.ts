import type { PageSize, SrLevel } from '../../types'
import { Anime4KUpscaler } from './anime4k'
import { type Anime4KLevel, LEVEL_COST, type UpscaleBackend } from './backend'
import { WebGL2Backend } from './webgl2Backend'

export type SrBackendPreference = 'auto' | 'webgpu' | 'webgl2'

export interface SrResult {
  bitmap: ImageBitmap
  level: Anime4KLevel | 'CUNet'
  /** Wall time of the GPU pass + readback, ms. */
  ms: number
}

export type SrDecision = 'enhance' | 'native' | 'too-big'

interface Task {
  key: string
  index: number
  level: Anime4KLevel
  source: () => Promise<ImageBitmap>
  priority: number
  resolve: (r: SrResult) => void
  reject: (e: unknown) => void
}

/** Budget per page for the automatic level (ms). */
const AUTO_BUDGET_MS = 100
const CACHE_CAPACITY = 4

export class SrAborted extends Error {
  constructor() {
    super('aborted')
    this.name = 'SrAborted'
  }
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
  private level: SrLevel = 'auto'
  /** EMA of ms per input megapixel, per level. */
  private readonly msPerMP: Partial<Record<Anime4KLevel, number>> = {}
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

  setLevel(level: SrLevel): void {
    if (this.level === level) return
    this.level = level
    this.onChange?.()
  }

  /** Maximum level allowed by device memory (rough jetsam guard). */
  private memoryCap(): Anime4KLevel {
    const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
    if (mem !== undefined && mem <= 2) return 'M'
    if (mem !== undefined && mem <= 4) return 'VL'
    return 'UL'
  }

  /** Level that will be used for a page of `size`. */
  resolveLevel(size: PageSize): Anime4KLevel {
    const cap = this.memoryCap()
    const order: Anime4KLevel[] = ['M', 'VL', 'UL']
    const capIdx = order.indexOf(cap)
    if (this.level !== 'auto') return order[Math.min(order.indexOf(this.level), capIdx)]!
    const ref = this.msPerMP.VL ?? (this.msPerMP.M !== undefined ? this.msPerMP.M / LEVEL_COST.M : undefined)
    if (ref === undefined) return capIdx >= 1 ? 'VL' : 'M' // probe with VL first
    const mp = (size.w * size.h) / 1e6
    let best: Anime4KLevel = 'M'
    for (const l of order.slice(0, capIdx + 1)) if (ref * LEVEL_COST[l] * mp <= AUTO_BUDGET_MS) best = l
    return best
  }

  /** Measured cost estimate for the UI, ms per page of `size` at the resolved level (or undefined before the probe). */
  estimateMs(size: PageSize): number | undefined {
    const ref = this.msPerMP.VL ?? (this.msPerMP.M !== undefined ? this.msPerMP.M / LEVEL_COST.M : undefined)
    if (ref === undefined) return undefined
    return ref * LEVEL_COST[this.resolveLevel(size)] * ((size.w * size.h) / 1e6)
  }

  /** Enhance only when the page is displayed larger than its native pixels (and fits the limits). */
  decide(size: PageSize, displayedDevicePx: { w: number; h: number }): SrDecision {
    if (!this.upscaler.canUpscale(size)) return 'too-big'
    if (displayedDevicePx.w <= size.w * 1.1 && displayedDevicePx.h <= size.h * 1.1) return 'native'
    return 'enhance'
  }

  peek(index: number, size: PageSize): SrResult | undefined {
    const level = this.resolveLevel(size)
    const hit = this.cache.get(this.key(index, level))
    if (hit) this.touch(index, level)
    return hit
  }

  private key(index: number, level: Anime4KLevel): string {
    return `${index}:${level}`
  }

  private touch(index: number, level: Anime4KLevel): void {
    const k = this.key(index, level)
    const v = this.cache.get(k)
    if (!v) return
    this.cache.delete(k)
    this.cache.set(k, v)
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

  enhance(index: number, size: PageSize, source: () => Promise<ImageBitmap>, priority: number): Promise<SrResult> {
    if (!this.available) return Promise.reject(new Error('SR non disponibile'))
    const level = this.resolveLevel(size)
    const key = this.key(index, level)
    const hit = this.cache.get(key)
    if (hit) {
      this.touch(index, level)
      return Promise.resolve(hit)
    }
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
      this.queue.push({ key, index, level, source, priority, resolve, reject })
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
    const source = await task.source()
    try {
      // The one-off pipeline build (shader compile) must not pollute the throughput estimate.
      const built = await this.upscaler.prepare(task.level, source.width)
      const t0 = performance.now()
      const { data, width, height } = await this.upscaler.upscale(source, task.level)
      const ms = performance.now() - t0
      if (!built) {
        const mp = (source.width * source.height) / 1e6
        const prev = this.msPerMP[task.level]
        const sample = ms / mp
        this.msPerMP[task.level] = prev === undefined ? sample : prev * 0.6 + sample * 0.4
      }
      const bitmap = await createImageBitmap(new ImageData(data, width, height))
      return { bitmap, level: task.level, ms }
    } finally {
      source.close()
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
