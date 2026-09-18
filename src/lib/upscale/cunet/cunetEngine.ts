import type { DistributiveOmit } from '../../archive/rar/protocol'
import { flags } from '../../flags'
import { assertSafeEncodedImage } from '../../imageDimensions'
import type { HeavyModel } from '../../../types'
import { cacheBudgetBytes } from '../backend'
import {
  cacheDirFor,
  cacheKeyFor,
  CUNET_CACHE_DIR,
  type CunetEp,
  type CunetInitResult,
  type CunetRequest,
  type CunetResponse,
  HEAVY_FACTORS,
  type HeavyFactor,
  MODEL_SPECS,
} from './protocol'

export type CunetStatus = 'idle' | 'loading' | 'ready' | 'model-missing' | 'unavailable'

export interface CunetInfo {
  ep: CunetEp
  threads: number
  crossOriginIsolated: boolean
  precision: 'fp16' | 'fp32'
  graphCapture: boolean
}

export interface BatchProgress {
  done: number
  total: number
  tilesDone: number
  tilesTotal: number
  /** Seconds per page, EMA. */
  secondsPerPage?: number
  currentPage?: number
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  onProgress?: (done: number, total: number) => void
}

interface HeavyTask {
  key: string
  priority: number
  run: () => Promise<void>
  cancel: () => void
}

export class CunetAborted extends Error {
  constructor() {
    super('aborted')
    this.name = 'CunetAborted'
  }
}

/**
 * "Qualità massima": drives the heavy-model worker, keeps a byte-bounded LRU of decoded results
 * and runs the per-volume batch job. Cached pages are read straight from OPFS on the main thread;
 * the x4 result of a page is preferred over its x2 one whenever both exist.
 */
export class CunetEngine {
  readonly model: HeavyModel
  status: CunetStatus = 'idle'
  info: CunetInfo | null = null
  error: string | null = null
  onChange: (() => void) | null = null
  private worker: Worker | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private initPromise: Promise<void> | null = null
  private readonly bitmaps = new Map<string, ImageBitmap>()
  private bitmapBytes = 0
  /** The heavy tier is exclusive with Anime4K (that engine is disposed while this one runs), so it
   *  may use the whole budget: enough for the visible spread plus read-ahead without LRU thrash. */
  private readonly budget = cacheBudgetBytes()
  private readonly inflight = new Map<string, Promise<ImageBitmap>>()
  private readonly cacheLookups = new Map<string, Promise<ImageBitmap | null>>()
  private queue: HeavyTask[] = []
  private activeTask: HeavyTask | null = null
  private protectedKeys = new Set<string>()
  private wantedKeys: Set<string> | null = null
  private readonly pendingCloses = new Map<ImageBitmap, ReturnType<typeof setTimeout>>()
  private running = false
  private disposed = false
  /** Per-page wall time EMA (seconds), used for the batch estimate. */
  private secondsPerPage: number | undefined

  constructor(model: HeavyModel = 'cunet') {
    this.model = model
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./cunet.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (ev: MessageEvent<CunetResponse>) => {
      const msg = ev.data
      if (msg.type === 'mode') {
        this.info = msg.info
        this.onChange?.()
        return
      }
      const p = this.pending.get(msg.id)
      if (!p) return
      if (msg.type === 'progress') {
        p.onProgress?.(msg.tilesDone, msg.tilesTotal)
        return
      }
      this.pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }))
    }
    worker.onerror = (ev) => {
      const err = new Error(ev.message || 'Errore nel worker CUNet')
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
      this.status = 'unavailable'
      this.error = err.message
      this.onChange?.()
    }
    this.worker = worker
    return worker
  }

  private call<T>(req: DistributiveOmit<CunetRequest, 'id'>, onProgress?: (d: number, t: number) => void): { id: number; promise: Promise<T> } {
    const worker = this.ensureWorker()
    const id = this.nextId++
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress })
      worker.postMessage({ ...req, id } as CunetRequest)
    })
    return { id, promise }
  }

  /** Loads the runtime and the model (30 MB the first time; cached by the service worker afterwards). */
  init(): Promise<void> {
    if (this.initPromise) return this.initPromise
    this.status = 'loading'
    this.onChange?.()
    const base = new URL(import.meta.env.BASE_URL, location.origin).href
    this.initPromise = this.call<CunetInitResult>({
      type: 'init',
      modelUrl: `${base}models/${MODEL_SPECS[this.model].file}`,
      ortPath: `${base}ort/`,
      preferGpu: flags.cunet !== 'wasm',
      spec: MODEL_SPECS[this.model],
    })
      .promise.then((r) => {
        this.info = r
        this.status = 'ready'
        this.onChange?.()
      })
      .catch((e: Error & { code?: string }) => {
        this.status = e.code === 'model-missing' ? 'model-missing' : 'unavailable'
        this.error = e.message
        this.initPromise = null
        this.onChange?.()
        throw e
      })
    return this.initPromise
  }

  get ready(): boolean {
    return this.status === 'ready' && !this.disposed
  }

  /** On WebGPU the next pages can be processed while reading; on WASM only the batch job makes sense. */
  get prefetchAllowed(): boolean {
    return this.ready && this.info?.ep === 'webgpu'
  }

  private key(bookId: string, page: number): string {
    return `${bookId}:${page}`
  }

  peek(bookId: string, page: number): ImageBitmap | undefined {
    const k = this.key(bookId, page)
    const hit = this.bitmaps.get(k)
    if (hit) {
      this.bitmaps.delete(k)
      this.bitmaps.set(k, hit)
    }
    return hit
  }

  private closeAfterPaint(bitmap: ImageBitmap): void {
    if (this.pendingCloses.has(bitmap)) return
    const timer = setTimeout(() => {
      this.pendingCloses.delete(bitmap)
      bitmap.close()
    }, 500)
    this.pendingCloses.set(bitmap, timer)
  }

  private remember(k: string, bitmap: ImageBitmap): boolean {
    if (this.disposed) {
      bitmap.close()
      return false
    }
    const old = this.bitmaps.get(k)
    if (old === bitmap) {
      this.bitmaps.delete(k)
      this.bitmaps.set(k, bitmap)
      return true
    }
    if (old && old !== bitmap) {
      this.bitmapBytes -= old.width * old.height * 4
      this.closeAfterPaint(old)
    }
    this.bitmaps.set(k, bitmap)
    this.bitmapBytes += bitmap.width * bitmap.height * 4
    this.evictBitmaps()
    return this.bitmaps.get(k) === bitmap
  }

  /** The visible spread must never be closed while React is painting it. */
  protect(bookId: string, pages: Iterable<number>): void {
    this.protectedKeys = new Set([...pages].map((page) => this.key(bookId, page)))
    this.evictBitmaps()
  }

  private evictBitmaps(): void {
    for (const [key, b] of this.bitmaps) {
      if (this.bitmapBytes <= this.budget) break
      if (this.protectedKeys.has(key)) continue
      this.bitmaps.delete(key)
      this.bitmapBytes -= b.width * b.height * 4
      this.closeAfterPaint(b)
    }
  }

  /** Cached result from OPFS, decoded; null when the page was never processed. */
  lookup(bookId: string, page: number, persist = true): Promise<ImageBitmap | null> {
    const k = this.key(bookId, page)
    const hit = this.peek(bookId, page)
    if (hit) return Promise.resolve(hit)
    if (!persist) return Promise.resolve(null)
    const pending = this.inflight.get(k)
    if (pending) return pending.then((b) => b, () => null)
    const lookup = this.cacheLookups.get(k)
    if (lookup) return lookup
    const created = this.readCache(bookId, page).finally(() => this.cacheLookups.delete(k))
    this.cacheLookups.set(k, created)
    return created
  }

  /** Pure OPFS read (no queue interaction), so it is safe to call from inside a queued task. x4 first. */
  private async readCache(bookId: string, page: number): Promise<ImageBitmap | null> {
    for (const factor of HEAVY_FACTORS) {
      try {
        const root = await navigator.storage.getDirectory()
        const dir = await (await root.getDirectoryHandle(CUNET_CACHE_DIR, { create: false })).getDirectoryHandle(
          cacheDirFor(cacheKeyFor(bookId, this.model), factor),
          { create: false },
        )
        const file = await (await dir.getFileHandle(`${page}`)).getFile()
        if (file.size === 0) continue
        // OPFS files carry no MIME type: sniff so Safari decodes them too.
        const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
        const isWebp = head[0] === 0x52 && head[1] === 0x49 && head[8] === 0x57 && head[9] === 0x45
        const typed = file.type ? file : new Blob([file], { type: isWebp ? 'image/webp' : 'image/jpeg' })
        await assertSafeEncodedImage(typed)
        const bitmap = await createImageBitmap(typed)
        if (this.remember(this.key(bookId, page), bitmap)) return bitmap
        return null
      } catch {
        // not cached at this factor
      }
    }
    return null
  }

  /** Pages with a result at `factor` (x4 requests are only satisfied by x4 results; x2 by either). */
  async cachedPages(bookId: string, factor: HeavyFactor): Promise<number[]> {
    if (this.disposed) return []
    const base = cacheKeyFor(bookId, this.model)
    const factors = factor === 4 ? [4 as HeavyFactor] : HEAVY_FACTORS
    const pages = new Set<number>()
    for (const f of factors) for (const p of await this.call<number[]>({ type: 'list', cacheKey: cacheDirFor(base, f) }).promise) pages.add(p)
    return [...pages].sort((a, b) => a - b)
  }

  /**
   * Processes one page (queued, one at a time) at up to `maxFactor` and caches it. `priority` is
   * the reading distance (0 = the visible page): the queue always runs the lowest number next, so
   * the page in front of the reader is never made to wait behind a stale read-ahead job.
   */
  enhance(
    bookId: string,
    page: number,
    source: () => Promise<Blob>,
    maxFactor: HeavyFactor,
    priority = 0,
    persist = true,
    onProgress?: (d: number, t: number) => void,
  ): Promise<ImageBitmap> {
    if (this.disposed) return Promise.reject(new CunetAborted())
    const k = this.key(bookId, page)
    if (this.wantedKeys && !this.wantedKeys.has(k)) return Promise.reject(new CunetAborted())
    const hit = this.peek(bookId, page)
    if (hit) return Promise.resolve(hit)
    const lookup = this.cacheLookups.get(k)
    if (lookup) {
      return lookup.then((cached) => {
        if (this.wantedKeys && !this.wantedKeys.has(k)) throw new CunetAborted()
        return cached ?? this.enhance(bookId, page, source, maxFactor, priority, persist, onProgress)
      })
    }
    const pending = this.inflight.get(k)
    if (pending) {
      // Re-prioritise an already-queued page (e.g. the reader just turned onto a read-ahead page).
      const q = this.queue.find((t) => t.key === k)
      if (q) q.priority = Math.min(q.priority, priority)
      this.queue.sort((a, b) => a.priority - b.priority)
      return pending
    }
    let task!: HeavyTask
    const promise = new Promise<ImageBitmap>((resolve, reject) => {
      let cancelled = false
      let workerRequestId: number | null = null
      const cancel = () => {
        if (cancelled) return
        cancelled = true
        if (workerRequestId !== null) this.worker?.postMessage({ type: 'cancel', id: workerRequestId } satisfies CunetRequest)
        reject(new CunetAborted())
      }
      task = {
        key: k,
        priority,
        cancel,
        run: async () => {
          if (cancelled) return
          try {
            await this.init()
            if (cancelled) return
            const cached = persist ? await this.readCache(bookId, page) : null
            if (cancelled) return
            if (cached) {
              resolve(cached)
              return
            }
            const blob = await source()
            if (cancelled) return
            const t0 = performance.now()
            const called = this.call<Blob>(
              { type: 'process', cacheKeyBase: cacheKeyFor(bookId, this.model), page, blob, maxFactor, persist },
              onProgress,
            )
            workerRequestId = called.id
            if (cancelled) {
              this.worker?.postMessage({ type: 'cancel', id: called.id } satisfies CunetRequest)
              return
            }
            const encoded = await called.promise
            workerRequestId = null
            if (cancelled) return
            const secs = (performance.now() - t0) / 1000
            this.secondsPerPage = this.secondsPerPage === undefined ? secs : this.secondsPerPage * 0.6 + secs * 0.4
            const bitmap = await createImageBitmap(encoded)
            if (cancelled) {
              bitmap.close()
              return
            }
            if (!this.remember(k, bitmap)) {
              reject(new CunetAborted())
              return
            }
            resolve(bitmap)
            this.onChange?.()
          } catch (e) {
            workerRequestId = null
            if (!cancelled) reject((e as { code?: string })?.code === 'aborted' ? new CunetAborted() : e)
          }
        },
      }
      this.queue.push(task)
      this.queue.sort((a, b) => a.priority - b.priority)
      void this.pump()
    }).finally(() => this.inflight.delete(k))
    this.inflight.set(k, promise)
    return promise
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0 && !this.disposed) {
        // Re-read the head each turn: priorities may have changed while the previous page ran.
        this.queue.sort((a, b) => a.priority - b.priority)
        const task = this.queue.shift()!
        this.activeTask = task
        try {
          await task.run()
        } finally {
          if (this.activeTask === task) this.activeTask = null
        }
      }
    } finally {
      this.running = false
    }
  }

  /** Drops queued (not started) work for pages other than `keep`. */
  prune(bookId: string, keep: Iterable<number>): void {
    const keepKeys = new Set([...keep].map((p) => this.key(bookId, p)))
    this.wantedKeys = keepKeys
    const kept: HeavyTask[] = []
    for (const task of this.queue) {
      if (keepKeys.has(task.key)) kept.push(task)
      else task.cancel()
    }
    this.queue = kept
    if (this.activeTask && !keepKeys.has(this.activeTask.key)) this.activeTask.cancel()
  }

  /**
   * "Pre-elabora questo volume": every page not yet cached, sequentially, with progress and cancel.
   */
  async preprocess(
    bookId: string,
    pages: number[],
    source: (page: number) => Promise<Blob>,
    maxFactor: HeavyFactor,
    persist: boolean,
    onProgress: (p: BatchProgress) => void,
    signal: AbortSignal,
  ): Promise<void> {
    await this.init()
    const done = new Set(persist ? await this.cachedPages(bookId, maxFactor) : [])
    const todo = pages.filter((p) => !done.has(p))
    const total = pages.length
    let count = pages.length - todo.length
    onProgress({ done: count, total, tilesDone: 0, tilesTotal: 0, secondsPerPage: this.secondsPerPage })
    for (const page of todo) {
      if (signal.aborted) throw new CunetAborted()
      const blob = await source(page)
      const t0 = performance.now()
      const { id, promise } = this.call<Blob>(
        { type: 'process', cacheKeyBase: cacheKeyFor(bookId, this.model), page, blob, maxFactor, persist },
        (tilesDone, tilesTotal) => onProgress({ done: count, total, tilesDone, tilesTotal, secondsPerPage: this.secondsPerPage, currentPage: page }),
      )
      const onAbort = () => this.worker?.postMessage({ type: 'cancel', id } satisfies CunetRequest)
      signal.addEventListener('abort', onAbort)
      try {
        await promise
      } catch (e) {
        if ((e as { code?: string })?.code === 'aborted' || signal.aborted) throw new CunetAborted()
        throw e
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
      const secs = (performance.now() - t0) / 1000
      this.secondsPerPage = this.secondsPerPage === undefined ? secs : this.secondsPerPage * 0.6 + secs * 0.4
      count++
      onProgress({ done: count, total, tilesDone: 0, tilesTotal: 0, secondsPerPage: this.secondsPerPage })
      this.onChange?.()
    }
  }

  dispose(): void {
    this.disposed = true
    for (const task of this.queue) task.cancel()
    this.queue = []
    this.activeTask?.cancel()
    this.activeTask = null
    this.protectedKeys.clear()
    this.wantedKeys = null
    for (const b of this.bitmaps.values()) b.close()
    this.bitmaps.clear()
    for (const [bitmap, timer] of this.pendingCloses) {
      clearTimeout(timer)
      bitmap.close()
    }
    this.pendingCloses.clear()
    this.bitmapBytes = 0
    this.worker?.terminate()
    this.worker = null
    for (const pending of this.pending.values()) pending.reject(new CunetAborted())
    this.pending.clear()
    this.cacheLookups.clear()
  }
}

/** Removes the cached results of a book, every model and factor (called when the book is deleted). */
export async function deleteCunetCache(bookId: string): Promise<void> {
  for (const model of Object.keys(MODEL_SPECS) as HeavyModel[]) {
    for (const factor of HEAVY_FACTORS) {
      try {
        const root = await navigator.storage.getDirectory()
        const base = await root.getDirectoryHandle(CUNET_CACHE_DIR, { create: false })
        await base.removeEntry(cacheDirFor(cacheKeyFor(bookId, model), factor), { recursive: true })
      } catch {
        // nothing cached
      }
    }
  }
}
