import { useCallback, useEffect, useRef, useState } from 'react'
import { coverQueryFromTitle, downloadCover, downloadCoverPreview, searchCovers, type CoverCandidate } from '../lib/coverSearch'
import type { Book } from '../types'

interface CoverSearchDialogProps {
  book: Book
  onApply: (cover: Blob, signal: AbortSignal) => Promise<void>
  onClose: () => void
}

function CoverPreview({ candidate }: { candidate: CoverCandidate }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    let objectUrl: string | null = null
    void downloadCoverPreview(candidate, controller.signal).then(
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
  return url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <div className="h-full w-full bg-tertiary" />
}

export function CoverSearchDialog({ book, onApply, onClose }: CoverSearchDialogProps) {
  const [query, setQuery] = useState(() => coverQueryFromTitle(book.title))
  const initialQuery = useRef(query)
  const [results, setResults] = useState<CoverCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const saving = useRef(false)

  const runSearch = useCallback((value: string) => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 15_000)
    setLoading(true)
    setError(null)
    void searchCovers(value, controller.signal)
      .then((covers) => {
        setResults(covers)
        if (covers.length === 0) setError('Nessuna copertina trovata. Prova a semplificare il titolo.')
      })
      .catch((reason) => {
        if (timedOut) setError('La ricerca online ha impiegato troppo tempo. Riprova.')
        else if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        clearTimeout(timeout)
        if (timedOut || !controller.signal.aborted) setLoading(false)
      })
  }, [])

  useEffect(() => {
    runSearch(initialQuery.current)
    return () => request.current?.abort()
  }, [runSearch])

  const choose = (candidate: CoverCandidate) => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 20_000)
    setApplying(candidate.id)
    setError(null)
    void (async () => {
      try {
        const cover = await downloadCover(candidate, controller.signal)
        if (controller.signal.aborted) return
        clearTimeout(timeout)
        saving.current = true
        await onApply(cover, controller.signal)
      } catch (reason) {
        if (timedOut) setError('Il download della copertina ha impiegato troppo tempo. Riprova.')
        else if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        clearTimeout(timeout)
        saving.current = false
        if (timedOut || !controller.signal.aborted) setApplying(null)
      }
    })()
  }

  const close = () => {
    if (saving.current) return
    request.current?.abort()
    onClose()
  }

  return (
    <div className="fade-enter fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" role="presentation" onClick={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cover-search-title"
        className="flex max-h-[90dvh] w-full max-w-3xl flex-col overflow-hidden rounded-[16px] bg-card shadow-sheet"
        onClick={(event) => event.stopPropagation()}
        data-testid="cover-search-dialog"
      >
        <div className="hairline-b px-6 pt-6 pb-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 id="cover-search-title" className="text-title2">Scegli una copertina</h2>
              <p className="mt-1 text-footnote text-label-2">Open Library + AniList</p>
            </div>
            <button type="button" className="btn-ghost !min-h-[36px] !px-3.5 !text-[13px]" onClick={close}>Mantieni attuale</button>
          </div>
          <form className="mt-5 flex gap-2" onSubmit={(event) => { event.preventDefault(); runSearch(query) }}>
            <input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              maxLength={180}
              aria-label="Cerca titolo copertina"
              className="field min-w-0 flex-1"
            />
            <button type="submit" className="btn-primary !min-h-[40px]">Cerca</button>
          </form>
          {error && <p className="mt-2 text-footnote text-red">{error}</p>}
        </div>
        <div className="min-h-40 flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex h-40 items-center justify-center"><div className="spinner" aria-label="Ricerca copertine" /></div>
          ) : (
            <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-6">
              {results.map((candidate) => (
                <button key={candidate.id} type="button" className="tile-focus min-w-0 text-left" onClick={() => choose(candidate)} disabled={applying !== null} data-testid="cover-candidate">
                  <div className="tile relative aspect-[2/3] w-full overflow-hidden">
                    <CoverPreview candidate={candidate} />
                    {applying === candidate.id && <div className="absolute inset-0 flex items-center justify-center bg-black/30"><div className="spinner" /></div>}
                  </div>
                  <p className="mt-2 line-clamp-2 text-caption font-semibold text-label">{candidate.title}</p>
                  <p className="truncate text-[11px] text-label-2">
                    {candidate.source} · {candidate.author ?? candidate.year ?? ''}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
