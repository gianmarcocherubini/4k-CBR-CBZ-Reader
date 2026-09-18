import { useState } from 'react'

interface CollectionDialogProps {
  existingNames: readonly string[]
  onSave: (name: string) => void
  onCancel: () => void
}

export function CollectionDialog({ existingNames, onSave, onCancel }: CollectionDialogProps) {
  const [name, setName] = useState('')
  const trimmed = name.trim()
  const duplicate = existingNames.some((existing) => existing.localeCompare(trimmed, 'it', { sensitivity: 'base' }) === 0)
  return (
    <div className="fade-enter fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6 backdrop-blur-sm" role="presentation" onClick={onCancel}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="collection-dialog-title"
        className="material-strong w-full max-w-sm overflow-hidden rounded-2xl shadow-sheet"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          if (trimmed && !duplicate) onSave(trimmed)
        }}
      >
        <div className="px-5 pt-5 pb-4">
          <h2 id="collection-dialog-title" className="text-center text-headline">
            Nuova collezione
          </h2>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            maxLength={80}
            aria-label="Nome collezione"
            className="mt-4 min-h-[44px] w-full rounded-xl border border-separator bg-card px-3 text-body text-label outline-none focus:border-tint"
          />
          {duplicate && <p className="mt-2 text-footnote text-red">Esiste già una collezione con questo nome.</p>}
        </div>
        <div className="grid grid-cols-2 border-t border-separator">
          <button type="button" className="min-h-[44px] border-r border-separator text-body text-tint active:bg-fill" onClick={onCancel}>
            Annulla
          </button>
          <button type="submit" disabled={!trimmed || duplicate} className="min-h-[44px] text-body font-semibold text-tint disabled:opacity-35 active:bg-fill">
            Crea
          </button>
        </div>
      </form>
    </div>
  )
}
