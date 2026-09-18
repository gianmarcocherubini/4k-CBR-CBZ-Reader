import {
  BlobReader,
  BlobWriter,
  configure,
  ERR_ENCRYPTED,
  ERR_ENCRYPTED_CENTRAL_DIRECTORY,
  ERR_INVALID_AUTHENTICATION_CODE,
  ERR_INVALID_COMPRESSED_DATA,
  ERR_INVALID_CRC32,
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

const MAX_ENTRIES = 50_000
const MAX_FILENAME_LENGTH = 4096
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024
const MAX_APPENDED_BYTES = 1024 * 1024

/** Enforces the allocation cap regardless of which EOCD candidate zip.js selects. */
class BoundedBlobReader extends BlobReader {
  override async readUint8Array(index: number, length: number): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(length) ||
      index < 0 ||
      length < 0 ||
      length > MAX_DIRECTORY_BYTES
    ) {
      throw new ArchiveError('corrupt', `Lettura ZIP eccessiva: ${length} byte`)
    }
    return super.readUint8Array(index, length)
  }
}

function mapZipError(e: unknown): ArchiveError {
  const message = e instanceof Error ? e.message : String(e)
  if (
    message === ERR_ENCRYPTED ||
    message === ERR_UNSUPPORTED_ENCRYPTION ||
    message === ERR_ENCRYPTED_CENTRAL_DIRECTORY
  ) {
    return new ArchiveError('encrypted', message)
  }
  if (message === ERR_INVALID_PASSWORD) return new ArchiveError('invalid-password', message)
  if (message === ERR_SPLIT_ZIP_FILE) return new ArchiveError('multivolume', message)
  return new ArchiveError('corrupt', message)
}

function mapPasswordValidationError(e: unknown): ArchiveError {
  const message = e instanceof Error ? e.message : String(e)
  if (
    message === ERR_INVALID_PASSWORD ||
    message === ERR_INVALID_CRC32 ||
    message === ERR_INVALID_AUTHENTICATION_CODE ||
    message === ERR_INVALID_COMPRESSED_DATA
  ) {
    return new ArchiveError('invalid-password', message)
  }
  return mapZipError(e)
}

/**
 * CBZ reader on top of zip.js. Reads the central directory from the end of the Blob and
 * extracts entries one at a time (ZIP64 supported), so 10 GB files never enter memory.
 */
export class ZipArchiveReader implements ArchiveReader {
  readonly format = 'cbz' as const
  private readonly reader: ZipReader<Blob>
  private readonly password?: string
  private entryMap: Map<string, FileEntry> | null = null

  constructor(blob: Blob, password?: string, signal?: AbortSignal) {
    this.password = password
    this.reader = new ZipReader(new BoundedBlobReader(blob), {
      strictness: 'balanced',
      maxAppendedDataSize: MAX_APPENDED_BYTES,
      useWebWorkers: false,
      password,
      signal,
    })
  }

  async entries(): Promise<ArchiveEntry[]> {
    const list: Entry[] = []
    try {
      for await (const entry of this.reader.getEntriesGenerator()) {
        list.push(entry)
        if (list.length > MAX_ENTRIES) throw new ArchiveError('corrupt', `Troppe voci ZIP: ${list.length}`)
      }
    } catch (e) {
      if (e instanceof ArchiveError) throw e
      throw mapZipError(e)
    }
    if ((this.reader.directoryLength ?? 0) > MAX_DIRECTORY_BYTES) {
      throw new ArchiveError('corrupt', `Directory ZIP troppo grande: ${this.reader.directoryLength} byte`)
    }
    this.entryMap = new Map()
    const out: ArchiveEntry[] = []
    for (const entry of list) {
      if (entry.filename.length > MAX_FILENAME_LENGTH) throw new ArchiveError('corrupt', 'Nome voce ZIP troppo lungo')
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) throw new ArchiveError('corrupt', `Dimensione non valida: ${entry.filename}`)
      if (!entry.directory) this.entryMap.set(entry.filename, entry)
      out.push({
        name: entry.filename,
        size: entry.uncompressedSize,
        compressedSize: entry.compressedSize,
        directory: entry.directory,
        encrypted: entry.encrypted,
      })
    }
    return out
  }

  async validatePassword(name: string, signal?: AbortSignal): Promise<void> {
    if (!this.entryMap) await this.entries()
    const entry = this.entryMap!.get(name)
    if (!entry) throw new ArchiveError('missing', `Voce non trovata: ${name}`)
    if (!entry.encrypted) return
    if (this.password === undefined) throw new ArchiveError('encrypted')
    try {
      // Full authentication, not checkPasswordOnly: ZipCrypto's one-byte verifier admits false
      // positives. CRC catches those; AES AE-2 uses its authentication code.
      const discard = {
        writable: new WritableStream<Uint8Array>({ write: () => undefined }),
        size: 0,
      }
      await entry.getData(discard, {
        password: this.password,
        checkCrc32: true,
        checkAuthenticationCode: true,
        signal,
      })
    } catch (e) {
      throw mapPasswordValidationError(e)
    }
  }

  async extract(name: string, signal?: AbortSignal): Promise<Blob> {
    if (!this.entryMap) await this.entries()
    const entry = this.entryMap!.get(name)
    if (!entry) throw new ArchiveError('missing', `Voce non trovata: ${name}`)
    if (entry.encrypted && this.password === undefined) throw new ArchiveError('encrypted')
    try {
      return await entry.getData(new BlobWriter(mimeForName(name)), {
        password: this.password,
        checkCrc32: true,
        checkAuthenticationCode: true,
        signal,
      })
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
