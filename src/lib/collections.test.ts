import { describe, expect, it } from 'vitest'
import type { Book, Collection } from '../types'
import { collectionViews, DEFAULT_COLLECTION_ID, mostRecentCollectionId, normalizeCollectionGlyph } from './collections'

const book = (id: string, collectionId: string | undefined, lastReadAt: number): Book => ({
  id,
  title: id,
  fileName: `${id}.cbz`,
  fileSize: 1,
  format: 'cbz',
  storage: 'opfs',
  pageCount: 1,
  addedAt: 1,
  lastReadAt,
  collectionId,
})

describe('collections', () => {
  const collections: Collection[] = [
    { id: 'one-piece', name: 'One Piece', createdAt: 2 },
    { id: 'berserk', name: 'Berserk', createdAt: 3 },
  ]

  it('puts unknown/unassigned books in the default collection and sorts by latest opening', () => {
    const views = collectionViews(collections, [
      book('op', 'one-piece', 100),
      book('b', 'berserk', 50),
      book('loose', undefined, 70),
      book('stale', 'deleted', 60),
    ])
    expect(views.map((view) => [view.id, view.count])).toEqual([
      ['one-piece', 1],
      [DEFAULT_COLLECTION_ID, 2],
      ['berserk', 1],
    ])
  })

  it('selects the collection of the most recently opened book', () => {
    expect(mostRecentCollectionId(collections, [book('op', 'one-piece', 100), book('b', 'berserk', 200)])).toBe('berserk')
    expect(mostRecentCollectionId(collections, [book('new', undefined, 0)])).toBe(DEFAULT_COLLECTION_ID)
  })

  it('maps the old emoji choices to the modern monochrome set and keeps no-icon empty', () => {
    expect(normalizeCollectionGlyph('🏴‍☠️')).toBe('skull')
    expect(normalizeCollectionGlyph('📖')).toBe('book-open')
    expect(normalizeCollectionGlyph(undefined)).toBeUndefined()
    expect(normalizeCollectionGlyph('unknown')).toBeUndefined()
  })
})
