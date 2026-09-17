import { Extractor, type SeekMethod } from 'node-unrar-js'

/**
 * Synchronous random-access byte source. In a worker this is a Blob read through
 * FileReaderSync; in tests it is a plain Uint8Array.
 */
export interface SyncSource {
  readonly size: number
  /** Returns bytes [start, end). `end` is clamped to `size` by the caller. */
  read(start: number, end: number): Uint8Array
}

export function arraySource(data: Uint8Array): SyncSource {
  return {
    size: data.byteLength,
    read: (start, end) => data.subarray(start, end),
  }
}

const BLOCK = 64 * 1024
const BLOCK_CACHE_MAX_BYTES = 24 * 1024 * 1024
const WINDOW_MIN = 512 * 1024
const WINDOW_MAX = 8 * 1024 * 1024
const ARCHIVE_FD = 1

/**
 * Small-read cache: 64 KB blocks in LRU order (Map keeps insertion order).
 * Header scanning touches a few dozen bytes per entry, spread across the whole file.
 */
class BlockCache {
  private readonly blocks = new Map<number, Uint8Array>()
  private readonly source: SyncSource

  constructor(source: SyncSource) {
    this.source = source
  }

  private block(index: number): Uint8Array {
    const hit = this.blocks.get(index)
    if (hit) {
      this.blocks.delete(index)
      this.blocks.set(index, hit)
      return hit
    }
    const start = index * BLOCK
    const end = Math.min(start + BLOCK, this.source.size)
    const data = this.source.read(start, end)
    this.blocks.set(index, data)
    while (this.blocks.size * BLOCK > BLOCK_CACHE_MAX_BYTES) {
      const oldest = this.blocks.keys().next().value
      if (oldest === undefined) break
      this.blocks.delete(oldest)
    }
    return data
  }

  read(start: number, end: number): Uint8Array {
    const first = Math.floor(start / BLOCK)
    const last = Math.floor((end - 1) / BLOCK)
    if (first === last) {
      const b = this.block(first)
      const off = start - first * BLOCK
      return b.subarray(off, off + (end - start))
    }
    const out = new Uint8Array(end - start)
    let pos = 0
    for (let i = first; i <= last; i++) {
      const b = this.block(i)
      const bStart = i * BLOCK
      const from = Math.max(start, bStart) - bStart
      const to = Math.min(end, bStart + b.byteLength) - bStart
      out.set(b.subarray(from, to), pos)
      pos += to - from
    }
    return out
  }
}

/**
 * node-unrar-js `Extractor` backed by a random-access source instead of an in-memory buffer.
 *
 * unrar (WASM) calls open/read/seek/tell synchronously with 64-bit offsets, so a 10 GB CBR is
 * read lazily: headers come from a 64 KB LRU block cache, entry data from an adaptive
 * read-ahead window (0.5–8 MB). Extracted bytes are collected per output file and handed
 * back through `extract()`; nothing is retained between extractions.
 */
export class BlobExtractor extends Extractor<Uint8Array[]> {
  protected _filePath = 'archive.rar'
  private readonly source: SyncSource
  private readonly cache: BlockCache
  private pos = 0
  private window: { start: number; data: Uint8Array } | null = null
  private windowSize = WINDOW_MIN
  private nextFd = 2
  private readonly outputs = new Map<number, Uint8Array[]>()
  private readonly outputNames = new Map<number, string>()
  private readonly outputsByName = new Map<string, Uint8Array[]>()

  constructor(unrar: unknown, source: SyncSource, password = '') {
    super(unrar, password)
    this.source = source
    this.cache = new BlockCache(source)
  }

  /** Extracts and attaches the content chunks to each yielded file. */
  override extract(options: Parameters<Extractor['extract']>[0] = {}) {
    const { arcHeader, files } = super.extract(options)
    function* withContent(this: BlobExtractor) {
      for (const file of files) {
        if (!file.fileHeader.flags.directory) {
          file.extraction = this.takeOutput(file.fileHeader.name)
        }
        yield file
      }
      this.clearOutputs()
    }
    return { arcHeader, files: withContent.call(this) }
  }

  takeOutput(name: string): Uint8Array[] {
    const chunks = this.outputsByName.get(name) ?? []
    this.outputsByName.delete(name)
    return chunks
  }

  clearOutputs(): void {
    this.outputs.clear()
    this.outputNames.clear()
    this.outputsByName.clear()
  }

  private readRange(start: number, end: number): Uint8Array {
    const w = this.window
    if (w && start >= w.start && end <= w.start + w.data.byteLength) {
      return w.data.subarray(start - w.start, end - w.start)
    }
    const len = end - start
    if (len < BLOCK) return this.cache.read(start, end)
    // Large read: refill the read-ahead window. Grow it while reads stay sequential.
    if (w && start === w.start + w.data.byteLength) {
      this.windowSize = Math.min(this.windowSize * 2, WINDOW_MAX)
    } else {
      this.windowSize = WINDOW_MIN
    }
    const winEnd = Math.min(this.source.size, start + Math.max(len, this.windowSize))
    const data = this.source.read(start, winEnd)
    this.window = { start, data }
    return data.subarray(0, len)
  }

  private heap(): Uint8Array {
    return (this.unrar as { HEAPU8: Uint8Array }).HEAPU8
  }

  protected open(filename: string): number {
    if (filename !== this._filePath) return 0
    this.pos = 0
    return ARCHIVE_FD
  }

  protected create(filename: string): number {
    const fd = this.nextFd++
    const chunks: Uint8Array[] = []
    this.outputs.set(fd, chunks)
    this.outputNames.set(fd, filename)
    this.outputsByName.set(filename, chunks)
    return fd
  }

  protected read(fd: number, buf: number, size: number): number {
    if (fd !== ARCHIVE_FD) return -1
    const n = Math.min(size, this.source.size - this.pos)
    if (n <= 0) return 0
    const data = this.readRange(this.pos, this.pos + n)
    this.heap().set(data, buf)
    this.pos += n
    return n
  }

  protected write(fd: number, buf: number, size: number): boolean {
    const out = this.outputs.get(fd)
    if (!out) return false
    out.push(this.heap().slice(buf, buf + size))
    return true
  }

  protected tell(fd: number): number {
    if (fd === ARCHIVE_FD) return this.pos
    const out = this.outputs.get(fd)
    if (!out) return -1
    return out.reduce((acc, c) => acc + c.byteLength, 0)
  }

  protected seek(fd: number, pos: number, method: SeekMethod): boolean {
    if (fd !== ARCHIVE_FD) return false
    let next = this.pos
    if (method === 'SET') next = pos
    else if (method === 'CUR') next += pos
    else next = this.source.size - pos
    if (next < 0 || next > this.source.size) return false
    this.pos = next
    return true
  }

  protected closeFile(fd: number): void {
    if (fd === ARCHIVE_FD) return
    this.outputs.delete(fd)
    this.outputNames.delete(fd)
  }
}
