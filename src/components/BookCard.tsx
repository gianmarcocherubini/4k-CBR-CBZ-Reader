import { useEffect, useState } from 'react'
import { formatBytes } from '../lib/storage/opfs'
import type { Book, Progress } from '../types'

interface BookCardProps {
  book: Book
  progress?: Progress
  onOpen: () => void
  onMenu: () => void
}

/** A book on the shelf: cover with a soft shadow, title, and reading progress like Apple Books. */
export function BookCard({ book, progress, onOpen, onMenu }: BookCardProps) {
  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!book.cover) {
      setCoverUrl(null)
      return
    }
    const url = URL.createObjectURL(book.cover)
    setCoverUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [book.cover])

  const page = progress?.page ?? 0
  const started = progress !== undefined && page > 0
  const finished = started && page >= book.pageCount - 1
  const pct = book.pageCount > 1 ? Math.min(100, Math.round(((page + 1) / book.pageCount) * 100)) : 0

  return (
    <div className="group relative flex flex-col" data-testid="book-card">
      <button type="button" className="cover relative block aspect-[3/4] w-full text-left" onClick={onOpen} aria-label={`Apri ${book.title}`}>
        {coverUrl ? (
          <img src={coverUrl} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-tertiary">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-label-3" aria-hidden>
              <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" />
              <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20" />
            </svg>
          </div>
        )}
        {book.storage === 'session' && (
          <span className="absolute top-2 left-2 rounded-full bg-tint px-2 py-0.5 text-caption font-semibold text-white">Sessione</span>
        )}
      </button>
      <div className="mt-2.5 flex items-start justify-between gap-1">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <div className="line-clamp-2 text-subhead font-semibold text-label">{book.title}</div>
          <div className="mt-0.5 truncate text-footnote text-label-2" data-testid="book-progress">
            {finished ? 'Completato' : started ? `Pagina ${page + 1} di ${book.pageCount}` : `${book.pageCount} pagine`}
          </div>
          <div className="mt-0.5 text-caption text-label-3 uppercase">
            {book.format} · {formatBytes(book.fileSize)}
          </div>
        </button>
        <button
          type="button"
          onClick={onMenu}
          aria-label={`Modifica ${book.title}`}
          className="-mr-2 shrink-0 rounded-full p-2 text-label-3 transition-colors hover:text-label-2 active:bg-fill"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="12" cy="12" r="10" opacity=".18" />
            <circle cx="7" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="17" cy="12" r="1.6" />
          </svg>
        </button>
      </div>
      {started && !finished && (
        <div className="mt-1.5 h-[3px] w-full overflow-hidden rounded-full bg-fill">
          <div className="h-full rounded-full bg-tint" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}
