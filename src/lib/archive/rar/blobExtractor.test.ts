import { readFileSync } from 'node:fs'
import { getUnrar } from 'node-unrar-js/esm/js/unrar.singleton'
import { beforeAll, describe, expect, it } from 'vitest'
import { arraySource, BlobExtractor, type SyncSource } from './blobExtractor'

type UnrarModule = { HEAPU8: Uint8Array; extractor?: unknown }

let unrar: UnrarModule

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)))

function makeExtractor(source: SyncSource, password?: string) {
  const ex = new BlobExtractor(unrar, source, password)
  unrar.extractor = ex
  return ex
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let pos = 0
  for (const c of chunks) {
    out.set(c, pos)
    pos += c.byteLength
  }
  return out
}

beforeAll(async () => {
  const wasmBinary = readFileSync(new URL('../../../../node_modules/node-unrar-js/esm/js/unrar.wasm', import.meta.url))
  unrar = (await getUnrar({ wasmBinary })) as UnrarModule
})

describe('BlobExtractor over a random-access source', () => {
  it('lists headers of an archive with folders (RAR 4)', () => {
    const ex = makeExtractor(arraySource(fixture('FolderTest.rar')))
    const { arcHeader, fileHeaders } = ex.getFileList()
    expect(arcHeader.flags.solid).toBe(false)
    expect(arcHeader.flags.volume).toBe(false)
    const list = [...fileHeaders]
    expect(list.map((h) => [h.name, h.flags.directory, h.unpSize])).toEqual([
      ['Folder1/Folder Space/long.txt', false, 1049076],
      ['Folder1/Folder 中文/2中文.txt', false, 15],
      ['Folder1/Folder Space', true, 0],
      ['Folder1/Folder 中文', true, 0],
      ['Folder1', true, 0],
    ])
  })

  it('extracts a single ~1 MB compressed entry through chunked writes', () => {
    const ex = makeExtractor(arraySource(fixture('FolderTest.rar')))
    const { files } = ex.extract({ files: ['Folder1/Folder Space/long.txt'] })
    const list = [...files]
    expect(list).toHaveLength(1)
    const data = concat(list[0]!.extraction!)
    expect(data.byteLength).toBe(1049076)
    let long = ''
    let i = 0
    while (long.length < 1024 * 1024) long += '1' + '0'.repeat(i++)
    expect(new TextDecoder().decode(data)).toBe(long)
    // Nothing retained after the generator completes.
    expect(ex.takeOutput('Folder1/Folder Space/long.txt')).toEqual([])
  })

  it('extracts a later entry without touching earlier ones, repeatedly', () => {
    const ex = makeExtractor(arraySource(fixture('FolderTest.rar')))
    for (let round = 0; round < 3; round++) {
      const { files } = ex.extract({ files: ['Folder1/Folder 中文/2中文.txt'] })
      const list = [...files]
      expect(list).toHaveLength(1)
      const data = concat(list[0]!.extraction!)
      expect(Array.from(data.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf])
      expect(new TextDecoder().decode(data.subarray(3))).toBe('中文中文')
    }
  })

  it('reports encrypted entries and refuses to extract them without a password', () => {
    const ex = makeExtractor(arraySource(fixture('FileEncByName.rar')))
    const list = [...ex.getFileList().fileHeaders]
    expect(list.map((h) => [h.name, h.flags.encrypted])).toEqual([
      ['1File.txt', false],
      ['2中文.txt', true],
      ['3Sec.txt', true],
    ])
    const plain = [...ex.extract({ files: ['1File.txt'] }).files]
    expect(new TextDecoder().decode(concat(plain[0]!.extraction!))).toBe('1File')
    expect(() => [...ex.extract({ files: ['3Sec.txt'] }).files]).toThrowError(
      expect.objectContaining({ reason: 'ERAR_MISSING_PASSWORD' }),
    )
  })

  it('fails to open an archive with encrypted headers without a password', () => {
    const ex = makeExtractor(arraySource(fixture('HeaderEnc1234.rar')))
    expect(() => ex.getFileList()).toThrowError(expect.objectContaining({ reason: 'ERAR_MISSING_PASSWORD' }))
    const ok = makeExtractor(arraySource(fixture('HeaderEnc1234.rar')), '1234')
    expect([...ok.getFileList().fileHeaders].map((h) => h.name).sort()).toEqual(['1File.txt', '2中文.txt'])
  })

  it('rejects garbage after a RAR signature and truncated archives', () => {
    const garbage = new Uint8Array(4096)
    garbage.set([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])
    for (let i = 7; i < garbage.length; i++) garbage[i] = (i * 2654435761) >>> 24
    expect(() => [...makeExtractor(arraySource(garbage)).getFileList().fileHeaders]).toThrow()

    const truncated = fixture('FolderTest.rar').subarray(0, 3000)
    const ex = makeExtractor(arraySource(truncated))
    expect(() => [...ex.extract({ files: ['Folder1/Folder Space/long.txt'] }).files]).toThrow()
  })

  it('serves small header reads from the block cache and large reads from the window', () => {
    const data = fixture('FolderTest.rar')
    const reads: Array<[number, number]> = []
    const source: SyncSource = {
      size: data.byteLength,
      read: (s, e) => {
        reads.push([s, e])
        return data.subarray(s, e)
      },
    }
    const ex = makeExtractor(source)
    const list = [...ex.getFileList().fileHeaders]
    expect(list).toHaveLength(5)
    // A 5.6 KB archive fits in one 64 KB block: every header read hits the same cached block.
    expect(reads).toEqual([[0, data.byteLength]])
  })
})
