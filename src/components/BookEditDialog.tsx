import { useState } from 'react'
import { DEFAULT_COLLECTION_ID } from '../lib/collections'
import type { Book, Collection } from '../types'

interface BookEditDialogProps {
  book: Book
  collections: readonly Collection[]
  onSave: (title: string, collectionId?: string) => void
  onCoverSearch: (title: string, collectionId?: string) => void
  onDelete: () => void
  onCancel: () => void
}

export function BookEditDialog({ book, collections, onSave, onCoverSearch, onDelete, onCancel }: BookEditDialogProps) {
  const [title, setTitle] = useState(book.title)
  const known = new Set(collections.map((collection) => collection.id))
  const [collectionId, setCollectionId] = useState(book.collectionId && known.has(book.collectionId) ? book.collectionId : DEFAULT_COLLECTION_ID)
  const trimmed = title.trim()

  return (
    <div className="fade-enter fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6 backdrop-blur-sm" role="presentation" onClick={onCancel}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="book-edit-title"
        className="material-strong w-full max-w-sm overflow-hidden rounded-2xl shadow-sheet"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          if (trimmed) onSave(trimmed, collectionId === DEFAULT_COLLECTION_ID ? undefined : collectionId)
        }}
        data-testid="book-edit-dialog"
      >
        <div className="px-5 pt-5 pb-4">
          <h2 id="book-edit-title" className="text-center text-headline">
            Modifica volume
          </h2>
          <label className="mt-4 block text-footnote text-label-2">
            Titolo
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
              maxLength={180}
              className="mt-1 min-h-[44px] w-full rounded-xl border border-separator bg-card px-3 text-body text-label outline-none focus:border-tint"
              data-testid="book-title-input"
            />
          </label>
          <label className="mt-4 block text-footnote text-label-2">
            Collezione
            <select
              value={collectionId}
              onChange={(event) => setCollectionId(event.currentTarget.value)}
              className="mt-1 min-h-[44px] w-full appearance-none rounded-xl border border-separator bg-card px-3 text-body text-label outline-none focus:border-tint"
              data-testid="book-collection-select"
            >
              <option value={DEFAULT_COLLECTION_ID}>Senza collezione</option>
              {collections.map((collection) => (
                <option key={collection.id} value={collection.id}>
                  {collection.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn-ghost mt-4 w-full"
            disabled={!trimmed}
            onClick={() => onCoverSearch(trimmed, collectionId === DEFAULT_COLLECTION_ID ? undefined : collectionId)}
          >
            Cerca copertina online
          </button>
        </div>
        <div className="grid grid-cols-2 border-t border-separator">
          <button type="button" className="min-h-[44px] border-r border-separator text-body text-red active:bg-fill" onClick={onDelete}>
            Elimina
          </button>
          <button type="submit" disabled={!trimmed} className="min-h-[44px] text-body font-semibold text-tint disabled:opacity-35 active:bg-fill">
            Salva
          </button>
        </div>
      </form>
    </div>
  )
}
