import { naturalCompare } from './naturalSort'

export interface ArchiveEntry {
  /** Full path inside the archive. */
  name: string
  /** Uncompressed size in bytes (may be 0 when unknown). */
  size: number
  directory: boolean
  encrypted: boolean
}

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif', 'jxl'])

export function mimeForName(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'bmp':
      return 'image/bmp'
    case 'avif':
      return 'image/avif'
    case 'heic':
    case 'heif':
      return 'image/heic'
    case 'jxl':
      return 'image/jxl'
    default:
      return 'application/octet-stream'
  }
}

export function isImageEntry(entry: ArchiveEntry): boolean {
  if (entry.directory) return false
  const path = entry.name.replace(/\\/g, '/')
  const parts = path.split('/')
  const base = parts[parts.length - 1] ?? ''
  if (!base || base.startsWith('.')) return false // ._resource forks, .DS_Store
  if (parts.some((p) => p === '__MACOSX')) return false
  if (/^thumbs\.db$/i.test(base)) return false
  const dot = base.lastIndexOf('.')
  if (dot < 0) return false
  return IMAGE_EXT.has(base.slice(dot + 1).toLowerCase())
}

/** Keeps image entries and returns them in reading order (natural sort on the full path). */
export function pageEntries(entries: ArchiveEntry[]): ArchiveEntry[] {
  return entries
    .filter(isImageEntry)
    .sort((a, b) => naturalCompare(a.name.replace(/\\/g, '/'), b.name.replace(/\\/g, '/')))
}
