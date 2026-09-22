import { useEffect, useState } from 'react'
import { ARCHIVE_CATALOG, type Catalog, catalogNameFor } from '../lib/catalog/catalogs'
import {
  ARCHIVE_SHELVES,
  type ArchiveDownloadProgress,
  type ArchiveFile,
  type ArchiveItem,
  type ArchiveItemSummary,
  type ArchiveShelf,
  coverUrl,
  downloadArchiveFile,
  formatBadge,
  licenseLabel,
  loadArchiveItem,
  searchArchive,
} from '../lib/catalog/internetArchive'
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
import { Segmented } from './reader/SettingsPanel'

interface CatalogDialogProps {
  catalogs: Catalog[]
  onAddCatalog: (catalog: Catalog) => void
  onRemoveCatalog: (id: string) => void
  /** A downloaded file, and the series it belongs to (its collection in the library), when there is one. */
  onDownloaded: (file: File, seriesTitle?: string) => void
  onClose: () => void
}

type View =
  | { kind: 'catalogs' }
  | { kind: 'series'; catalog: Catalog }
  | { kind: 'units'; catalog: Catalog; series: SeriesSummary }
  | { kind: 'download'; catalog: Catalog; series: SeriesSummary; units: UnitSummary[] }
  | { kind: 'archive'; catalog: Catalog }
  | { kind: 'archive-item'; catalog: Catalog; item: ArchiveItemSummary }
  | { kind: 'archive-download'; catalog: Catalog; item: ArchiveItem; file: ArchiveFile }

const homeView = (catalog: Catalog): View => (catalog.kind === 'archive' ? { kind: 'archive', catalog } : { kind: 'series', catalog })

const ArchiveMark = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 21h18M4 18h16M5 10v8M9 10v8M15 10v8M19 10v8M3 8l9-5 9 5H3z" />
  </svg>
)

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
      onAdd({ id: origin, name: catalogNameFor(origin), url: origin, kind: 'site', addedAt: Date.now() })
      setUrl('')
      if (series.length === 0) setError('Nessuna serie trovata.')
    } catch (e) {
      setError(describe(e))
    } finally {
      setBusy(false)
    }
  }
  const hasArchive = catalogs.some((c) => c.kind === 'archive')
  return (
    <div className="space-y-6">
      {catalogs.length > 0 && (
        <ul className="group-card" data-testid="catalog-list">
          {catalogs.map((catalog) => (
            <li key={catalog.id} className="row">
              <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => onOpen(catalog)} data-testid="catalog-open">
                {catalog.kind === 'archive' && <span className="shrink-0 text-label-2">{ArchiveMark}</span>}
                <span className="min-w-0">
                  <span className="block truncate text-body">{catalog.name}</span>
                  <span className="block truncate text-footnote text-label-2">{catalog.kind === 'archive' ? 'Biblioteca digitale · fumetti di pubblico dominio e con licenza libera' : catalog.url}</span>
                </span>
              </button>
              <button type="button" className="btn-pill shrink-0 !text-red" onClick={() => onRemove(catalog.id)} aria-label={`Rimuovi ${catalog.name}`}>
                Rimuovi
              </button>
            </li>
          ))}
        </ul>
      )}
      {!hasArchive && (
        <section>
          <h3 className="eyebrow mb-2">Suggerito</h3>
          <div className="flex items-center gap-4 rounded-[14px] bg-card p-4 shadow-[inset_0_0_0_1px_var(--line)]" data-testid="archive-suggestion">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] bg-fill text-label">{ArchiveMark}</span>
            <div className="min-w-0 flex-1">
              <div className="text-body">Internet Archive</div>
              <div className="text-footnote text-label-2">
                La biblioteca digitale senza scopo di lucro: decine di migliaia di fumetti in CBZ, CBR e PDF, con raccolte di pubblico dominio e con licenza
                libera. Si cerca e si scarica direttamente nella libreria.
              </div>
            </div>
            <button type="button" className="btn-primary shrink-0 !min-h-[36px] !px-3.5 !text-[13px]" onClick={() => onAdd({ ...ARCHIVE_CATALOG, addedAt: Date.now() })} data-testid="archive-add">
              Aggiungi
            </button>
          </div>
        </section>
      )}
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <label className="eyebrow block">
          {catalogs.length === 0 ? 'Aggiungi un sito' : 'Altro sito'}
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

const formatMB = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toLocaleString('it-IT', { maximumFractionDigits: bytes >= 104857600 ? 0 : 1 })} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)
const formatCount = (n: number) => n.toLocaleString('it-IT')

function ArchiveCard({ item, onOpen }: { item: ArchiveItemSummary; onOpen: () => void }) {
  const [broken, setBroken] = useState(false)
  const licence = licenseLabel(item.licenseUrl)
  return (
    <button type="button" className="tile-focus min-w-0 text-left" onClick={onOpen} data-testid="archive-card">
      <div className="tile aspect-[3/4] w-full">
        {broken ? <div className="flex h-full w-full items-center justify-center text-label-3">{ArchiveMark}</div> : <img src={coverUrl(item.identifier)} alt="" className="h-full w-full object-cover" loading="lazy" draggable={false} onError={() => setBroken(true)} />}
      </div>
      <div className="mt-2 line-clamp-2 text-[13px] leading-[17px] font-medium text-label">{item.title}</div>
      <div className="truncate text-caption text-label-2">
        {[item.creator, item.year ? String(item.year) : undefined].filter(Boolean).join(' · ') || '\u00a0'}
      </div>
      <div className="truncate text-caption text-label-3">
        {licence ? `${licence} · ` : ''}
        {formatCount(item.downloads)} download
      </div>
    </button>
  )
}

/** Internet Archive: curated shelves, or a free-text search across the whole library. */
function ArchiveBrowseView({ onOpen }: { onOpen: (item: ArchiveItemSummary) => void }) {
  const [shelf, setShelf] = useState<ArchiveShelf>(ARCHIVE_SHELVES[0]!)
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [pages, setPages] = useState<ArchiveItemSummary[][]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The shelf/search the shown results belong to: nothing of a previous one is shown meanwhile. */
  const [loaded, setLoaded] = useState<string | null>(null)
  const searching = submitted.trim().length > 0
  const key = searching ? `q:${submitted}` : `s:${shelf.id}`
  const current = loaded === key
  useEffect(() => {
    const controller = new AbortController()
    setPages([])
    setTotal(0)
    setError(null)
    setLoading(true)
    searchArchive(searching ? { text: submitted, page: 1 } : { shelf, page: 1 }, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return
        setPages([result.items])
        setTotal(result.total)
        setLoaded(key)
        setLoading(false)
      },
      (e: unknown) => {
        if (controller.signal.aborted) return
        setError(describe(e))
        setLoading(false)
      },
    )
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const items = pages.flat()
  const loadMore = async () => {
    setLoading(true)
    try {
      const result = await searchArchive(searching ? { text: submitted, page: pages.length + 1 } : { shelf, page: pages.length + 1 })
      setPages((p) => [...p, result.items])
    } catch (e) {
      setError(describe(e))
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className="space-y-5">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          setSubmitted(query)
        }}
      >
        <input
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value)
            if (!e.currentTarget.value.trim()) setSubmitted('')
          }}
          placeholder="Cerca in tutto Internet Archive"
          aria-label="Cerca in Internet Archive"
          className="field !rounded-full"
          data-testid="archive-search"
        />
        <button type="submit" className="btn-primary shrink-0 !min-h-[40px] !px-4 !text-[13px]" disabled={!query.trim()} data-testid="archive-search-go">
          Cerca
        </button>
      </form>
      {!searching && (
        <div>
          <Segmented<string> label="Raccolta" idPrefix="shelf" className="w-full" value={shelf.id} options={ARCHIVE_SHELVES.map((s) => ({ value: s.id, label: s.label }))} onChange={(id) => setShelf(ARCHIVE_SHELVES.find((s) => s.id === id) ?? ARCHIVE_SHELVES[0]!)} />
          <p className="mt-2 text-footnote text-label-2">{shelf.description}</p>
        </div>
      )}
      {searching && current && !loading && (
        <p className="text-footnote text-label-2" data-testid="archive-result-count">
          {total === 0 ? 'Nessun risultato.' : `${formatCount(total)} risultati in tutta la biblioteca; prima i titoli che contengono le parole cercate, poi i più scaricati.`}
        </p>
      )}
      {error && (
        <p className="text-footnote text-red" data-testid="catalog-error">
          {error}
        </p>
      )}
      {current && items.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-x-4 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(140px,1fr))]" data-testid="archive-grid">
          {items.map((item) => (
            <ArchiveCard key={item.identifier} item={item} onOpen={() => onOpen(item)} />
          ))}
        </div>
      )}
      {(loading || (!current && !error)) && (
        <div className="flex h-24 items-center justify-center">
          <div className="spinner" aria-label="Caricamento" />
        </div>
      )}
      {current && !loading && items.length > 0 && items.length < total && (
        <div className="flex justify-center">
          <button type="button" className="btn-ghost !min-h-[36px] !px-3.5 !text-[13px]" onClick={() => void loadMore()} data-testid="archive-more">
            Mostra altri ({formatCount(total - items.length)})
          </button>
        </div>
      )}
      <p className="text-footnote text-label-3">
        Internet Archive è una biblioteca digitale senza scopo di lucro. Le raccolte proposte contengono opere di pubblico dominio o con licenza
        libera; la ricerca copre tutta la biblioteca, dove alcuni caricamenti possono essere protetti da diritto d’autore. Scaricare è una scelta
        e una responsabilità di chi legge.
      </p>
    </div>
  )
}

function ArchiveItemView({ summary, onDownload }: { summary: ArchiveItemSummary; onDownload: (item: ArchiveItem, file: ArchiveFile) => void }) {
  const { data: item, error, loading } = useLoader((signal) => loadArchiveItem(summary.identifier, signal), [summary.identifier])
  const licence = licenseLabel(summary.licenseUrl)
  const originals = item?.files.filter((f) => f.source === 'original') ?? []
  const derivatives = item?.files.filter((f) => f.source === 'derivative') ?? []
  const fileRow = (file: ArchiveFile) => (
    <li key={file.name} className="row !min-h-[44px] !py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-subhead text-label">{file.name.split('/').pop()}</div>
        <div className="text-caption text-label-3">
          <span className="font-semibold text-label-2">{formatBadge(file.kind)}</span> · {formatMB(file.size)}
        </div>
      </div>
      <button type="button" className="btn-pill shrink-0 !min-h-[28px] !px-2.5 !text-[12px]" onClick={() => item && onDownload(item, file)} aria-label={`Scarica ${file.name}`} data-testid="archive-file-download">
        Scarica
      </button>
    </li>
  )
  return (
    <div className="space-y-5">
      <div className="flex gap-4">
        <div className="tile h-[132px] w-[99px] shrink-0">
          <img src={coverUrl(summary.identifier)} alt="" className="h-full w-full object-cover" draggable={false} />
        </div>
        <div className="min-w-0 flex-1 text-footnote text-label-2">
          {(summary.creator || summary.year) && <div className="text-subhead text-label">{[summary.creator, summary.year].filter(Boolean).join(' · ')}</div>}
          {licence && <div className="mt-1">{licence}</div>}
          <div className="mt-1">{formatCount(summary.downloads)} download su archive.org</div>
          {item?.subjects.length ? <div className="mt-1 truncate text-label-3">{item.subjects.join(' · ')}</div> : null}
          <a className="mt-2 inline-block text-label-2 underline-offset-2 hover:text-label hover:underline" href={summary.url} target="_blank" rel="noopener">
            Apri su archive.org
          </a>
        </div>
      </div>
      {item?.description && <p className="whitespace-pre-line text-footnote text-label-2">{item.description}</p>}
      {loading && (
        <div className="flex h-24 items-center justify-center">
          <div className="spinner" aria-label="Caricamento" />
        </div>
      )}
      {error && (
        <p className="text-footnote text-red" data-testid="catalog-error">
          {error}
        </p>
      )}
      {item && (
        <>
          {originals.length > 0 && (
            <section>
              <h3 className="eyebrow mb-2">{originals.length === 1 ? 'File' : `${originals.length} file`}</h3>
              <ul className="group-card" data-testid="archive-files">
                {originals.map(fileRow)}
              </ul>
              {originals.some((f) => f.kind === 'cbr') && (
                <p className="group-footer">I CBR sono archivi RAR: quelli «solidi» non si aprono pagina per pagina; in quel caso il PDF derivato va bene.</p>
              )}
            </section>
          )}
          {derivatives.length > 0 && (
            <section>
              <h3 className="eyebrow mb-2">Versioni derivate da archive.org</h3>
              <ul className="group-card" data-testid="archive-derivatives">
                {derivatives.map(fileRow)}
              </ul>
              <p className="group-footer">PDF ricavati dalle scansioni: più leggeri, stesse pagine.</p>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function ArchiveDownloadView({ item, file, onDone, onCancel }: { item: ArchiveItem; file: ArchiveFile; onDone: (file: File) => void; onCancel: () => void }) {
  const [progress, setProgress] = useState<ArchiveDownloadProgress>({ bytes: 0, total: file.size })
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const c = new AbortController()
    downloadArchiveFile(item, file, setProgress, c.signal).then(
      (result) => !c.signal.aborted && onDone(result),
      (e: unknown) => {
        if (!c.signal.aborted && (e as DOMException)?.name !== 'AbortError') setError(describe(e))
      },
    )
    return () => c.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const pct = progress.total > 0 ? Math.min(100, (progress.bytes / progress.total) * 100) : 0
  return (
    <div className="space-y-5" data-testid="archive-progress">
      <div>
        <div className="truncate text-body">{file.name.split('/').pop()}</div>
        <div className="mt-1 text-footnote text-label-2 tabular-nums">
          {formatMB(progress.bytes)} di {formatMB(progress.total)}
        </div>
        <div className="mt-3 h-[3px] w-full overflow-hidden rounded-full bg-fill-2">
          <div className="h-full rounded-full bg-invert transition-[width]" style={{ width: `${Math.max(2, pct)}%` }} />
        </div>
      </div>
      {error ? (
        <p className="text-footnote text-red" data-testid="catalog-error">
          {error}
        </p>
      ) : (
        <p className="text-footnote text-label-3">Il file viene scaricato così com’è da archive.org e poi importato come un normale volume.</p>
      )}
      <button type="button" className="btn-ghost !min-h-[36px] !px-3.5 !text-[13px]" onClick={onCancel}>
        {error ? 'Indietro' : 'Annulla'}
      </button>
    </div>
  )
}

export function CatalogDialog({ catalogs, onAddCatalog, onRemoveCatalog, onDownloaded, onClose }: CatalogDialogProps) {
  const [view, setView] = useState<View>(() => (catalogs.length === 1 ? homeView(catalogs[0]!) : { kind: 'catalogs' }))
  switch (view.kind) {
    case 'catalogs':
      return (
        <Sheet title="Cataloghi" onClose={onClose}>
          <CatalogsView catalogs={catalogs} onAdd={onAddCatalog} onRemove={onRemoveCatalog} onOpen={(catalog) => setView(homeView(catalog))} />
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
    case 'archive':
      return (
        <Sheet title="Internet Archive" onBack={() => setView({ kind: 'catalogs' })} onClose={onClose}>
          <ArchiveBrowseView onOpen={(item) => setView({ kind: 'archive-item', catalog: view.catalog, item })} />
        </Sheet>
      )
    case 'archive-item':
      return (
        <Sheet title={view.item.title} onBack={() => setView({ kind: 'archive', catalog: view.catalog })} onClose={onClose}>
          <ArchiveItemView summary={view.item} onDownload={(item, file) => setView({ kind: 'archive-download', catalog: view.catalog, item, file })} />
        </Sheet>
      )
    case 'archive-download':
      return (
        <Sheet title={`Scaricamento · ${view.item.title}`} onClose={onClose}>
          <ArchiveDownloadView
            item={view.item}
            file={view.file}
            onDone={(file) => onDownloaded(file, view.item.files.length > 1 ? view.item.title : undefined)}
            onCancel={() => setView({ kind: 'archive-item', catalog: view.catalog, item: view.item })}
          />
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
