import { useEffect, useState } from 'react'
import { readingState } from '../lib/libraryView'
import { formatBytes } from '../lib/storage/opfs'
import type { Book, Progress } from '../types'

/** Object URL of a book cover, revoked when the cover changes. */
export function useCoverUrl(cover: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!cover) {
      setUrl(null)
      return
    }
    const objectUrl = URL.createObjectURL(cover)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [cover])
  return url
}

const Placeholder = (
  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" className="text-label-3" aria-hidden>
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" />
    <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20" />
  </svg>
)

export function Cover({ url, alt = '', className = '' }: { url: string | null; alt?: string; className?: string }) {
  return (
    <div className={`tile ${className}`}>
      {url ? <img src={url} alt={alt} className="h-full w-full object-cover" draggable={false} /> : <div className="flex h-full w-full items-center justify-center">{Placeholder}</div>}
    </div>
  )
}

interface BookCardProps {
  book: Book
  progress?: Progress
  onOpen: () => void
  onMenu: () => void
}

/** A volume on the shelf: art that lifts on hover/focus, title, reading state, a thin progress line. */
export function BookCard({ book, progress, onOpen, onMenu }: BookCardProps) {
  const coverUrl = useCoverUrl(book.cover)
  const { page, started, finished, pct } = readingState(book, progress)
  return (
    <div className="group relative flex flex-col" data-testid="book-card">
      <button type="button" className="tile-focus relative block w-full text-left" onClick={onOpen} aria-label={`Apri ${book.title}`}>
        <Cover url={coverUrl} className="aspect-[3/4] w-full" />
        {book.storage === 'session' && (
          <span className="absolute top-2 left-2 rounded-md bg-invert/90 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-invert-fg uppercase">Sessione</span>
        )}
        {finished && (
          <span className="absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-invert/90 text-invert-fg" aria-hidden>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12 5 5L20 7" />
            </svg>
          </span>
        )}
        {started && !finished && (
          <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/25">
            <div className="h-full bg-tint" style={{ width: `${pct}%` }} />
          </div>
        )}
      </button>
      <div className="mt-3 flex items-start justify-between gap-1">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <div className="line-clamp-2 text-[14px] leading-[18px] font-medium text-label">{book.title}</div>
          <div className="mt-1 truncate text-caption text-label-2" data-testid="book-progress">
            {finished ? 'Completato' : started ? `Pagina ${page + 1} di ${book.pageCount}` : `${book.pageCount} pagine`}
            <span className="text-label-3">
              {' · '}
              {book.format.toUpperCase()} · {formatBytes(book.fileSize)}
            </span>
          </div>
        </button>
        <button
          type="button"
          onClick={onMenu}
          aria-label={`Modifica ${book.title}`}
          className="-mr-1.5 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-label-3 transition-colors hover:bg-fill hover:text-label"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="19" cy="12" r="1.8" />
          </svg>
        </button>
      </div>
    </div>
  )
}

interface ContinueCardProps {
  book: Book
  progress: Progress
  onOpen: () => void
}

/** "Continua a leggere" shelf card: cover, title, where you were, a wide progress line. */
export function ContinueCard({ book, progress, onOpen }: ContinueCardProps) {
  const coverUrl = useCoverUrl(book.cover)
  const { page, pct } = readingState(book, progress)
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Continua ${book.title}`}
      className="tile-focus flex w-[300px] shrink-0 items-center gap-4 rounded-[14px] bg-card p-3 text-left shadow-[inset_0_0_0_1px_var(--line)] transition-colors hover:bg-tertiary sm:w-[340px]"
      data-testid="continue-card"
    >
      <Cover url={coverUrl} className="h-[104px] w-[78px] shrink-0 !rounded-[7px]" />
      <div className="min-w-0 flex-1">
        <div className="eyebrow">Continua</div>
        <div className="mt-1 line-clamp-2 text-[15px] leading-[19px] font-semibold text-label">{book.title}</div>
        <div className="mt-1 text-caption text-label-2">
          Pagina {page + 1} di {book.pageCount} · {pct}%
        </div>
        <div className="mt-3 h-[3px] w-full overflow-hidden rounded-full bg-fill-2">
          <div className="h-full rounded-full bg-tint" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </button>
  )
}
