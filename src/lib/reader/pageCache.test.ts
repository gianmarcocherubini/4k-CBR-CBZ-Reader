import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArchiveReader } from '../archive/types'
import type { ArchiveEntry } from '../entries'
import { PageCache } from './pageCache'

function pngHeader(w: number, h: number): Blob {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, w, false)
  view.setUint32(20, h, false)
  return new Blob([bytes], { type: 'image/png' })
}

const page: ArchiveEntry = { name: 'p.png', size: 24, compressedSize: 24, directory: false, encrypted: false }
const reader: ArchiveReader = {
  format: 'cbz',
  entries: async () => [page],
  extract: async () => pngHeader(5, 5),
  close: async () => undefined,
}

describe('PageCache memory reservations', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('enforces the byte budget even for a visible/protected page', async () => {
    const cache = new PageCache(reader, [page], () => undefined, 8, 100, 2)
    cache.protect([0])
    await expect(cache.get(0)).rejects.toMatchObject({ code: 'memory' })
    cache.dispose()
  })

  it('silently skips an over-budget preload so it can retry when visible', async () => {
    const cache = new PageCache(reader, [page], () => undefined, 8, 100, 2)
    cache.protect([])
    await expect(cache.get(0)).rejects.toMatchObject({ code: 'aborted' })
    cache.dispose()
  })

  it('evicts an old preload to admit an incoming visible page', async () => {
    vi.stubGlobal(
      'Image',
      class {
        decoding = ''
        src = ''
        naturalWidth = 5
        naturalHeight = 5
        complete = true
        async decode() {}
      },
    )
    const pages = [{ ...page, name: 'p1.png' }, { ...page, name: 'p2.png' }]
    const cache = new PageCache(reader, pages, () => undefined, 8, 150, 1)
    cache.protect([])
    await cache.get(0)
    cache.protect([1])
    await cache.get(1)
    expect(cache.peek(0)).toBeUndefined()
    expect(cache.peek(1)).toBeDefined()
    cache.dispose()
  })
})
