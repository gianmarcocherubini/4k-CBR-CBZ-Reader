import type { BookFormat } from '../../types'
import { detectBlob } from '../detect'
import { type ArchiveEntry, pageEntries } from '../entries'
import { RarArchiveReader } from './rarReader'
import { ArchiveError, type ArchiveReader } from './types'
import { ZipArchiveReader } from './zipReader'

export interface OpenedArchive {
  reader: ArchiveReader
  format: BookFormat
  /** Image entries in reading order. */
  pages: ArchiveEntry[]
}

/** Detects the container, opens it and lists its pages. Throws ArchiveError. */
export async function openArchive(blob: Blob): Promise<OpenedArchive> {
  const kind = await detectBlob(blob)
  let reader: ArchiveReader
  switch (kind) {
    case 'zip':
      reader = new ZipArchiveReader(blob)
      break
    case 'rar4':
    case 'rar5':
      reader = new RarArchiveReader(blob)
      break
    default:
      throw new ArchiveError('unsupported', `Contenitore: ${kind}`)
  }
  try {
    const entries = await reader.entries()
    const pages = pageEntries(entries)
    if (pages.length === 0) {
      if (entries.some((e) => e.encrypted)) throw new ArchiveError('encrypted')
      throw new ArchiveError('empty')
    }
    // Encrypted pages cannot be shown: fail now instead of at the first page.
    if (pages.every((p) => p.encrypted)) throw new ArchiveError('encrypted')
    return { reader, format: reader.format, pages }
  } catch (e) {
    await reader.close()
    throw e
  }
}
