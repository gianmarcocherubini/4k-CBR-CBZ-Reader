import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js'
import { describe, expect, it } from 'vitest'
import { openArchive } from './openArchive'
import { ArchiveError } from './types'
import { ZipArchiveReader } from './zipReader'

async function makeZip(
  entries: Array<{ name: string; data: Uint8Array | string; directory?: boolean }>,
  opts: { password?: string; zip64?: boolean; zipCrypto?: boolean } = {},
): Promise<Blob> {
  const writer = new ZipWriter(new BlobWriter('application/zip'), {
    password: opts.password,
    zip64: opts.zip64,
    zipCrypto: opts.zipCrypto,
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

  it('requires, validates and uses the password of encrypted archives', async () => {
    const zip = await makeZip([{ name: 'p1.png', data: png(1) }], { password: 'secret' })
    const reader = new ZipArchiveReader(zip)
    const entries = await reader.entries()
    expect(entries[0]?.encrypted).toBe(true)
    await expect(reader.extract('p1.png')).rejects.toMatchObject({ code: 'encrypted' })
    await expect(openArchive(zip)).rejects.toMatchObject({ code: 'encrypted' })
    await expect(openArchive(zip, 'wrong')).rejects.toMatchObject({ code: 'invalid-password' })

    const opened = await openArchive(zip, 'secret')
    expect(opened.pages.map((page) => page.name)).toEqual(['p1.png'])
    const extracted = await opened.reader.extract('p1.png')
    expect(new Uint8Array(await extracted.arrayBuffer())).toEqual(png(1))
    await opened.reader.close()
  })

  it('fully validates legacy ZipCrypto with CRC, not only its collision-prone header byte', async () => {
    const zip = await makeZip([{ name: 'legacy.png', data: png(7) }], { password: 'secret', zipCrypto: true })
    await expect(openArchive(zip, 'wrong')).rejects.toMatchObject({ code: 'invalid-password' })
    const opened = await openArchive(zip, 'secret')
    expect(new Uint8Array(await (await opened.reader.extract('legacy.png')).arrayBuffer())).toEqual(png(7))
    await opened.reader.close()
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

  it('rejects an oversized central directory from the EOCD before zip.js allocates it', async () => {
    const fake = new Uint8Array(64)
    const view = new DataView(fake.buffer)
    view.setUint32(0, 0x04034b50, true)
    const eocd = fake.length - 22
    view.setUint32(eocd, 0x06054b50, true)
    view.setUint16(eocd + 8, 1, true)
    view.setUint16(eocd + 10, 1, true)
    view.setUint32(eocd + 12, 128 * 1024 * 1024, true)
    view.setUint32(eocd + 16, 8, true)
    await expect(openArchive(new Blob([fake]))).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('stops the entry generator before materialising more than 50,000 objects', async () => {
    const count = 50_001
    const local = new Uint8Array(30)
    new DataView(local.buffer).setUint32(0, 0x04034b50, true)
    const records: Uint8Array[] = []
    let directorySize = 0
    for (let i = 0; i < count; i++) {
      const name = new TextEncoder().encode(`f${i.toString().padStart(5, '0')}.txt`)
      const record = new Uint8Array(46 + name.length)
      const view = new DataView(record.buffer)
      view.setUint32(0, 0x02014b50, true)
      view.setUint16(4, 20, true)
      view.setUint16(6, 20, true)
      view.setUint16(28, name.length, true)
      record.set(name, 46)
      records.push(record)
      directorySize += record.length
    }
    const end = new Uint8Array(22)
    const endView = new DataView(end.buffer)
    endView.setUint32(0, 0x06054b50, true)
    endView.setUint16(8, count, true)
    endView.setUint16(10, count, true)
    endView.setUint32(12, directorySize, true)
    endView.setUint32(16, local.length, true)
    await expect(new ZipArchiveReader(new Blob([local, ...records, end])).entries()).rejects.toMatchObject({ code: 'corrupt' })
  }, 20_000)

  it('lets zip.js resolve an appended fake EOCD without bypassing bounded reads', async () => {
    const real = await makeZip([{ name: 'p1.png', data: png(3) }])
    const fakeEocd = new Uint8Array(22)
    new DataView(fakeEocd.buffer).setUint32(0, 0x06054b50, true)
    // zip.js may select the fake empty record in tolerant/balanced recovery, but it cannot make
    // the bounded reader allocate the directory described by a different hidden record.
    await expect(openArchive(new Blob([real, fakeEocd]))).rejects.toMatchObject({ code: 'empty' })
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
