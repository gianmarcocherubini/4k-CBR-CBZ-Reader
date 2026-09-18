import type { Book, Collection } from '../types'

export const DEFAULT_COLLECTION_ID = 'default'
export const ALL_COLLECTION_ID = 'all'
const GLYPH_IDS = new Set(['book-open', 'folder', 'star', 'flame', 'crown', 'compass', 'skull', 'swords', 'sparkles', 'palette', 'moon', 'bolt'])
const LEGACY_ICONS: Record<string, string> = {
  '📖': 'book-open',
  '📚': 'book-open',
  '🏴‍☠️': 'skull',
  '👒': 'compass',
  '⚔️': 'swords',
  '🔥': 'flame',
  '🐉': 'sparkles',
  '⭐': 'star',
  '🌙': 'moon',
  '💥': 'bolt',
  '🧭': 'compass',
  '🎨': 'palette',
}

export function normalizeCollectionGlyph(icon?: string): string | undefined {
  if (!icon) return undefined
  return GLYPH_IDS.has(icon) ? icon : LEGACY_ICONS[icon]
}

export interface CollectionView {
  id: string
  name: string
  count: number
  lastActivity: number
  builtIn: boolean
  icon?: string
  iconImage?: Blob
}

export function effectiveCollectionId(book: Book, knownIds: ReadonlySet<string>): string {
  return book.collectionId && knownIds.has(book.collectionId) ? book.collectionId : DEFAULT_COLLECTION_ID
}

/** Custom/default collections ordered by the latest book opening, then creation/name. */
export function collectionViews(collections: readonly Collection[], books: readonly Book[]): CollectionView[] {
  const known = new Set(collections.map((collection) => collection.id))
  const views: CollectionView[] = [
    { id: DEFAULT_COLLECTION_ID, name: 'Senza collezione', count: 0, lastActivity: 0, builtIn: true },
    ...collections.map((collection) => ({
      id: collection.id,
      name: collection.name,
      count: 0,
      lastActivity: collection.createdAt,
      builtIn: false,
      icon: normalizeCollectionGlyph(collection.icon),
      iconImage: collection.iconImage,
    })),
  ]
  const byId = new Map(views.map((view) => [view.id, view]))
  for (const book of books) {
    const view = byId.get(effectiveCollectionId(book, known))!
    view.count++
    view.lastActivity = Math.max(view.lastActivity, book.lastReadAt)
  }
  return views.sort((a, b) => b.lastActivity - a.lastActivity || a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }))
}

export function mostRecentCollectionId(collections: readonly Collection[], books: readonly Book[]): string {
  const known = new Set(collections.map((collection) => collection.id))
  const latest = books.reduce<Book | undefined>((best, book) => (!best || book.lastReadAt > best.lastReadAt ? book : best), undefined)
  return latest && latest.lastReadAt > 0 ? effectiveCollectionId(latest, known) : DEFAULT_COLLECTION_ID
}
