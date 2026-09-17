import { useCallback, useEffect, useRef, useState } from 'react'
import { ArchiveError, describeError, isArchiveError } from '../lib/archive/types'
import { flags, isIOS, isStandalone } from '../lib/flags'
import { getAllProgress, listBooks } from '../lib/storage/db'
import { deleteBook, importFile, openSessionBook } from '../lib/storage/importer'
import { estimateStorage, formatBytes, requestPersistentStorage, type StorageEstimate } from '../lib/storage/opfs'
import type { Book, Progress } from '../types'
import { BookCard } from './BookCard'
import { Dialog, DialogAction } from './Dialog'
import { type ImportItem, ImportOverlay } from './ImportOverlay'

interface LibraryProps {
  sessionBooks: Book[]
  /** A new version of the app has been installed by the service worker; a reload applies it. */
  updateReady?: boolean
  onOpen: (book: Book) => void
  onSessionBook: (book: Book) => void
  onRemoveSessionBook: (id: string) => void
}

declare global {
  interface Window {
    __reader?: {
      importFiles: (files: File[]) => Promise<void>
      openSession: (file: File) => Promise<void>
    }
  }
}

const ACCEPT = isIOS() ? undefined : '.cbz,.cbr,.zip,.rar,application/zip,application/vnd.rar,application/x-rar-compressed'

const PlusIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export function Library({ sessionBooks, updateReady = false, onOpen, onSessionBook, onRemoveSessionBook }: LibraryProps) {
  const [books, setBooks] = useState<Book[] | null>(null)
  const [progress, setProgress] = useState<Map<string, Progress>>(new Map())
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null)
  const [importItems, setImportItems] = useState<ImportItem[] | null>(null)
  const [importing, setImporting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<{ title: string; message: string } | null>(null)
  const [toDelete, setToDelete] = useState<Book | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const importInput = useRef<HTMLInputElement>(null)
  const sessionInput = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    const [b, p, e] = await Promise.all([listBooks(), getAllProgress(), estimateStorage()])
    setBooks(b)
    setProgress(p)
    setEstimate(e)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const startImport = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      const controller = new AbortController()
      abortRef.current = controller
      const items: ImportItem[] = files.map((f, i) => ({
        key: `${i}-${f.name}`,
        fileName: f.name,
        stage: 'verifica',
        bytes: 0,
        total: f.size,
      }))
      setImportItems(items)
      setImporting(true)
      // Files are imported one at a time to bound memory and I/O.
      for (let i = 0; i < files.length; i++) {
        if (controller.signal.aborted) break
        const file = files[i]!
        const update = (patch: Partial<ImportItem>) =>
          setImportItems((prev) => prev?.map((it, j) => (j === i ? { ...it, ...patch } : it)) ?? prev)
        try {
          await importFile(file, {
            signal: controller.signal,
            forceIdb: flags.forceIdb,
            onStatus: (s) => update({ stage: s.stage, bytes: s.bytes, total: s.total, error: s.error }),
          })
        } catch (e) {
          const err = isArchiveError(e) ? e : new ArchiveError('read', String(e))
          update({ stage: 'errore', error: { code: err.code, message: err.message } })
        }
        if (i === 0 || i === files.length - 1) void requestPersistentStorage()
      }
      setImporting(false)
      abortRef.current = null
      await refresh()
    },
    [refresh],
  )

  const openSession = useCallback(
    async (file: File) => {
      try {
        const book = await openSessionBook(file)
        onSessionBook(book)
        onOpen(book)
      } catch (e) {
        const err = isArchiveError(e) ? e : new ArchiveError('read', String(e))
        setError({ title: 'Impossibile aprire il file', message: describeError(err.code, file.name) })
      }
    },
    [onOpen, onSessionBook],
  )

  // Test hooks (dev / ?test): drive imports without a file picker.
  useEffect(() => {
    if (!flags.test) return
    window.__reader = { importFiles: startImport, openSession }
    return () => {
      delete window.__reader
    }
  }, [startImport, openSession])

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    void startImport(Array.from(e.dataTransfer.files))
  }

  const confirmDelete = async () => {
    if (!toDelete) return
    const book = toDelete
    setToDelete(null)
    if (book.storage === 'session') onRemoveSessionBook(book.id)
    await deleteBook(book)
    await refresh()
  }

  const allBooks = [...sessionBooks, ...(books ?? [])]
  const showInstallHint = isIOS() && !isStandalone()
  const reading = allBooks.filter((b) => (progress.get(b.id)?.page ?? 0) > 0 && (progress.get(b.id)?.page ?? 0) < b.pageCount - 1)

  return (
    <div
      className="flex min-h-full flex-col bg-bg pt-safe px-safe"
      onDragOver={(e) => {
        e.preventDefault()
        if (!dragOver) setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return
        setDragOver(false)
      }}
      onDrop={onDrop}
    >
      <header className="material hairline-b sticky top-0 z-10">
        <div className="mx-auto flex w-full max-w-6xl items-end justify-between gap-3 px-5 pt-4 pb-2 sm:px-8">
          <h1 className="text-large-title">Libreria</h1>
          <div className="flex items-center gap-1 pb-1">
            <button type="button" className="btn-plain" onClick={() => sessionInput.current?.click()} data-testid="open-session">
              Apri senza importare
            </button>
            <button type="button" className="btn-pill" onClick={() => importInput.current?.click()} data-testid="import" aria-label="Importa">
              {PlusIcon}
              Importa
            </button>
          </div>
        </div>
        <input
          ref={importInput}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          data-testid="import-input"
          onChange={(e) => {
            void startImport(Array.from(e.currentTarget.files ?? []))
            e.currentTarget.value = ''
          }}
        />
        <input
          ref={sessionInput}
          type="file"
          accept={ACCEPT}
          className="hidden"
          data-testid="session-input"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0]
            if (f) void openSession(f)
            e.currentTarget.value = ''
          }}
        />
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 pb-10 sm:px-8">
        {updateReady && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl bg-tint-soft px-4 py-3" role="status" data-testid="update-banner">
            <span className="text-subhead">Nuova versione dell’app pronta.</span>
            <button type="button" className="btn-pill" onClick={() => location.reload()}>
              Ricarica
            </button>
          </div>
        )}
        {books === null ? (
          <div className="flex h-64 items-center justify-center">
            <div className="spinner" aria-label="Caricamento" />
          </div>
        ) : allBooks.length === 0 ? (
          <div
            className={`mt-10 flex flex-col items-center justify-center rounded-3xl px-6 py-20 text-center transition-colors ${
              dragOver ? 'bg-tint-soft outline-2 outline-dashed outline-tint' : 'bg-grouped'
            }`}
            data-testid="empty-library"
          >
            <div className="cover flex h-40 w-[7.5rem] items-center justify-center bg-card">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-label-3" aria-hidden>
                <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" />
                <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20" />
              </svg>
            </div>
            <h2 className="mt-7 text-title2">Nessun libro</h2>
            <p className="mt-2 max-w-md text-subhead text-label-2">
              Importa file CBZ o CBR (fino a 10 GB ciascuno): vengono copiati nell’archiviazione dell’app e restano disponibili
              anche offline. Oppure trascinali qui.
            </p>
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <button type="button" className="btn-primary" onClick={() => importInput.current?.click()}>
                Importa file
              </button>
              <button type="button" className="btn-ghost" onClick={() => sessionInput.current?.click()}>
                Apri senza importare
              </button>
            </div>
          </div>
        ) : (
          <>
            {dragOver && (
              <div className="pointer-events-none fixed inset-0 z-20 flex items-center justify-center bg-tint-soft outline-4 outline-dashed -outline-offset-8 outline-tint">
                <span className="material-strong rounded-2xl px-5 py-3 text-headline shadow-sheet">Rilascia per importare</span>
              </div>
            )}
            <section className="pt-6">
              <p className="text-footnote text-label-2">
                {allBooks.length === 1 ? '1 libro' : `${allBooks.length} libri`}
                {reading.length > 0 ? ` · ${reading.length} in lettura` : ''}
              </p>
              <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-5 gap-y-8 sm:grid-cols-[repeat(auto-fill,minmax(160px,1fr))]">
                {allBooks.map((book) => (
                  <BookCard
                    key={book.id}
                    book={book}
                    progress={progress.get(book.id)}
                    onOpen={() => onOpen(book)}
                    onDelete={() => setToDelete(book)}
                  />
                ))}
              </div>
            </section>
          </>
        )}
      </main>

      <footer className="hairline-t px-5 py-4 pb-safe text-footnote text-label-2 sm:px-8">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2">
          <span data-testid="storage-footer">
            {estimate && estimate.quota > 0
              ? `Spazio usato: ${formatBytes(estimate.usage)} di ${formatBytes(estimate.quota)} disponibili`
              : 'Spazio disponibile: sconosciuto'}
          </span>
          <span>{books?.length ?? 0} nella libreria</span>
        </div>
        {showInstallHint && (
          <p className="mx-auto mt-2 w-full max-w-6xl" data-testid="install-hint">
            Per installare: tocca <strong>Condividi</strong> in Safari e poi <strong>Aggiungi alla schermata Home</strong>. L’app
            installata ha uno spazio di archiviazione separato da Safari: importa i file dall’app installata.
          </p>
        )}
      </footer>

      {importItems && (
        <ImportOverlay
          items={importItems}
          running={importing}
          onCancel={() => abortRef.current?.abort()}
          onClose={() => setImportItems(null)}
        />
      )}

      {error && (
        <Dialog
          title={error.title}
          onClose={() => setError(null)}
          actions={
            <DialogAction primary onClick={() => setError(null)}>
              OK
            </DialogAction>
          }
        >
          <p data-testid="error-message">{error.message}</p>
        </Dialog>
      )}

      {toDelete && (
        <Dialog
          title="Eliminare questo libro?"
          onClose={() => setToDelete(null)}
          actions={
            <>
              <DialogAction destructive onClick={() => void confirmDelete()} testId="confirm-delete">
                Elimina
              </DialogAction>
              <DialogAction primary onClick={() => setToDelete(null)}>
                Annulla
              </DialogAction>
            </>
          }
        >
          <p>
            “{toDelete.title}” ({formatBytes(toDelete.fileSize)}) verrà rimosso dalla libreria
            {toDelete.storage === 'session' ? '.' : ' insieme alla copia nell’archiviazione dell’app e al segnalibro.'}
          </p>
        </Dialog>
      )}
    </div>
  )
}
