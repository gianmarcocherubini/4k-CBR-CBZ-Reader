import type { DistributiveOmit } from '../../archive/rar/protocol'
import { flags } from '../../flags'
import type { HeavyModel } from '../../../types'
import { CUNET_CACHE_DIR, type CunetEp, type CunetInitResult, type CunetRequest, type CunetResponse, cacheKeyFor, MODEL_SPECS } from './protocol'

export type CunetStatus = 'idle' | 'loading' | 'ready' | 'model-missing' | 'unavailable'

export interface CunetInfo {
  ep: CunetEp
  threads: number
  crossOriginIsolated: boolean
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

export class CunetAborted extends Error {
  constructor() {
    super('aborted')
    this.name = 'CunetAborted'
  }
}

/**
 * "Qualità massima": drives the CUNet worker, keeps a small LRU of decoded results and runs the
 * per-volume batch job. Cached pages are read straight from OPFS on the main thread.
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
  private readonly inflight = new Map<string, Promise<ImageBitmap>>()
  private queue: Array<{ key: string; run: () => Promise<void> }> = []
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

  private remember(k: string, bitmap: ImageBitmap): void {
    this.bitmaps.set(k, bitmap)
    while (this.bitmaps.size > 4) {
      const oldest = this.bitmaps.keys().next().value
      if (oldest === undefined) break
      this.bitmaps.get(oldest)?.close()
      this.bitmaps.delete(oldest)
    }
  }

  /** Cached result from OPFS, decoded; null when the page was never processed. */
  lookup(bookId: string, page: number): Promise<ImageBitmap | null> {
    const hit = this.peek(bookId, page)
    if (hit) return Promise.resolve(hit)
    const pending = this.inflight.get(this.key(bookId, page))
    if (pending) return pending.then((b) => b, () => null)
    return this.readCache(bookId, page)
  }

  /** Pure OPFS read (no queue interaction), so it is safe to call from inside a queued task. */
  private async readCache(bookId: string, page: number): Promise<ImageBitmap | null> {
    try {
      const root = await navigator.storage.getDirectory()
      const dir = await (await root.getDirectoryHandle(CUNET_CACHE_DIR, { create: false })).getDirectoryHandle(cacheKeyFor(bookId, this.model), { create: false })
      const file = await (await dir.getFileHandle(`${page}`)).getFile()
      if (file.size === 0) return null
      // OPFS files carry no MIME type: sniff so Safari decodes them too.
      const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
      const isWebp = head[0] === 0x52 && head[1] === 0x49 && head[8] === 0x57 && head[9] === 0x45
      const typed = file.type ? file : new Blob([file], { type: isWebp ? 'image/webp' : 'image/jpeg' })
      const bitmap = await createImageBitmap(typed)
      this.remember(this.key(bookId, page), bitmap)
      return bitmap
    } catch {
      return null
    }
  }

  async cachedPages(bookId: string): Promise<number[]> {
    if (this.disposed) return []
    return this.call<number[]>({ type: 'list', cacheKey: cacheKeyFor(bookId, this.model) }).promise
  }

  /** Processes one page (queued, one at a time) and caches it. */
  enhance(bookId: string, page: number, source: () => Promise<Blob>, onProgress?: (d: number, t: number) => void): Promise<ImageBitmap> {
    const k = this.key(bookId, page)
    const hit = this.peek(bookId, page)
    if (hit) return Promise.resolve(hit)
    const pending = this.inflight.get(k)
    if (pending) return pending
    const promise = new Promise<ImageBitmap>((resolve, reject) => {
      this.queue.push({
        key: k,
        run: async () => {
          try {
            await this.init()
            const cached = await this.readCache(bookId, page)
            if (cached) {
              resolve(cached)
              return
            }
            const blob = await source()
            const t0 = performance.now()
            const { promise: p } = this.call<Blob>({ type: 'process', cacheKey: cacheKeyFor(bookId, this.model), page, blob }, onProgress)
            const encoded = await p
            const secs = (performance.now() - t0) / 1000
            this.secondsPerPage = this.secondsPerPage === undefined ? secs : this.secondsPerPage * 0.6 + secs * 0.4
            const bitmap = await createImageBitmap(encoded)
            this.remember(k, bitmap)
            resolve(bitmap)
            this.onChange?.()
          } catch (e) {
            reject((e as { code?: string })?.code === 'aborted' ? new CunetAborted() : e)
          }
        },
      })
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
        const task = this.queue.shift()!
        await task.run()
      }
    } finally {
      this.running = false
    }
  }

  /** Drops queued (not started) work for pages other than `keep`. */
  prune(bookId: string, keep: Iterable<number>): void {
    const keepKeys = new Set([...keep].map((p) => this.key(bookId, p)))
    this.queue = this.queue.filter((t) => keepKeys.has(t.key))
  }

  /**
   * "Pre-elabora questo volume": every page not yet cached, sequentially, with progress and cancel.
   */
  async preprocess(
    bookId: string,
    pages: number[],
    source: (page: number) => Promise<Blob>,
    onProgress: (p: BatchProgress) => void,
    signal: AbortSignal,
  ): Promise<void> {
    await this.init()
    const done = new Set(await this.cachedPages(bookId))
    const todo = pages.filter((p) => !done.has(p))
    const total = pages.length
    let count = done.size
    onProgress({ done: count, total, tilesDone: 0, tilesTotal: 0, secondsPerPage: this.secondsPerPage })
    for (const page of todo) {
      if (signal.aborted) throw new CunetAborted()
      const blob = await source(page)
      const t0 = performance.now()
      const { id, promise } = this.call<Blob>({ type: 'process', cacheKey: cacheKeyFor(bookId, this.model), page, blob }, (tilesDone, tilesTotal) =>
        onProgress({ done: count, total, tilesDone, tilesTotal, secondsPerPage: this.secondsPerPage, currentPage: page }),
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
    this.queue = []
    for (const b of this.bitmaps.values()) b.close()
    this.bitmaps.clear()
    this.worker?.terminate()
    this.worker = null
    this.pending.clear()
  }
}

/** Removes the cached results of a book (called when the book is deleted). */
export async function deleteCunetCache(bookId: string): Promise<void> {
  for (const model of Object.keys(MODEL_SPECS) as HeavyModel[]) {
    try {
      const root = await navigator.storage.getDirectory()
      const base = await root.getDirectoryHandle(CUNET_CACHE_DIR, { create: false })
      await base.removeEntry(cacheKeyFor(bookId, model), { recursive: true })
    } catch {
      // nothing cached
    }
  }
}
