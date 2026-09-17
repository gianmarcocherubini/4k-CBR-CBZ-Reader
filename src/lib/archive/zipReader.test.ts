import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js'
import { describe, expect, it } from 'vitest'
import { openArchive } from './openArchive'
import { ArchiveError } from './types'
import { ZipArchiveReader } from './zipReader'

async function makeZip(
  entries: Array<{ name: string; data: Uint8Array | string; directory?: boolean }>,
  opts: { password?: string; zip64?: boolean } = {},
): Promise<Blob> {
  const writer = new ZipWriter(new BlobWriter('application/zip'), {
    password: opts.password,
    zip64: opts.zip64,
    useWebWorkers: false,
  })
  for (const e of entries) {
    if (e.directory) {
      await writer.add(e.name, undefined, { directory: true })
    } else if (typeof e.data === 'string') {
      await writer.add(e.name, new TextReader(e.data))
    } else {
      await writer.add(e.name, new Uint8ArrayReader(e.data))
    }
  }
  return writer.close()
}

const png = (seed: number) => {
  const bytes = new Uint8Array(1024)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  for (let i = 8; i < bytes.length; i++) bytes[i] = (i * seed) & 0xff
  return bytes
}

describe('ZipArchiveReader', () => {
  it('lists and extracts entries, including ZIP64 archives', async () => {
    const zip = await makeZip(
      [
        { name: 'vol/', data: '', directory: true },
        { name: 'vol/010.png', data: png(3) },
        { name: 'vol/002.png', data: png(5) },
        { name: 'ComicInfo.xml', data: '<ComicInfo/>' },
      ],
      { zip64: true },
    )
    const reader = new ZipArchiveReader(zip)
    const entries = await reader.entries()
    expect(entries.map((e) => [e.name, e.directory, e.size])).toEqual([
      ['vol/', true, 0],
      ['vol/010.png', false, 1024],
      ['vol/002.png', false, 1024],
      ['ComicInfo.xml', false, 12],
    ])
    const blob = await reader.extract('vol/002.png')
    expect(blob.type).toBe('image/png')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(png(5))
    await reader.close()
  })

  it('openArchive keeps only images in natural order', async () => {
    const zip = await makeZip([
      { name: 'ComicInfo.xml', data: '<ComicInfo/>' },
      { name: 'p10.png', data: png(1) },
      { name: 'p2.png', data: png(2) },
      { name: '__MACOSX/._p2.png', data: png(9) },
    ])
    const opened = await openArchive(zip)
    expect(opened.format).toBe('cbz')
    expect(opened.pages.map((p) => p.name)).toEqual(['p2.png', 'p10.png'])
    await opened.reader.close()
  })

  it('reports encrypted archives', async () => {
    const zip = await makeZip([{ name: 'p1.png', data: png(1) }], { password: 'secret' })
    const reader = new ZipArchiveReader(zip)
    const entries = await reader.entries()
    expect(entries[0]?.encrypted).toBe(true)
    await expect(reader.extract('p1.png')).rejects.toMatchObject({ code: 'encrypted' })
    await expect(openArchive(zip)).rejects.toMatchObject({ code: 'encrypted' })
  })

  it('reports archives without images as empty', async () => {
    const zip = await makeZip([{ name: 'readme.txt', data: 'hi' }])
    await expect(openArchive(zip)).rejects.toMatchObject({ code: 'empty' })
  })

  it('reports corrupt and unsupported files', async () => {
    const corrupt = new Uint8Array(2048)
    corrupt.set([0x50, 0x4b, 0x03, 0x04])
    await expect(openArchive(new Blob([corrupt]))).rejects.toMatchObject({ code: 'corrupt' })

    const sevenZip = new Uint8Array(64)
    sevenZip.set([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
    await expect(openArchive(new Blob([sevenZip]))).rejects.toBeInstanceOf(ArchiveError)
    await expect(openArchive(new Blob([sevenZip]))).rejects.toMatchObject({ code: 'unsupported' })
    await expect(openArchive(new Blob([new Uint8Array(3)]))).rejects.toMatchObject({ code: 'unsupported' })
  })

  it('a truncated archive fails on extraction, not on listing of what survived', async () => {
    const zip = await makeZip([
      { name: 'a.png', data: png(1) },
      { name: 'b.png', data: png(2) },
    ])
    const buf = new Uint8Array(await zip.arrayBuffer())
    // Cut the beginning: central directory still there, data of a.png gone.
    const cut = new Blob([buf.subarray(600)])
    const reader = new ZipArchiveReader(cut)
    await expect(reader.entries().then(() => reader.extract('a.png'))).rejects.toMatchObject({ code: 'corrupt' })
  })
})
