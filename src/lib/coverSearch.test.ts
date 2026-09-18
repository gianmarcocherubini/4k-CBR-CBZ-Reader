import { afterEach, describe, expect, it, vi } from 'vitest'
import { coverQueryFromTitle, searchCovers } from './coverSearch'

describe('coverQueryFromTitle', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps series and volume while removing scan/release noise', () => {
    expect(coverQueryFromTitle('[Group] One_Piece - Volume 46 - Digital Colored Comics [CBZ]')).toBe('One Piece Volume 46')
  })

  it('ignores malformed remote fields instead of passing objects into React', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            docs: [
              { key: {}, title: { unsafe: true }, cover_i: '123', author_name: [42] },
              { key: '/works/ok', title: 'Valid Book', cover_i: 123, author_name: ['Author'], first_publish_year: 2020 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
    await expect(searchCovers('book')).resolves.toEqual([
      {
        id: '/works/ok',
        title: 'Valid Book',
        author: 'Author',
        year: 2020,
        imageUrl: 'https://covers.openlibrary.org/b/id/123-L.jpg',
        previewUrl: 'https://covers.openlibrary.org/b/id/123-M.jpg',
      },
    ])
  })

  it('rejects an oversized JSON response before parsing it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(1024 * 1024 + 1), { status: 200 })))
    await expect(searchCovers('book')).rejects.toThrow(/troppo grande/)
  })
})
