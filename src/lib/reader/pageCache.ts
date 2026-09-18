import type { PageSize } from '../../types'
import { ArchiveError, type ArchiveReader } from '../archive/types'
import type { ArchiveEntry } from '../entries'
import { assertSafeEncodedImage, assertSafeImageSize } from '../imageDimensions'

export interface LoadedPage {
  index: number
  url: string
  blob: Blob
  size: PageSize
}

/** Decodes once through an <img>; the browser keeps the decoded bitmap keyed by URL for rendering. */
async function probeImage(url: string): Promise<PageSize> {
  const img = new Image()
  img.decoding = 'async'
  img.src = url
  try {
    await img.decode()
  } catch {
    // Some engines reject decode() for huge images but still load them.
    if (!img.naturalWidth) {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('decode'))
        if (img.complete && img.naturalWidth) resolve()
      })
    }
  }
  if (!img.naturalWidth || !img.naturalHeight) throw new Error('decode')
  const size = { w: img.naturalWidth, h: img.naturalHeight }
  assertSafeImageSize(size)
  return size
}

interface LoadTask {
  index: number
  resolve: (page: LoadedPage) => void
  reject: (error: unknown) => void
}

/**
 * LRU cache of decoded pages with object URLs. `protect()` marks the pages on screen so they
 * are never evicted; everything else goes once the capacity is exceeded.
 */
export class PageCache {
  private readonly reader: ArchiveReader
  private readonly pages: ArchiveEntry[]
  private readonly capacity: number
  private readonly maxDecodedBytes: number
  private readonly maxConcurrentLoads: number
  private readonly onSize: (index: number, size: PageSize) => void
  private readonly entries = new Map<number, LoadedPage>()
  private readonly inflight = new Map<number, Promise<LoadedPage>>()
  private protectedSet = new Set<number>()
  private readonly loadQueue: LoadTask[] = []
  private activeLoads = 0
  private reservedBytes = 0
  private readonly abort = new AbortController()
  private disposed = false

  constructor(
    reader: ArchiveReader,
    pages: ArchiveEntry[],
    onSize: (index: number, size: PageSize) => void,
    capacity = 8,
    maxDecodedBytes = 256 * 1024 * 1024,
    maxConcurrentLoads = 2,
  ) {
    this.reader = reader
    this.pages = pages
    this.onSize = onSize
    this.capacity = capacity
    this.maxDecodedBytes = maxDecodedBytes
    this.maxConcurrentLoads = maxConcurrentLoads
  }

  get count(): number {
    return this.pages.length
  }

  peek(index: number): LoadedPage | undefined {
    const hit = this.entries.get(index)
    if (hit) this.touch(index)
    return hit
  }

  get(index: number): Promise<LoadedPage> {
    if (this.disposed) return Promise.reject(new ArchiveError('aborted'))
    const hit = this.entries.get(index)
    if (hit) {
      this.touch(index)
      return Promise.resolve(hit)
    }
    const pending = this.inflight.get(index)
    if (pending) return pending
    const p = this.scheduleLoad(index).finally(() => this.inflight.delete(index))
    this.inflight.set(index, p)
    return p
  }

  private scheduleLoad(index: number): Promise<LoadedPage> {
    return new Promise((resolve, reject) => {
      this.loadQueue.push({ index, resolve, reject })
      this.pumpLoads()
    })
  }

  private pumpLoads(): void {
    while (!this.disposed && this.activeLoads < this.maxConcurrentLoads && this.loadQueue.length > 0) {
      const task = this.loadQueue.shift()!
      this.activeLoads++
      void this.load(task.index)
        .then(task.resolve, task.reject)
        .finally(() => {
          this.activeLoads--
          this.pumpLoads()
        })
    }
  }

  protect(indices: Iterable<number>): void {
    this.protectedSet = new Set(indices)
    this.evict()
  }

  private touch(index: number): void {
    const v = this.entries.get(index)
    if (!v) return
    this.entries.delete(index)
    this.entries.set(index, v)
  }

  private async load(index: number): Promise<LoadedPage> {
    const entry = this.pages[index]
    if (!entry) throw new ArchiveError('missing', `Pagina ${index + 1} inesistente`)
    const blob = await this.reader.extract(entry.name, this.abort.signal)
    if (this.disposed) throw new ArchiveError('aborted')
    let encodedSize: PageSize
    try {
      encodedSize = await assertSafeEncodedImage(blob)
    } catch (e) {
      throw new ArchiveError('corrupt', e instanceof Error ? e.message : String(e))
    }
    const reservation = encodedSize.w * encodedSize.h * 4 + blob.size
    // Make room for the incoming page before deciding it cannot fit. Without the incoming
    // reservation, an under-budget cache never evicted its oldest preload and reading got stuck.
    this.evict(this.reservedBytes + reservation, 1)
    if (this.currentBytes() + this.reservedBytes + reservation > this.maxDecodedBytes) {
      throw new ArchiveError(
        this.protectedSet.has(index) ? 'memory' : 'aborted',
        this.protectedSet.has(index) ? 'Spread oltre il limite di memoria' : 'Precaricamento saltato per il limite di memoria',
      )
    }
    this.reservedBytes += reservation
    let url: string | null = null
    try {
      url = URL.createObjectURL(blob)
      let size: PageSize
      try {
        size = await probeImage(url)
      } catch {
        throw new ArchiveError('corrupt', `Immagine non decodificabile: ${entry.name}`)
      }
      if (this.disposed) throw new ArchiveError('aborted')
      const page: LoadedPage = { index, url, blob, size }
      url = null // ownership moved to the cache entry
      this.entries.set(index, page)
      this.onSize(index, size)
      this.evict()
      return page
    } finally {
      this.reservedBytes -= reservation
      if (url) URL.revokeObjectURL(url)
    }
  }

  private currentBytes(): number {
    let bytes = 0
    for (const page of this.entries.values()) bytes += page.size.w * page.size.h * 4 + page.blob.size
    return bytes
  }

  private evict(incomingBytes = 0, incomingEntries = 0): void {
    let decodedBytes = this.currentBytes() + incomingBytes
    if (this.entries.size + incomingEntries <= this.capacity && decodedBytes <= this.maxDecodedBytes) return
    for (const [index, page] of this.entries) {
      if (this.entries.size + incomingEntries <= this.capacity && decodedBytes <= this.maxDecodedBytes) break
      if (this.protectedSet.has(index)) continue
      this.entries.delete(index)
      decodedBytes -= page.size.w * page.size.h * 4 + page.blob.size
      URL.revokeObjectURL(page.url)
    }
  }

  dispose(): void {
    this.disposed = true
    this.abort.abort()
    for (const task of this.loadQueue.splice(0)) task.reject(new ArchiveError('aborted'))
    for (const page of this.entries.values()) URL.revokeObjectURL(page.url)
    this.entries.clear()
  }
}
