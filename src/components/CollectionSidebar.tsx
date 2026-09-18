import { useEffect, useState } from 'react'
import { ALL_COLLECTION_ID, type CollectionView } from '../lib/collections'

interface CollectionSidebarProps {
  collections: CollectionView[]
  selectedId: string
  onSelect: (id: string) => void
  onCreate: () => void
  onEdit: (collection: CollectionView) => void
  onDelete: (collection: CollectionView) => void
  total: number
}

function CollectionIcon({ collection }: { collection: CollectionView }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!collection.iconImage) {
      setUrl(null)
      return
    }
    const objectUrl = URL.createObjectURL(collection.iconImage)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [collection.iconImage])
  return url ? (
    <img src={url} alt="" className="h-6 w-6 shrink-0 rounded-md object-cover" />
  ) : (
    <span className="w-6 shrink-0 text-center text-base" aria-hidden>{collection.icon}</span>
  )
}

function CollectionButton({
  collection,
  selected,
  onSelect,
  onEdit,
  onDelete,
}: {
  collection: CollectionView
  selected: boolean
  onSelect: () => void
  onEdit?: () => void
  onDelete?: () => void
}) {
  return (
    <div className="group/collection flex items-center gap-1">
      <button
        type="button"
        className={`flex min-h-[38px] min-w-0 flex-1 items-center justify-between gap-2 rounded-xl px-3 text-left text-subhead transition-colors ${
          selected ? 'bg-tint-soft font-semibold text-tint' : 'text-label hover:bg-fill'
        }`}
        onClick={onSelect}
        aria-pressed={selected}
        data-testid={`collection-${collection.id}`}
      >
        <span className="flex min-w-0 items-center gap-2">
          <CollectionIcon collection={collection} />
          <span className="truncate">{collection.name}</span>
        </span>
        <span className="shrink-0 text-caption text-label-3 tabular-nums">{collection.count}</span>
      </button>
      {onEdit && onDelete && (
        <div className="flex shrink-0">
          <button type="button" className="rounded-full p-1.5 text-label-3 opacity-60 hover:opacity-100" aria-label={`Modifica collezione ${collection.name}`} onClick={onEdit}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="m4 20 4.5-1 10-10a2 2 0 0 0-3-3l-10 10L4 20Zm9.5-12.5 3 3" />
            </svg>
          </button>
          <button type="button" className="rounded-full p-1.5 text-label-3 opacity-60 hover:opacity-100" aria-label={`Elimina collezione ${collection.name}`} onClick={onDelete}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}

export function CollectionSidebar({ collections, selectedId, onSelect, onCreate, onEdit, onDelete, total }: CollectionSidebarProps) {
  const all: CollectionView = { id: ALL_COLLECTION_ID, name: 'Tutti i libri', count: total, lastActivity: 0, builtIn: true, icon: '▦' }
  return (
    <>
      <aside className="hidden w-60 shrink-0 border-r border-separator px-4 pt-6 md:block" aria-label="Collezioni">
        <div className="mb-3 flex items-center justify-between px-2">
          <h2 className="text-headline">Collezioni</h2>
          <button type="button" className="btn-icon h-8 w-8" onClick={onCreate} aria-label="Nuova collezione" data-testid="new-collection">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
        <nav className="space-y-1">
          {collections.map((collection) => (
            <CollectionButton
              key={collection.id}
              collection={collection}
              selected={selectedId === collection.id}
              onSelect={() => onSelect(collection.id)}
              onEdit={collection.builtIn ? undefined : () => onEdit(collection)}
              onDelete={collection.builtIn ? undefined : () => onDelete(collection)}
            />
          ))}
          <div className="my-2 border-t border-separator" />
          <CollectionButton collection={all} selected={selectedId === ALL_COLLECTION_ID} onSelect={() => onSelect(ALL_COLLECTION_ID)} />
        </nav>
      </aside>

      <div className="flex gap-2 overflow-x-auto border-b border-separator px-5 py-3 md:hidden" aria-label="Collezioni">
        {[...collections, all].map((collection) => (
          <div
            key={collection.id}
            className={`flex shrink-0 items-center overflow-hidden rounded-full ${
              selectedId === collection.id ? 'bg-tint font-semibold text-white' : 'bg-fill text-label'
            }`}
          >
            <button type="button" className="flex items-center gap-1.5 px-3 py-1.5 text-footnote" onClick={() => onSelect(collection.id)} data-testid={`mobile-collection-${collection.id}`}>
              <CollectionIcon collection={collection} /> {collection.name} · {collection.count}
            </button>
            {!collection.builtIn && (
              <>
                <button type="button" className="border-l border-white/25 px-2 py-1.5 text-footnote" aria-label={`Modifica collezione ${collection.name}`} onClick={() => onEdit(collection)}>✎</button>
                <button type="button" className="border-l border-white/25 px-2 py-1.5 text-footnote" aria-label={`Elimina collezione ${collection.name}`} onClick={() => onDelete(collection)}>×</button>
              </>
            )}
          </div>
        ))}
        <button type="button" className="btn-pill shrink-0" onClick={onCreate} aria-label="Nuova collezione">
          +
        </button>
      </div>
    </>
  )
}
