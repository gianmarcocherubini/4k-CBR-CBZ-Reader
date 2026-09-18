import { useEffect, useRef, useState } from 'react'
import { CollectionGlyph, COLLECTION_GLYPHS } from './CollectionGlyph'
import {
  downloadCollectionIcon,
  downloadCollectionIconPreview,
  normalizeCollectionIcon,
  searchCollectionIcons,
  type OnlineCollectionIcon,
} from '../lib/collectionIcons'
import type { Collection } from '../types'

interface CollectionDialogProps {
  collection?: Collection
  existingNames: readonly string[]
  onSave: (name: string, icon?: string, iconImage?: Blob) => Promise<void>
  onCancel: () => void
}

function OnlineIconPreview({ candidate }: { candidate: OnlineCollectionIcon }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    let objectUrl: string | null = null
    void downloadCollectionIconPreview(candidate, controller.signal).then(
      (blob) => {
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      },
      () => undefined,
    )
    return () => {
      clearTimeout(timeout)
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [candidate])
  return url ? <img src={url} alt="" className="h-full w-full object-contain" /> : <div className="h-full w-full rounded bg-fill" />
}

export function CollectionDialog({ collection, existingNames, onSave, onCancel }: CollectionDialogProps) {
  const [name, setName] = useState(collection?.name ?? '')
  const [icon, setIcon] = useState<string | undefined>(collection?.icon)
  const [iconImage, setIconImage] = useState<Blob | undefined>(collection?.iconImage)
  const [iconUrl, setIconUrl] = useState<string | null>(null)
  const [iconError, setIconError] = useState<string | null>(null)
  const [loadingIcon, setLoadingIcon] = useState(false)
  const [saving, setSaving] = useState(false)
  const [onlineQuery, setOnlineQuery] = useState(collection?.name ?? '')
  const [onlineIcons, setOnlineIcons] = useState<OnlineCollectionIcon[]>([])
  const [searchingIcons, setSearchingIcons] = useState(false)
  const iconGeneration = useRef(0)
  const iconSearchRequest = useRef<AbortController | null>(null)
  const iconDownloadRequest = useRef<AbortController | null>(null)
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
      iconSearchRequest.current?.abort()
      iconDownloadRequest.current?.abort()
    },
    [],
  )

  const searchOnline = () => {
    iconSearchRequest.current?.abort()
    const controller = new AbortController()
    iconSearchRequest.current = controller
    const timeout = setTimeout(() => {
      controller.abort()
      if (iconSearchRequest.current === controller) {
        setSearchingIcons(false)
        setIconError('La ricerca icone ha impiegato troppo tempo.')
      }
    }, 12_000)
    setSearchingIcons(true)
    setOnlineIcons([])
    setIconError(null)
    void searchCollectionIcons(onlineQuery || trimmed, controller.signal)
      .then((results) => {
        if (controller.signal.aborted) return
        setOnlineIcons(results)
        if (results.length === 0) setIconError('Nessuna icona trovata. Prova parole come “pirate”, “hat” o “sword”.')
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setIconError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        clearTimeout(timeout)
        if (!controller.signal.aborted) setSearchingIcons(false)
      })
  }

  const chooseOnline = (candidate: OnlineCollectionIcon) => {
    iconDownloadRequest.current?.abort()
    const controller = new AbortController()
    iconDownloadRequest.current = controller
    const timeout = setTimeout(() => {
      controller.abort()
      if (iconDownloadRequest.current === controller) {
        setLoadingIcon(false)
        setIconError('Il download dell’icona ha impiegato troppo tempo.')
      }
    }, 12_000)
    const generation = ++iconGeneration.current
    setLoadingIcon(true)
    setIconError(null)
    void downloadCollectionIcon(candidate, controller.signal)
      .then((image) => {
        if (generation !== iconGeneration.current || controller.signal.aborted) return
        setIcon(undefined)
        setIconImage(image)
      })
      .catch((reason) => {
        if (generation === iconGeneration.current && !controller.signal.aborted) setIconError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        clearTimeout(timeout)
        if (generation === iconGeneration.current) setLoadingIcon(false)
      })
  }

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
            <button
              type="button"
              className={`flex aspect-square items-center justify-center rounded-xl text-caption ${!iconImage && !icon ? 'bg-tint-soft ring-2 ring-tint' : 'bg-fill'}`}
              aria-label="Nessuna icona"
              aria-pressed={!iconImage && !icon}
              disabled={loadingIcon || saving}
              onClick={() => {
                iconGeneration.current++
                setIcon(undefined)
                setIconImage(undefined)
                setIconError(null)
              }}
            >
              Nessuna
            </button>
            {COLLECTION_GLYPHS.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className={`flex aspect-square items-center justify-center rounded-xl ${!iconImage && icon === candidate.id ? 'bg-tint-soft text-tint ring-2 ring-tint' : 'bg-fill text-label'}`}
                aria-label={`Icona ${candidate.label}`}
                aria-pressed={!iconImage && icon === candidate.id}
                disabled={loadingIcon || saving}
                onClick={() => {
                  iconGeneration.current++
                  setIcon(candidate.id)
                  setIconImage(undefined)
                  setIconError(null)
                }}
              >
                <CollectionGlyph icon={candidate.id} className="h-6 w-6" />
              </button>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-3 rounded-xl bg-fill p-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-card text-2xl">
              {iconUrl ? (
                <img src={iconUrl} alt="" className="h-full w-full object-cover" />
              ) : icon ? (
                <CollectionGlyph icon={icon} className="h-7 w-7" />
              ) : (
                <span className="text-[10px] text-label-3">Nessuna</span>
              )}
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
          <div className="mt-4 rounded-xl bg-fill p-3">
            <p className="text-footnote font-semibold text-label">Cerca icone online</p>
            <p className="mt-0.5 text-caption text-label-3">Ricerca integrata Iconify · set moderni Lucide, Tabler, Phosphor e Material</p>
            <div className="mt-2 flex gap-2">
              <input
                value={onlineQuery}
                onChange={(event) => setOnlineQuery(event.currentTarget.value)}
                maxLength={100}
                aria-label="Cerca icone online"
                placeholder="es. pirate, straw hat, sword"
                className="min-h-[38px] min-w-0 flex-1 rounded-lg border border-separator bg-card px-3 text-footnote text-label outline-none focus:border-tint"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    searchOnline()
                  }
                }}
              />
              <button type="button" className="btn-pill" disabled={searchingIcons || loadingIcon || !onlineQuery.trim()} onClick={searchOnline}>
                {searchingIcons ? '…' : 'Cerca'}
              </button>
            </div>
            {onlineIcons.length > 0 && (
              <div className="mt-3 grid grid-cols-6 gap-2" data-testid="online-icon-results">
                {onlineIcons.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className="flex aspect-square items-center justify-center rounded-lg bg-card p-2"
                    title={`${candidate.label}${candidate.license ? ` · ${candidate.license}` : ''}`}
                    aria-label={`Scegli icona ${candidate.label}`}
                    disabled={loadingIcon || saving}
                    onClick={() => chooseOnline(candidate)}
                  >
                    <OnlineIconPreview candidate={candidate} />
                  </button>
                ))}
              </div>
            )}
          </div>
          <p className="mt-2 text-caption text-label-3">Le icone scelte o caricate vengono copiate nel database locale e restano disponibili offline.</p>
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
