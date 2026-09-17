import {
  BlobReader,
  BlobWriter,
  configure,
  ERR_ENCRYPTED,
  ERR_ENCRYPTED_CENTRAL_DIRECTORY,
  ERR_INVALID_PASSWORD,
  ERR_SPLIT_ZIP_FILE,
  ERR_UNSUPPORTED_ENCRYPTION,
  type Entry,
  type FileEntry,
  ZipReader,
} from '@zip.js/zip.js'
import { type ArchiveEntry, mimeForName } from '../entries'
import { ArchiveError, type ArchiveReader } from './types'

// Decompress with the native DecompressionStream (Safari 16.4+, Chrome 80+) on the calling
// thread: entries are streamed, so this stays cheap and avoids shipping zip.js worker scripts.
configure({ useWebWorkers: false, useCompressionStream: true })

function mapZipError(e: unknown): ArchiveError {
  const message = e instanceof Error ? e.message : String(e)
  if (
    message === ERR_ENCRYPTED ||
    message === ERR_INVALID_PASSWORD ||
    message === ERR_UNSUPPORTED_ENCRYPTION ||
    message === ERR_ENCRYPTED_CENTRAL_DIRECTORY
  ) {
    return new ArchiveError('encrypted', message)
  }
  if (message === ERR_SPLIT_ZIP_FILE) return new ArchiveError('multivolume', message)
  return new ArchiveError('corrupt', message)
}

/**
 * CBZ reader on top of zip.js. Reads the central directory from the end of the Blob and
 * extracts entries one at a time (ZIP64 supported), so 10 GB files never enter memory.
 */
export class ZipArchiveReader implements ArchiveReader {
  readonly format = 'cbz' as const
  private readonly reader: ZipReader<Blob>
  private entryMap: Map<string, FileEntry> | null = null

  constructor(blob: Blob) {
    this.reader = new ZipReader(new BlobReader(blob), { strictness: 'tolerant', useWebWorkers: false })
  }

  async entries(): Promise<ArchiveEntry[]> {
    let list: Entry[]
    try {
      list = await this.reader.getEntries()
    } catch (e) {
      throw mapZipError(e)
    }
    this.entryMap = new Map()
    const out: ArchiveEntry[] = []
    for (const entry of list) {
      if (!entry.directory) this.entryMap.set(entry.filename, entry)
      out.push({
        name: entry.filename,
        size: entry.uncompressedSize,
        directory: entry.directory,
        encrypted: entry.encrypted,
      })
    }
    return out
  }

  async extract(name: string): Promise<Blob> {
    if (!this.entryMap) await this.entries()
    const entry = this.entryMap!.get(name)
    if (!entry) throw new ArchiveError('missing', `Voce non trovata: ${name}`)
    if (entry.encrypted) throw new ArchiveError('encrypted')
    try {
      return await entry.getData(new BlobWriter(mimeForName(name)))
    } catch (e) {
      throw mapZipError(e)
    }
  }

  async close(): Promise<void> {
    try {
      await this.reader.close()
    } catch {
      // ignore
    }
  }
}
