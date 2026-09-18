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
    const results = await searchCovers('book')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ id: '/works/ok', title: 'Valid Book', author: 'Author', year: 2020, source: 'Open Library' })
    expect(results[0]!.imageUrl).toMatch(/^https:\/\/images\.weserv\.nl\//)
    expect(new URL(results[0]!.imageUrl).searchParams.get('url')).toBe('https://covers.openlibrary.org/b/id/123-L.jpg?default=false')
  })

  it('rejects an oversized JSON response before parsing it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(1024 * 1024 + 1), { status: 200 })))
    await expect(searchCovers('book')).rejects.toThrow(/troppo grande/)
  })

  it('includes AniList when Open Library has no volume', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ docs: [] }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              Page: {
                media: [
                  {
                    id: 30013,
                    title: { english: 'Missing Series', romaji: 'Missing Series' },
                    coverImage: {
                      extraLarge: 'https://s4.anilist.co/file/anilistcdn/media/manga/cover/large/test.jpg',
                      large: 'https://s4.anilist.co/file/anilistcdn/media/manga/cover/medium/test.jpg',
                    },
                    startDate: { year: 2024 },
                  },
                ],
              },
            },
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    const results = await searchCovers('Missing Series Volume 46')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      id: 'anilist:30013',
      title: 'Missing Series · serie (ricerca Vol. 46)',
      source: 'AniList',
      year: 2024,
    })
    expect(results[0]!.imageUrl).toContain('s4.anilist.co/file/anilistcdn/media/manga/cover/')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
