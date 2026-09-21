import type { Book, Progress } from '../types'

export interface ReadingState {
  page: number
  started: boolean
  finished: boolean
  /** 0–100. */
  pct: number
}

export function readingState(book: Book, progress: Progress | undefined): ReadingState {
  const page = progress?.page ?? 0
  const started = progress !== undefined && page > 0
  const finished = started && page >= book.pageCount - 1
  const pct = book.pageCount > 1 ? Math.min(100, Math.round(((page + 1) / book.pageCount) * 100)) : 0
  return { page, started, finished, pct }
}

/** Which volumes the grid shows: all, never opened, started and not finished, or finished. */
export type ReadingFilter = 'all' | 'unread' | 'reading' | 'finished'
/** Grid order: by last opening (then newest import), by title, or by import date (newest first). */
export type LibrarySort = 'recent' | 'title' | 'added'

export interface LibraryView {
  filter: ReadingFilter
  sort: LibrarySort
}

export const DEFAULT_LIBRARY_VIEW: LibraryView = { filter: 'all', sort: 'recent' }
export const READING_FILTERS: ReadonlyArray<{ value: ReadingFilter; label: string }> = [
  { value: 'all', label: 'Tutti' },
  { value: 'unread', label: 'Da leggere' },
  { value: 'reading', label: 'In lettura' },
  { value: 'finished', label: 'Finiti' },
]
export const LIBRARY_SORTS: ReadonlyArray<{ value: LibrarySort; label: string }> = [
  { value: 'recent', label: 'Recenti' },
  { value: 'title', label: 'Titolo' },
  { value: 'added', label: 'Aggiunti' },
]

const KEY = 'reader.library-view.v1'

export function normalizeLibraryView(stored: unknown): LibraryView {
  const view = { ...DEFAULT_LIBRARY_VIEW }
  if (!stored || typeof stored !== 'object') return view
  const { filter, sort } = stored as Partial<Record<keyof LibraryView, unknown>>
  if (READING_FILTERS.some((option) => option.value === filter)) view.filter = filter as ReadingFilter
  if (LIBRARY_SORTS.some((option) => option.value === sort)) view.sort = sort as LibrarySort
  return view
}

export function loadLibraryView(): LibraryView {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? normalizeLibraryView(JSON.parse(raw)) : { ...DEFAULT_LIBRARY_VIEW }
  } catch {
    return { ...DEFAULT_LIBRARY_VIEW }
  }
}

export function saveLibraryView(view: LibraryView): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(view))
  } catch {
    // Private mode / quota: the view just does not persist.
  }
}

export function matchesFilter(book: Book, progress: Progress | undefined, filter: ReadingFilter): boolean {
  if (filter === 'all') return true
  const state = readingState(book, progress)
  if (filter === 'finished') return state.finished
  if (filter === 'reading') return state.started && !state.finished
  return !state.started
}

const byTitle = (a: Book, b: Book) => a.title.localeCompare(b.title, 'it', { numeric: true, sensitivity: 'base' })

export function compareBooks(a: Book, b: Book, sort: LibrarySort): number {
  switch (sort) {
    case 'title':
      return byTitle(a, b) || b.addedAt - a.addedAt
    case 'added':
      return b.addedAt - a.addedAt || byTitle(a, b)
    case 'recent':
      return b.lastReadAt - a.lastReadAt || b.addedAt - a.addedAt || byTitle(a, b)
  }
}

/** The grid: the given books filtered by reading state and ordered as chosen. */
export function applyLibraryView(books: readonly Book[], progress: ReadonlyMap<string, Progress>, view: LibraryView): Book[] {
  return books.filter((book) => matchesFilter(book, progress.get(book.id), view.filter)).sort((a, b) => compareBooks(a, b, view.sort))
}
