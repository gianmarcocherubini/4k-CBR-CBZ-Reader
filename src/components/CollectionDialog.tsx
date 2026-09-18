import { useEffect, useRef, useState } from 'react'
import { COLLECTION_ICONS, normalizeCollectionIcon } from '../lib/collectionIcons'
import type { Collection } from '../types'

interface CollectionDialogProps {
  collection?: Collection
  existingNames: readonly string[]
  onSave: (name: string, icon: string, iconImage?: Blob) => Promise<void>
  onCancel: () => void
}

export function CollectionDialog({ collection, existingNames, onSave, onCancel }: CollectionDialogProps) {
  const [name, setName] = useState(collection?.name ?? '')
  const [icon, setIcon] = useState(collection?.icon ?? '📖')
  const [iconImage, setIconImage] = useState<Blob | undefined>(collection?.iconImage)
  const [iconUrl, setIconUrl] = useState<string | null>(null)
  const [iconError, setIconError] = useState<string | null>(null)
  const [loadingIcon, setLoadingIcon] = useState(false)
  const [saving, setSaving] = useState(false)
  const iconGeneration = useRef(0)
  const mounted = useRef(true)
  const trimmed = name.trim()
  const duplicate = existingNames.some((existing) => existing.localeCompare(trimmed, 'it', { sensitivity: 'base' }) === 0)

  useEffect(() => {
    if (!iconImage) {
      setIconUrl(null)
      return
    }
    const url = URL.createObjectURL(iconImage)
    setIconUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [iconImage])

  useEffect(
    () => () => {
      mounted.current = false
      iconGeneration.current++
    },
    [],
  )

  return (
    <div className="fade-enter fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6 backdrop-blur-sm" role="presentation" onClick={onCancel}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="collection-dialog-title"
        className="material-strong max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-2xl shadow-sheet"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          if (!trimmed || duplicate || loadingIcon || saving) return
          setSaving(true)
          void onSave(trimmed, icon, iconImage).finally(() => {
            if (mounted.current) setSaving(false)
          })
        }}
      >
        <div className="px-5 pt-5 pb-4">
          <h2 id="collection-dialog-title" className="text-center text-headline">
            {collection ? 'Modifica collezione' : 'Nuova collezione'}
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
          <p className="mt-4 text-footnote text-label-2">Icona</p>
          <div className="mt-2 grid grid-cols-6 gap-2">
            {COLLECTION_ICONS.map((candidate) => (
              <button
                key={candidate}
                type="button"
                className={`flex aspect-square items-center justify-center rounded-xl text-xl ${!iconImage && icon === candidate ? 'bg-tint-soft ring-2 ring-tint' : 'bg-fill'}`}
                aria-label={`Icona ${candidate}`}
                aria-pressed={!iconImage && icon === candidate}
                disabled={loadingIcon || saving}
                onClick={() => {
                  iconGeneration.current++
                  setIcon(candidate)
                  setIconImage(undefined)
                  setIconError(null)
                }}
              >
                {candidate}
              </button>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-3 rounded-xl bg-fill p-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-card text-2xl">
              {iconUrl ? <img src={iconUrl} alt="" className="h-full w-full object-cover" /> : icon}
            </div>
            <div className="min-w-0 flex-1">
              <label className="btn-plain cursor-pointer p-0 text-footnote font-semibold">
                {loadingIcon ? 'Elaborazione…' : 'Carica PNG/JPEG'}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/avif,image/heic"
                  className="hidden"
                  disabled={loadingIcon || saving}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0]
                    event.currentTarget.value = ''
                    if (!file) return
                    const generation = ++iconGeneration.current
                    setLoadingIcon(true)
                    setIconError(null)
                    void normalizeCollectionIcon(file)
                      .then((image) => {
                        if (generation === iconGeneration.current) setIconImage(image)
                      })
                      .catch((reason) => {
                        if (generation === iconGeneration.current) setIconError(reason instanceof Error ? reason.message : String(reason))
                      })
                      .finally(() => {
                        if (generation === iconGeneration.current) setLoadingIcon(false)
                      })
                  }}
                  data-testid="collection-icon-input"
                />
              </label>
              {iconImage && (
                <button type="button" disabled={loadingIcon || saving} className="mt-1 block text-caption text-red disabled:opacity-35" onClick={() => { iconGeneration.current++; setIconImage(undefined) }}>
                  Rimuovi immagine
                </button>
              )}
            </div>
          </div>
          <a
            href={`https://www.softicons.com/search?search=${encodeURIComponent(trimmed || 'book')}&x=0&y=0`}
            target="_blank"
            rel="noreferrer"
            className="mt-3 block text-footnote font-semibold text-tint"
          >
            Cerca su SoftIcons ↗
          </a>
          <p className="mt-1 text-caption text-label-3">Scarica un PNG rispettando la licenza indicata dal set, poi caricalo qui. L’icona resta solo sul dispositivo.</p>
          {iconError && <p className="mt-2 text-footnote text-red">{iconError}</p>}
        </div>
        <div className="grid grid-cols-2 border-t border-separator">
          <button type="button" className="min-h-[44px] border-r border-separator text-body text-tint active:bg-fill" onClick={onCancel}>
            Annulla
          </button>
          <button type="submit" disabled={!trimmed || duplicate || loadingIcon || saving} className="min-h-[44px] text-body font-semibold text-tint disabled:opacity-35 active:bg-fill">
            {saving ? 'Salvataggio…' : collection ? 'Salva' : 'Crea'}
          </button>
        </div>
      </form>
    </div>
  )
}
