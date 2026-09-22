import type { BookFormat } from '../../types'
import { detectBlob } from '../detect'
import { type ArchiveEntry, pageEntries } from '../entries'
import { epubPages, isEpub } from './epub'
import { PdfArchiveReader } from './pdfReader'
import { RarArchiveReader } from './rarReader'
import { TarArchiveReader } from './tarReader'
import { ArchiveError, type ArchiveReader } from './types'
import { ZipArchiveReader } from './zipReader'

const MAX_PAGES = 20_000
const MAX_PAGE_BYTES = 64 * 1024 * 1024
const MAX_PAGE_COMPRESSION_RATIO = 1000

export interface OpenedArchive {
  reader: ArchiveReader
  format: BookFormat
  /** Image entries in reading order. */
  pages: ArchiveEntry[]
}

/** Containers whose password prompt is worth showing: the reader can retry them with one. */
export function supportsPassword(format: BookFormat): boolean {
  return format === 'cbz' || format === 'epub' || format === 'pdf'
}

/** Detects the container, opens it and lists its pages. Throws ArchiveError. */
export async function openArchive(blob: Blob, password?: string, signal?: AbortSignal): Promise<OpenedArchive> {
  const kind = await detectBlob(blob)
  let reader: ArchiveReader
  switch (kind) {
    case 'zip':
      reader = new ZipArchiveReader(blob, password, signal)
      break
    case 'rar4':
    case 'rar5':
      reader = new RarArchiveReader(blob)
      break
    case 'tar':
      reader = new TarArchiveReader(blob)
      break
    case 'pdf':
      // Opening validates the password: pdf.js rejects with encrypted / invalid-password.
      reader = await PdfArchiveReader.open(blob, password, signal)
      break
    default:
      throw new ArchiveError('unsupported', `Contenitore: ${kind}`)
  }
  try {
    const entries = await reader.entries()
    let format: BookFormat = reader.format
    let pages: ArchiveEntry[]
    if (kind === 'zip' && isEpub(entries)) {
      format = 'epub'
      pages = await epubPages(reader, entries, signal)
    } else {
      pages = pageEntries(entries)
    }
    if (pages.length === 0) {
      if (entries.some((e) => e.encrypted)) throw new ArchiveError('encrypted')
      throw new ArchiveError('empty')
    }
    if (pages.length > MAX_PAGES) throw new ArchiveError('corrupt', `Troppe pagine: ${pages.length}`)
    for (const page of pages) {
      if (!Number.isSafeInteger(page.size) || page.size < 0 || page.size > MAX_PAGE_BYTES) {
        throw new ArchiveError('corrupt', `Pagina troppo grande: ${page.name}`)
      }
      if (page.compressedSize && page.compressedSize > 0 && page.size / page.compressedSize > MAX_PAGE_COMPRESSION_RATIO) {
        throw new ArchiveError('corrupt', `Rapporto di compressione eccessivo: ${page.name}`)
      }
    }
    // Ask before import even when only some image entries are encrypted; otherwise the book would
    // import successfully and fail later on an arbitrary page.
    if (pages.some((p) => p.encrypted) && password === undefined) throw new ArchiveError('encrypted')
    const encryptedPage = pages.find((page) => page.encrypted)
    if (encryptedPage && password !== undefined) await reader.validatePassword?.(encryptedPage.name, signal)
    return { reader, format, pages }
  } catch (e) {
    await reader.close()
    throw e
  }
}
