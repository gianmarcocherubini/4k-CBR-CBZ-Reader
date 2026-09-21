import { useEffect, useState } from 'react'
import { ALL_COLLECTION_ID, type CollectionView } from '../lib/collections'
import { CollectionGlyph } from './CollectionGlyph'

interface CollectionTabsProps {
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
  if (url) return <img src={url} alt="" className="h-4 w-4 shrink-0 rounded-[3px] object-cover" />
  if (collection.icon) return <CollectionGlyph icon={collection.icon} className="h-4 w-4 shrink-0" />
  return null
}

/**
 * Collections as a tab row under the top bar, the way the Apple TV app switches between its
 * shelves: "Tutti i libri" first, then the collections by recent activity. Custom collections
 * carry a small actions button; the row scrolls horizontally when it does not fit.
 */
export function CollectionTabs({ collections, selectedId, onSelect, onCreate, onMenu, total }: CollectionTabsProps) {
  const all: CollectionView = { id: ALL_COLLECTION_ID, name: 'Tutti i libri', count: total, lastActivity: 0, builtIn: true, icon: 'library' }
  return (
    <nav className="shelf !gap-1 !py-2 !my-0" aria-label="Collezioni" data-testid="collection-tabs">
      {[all, ...collections].map((collection) => {
        const selected = selectedId === collection.id
        return (
          <div
            key={collection.id}
            className={`flex shrink-0 items-center rounded-full transition-colors ${selected ? 'bg-invert text-invert-fg' : 'text-label-2 hover:bg-fill hover:text-label'}`}
          >
            <button
              type="button"
              className="flex min-h-[34px] items-center gap-2 pl-3.5 pr-3 text-[14px] font-medium"
              onClick={() => onSelect(collection.id)}
              aria-pressed={selected}
              data-testid={`collection-${collection.id}`}
            >
              <CollectionIcon collection={collection} />
              <span className="whitespace-nowrap">{collection.name}</span>
              <span className={`text-caption tabular-nums ${selected ? 'opacity-70' : 'text-label-3'}`}>{collection.count}</span>
            </button>
            {!collection.builtIn && (
              <button
                type="button"
                className={`-ml-1 mr-1 flex h-7 w-7 items-center justify-center rounded-full ${selected ? 'opacity-80 hover:opacity-100' : 'text-label-3 hover:text-label'}`}
                aria-label={`Azioni collezione ${collection.name}`}
                onClick={() => onMenu(collection)}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <circle cx="5" cy="12" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="19" cy="12" r="1.8" />
                </svg>
              </button>
            )}
          </div>
        )
      })}
      <button
        type="button"
        className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full text-label-3 hover:bg-fill hover:text-label"
        onClick={onCreate}
        aria-label="Nuova collezione"
        data-testid="new-collection"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </nav>
  )
}
