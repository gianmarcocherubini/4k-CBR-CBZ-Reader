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
        className="w-full max-w-sm overflow-hidden rounded-[16px] bg-card shadow-sheet"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          if (trimmed) onSave(trimmed, collectionId === DEFAULT_COLLECTION_ID ? undefined : collectionId)
        }}
        data-testid="book-edit-dialog"
      >
        <div className="px-6 pt-6 pb-2">
          <h2 id="book-edit-title" className="text-title2">
            Modifica volume
          </h2>
          <label className="eyebrow mt-5 block">
            Titolo
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
              maxLength={180}
              className="field mt-1.5 !text-[15px] !font-normal !tracking-normal !normal-case"
              data-testid="book-title-input"
            />
          </label>
          <label className="eyebrow mt-4 block">
            Collezione
            <select
              value={collectionId}
              onChange={(event) => setCollectionId(event.currentTarget.value)}
              className="field mt-1.5 appearance-none !text-[15px] !font-normal !tracking-normal !normal-case"
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
            className="btn-ghost mt-5 w-full !min-h-[36px] !text-[13px]"
            disabled={!trimmed}
            onClick={() => onCoverSearch(trimmed, collectionId === DEFAULT_COLLECTION_ID ? undefined : collectionId)}
          >
            Cerca copertina online
          </button>
        </div>
        <div className="flex items-center justify-between gap-2 px-6 pt-4 pb-6">
          <button type="button" className="btn-ghost !min-h-[36px] !px-3.5 !text-[13px] !text-red" onClick={onDelete}>
            Elimina
          </button>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost !min-h-[36px] !px-3.5 !text-[13px]" onClick={onCancel}>
              Annulla
            </button>
            <button type="submit" disabled={!trimmed} className="btn-primary !min-h-[36px] !px-3.5 !text-[13px]">
              Salva
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
