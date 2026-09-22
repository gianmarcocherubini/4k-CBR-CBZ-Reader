import { type ArchiveEntry, mimeForName } from '../entries'
import { ArchiveError, type ArchiveReader } from './types'

/**
 * CBT: an uncompressed tar. Headers are 512-byte blocks followed by the file data padded to 512;
 * the whole index is read with one small slice per header, and a page is one slice of the Blob.
 * Handles ustar prefixes, GNU long names ('L') and pax extended headers ('x', `path=`).
 */

const BLOCK = 512
const MAX_ENTRIES = 50_000
const MAX_NAME = 4096
const MAX_META_BYTES = 1024 * 1024

interface TarEntry extends ArchiveEntry {
  offset: number
}

const decoder = new TextDecoder()

function field(block: Uint8Array, start: number, length: number): string {
  let end = start
  while (end < start + length && block[end] !== 0) end++
  return decoder.decode(block.subarray(start, end))
}

/** Sizes are octal, or base-256 when the high bit of the first byte is set (GNU, files ≥ 8 GB). */
function numeric(block: Uint8Array, start: number, length: number): number {
  if (block[start]! & 0x80) {
    let value = 0
    for (let i = start + 1; i < start + length; i++) value = value * 256 + block[i]!
    return value
  }
  const text = field(block, start, length).trim()
  return text ? parseInt(text, 8) : 0
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((b) => b === 0)
}

export class TarArchiveReader implements ArchiveReader {
  readonly format = 'cbt' as const
  private index: TarEntry[] | null = null
  private readonly blob: Blob

  constructor(blob: Blob) {
    this.blob = blob
  }

  async entries(): Promise<ArchiveEntry[]> {
    if (this.index) return this.index
    const entries: TarEntry[] = []
    let offset = 0
    let longName: string | null = null
    let paxPath: string | null = null
    while (offset + BLOCK <= this.blob.size) {
      const block = new Uint8Array(await this.blob.slice(offset, offset + BLOCK).arrayBuffer())
      if (isZeroBlock(block)) break
      const size = numeric(block, 124, 12)
      if (!Number.isSafeInteger(size) || size < 0 || offset + BLOCK + size > this.blob.size) throw new ArchiveError('corrupt', `Voce tar oltre la fine del file a ${offset}`)
      const type = String.fromCharCode(block[156]!)
      const dataStart = offset + BLOCK
      const padded = Math.ceil(size / BLOCK) * BLOCK
      if (type === 'L' || type === 'x' || type === 'g') {
        if (size > MAX_META_BYTES) throw new ArchiveError('corrupt', 'Intestazione tar eccessiva')
        const text = decoder.decode(new Uint8Array(await this.blob.slice(dataStart, dataStart + size).arrayBuffer()))
        if (type === 'L') longName = text.replace(/\0+$/, '')
        else if (type === 'x') {
          // "<len> path=<value>\n" records; only the path matters here.
          for (const m of text.matchAll(/(\d+) ([^=\n]+)=([^\n]*)\n/g)) if (m[2] === 'path') paxPath = m[3]!
        }
        offset = dataStart + padded
        continue
      }
      let name = paxPath ?? longName ?? field(block, 0, 100)
      if (paxPath === null && longName === null && field(block, 257, 5) === 'ustar') {
        const prefix = field(block, 345, 155)
        if (prefix) name = `${prefix}/${name}`
      }
      paxPath = null
      longName = null
      if (name.length > MAX_NAME) throw new ArchiveError('corrupt', 'Nome di file tar eccessivo')
      const directory = type === '5' || name.endsWith('/')
      // '0', '\0' and '7' are regular files; links, devices and FIFOs are listed but never pages.
      if (name) entries.push({ name: name.replace(/\/+$/, ''), size: directory ? 0 : size, directory, encrypted: false, offset: dataStart })
      if (entries.length > MAX_ENTRIES) throw new ArchiveError('corrupt', `Troppe voci: ${entries.length}`)
      offset = dataStart + padded
    }
    this.index = entries
    return entries
  }

  async extract(name: string, signal?: AbortSignal): Promise<Blob> {
    if (signal?.aborted) throw new ArchiveError('aborted')
    const entry = (await this.entries()).find((e) => e.name === name) as TarEntry | undefined
    if (!entry || entry.directory) throw new ArchiveError('missing', name)
    return this.blob.slice(entry.offset, entry.offset + entry.size, mimeForName(name))
  }

  async close(): Promise<void> {
    this.index = null
  }
}
