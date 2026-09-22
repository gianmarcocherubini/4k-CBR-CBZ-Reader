import { useEffect, useState } from 'react'
import { type Catalog, catalogNameFor } from '../lib/catalog/catalogs'
import {
  CatalogError,
  type DownloadProgress,
  downloadUnits,
  loadSeries,
  loadSeriesList,
  MAX_CHAPTERS_PER_DOWNLOAD,
  MAX_VOLUMES_PER_DOWNLOAD,
  normalizeCatalogUrl,
  type SeriesSummary,
  type UnitSummary,
} from '../lib/catalog/webCatalog'
import { formatBytes } from '../lib/storage/opfs'

interface CatalogDialogProps {
  catalogs: Catalog[]
  onAddCatalog: (catalog: Catalog) => void
  onRemoveCatalog: (id: string) => void
  /** A downloaded CBZ, and the series it belongs to (its collection in the library). */
  onDownloaded: (file: File, seriesTitle: string) => void
  onClose: () => void
}

type View =
  | { kind: 'catalogs' }
  | { kind: 'series'; catalog: Catalog }
  | { kind: 'units'; catalog: Catalog; series: SeriesSummary }
  | { kind: 'download'; catalog: Catalog; series: SeriesSummary; units: UnitSummary[] }

const EDITION_LABEL: Record<UnitSummary['edition'], string | null> = { color: null, unknown: null, partial: 'Colore parziale', bw: 'Bianco e nero' }

const describe = (e: unknown) => (e instanceof CatalogError ? e.message : e instanceof Error ? e.message : String(e))

const BackIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m15 5-7 7 7 7" />
  </svg>
)

/** Sheet: header with back/close, scrollable body. Wider than Dialog: it holds a grid of covers. */
function Sheet({ title, onBack, onClose, children, footer, testId }: { title: string; onBack?: () => void; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; testId?: string }) {
  return (
    <div className="fade-enter fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm sm:p-8" role="presentation" onClick={onClose} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-[16px] bg-card shadow-sheet" onClick={(e) => e.stopPropagation()} data-testid={testId ?? 'catalog-dialog'}>
        <div className="hairline-b flex h-14 shrink-0 items-center gap-2 px-4">
          {onBack ? (
            <button type="button" className="btn-icon !h-9 !w-9" onClick={onBack} aria-label="Indietro" data-testid="catalog-back">
              {BackIcon}
            </button>
          ) : (
            <span className="w-2" />
          )}
          <h2 className="min-w-0 flex-1 truncate text-headline">{title}</h2>
          <button type="button" className="btn-pill" onClick={onClose} aria-label="Chiudi cataloghi">
            Fine
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer && <div className="hairline-t shrink-0 px-5 py-4">{footer}</div>}
      </div>
    </div>
  )
}

function CatalogsView({ catalogs, onAdd, onRemove, onOpen }: { catalogs: Catalog[]; onAdd: (c: Catalog) => void; onRemove: (id: string) => void; onOpen: (c: Catalog) => void }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const add = async () => {
    setError(null)
    let origin: string
    try {
      origin = normalizeCatalogUrl(url)
    } catch (e) {
      setError(describe(e))
      return
    }
    if (catalogs.some((c) => c.url === origin)) {
      setError('Questo catalogo è già nell’elenco.')
      return
    }
    setBusy(true)
    try {
      // One read of the home page: the site must have series to show, or it is not a catalogue.
      const series = await loadSeriesList(origin)
      onAdd({ id: origin, name: catalogNameFor(origin), url: origin, addedAt: Date.now() })
      setUrl('')
      if (series.length === 0) setError('Nessuna serie trovata.')
    } catch (e) {
      setError(describe(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-6">
      {catalogs.length > 0 && (
        <ul className="group-card" data-testid="catalog-list">
          {catalogs.map((catalog) => (
            <li key={catalog.id} className="row">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpen(catalog)} data-testid="catalog-open">
                <div className="truncate text-body">{catalog.name}</div>
                <div className="truncate text-footnote text-label-2">{catalog.url}</div>
              </button>
              <button type="button" className="btn-pill shrink-0 !text-red" onClick={() => onRemove(catalog.id)} aria-label={`Rimuovi ${catalog.name}`}>
                Rimuovi
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <label className="eyebrow block">
          {catalogs.length === 0 ? 'Aggiungi un catalogo' : 'Altro catalogo'}
          <input
            type="text"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
            placeholder="https://…"
            className="field mt-1.5 !text-[15px] !font-normal !tracking-normal !normal-case"
            data-testid="catalog-url"
            disabled={busy}
          />
        </label>
        {error && (
          <p className="text-footnote text-red" data-testid="catalog-error">
            {error}
          </p>
        )}
        <div className="flex items-center gap-3">
          <button type="submit" className="btn-primary !min-h-[36px] !px-3.5 !text-[13px]" disabled={busy || !url.trim()} data-testid="catalog-add">
            {busy ? 'Verifica…' : 'Aggiungi'}
          </button>
          {busy && <div className="spinner" aria-label="Verifica del catalogo" />}
        </div>
      </form>
      <p className="text-footnote text-label-3">
        Un catalogo è un sito web di terzi che pubblica serie a capitoli, come pagine di immagini. Mangadana ne legge le pagine come farebbe
        Safari, senza account né dati tuoi, e salva nella libreria solo i capitoli che scegli, pochi per volta. Il contenuto è responsabilità
        del sito e tua: assicurati di poterlo scaricare e rispetta le sue condizioni d’uso.
      </p>
    </div>
  )
}

function useLoader<T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true })
  useEffect(() => {
    const controller = new AbortController()
    setState({ loading: true })
    load(controller.signal).then(
      (data) => !controller.signal.aborted && setState({ data, loading: false }),
      (e: unknown) => !controller.signal.aborted && setState({ error: describe(e), loading: false }),
    )
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}

function SeriesView({ catalog, onOpen }: { catalog: Catalog; onOpen: (series: SeriesSummary) => void }) {
  const { data, error, loading } = useLoader((signal) => loadSeriesList(catalog.url, signal), [catalog.url])
  const [query, setQuery] = useState('')
  const needle = query.trim().toLocaleLowerCase('it')
  const shown = (data ?? []).filter((s) => !needle || s.title.toLocaleLowerCase('it').includes(needle) || s.author?.toLocaleLowerCase('it').includes(needle))
  return (
    <div className="space-y-4">
      {data && data.length > 6 && (
        <input type="search" value={query} onChange={(e) => setQuery(e.currentTarget.value)} placeholder="Cerca una serie" aria-label="Cerca una serie" className="field !rounded-full" data-testid="catalog-search" />
      )}
      {loading && (
        <div className="flex h-40 items-center justify-center">
          <div className="spinner" aria-label="Caricamento" />
        </div>
      )}
      {error && (
        <p className="text-footnote text-red" data-testid="catalog-error">
          {error}
        </p>
      )}
      {data && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-x-4 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(140px,1fr))]" data-testid="catalog-series">
          {shown.map((series) => (
            <button key={series.slug} type="button" className="tile-focus min-w-0 text-left" onClick={() => onOpen(series)} data-testid="catalog-series-card">
              <div className="tile aspect-[3/4] w-full">
                {series.cover ? <img src={series.cover} alt="" className="h-full w-full object-cover" loading="lazy" draggable={false} /> : <div className="h-full w-full bg-tertiary" />}
              </div>
              <div className="mt-2 line-clamp-2 text-[13px] leading-[17px] font-medium text-label">{series.title}</div>
              {series.author && <div className="truncate text-caption text-label-2">{series.author}</div>}
            </button>
          ))}
          {shown.length === 0 && <p className="col-span-full text-footnote text-label-2">Nessuna serie corrisponde.</p>}
        </div>
      )}
    </div>
  )
}

function UnitsView({ series, onDownload }: { series: SeriesSummary; onDownload: (units: UnitSummary[]) => void }) {
  const { data, error, loading } = useLoader((signal) => loadSeries(series, signal), [series.url])
  const units = data?.units ?? []
  const kind = units[0]?.kind ?? 'chapter'
  const limit = kind === 'volume' ? MAX_VOLUMES_PER_DOWNLOAD : MAX_CHAPTERS_PER_DOWNLOAD
  const [from, setFrom] = useState<string | null>(null)
  const [to, setTo] = useState<string | null>(null)
  const fromIndex = Math.max(0, units.findIndex((u) => u.number === from))
  const toIndex = to === null ? Math.min(units.length - 1, fromIndex + limit - 1) : Math.min(units.findIndex((u) => u.number === to), fromIndex + limit - 1)
  const selected = units.slice(fromIndex, Math.max(fromIndex, toIndex) + 1)
  const noun = kind === 'volume' ? 'volumi' : 'capitoli'
  return (
    <div className="space-y-5">
      {series.blurb && <p className="text-footnote text-label-2">{series.blurb}</p>}
      {loading && (
        <div className="flex h-40 items-center justify-center">
          <div className="spinner" aria-label="Caricamento" />
        </div>
      )}
      {error && (
        <p className="text-footnote text-red" data-testid="catalog-error">
          {error}
        </p>
      )}
      {units.length > 0 && (
        <>
          <div className="group-card">
            <div className="row">
              <div className="text-body">Da</div>
              <select className="field !w-auto !min-h-[34px] !text-[14px]" value={units[fromIndex]!.number} onChange={(e) => setFrom(e.currentTarget.value)} aria-label="Dal" data-testid="catalog-from">
                {units.map((u) => (
                  <option key={u.number} value={u.number}>
                    {kind === 'volume' ? 'Vol.' : 'Cap.'} {u.number}
                  </option>
                ))}
              </select>
            </div>
            <div className="row">
              <div className="text-body">A</div>
              <select className="field !w-auto !min-h-[34px] !text-[14px]" value={units[Math.max(fromIndex, toIndex)]!.number} onChange={(e) => setTo(e.currentTarget.value)} aria-label="Al" data-testid="catalog-to">
                {units.slice(fromIndex, fromIndex + limit).map((u) => (
                  <option key={u.number} value={u.number}>
                    {kind === 'volume' ? 'Vol.' : 'Cap.'} {u.number}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn-primary !min-h-[36px] !px-3.5 !text-[13px]" onClick={() => onDownload(selected)} data-testid="catalog-download">
              Scarica {selected.length === 1 ? `1 ${kind === 'volume' ? 'volume' : 'capitolo'}` : `${selected.length} ${noun}`}
            </button>
            <span className="text-footnote text-label-3">
              Al massimo {limit} {noun} per volta; finiscono in un unico volume della libreria.
            </span>
          </div>
          <ul className="group-card" data-testid="catalog-units">
            {units.map((u) => {
              const badge = EDITION_LABEL[u.edition]
              const inRange = u.value >= units[fromIndex]!.value && u.value <= units[Math.max(fromIndex, toIndex)]!.value
              return (
                <li key={`${u.kind}:${u.number}`} className={`row !min-h-[44px] !py-2 ${inRange ? 'bg-fill' : ''}`}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-subhead">
                      <span className="tabular-nums text-label-2">{kind === 'volume' ? 'Vol.' : 'Cap.'} {u.number}</span>
                      {u.name && <span className="text-label"> · {u.name}</span>}
                    </div>
                    <div className="text-caption text-label-3">
                      {u.pages ? `${u.pages} pagine` : ''}
                      {badge ? `${u.pages ? ' · ' : ''}${badge}` : ''}
                    </div>
                  </div>
                  <button type="button" className="btn-pill shrink-0 !min-h-[28px] !px-2.5 !text-[12px]" onClick={() => onDownload([u])} aria-label={`Scarica ${kind === 'volume' ? 'volume' : 'capitolo'} ${u.number}`}>
                    Scarica
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}

function DownloadView({ series, units, onDone, onCancel }: { series: SeriesSummary; units: UnitSummary[]; onDone: (file: File) => void; onCancel: () => void }) {
  const [progress, setProgress] = useState<DownloadProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    // One controller per run: leaving the view (or a StrictMode re-run) aborts only its own download.
    const c = new AbortController()
    downloadUnits(series, units, setProgress, c.signal).then(
      (file) => !c.signal.aborted && onDone(file),
      (e: unknown) => {
        if (!c.signal.aborted && (e as DOMException)?.name !== 'AbortError') setError(describe(e))
      },
    )
    return () => c.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const kind = units[0]!.kind === 'volume' ? 'Volume' : 'Capitolo'
  return (
    <div className="space-y-5" data-testid="catalog-progress">
      <div>
        <div className="text-body">
          {progress ? `${kind} ${progress.unit.number}${progress.unit.name ? ` · ${progress.unit.name}` : ''}` : 'Avvio…'}
        </div>
        <div className="mt-1 text-footnote text-label-2 tabular-nums">
          {progress ? `${progress.unitIndex + 1} di ${progress.unitCount} · pagina ${progress.page} di ${progress.pageCount} · ${formatBytes(progress.bytes)}` : ''}
        </div>
        <div className="mt-3 h-[3px] w-full overflow-hidden rounded-full bg-fill-2">
          <div
            className="h-full rounded-full bg-invert transition-[width]"
            style={{ width: `${progress ? ((progress.unitIndex + (progress.pageCount ? progress.page / progress.pageCount : 0)) / progress.unitCount) * 100 : 2}%` }}
          />
        </div>
      </div>
      {error ? (
        <p className="text-footnote text-red" data-testid="catalog-error">
          {error}
        </p>
      ) : (
        <p className="text-footnote text-label-3">Le pagine vengono scaricate una manciata alla volta e impacchettate in un CBZ, poi importate come un normale volume.</p>
      )}
      <button type="button" className="btn-ghost !min-h-[36px] !px-3.5 !text-[13px]" onClick={onCancel}>
        {error ? 'Indietro' : 'Annulla'}
      </button>
    </div>
  )
}

export function CatalogDialog({ catalogs, onAddCatalog, onRemoveCatalog, onDownloaded, onClose }: CatalogDialogProps) {
  const [view, setView] = useState<View>(() => (catalogs.length === 1 ? { kind: 'series', catalog: catalogs[0]! } : { kind: 'catalogs' }))
  switch (view.kind) {
    case 'catalogs':
      return (
        <Sheet title="Cataloghi" onClose={onClose}>
          <CatalogsView catalogs={catalogs} onAdd={onAddCatalog} onRemove={onRemoveCatalog} onOpen={(catalog) => setView({ kind: 'series', catalog })} />
        </Sheet>
      )
    case 'series':
      return (
        <Sheet title={view.catalog.name} onBack={() => setView({ kind: 'catalogs' })} onClose={onClose}>
          <SeriesView catalog={view.catalog} onOpen={(series) => setView({ kind: 'units', catalog: view.catalog, series })} />
        </Sheet>
      )
    case 'units':
      return (
        <Sheet title={view.series.title} onBack={() => setView({ kind: 'series', catalog: view.catalog })} onClose={onClose}>
          <UnitsView series={view.series} onDownload={(units) => setView({ kind: 'download', catalog: view.catalog, series: view.series, units })} />
        </Sheet>
      )
    case 'download':
      return (
        <Sheet title={`Scaricamento · ${view.series.title}`} onClose={onClose}>
          <DownloadView
            series={view.series}
            units={view.units}
            onDone={(file) => onDownloaded(file, view.series.title)}
            onCancel={() => setView({ kind: 'units', catalog: view.catalog, series: view.series })}
          />
        </Sheet>
      )
  }
}
