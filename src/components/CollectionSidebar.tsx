import { useEffect, useState } from 'react'
import { ALL_COLLECTION_ID, type CollectionView } from '../lib/collections'
import { CollectionGlyph } from './CollectionGlyph'

interface CollectionSidebarProps {
  collections: CollectionView[]
  selectedId: string
  onSelect: (id: string) => void
  onCreate: () => void
  onMenu: (collection: CollectionView) => void
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
  ) : collection.icon ? <CollectionGlyph icon={collection.icon} className="h-5 w-5 shrink-0" /> : null
}

function CollectionButton({
  collection,
  selected,
  onSelect,
  onMenu,
}: {
  collection: CollectionView
  selected: boolean
  onSelect: () => void
  onMenu?: () => void
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
      {onMenu && (
        <button type="button" className="shrink-0 rounded-full p-1.5 text-label-3 opacity-70 hover:opacity-100" aria-label={`Azioni collezione ${collection.name}`} onClick={onMenu}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" />
          </svg>
        </button>
      )}
    </div>
  )
}

export function CollectionSidebar({ collections, selectedId, onSelect, onCreate, onMenu, total }: CollectionSidebarProps) {
  const all: CollectionView = { id: ALL_COLLECTION_ID, name: 'Tutti i libri', count: total, lastActivity: 0, builtIn: true, icon: 'library' }
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
              onMenu={collection.builtIn ? undefined : () => onMenu(collection)}
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
              <button type="button" className="border-l border-white/25 px-2.5 py-1.5 text-footnote" aria-label={`Azioni collezione ${collection.name}`} onClick={() => onMenu(collection)}>•••</button>
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
