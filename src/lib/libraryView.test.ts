import { describe, expect, it } from 'vitest'
import type { Book, Progress } from '../types'
import { applyLibraryView, compareBooks, matchesFilter, normalizeLibraryView, readingState } from './libraryView'

const book = (id: string, over: Partial<Book> = {}): Book => ({
  id,
  title: id,
  fileName: `${id}.cbz`,
  fileSize: 1,
  format: 'cbz',
  storage: 'opfs',
  pageCount: 10,
  addedAt: 0,
  lastReadAt: 0,
  ...over,
})
const at = (bookId: string, page: number): Progress => ({ bookId, page, updatedAt: 1 })

describe('readingState', () => {
  it('distinguishes unread, reading and finished', () => {
    const b = book('a')
    expect(readingState(b, undefined)).toEqual({ page: 0, started: false, finished: false, pct: 10 })
    expect(readingState(b, at('a', 0)).started).toBe(false)
    expect(readingState(b, at('a', 4))).toMatchObject({ started: true, finished: false, pct: 50 })
    expect(readingState(b, at('a', 9))).toMatchObject({ started: true, finished: true, pct: 100 })
  })
})

describe('matchesFilter', () => {
  const b = book('a')
  it.each([
    ['all', undefined, true],
    ['unread', undefined, true],
    ['unread', at('a', 3), false],
    ['reading', at('a', 3), true],
    ['reading', at('a', 9), false],
    ['finished', at('a', 9), true],
    ['finished', at('a', 3), false],
  ] as const)('%s with page %o → %s', (filter, progress, expected) => {
    expect(matchesFilter(b, progress, filter)).toBe(expected)
  })
})

describe('compareBooks and applyLibraryView', () => {
  const recent = book('Zeta 2', { lastReadAt: 300, addedAt: 1 })
  const older = book('alpha 10', { lastReadAt: 100, addedAt: 3 })
  const never = book('Alpha 9', { lastReadAt: 0, addedAt: 2 })
  const books = [never, older, recent]

  it('recent: last opened first, then newest import', () => {
    expect([...books].sort((a, b) => compareBooks(a, b, 'recent')).map((b) => b.id)).toEqual(['Zeta 2', 'alpha 10', 'Alpha 9'])
  })
  it('title: natural, case-insensitive Italian order', () => {
    expect([...books].sort((a, b) => compareBooks(a, b, 'title')).map((b) => b.id)).toEqual(['Alpha 9', 'alpha 10', 'Zeta 2'])
  })
  it('added: newest import first', () => {
    expect([...books].sort((a, b) => compareBooks(a, b, 'added')).map((b) => b.id)).toEqual(['alpha 10', 'Alpha 9', 'Zeta 2'])
  })
  it('filters then sorts', () => {
    const progress = new Map<string, Progress>([
      ['Zeta 2', at('Zeta 2', 9)],
      ['alpha 10', at('alpha 10', 2)],
    ])
    expect(applyLibraryView(books, progress, { filter: 'reading', sort: 'title' }).map((b) => b.id)).toEqual(['alpha 10'])
    expect(applyLibraryView(books, progress, { filter: 'unread', sort: 'title' }).map((b) => b.id)).toEqual(['Alpha 9'])
    expect(applyLibraryView(books, progress, { filter: 'finished', sort: 'recent' }).map((b) => b.id)).toEqual(['Zeta 2'])
    expect(applyLibraryView(books, progress, { filter: 'all', sort: 'title' })).toHaveLength(3)
  })
})

describe('normalizeLibraryView', () => {
  it('keeps known values and falls back for the rest', () => {
    expect(normalizeLibraryView({ filter: 'finished', sort: 'title' })).toEqual({ filter: 'finished', sort: 'title' })
    expect(normalizeLibraryView({ filter: 'nope', sort: 42 })).toEqual({ filter: 'all', sort: 'recent' })
    expect(normalizeLibraryView(null)).toEqual({ filter: 'all', sort: 'recent' })
  })
})
