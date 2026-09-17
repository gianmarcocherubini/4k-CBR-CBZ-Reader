import type { PageSize } from '../../types'
import { ArchiveError, type ArchiveReader } from '../archive/types'
import type { ArchiveEntry } from '../entries'

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
  return { w: img.naturalWidth, h: img.naturalHeight }
}

/**
 * LRU cache of decoded pages with object URLs. `protect()` marks the pages on screen so they
 * are never evicted; everything else goes once the capacity is exceeded.
 */
export class PageCache {
  private readonly reader: ArchiveReader
  private readonly pages: ArchiveEntry[]
  private readonly capacity: number
  private readonly onSize: (index: number, size: PageSize) => void
  private readonly entries = new Map<number, LoadedPage>()
  private readonly inflight = new Map<number, Promise<LoadedPage>>()
  private protectedSet = new Set<number>()
  private disposed = false

  constructor(
    reader: ArchiveReader,
    pages: ArchiveEntry[],
    onSize: (index: number, size: PageSize) => void,
    capacity = 8,
  ) {
    this.reader = reader
    this.pages = pages
    this.onSize = onSize
    this.capacity = capacity
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
    const p = this.load(index).finally(() => this.inflight.delete(index))
    this.inflight.set(index, p)
    return p
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
    const blob = await this.reader.extract(entry.name)
    if (this.disposed) throw new ArchiveError('aborted')
    const url = URL.createObjectURL(blob)
    let size: PageSize
    try {
      size = await probeImage(url)
    } catch {
      URL.revokeObjectURL(url)
      throw new ArchiveError('corrupt', `Immagine non decodificabile: ${entry.name}`)
    }
    if (this.disposed) {
      URL.revokeObjectURL(url)
      throw new ArchiveError('aborted')
    }
    const page: LoadedPage = { index, url, blob, size }
    this.entries.set(index, page)
    this.onSize(index, size)
    this.evict()
    return page
  }

  private evict(): void {
    if (this.entries.size <= this.capacity) return
    for (const [index, page] of this.entries) {
      if (this.entries.size <= this.capacity) break
      if (this.protectedSet.has(index)) continue
      this.entries.delete(index)
      URL.revokeObjectURL(page.url)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const page of this.entries.values()) URL.revokeObjectURL(page.url)
    this.entries.clear()
  }
}
