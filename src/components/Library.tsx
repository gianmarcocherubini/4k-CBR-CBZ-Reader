import { useCallback, useEffect, useRef, useState } from 'react'
import { ArchiveError, describeError, isArchiveError } from '../lib/archive/types'
import { ALL_COLLECTION_ID, collectionViews, DEFAULT_COLLECTION_ID, effectiveCollectionId, mostRecentCollectionId, type CollectionView } from '../lib/collections'
import { flags, isIOS, isStandalone } from '../lib/flags'
import { applyLibraryView, LIBRARY_SORTS, type LibrarySort, type LibraryView, loadLibraryView, READING_FILTERS, type ReadingFilter, readingState, saveLibraryView } from '../lib/libraryView'
import { useRelocationNotice } from '../lib/relocation'
import { createBackupFile, restoreBackupFile, type RestoreResult, shareOrDownload } from '../lib/storage/backupActions'
import {
  clearPendingRestores,
  DatabaseBlockedError,
  deleteCollection,
  getAllProgress,
  getBook,
  listBooks,
  listCollections,
  listPendingRestores,
  putBook,
  putCollection,
} from '../lib/storage/db'
import { type ArchivePasswordRequest, deleteBook, importFile, newId, openSessionBook } from '../lib/storage/importer'
import { cleanupOrphanedBookFiles, estimateStorage, formatBytes, ORPHAN_RETRY_MS, type StorageEstimate } from '../lib/storage/opfs'
import type { Book, Collection, PendingRestore, Progress, ReaderSettings } from '../types'
import { BookCard, ContinueCard } from './BookCard'
import { CrownMark, SITE_URL, Wordmark } from './Brand'
import { BookEditDialog } from './BookEditDialog'
import { CollectionDialog } from './CollectionDialog'
import { CollectionTabs } from './CollectionTabs'
import { CoverSearchDialog } from './CoverSearchDialog'
import { Dialog, DialogAction } from './Dialog'
import { type ImportItem, ImportOverlay } from './ImportOverlay'
import { Segmented } from './reader/SettingsPanel'

interface LibraryProps {
  sessionBooks: Book[]
  /** A new version of the app has been installed by the service worker; a reload applies it. */
  updateReady?: boolean
  onOpen: (book: Book) => void
  onSessionBook: (book: Book) => void
  onRemoveSessionBook: (id: string) => void
  requestPassword: (request: ArchivePasswordRequest) => Promise<string | null>
  /** Reading settings found in a restored backup, to apply to the running app. */
  onRestoreSettings?: (settings: ReaderSettings) => void
}

declare global {
  interface Window {
    __reader?: {
      importFiles: (files: File[]) => Promise<void>
      openSession: (file: File) => Promise<void>
      /** Compares the Real-ESRGAN WebGPU kernels with the float32 reference on a synthetic image. */
      esrganSelfTest: (opts?: import('../lib/upscale/esrgan/selfTest').SelfTestOptions) => Promise<import('../lib/upscale/esrgan/selfTest').SelfTestResult>
    }
  }
}

const ACCEPT = isIOS() ? undefined : '.cbz,.cbr,.zip,.rar,application/zip,application/vnd.rar,application/x-rar-compressed'
const COVER_CONSENT_KEY = 'reader.cover-search-consent-v4'

const PlusIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
    <path d="M12 5v14M5 12h14" />
  </svg>
)
const FolderOpenIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H7.5a2 2 0 0 0-1.9 1.4L3 19z" />
    <path d="M3 19h15.2a2 2 0 0 0 1.9-1.4L22 11" />
  </svg>
)
const SearchIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
)
const MoreIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <circle cx="5" cy="12" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="19" cy="12" r="1.8" />
  </svg>
)
const SortIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M7 4v16m0 0-3.5-3.5M7 20l3.5-3.5M17 20V4m0 0 3.5 3.5M17 4l-3.5 3.5" />
  </svg>
)
/** Volumes shown on the "Continua a leggere" shelf, most recently read first. */
const CONTINUE_LIMIT = 8
const EMPTY_FILTER_LABEL: Record<ReadingFilter, string> = {
  all: '',
  unread: 'Nessun volume da leggere',
  reading: 'Nessun volume in lettura',
  finished: 'Nessun volume finito',
}
const BACKUP_ACCEPT = '.json,application/json'

export function Library({ sessionBooks, updateReady = false, onOpen, onSessionBook, onRemoveSessionBook, requestPassword, onRestoreSettings }: LibraryProps) {
  const [books, setBooks] = useState<Book[] | null>(null)
  const [collections, setCollections] = useState<Collection[]>([])
  const [selectedCollectionId, setSelectedCollectionId] = useState(DEFAULT_COLLECTION_ID)
  const [progress, setProgress] = useState<Map<string, Progress>>(new Map())
  const [pendingRestores, setPendingRestores] = useState<PendingRestore[]>([])
  const [view, setView] = useState<LibraryView>(loadLibraryView)
  const [viewMenu, setViewMenu] = useState(false)
  const [libraryMenu, setLibraryMenu] = useState(false)
  const [backupBusy, setBackupBusy] = useState(false)
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null)
  const [showPending, setShowPending] = useState(false)
  const relocated = useRelocationNotice()
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null)
  const [importItems, setImportItems] = useState<ImportItem[] | null>(null)
  const [importing, setImporting] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<{ title: string; message: string } | null>(null)
  const [toDelete, setToDelete] = useState<Book | null>(null)
  const [editingBook, setEditingBook] = useState<Book | null>(null)
  const [coverBook, setCoverBook] = useState<Book | null>(null)
  const [pendingCoverBooks, setPendingCoverBooks] = useState<Book[]>([])
  const [coverConsentPending, setCoverConsentPending] = useState(false)
  const [creatingCollection, setCreatingCollection] = useState(false)
  const [editingCollection, setEditingCollection] = useState<Collection | null>(null)
  const [collectionMenu, setCollectionMenu] = useState<CollectionView | null>(null)
  const [collectionToDelete, setCollectionToDelete] = useState<CollectionView | null>(null)
  const [query, setQuery] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const importInput = useRef<HTMLInputElement>(null)
  const sessionInput = useRef<HTMLInputElement>(null)
  const restoreInput = useRef<HTMLInputElement>(null)
  const orphanCleanupDone = useRef(false)
  const initialCollectionSelected = useRef(false)
  const refreshGeneration = useRef(0)

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current
    const [b, c] = await Promise.all([listBooks(), listCollections()])
    if (!orphanCleanupDone.current) {
      orphanCleanupDone.current = true
      const { removeLegacySrCache } = await import('../lib/upscale/legacyCache')
      await removeLegacySrCache()
      await cleanupOrphanedBookFiles(
        new Set(b.filter((book) => book.storage === 'opfs').map((book) => book.id)),
        async (bookId) => (await getBook(bookId))?.storage === 'opfs',
      )
    }
    const [p, e, pending] = await Promise.all([getAllProgress(), estimateStorage(), listPendingRestores()])
    if (generation !== refreshGeneration.current) return
    setBooks(b)
    setCollections(c)
    setPendingRestores(pending)
    if (!initialCollectionSelected.current) {
      initialCollectionSelected.current = true
      setSelectedCollectionId(mostRecentCollectionId(c, b))
    } else {
      setSelectedCollectionId((selected) =>
        selected === ALL_COLLECTION_ID || selected === DEFAULT_COLLECTION_ID || c.some((collection) => collection.id === selected)
          ? selected
          : DEFAULT_COLLECTION_ID,
      )
    }
    setProgress(p)
    setEstimate(e)
  }, [])

  const reportOperationError = useCallback((reason: unknown, title = 'Operazione non riuscita') => {
    setError({
      title,
      message:
        reason instanceof DatabaseBlockedError
          ? 'Un’altra scheda sta usando una versione precedente della libreria. Chiudila e ricarica questa pagina.'
          : reason instanceof Error
            ? reason.message
            : String(reason),
    })
  }, [])

  useEffect(() => {
    void refresh().catch((reason) => {
      setBooks([])
      reportOperationError(reason, 'Impossibile aprire la libreria')
    })
  }, [refresh, reportOperationError])

  useEffect(() => {
    const timer = setInterval(() => {
      orphanCleanupDone.current = false
      void refresh().catch(reportOperationError)
    }, ORPHAN_RETRY_MS)
    return () => clearInterval(timer)
  }, [refresh, reportOperationError])

  const startImport = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || abortRef.current) return
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
      const coverSuggestions: Book[] = []
      // Files are imported one at a time to bound memory and I/O.
      for (let i = 0; i < files.length; i++) {
        if (controller.signal.aborted) break
        const file = files[i]!
        const update = (patch: Partial<ImportItem>) =>
          setImportItems((prev) => prev?.map((it, j) => (j === i ? { ...it, ...patch } : it)) ?? prev)
        try {
          const imported = await importFile(file, {
            signal: controller.signal,
            forceIdb: flags.forceIdb,
            requestPassword,
            onStatus: (s) => update({ stage: s.stage, bytes: s.bytes, total: s.total, error: s.error }),
          })
          // An automatic online query for a protected title would disclose metadata; keep that
          // path manual. Unprotected imports are suggested after the result overlay is closed.
          if (!imported.passwordProtected) coverSuggestions.push(imported)
        } catch (e) {
          const err = isArchiveError(e) ? e : new ArchiveError('read', String(e))
          update({ stage: 'errore', error: { code: err.code, message: err.message } })
        }
      }
      setImporting(false)
      abortRef.current = null
      setPendingCoverBooks(coverSuggestions)
      await refresh()
    },
    [refresh, requestPassword],
  )

  const openSession = useCallback(
    async (file: File) => {
      try {
        const book = await openSessionBook(file, { requestPassword })
        onSessionBook(book)
        onOpen(book)
      } catch (e) {
        const err = isArchiveError(e) ? e : new ArchiveError('read', String(e))
        if (err.code !== 'aborted') setError({ title: 'Impossibile aprire il file', message: describeError(err.code, file.name) })
      }
    },
    [onOpen, onSessionBook, requestPassword],
  )

  const openLibraryBook = useCallback(
    async (book: Book) => {
      try {
        const updated = { ...book, lastReadAt: Date.now() }
        if (book.storage === 'session') onSessionBook(updated)
        else await putBook(updated)
        onOpen(updated)
      } catch (reason) {
        reportOperationError(reason, 'Impossibile aprire il volume')
      }
    },
    [onOpen, onSessionBook, reportOperationError],
  )

  // Test hooks (dev / ?test): drive imports without a file picker.
  useEffect(() => {
    if (!flags.test) return
    window.__reader = {
      importFiles: startImport,
      openSession,
      esrganSelfTest: (opts) => import('../lib/upscale/esrgan/selfTest').then((m) => m.esrganSelfTest(opts)),
    }
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
    try {
      if (book.storage === 'session') onRemoveSessionBook(book.id)
      await deleteBook(book)
      await refresh()
    } catch (reason) {
      reportOperationError(reason, 'Impossibile eliminare il volume')
    }
  }

  const createCollection = async (name: string, icon?: string, iconImage?: Blob) => {
    try {
      const collection: Collection = { id: newId(), name, createdAt: Date.now(), icon, iconImage }
      await putCollection(collection)
      setCreatingCollection(false)
      setSelectedCollectionId(collection.id)
      await refresh()
    } catch (reason) {
      setCreatingCollection(false)
      reportOperationError(reason, 'Impossibile creare la collezione')
    }
  }

  const updateCollection = async (collection: Collection, name: string, icon?: string, iconImage?: Blob) => {
    try {
      await putCollection({ ...collection, name, icon, iconImage })
      setEditingCollection(null)
      await refresh()
    } catch (reason) {
      setEditingCollection(null)
      reportOperationError(reason, 'Impossibile salvare la collezione')
    }
  }

  const confirmDeleteCollection = async () => {
    const collection = collectionToDelete
    if (!collection || collection.builtIn) return
    try {
      setCollectionToDelete(null)
      await deleteCollection(collection.id)
      if (selectedCollectionId === collection.id) setSelectedCollectionId(DEFAULT_COLLECTION_ID)
      await refresh()
    } catch (reason) {
      reportOperationError(reason, 'Impossibile eliminare la collezione')
    }
  }

  const saveBookEdits = async (book: Book, title: string, collectionId?: string) => {
    try {
      const updated = { ...book, title, collectionId }
      if (book.storage === 'session') onSessionBook(updated)
      else await putBook(updated)
      setEditingBook(null)
      await refresh()
    } catch (reason) {
      setEditingBook(null)
      reportOperationError(reason, 'Impossibile salvare il volume')
    }
  }

  const searchCoverFromEditor = async (book: Book, title: string, collectionId?: string) => {
    try {
      const updated = { ...book, title, collectionId }
      if (book.storage === 'session') onSessionBook(updated)
      else await putBook(updated)
      setEditingBook(null)
      setCoverBook(updated)
      await refresh()
    } catch (reason) {
      setEditingBook(null)
      reportOperationError(reason, 'Impossibile salvare il volume')
    }
  }

  const showNextCoverSuggestion = () => {
    const [next, ...rest] = pendingCoverBooks
    setPendingCoverBooks(rest)
    setCoverBook(next ?? null)
  }

  const beginCoverSuggestions = () => {
    if (pendingCoverBooks.length === 0) return
    try {
      if (localStorage.getItem(COVER_CONSENT_KEY) === 'yes') {
        showNextCoverSuggestion()
        return
      }
    } catch {
      // Consent can still be given for this batch.
    }
    setCoverConsentPending(true)
  }

  const acceptCoverSuggestions = () => {
    try {
      localStorage.setItem(COVER_CONSENT_KEY, 'yes')
    } catch {
      // This session still proceeds.
    }
    setCoverConsentPending(false)
    showNextCoverSuggestion()
  }

  const declineCoverSuggestions = () => {
    setCoverConsentPending(false)
    setPendingCoverBooks([])
  }

  const applyCover = async (cover: Blob, signal: AbortSignal) => {
    if (!coverBook || signal.aborted) return
    const updated = { ...coverBook, cover, coverSource: 'remote' as const }
    if (updated.storage === 'session') onSessionBook(updated)
    else await putBook(updated)
    if (signal.aborted) return
    setCoverBook(null)
    await refresh()
    showNextCoverSuggestion()
  }

  const exportBackup = async () => {
    setLibraryMenu(false)
    if (backupBusy) return
    setBackupBusy(true)
    try {
      await shareOrDownload(await createBackupFile())
    } catch (reason) {
      reportOperationError(reason, 'Impossibile creare il backup')
    } finally {
      setBackupBusy(false)
    }
  }

  const restoreBackup = async (file: File) => {
    try {
      const result = await restoreBackupFile(file)
      if (result.settings) onRestoreSettings?.(result.settings)
      setRestoreResult(result)
      await refresh()
    } catch (reason) {
      reportOperationError(reason, 'Impossibile ripristinare il backup')
    }
  }

  const dismissPendingRestores = async () => {
    setShowPending(false)
    try {
      await clearPendingRestores()
      await refresh()
    } catch (reason) {
      reportOperationError(reason)
    }
  }

  const updateView = (patch: Partial<LibraryView>) => {
    setView((prev) => {
      const next = { ...prev, ...patch }
      saveLibraryView(next)
      return next
    })
  }

  const allBooks = [...sessionBooks, ...(books ?? [])]
  const collectionList = collectionViews(collections, allBooks)
  const knownCollectionIds = new Set(collections.map((collection) => collection.id))
  const inCollection =
    selectedCollectionId === ALL_COLLECTION_ID
      ? allBooks
      : allBooks.filter((book) => effectiveCollectionId(book, knownCollectionIds) === selectedCollectionId)
  const needle = query.trim().toLocaleLowerCase('it')
  const matchingQuery = needle ? inCollection.filter((book) => book.title.toLocaleLowerCase('it').includes(needle)) : inCollection
  const visibleBooks = applyLibraryView(matchingQuery, progress, view)
  const sortLabel = LIBRARY_SORTS.find((option) => option.value === view.sort)?.label ?? ''
  const filterLabel = READING_FILTERS.find((option) => option.value === view.filter)?.label ?? ''
  const viewLabel = view.filter === 'all' ? sortLabel : `${filterLabel} · ${sortLabel}`
  const selectedCollectionName =
    selectedCollectionId === ALL_COLLECTION_ID
      ? 'Tutti i libri'
      : collectionList.find((collection) => collection.id === selectedCollectionId)?.name ?? 'Senza collezione'
  const showInstallHint = isIOS() && !isStandalone()
  const reading = inCollection.filter((b) => {
    const state = readingState(b, progress.get(b.id))
    return state.started && !state.finished
  })
  const continueReading = !needle ? [...reading].sort((a, b) => b.lastReadAt - a.lastReadAt).slice(0, CONTINUE_LIMIT) : []

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
        <div className="mx-auto flex h-14 w-full max-w-[1400px] items-center gap-3 px-5 sm:px-8">
          <h1 className="flex items-center">
            <Wordmark />
          </h1>
          <div className="flex-1" />
          {allBooks.length > 0 && (
            <label className="relative hidden items-center sm:flex">
              <span className="pointer-events-none absolute left-3 text-label-3">{SearchIcon}</span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                placeholder="Cerca"
                aria-label="Cerca nella libreria"
                className="field !min-h-[34px] w-44 !rounded-full !pl-9 !text-[14px] transition-[width] focus:w-64"
                data-testid="library-search"
              />
            </label>
          )}
          <button type="button" className="btn-ghost !min-h-[34px] !px-3 !text-[13px]" onClick={() => sessionInput.current?.click()} data-testid="open-session" aria-label="Apri senza importare">
            {FolderOpenIcon}
            <span className="hidden md:inline">Apri senza importare</span>
          </button>
          <button type="button" className="btn-primary !min-h-[34px] !px-3.5 !text-[13px]" onClick={() => importInput.current?.click()} data-testid="import" aria-label="Importa">
            {PlusIcon}
            Importa
          </button>
          <button
            type="button"
            className="btn-icon !h-[34px] !w-[34px]"
            onClick={() => setLibraryMenu(true)}
            aria-label="Altre azioni: backup e ripristino"
            data-testid="library-menu"
          >
            {MoreIcon}
          </button>
        </div>
        {books !== null && (
          <div className="mx-auto w-full max-w-[1400px] px-5 sm:px-8">
            <CollectionTabs
              collections={collectionList}
              selectedId={selectedCollectionId}
              onSelect={setSelectedCollectionId}
              onCreate={() => setCreatingCollection(true)}
              onMenu={setCollectionMenu}
              total={allBooks.length}
            />
          </div>
        )}
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
        <input
          ref={restoreInput}
          type="file"
          accept={BACKUP_ACCEPT}
          className="hidden"
          data-testid="restore-input"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0]
            if (f) void restoreBackup(f)
            e.currentTarget.value = ''
          }}
        />
      </header>

      <main className="mx-auto w-full max-w-[1400px] flex-1 px-5 pb-16 sm:px-8">
        {updateReady && (
          <div className="mt-6 flex items-center justify-between gap-3 rounded-[14px] bg-card px-4 py-3 shadow-[inset_0_0_0_1px_var(--line)]" role="status" data-testid="update-banner">
            <span className="text-subhead">Nuova versione dell’app pronta.</span>
            <button type="button" className="btn-pill" onClick={() => location.reload()}>
              Ricarica
            </button>
          </div>
        )}
        {relocated && (
          <div className="mt-6 rounded-[14px] bg-card px-5 py-4 shadow-[inset_0_0_0_1px_var(--line)]" role="status" data-testid="relocation-banner">
            <div className="flex items-center gap-2 text-headline">
              <CrownMark className="h-4 w-4 shrink-0" />
              Mangadana ha un nuovo indirizzo: {new URL(SITE_URL).host}
            </div>
            <p className="mt-1.5 text-footnote text-label-2">
              Questa copia dell’app resta legata al vecchio indirizzo e non riceverà più aggiornamenti; la libreria continua a
              funzionare. Per passare: esporta un backup della libreria, apri {new URL(SITE_URL).host} in Safari e aggiungi
              l’app alla schermata Home, poi nella nuova app ripristina il backup e importa di nuovo i file: titoli,
              collezioni, copertine e segnalibri tornano da soli.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="btn-primary !min-h-[34px] !px-3.5 !text-[13px]" onClick={() => void exportBackup()} disabled={backupBusy}>
                Esporta backup
              </button>
              <a className="btn-ghost !min-h-[34px] !px-3.5 !text-[13px]" href={SITE_URL} target="_blank" rel="noopener">
                Apri il nuovo indirizzo
              </a>
            </div>
          </div>
        )}
        {pendingRestores.length > 0 && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-[14px] bg-card px-4 py-3 shadow-[inset_0_0_0_1px_var(--line)]" role="status" data-testid="pending-restores">
            <div className="min-w-0">
              <span className="text-subhead">
                Dal backup: {pendingRestores.length === 1 ? '1 volume da importare di nuovo.' : `${pendingRestores.length} volumi da importare di nuovo.`}
              </span>{' '}
              <span className="text-footnote text-label-2">Importando gli stessi file, titoli, collezioni, copertine e segnalibri tornano da soli.</span>
            </div>
            <div className="flex shrink-0 gap-2">
              <button type="button" className="btn-pill" onClick={() => setShowPending(true)} data-testid="pending-restores-list">
                Elenco
              </button>
              <button type="button" className="btn-pill" onClick={() => importInput.current?.click()}>
                Importa file
              </button>
            </div>
          </div>
        )}
        {books === null ? (
          <div className="flex h-64 items-center justify-center">
            <div className="spinner" aria-label="Caricamento" />
          </div>
        ) : allBooks.length === 0 ? (
          <div
            className={`mt-10 flex flex-col items-center justify-center rounded-[20px] px-6 py-24 text-center transition-colors ${
              dragOver ? 'bg-tint-soft shadow-[inset_0_0_0_1.5px_var(--accent)]' : 'bg-card shadow-[inset_0_0_0_1px_var(--line)]'
            }`}
            data-testid="empty-library"
          >
            <div className="tile flex h-44 w-[8.25rem] items-center justify-center">
              <CrownMark className="h-16 w-16 text-label-3" />
            </div>
            <h2 className="mt-8 text-large-title">La tua libreria è vuota</h2>
            <p className="mt-3 max-w-md text-subhead text-label-2">
              Importa file CBZ o CBR, fino a 10 GB ciascuno: vengono copiati nell’archiviazione dell’app e restano disponibili
              anche offline. Oppure trascinali qui.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <button type="button" className="btn-primary" onClick={() => importInput.current?.click()}>
                Importa file
              </button>
              <button type="button" className="btn-ghost" onClick={() => sessionInput.current?.click()}>
                Apri senza importare
              </button>
            </div>
            <button type="button" className="btn-plain mt-4 !text-[13px]" onClick={() => restoreInput.current?.click()} data-testid="restore-empty">
              Ripristina da un backup
            </button>
          </div>
        ) : (
          <>
            {dragOver && (
              <div className="pointer-events-none fixed inset-0 z-20 flex items-center justify-center bg-tint-soft shadow-[inset_0_0_0_3px_var(--accent)]">
                <span className="material-strong rounded-[14px] px-5 py-3 text-headline shadow-sheet">Rilascia per importare</span>
              </div>
            )}
            {continueReading.length > 0 && (
              <section className="pt-8" data-testid="continue-shelf">
                <h2 className="eyebrow">Continua a leggere</h2>
                {/* .shelf sets its own (negative) margins, so the gap needs !important: 4 px + its 8 px of padding. */}
                <div className="shelf !mt-1">
                  {continueReading.map((book) => (
                    <ContinueCard key={book.id} book={book} progress={progress.get(book.id)!} onOpen={() => void openLibraryBook(book)} />
                  ))}
                </div>
              </section>
            )}
            <section className="pt-8">
              <div className="flex items-end justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="text-large-title">{needle ? `Risultati per “${query.trim()}”` : selectedCollectionName}</h2>
                  <p className="mt-1 text-footnote text-label-2 tabular-nums" data-testid="grid-count">
                    {view.filter !== 'all' && matchingQuery.length !== visibleBooks.length
                      ? `${visibleBooks.length} di ${matchingQuery.length} volumi`
                      : visibleBooks.length === 1
                        ? '1 volume'
                        : `${visibleBooks.length} volumi`}
                    {!needle && reading.length > 0 ? ` · ${reading.length} in lettura` : ''}
                  </p>
                </div>
                {/* One quiet control for order and filter, as in Apple Books; filled while a filter narrows the grid. */}
                <button
                  type="button"
                  className="btn-pill mb-0.5 shrink-0"
                  aria-pressed={view.filter !== 'all'}
                  aria-label="Ordina e filtra"
                  onClick={() => setViewMenu(true)}
                  data-testid="library-view"
                >
                  {SortIcon}
                  {viewLabel}
                </button>
              </div>
              {visibleBooks.length === 0 ? (
                <div className="mt-6 rounded-[14px] bg-card px-6 py-14 text-center shadow-[inset_0_0_0_1px_var(--line)]" data-testid="grid-empty">
                  <p className="text-body text-label-2">
                    {needle
                      ? 'Nessun volume corrisponde alla ricerca.'
                      : matchingQuery.length > 0
                        ? `${EMPTY_FILTER_LABEL[view.filter]} in questa collezione.`
                        : 'Questa collezione è vuota.'}
                  </p>
                  {!needle && matchingQuery.length === 0 && <p className="mt-1 text-footnote text-label-3">Modifica un volume per spostarlo qui oppure importane uno nuovo.</p>}
                  {!needle && matchingQuery.length > 0 && (
                    <button type="button" className="btn-pill mt-4" onClick={() => updateView({ filter: 'all' })}>
                      Mostra tutti
                    </button>
                  )}
                </div>
              ) : (
                <div className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] gap-x-5 gap-y-9 sm:grid-cols-[repeat(auto-fill,minmax(164px,1fr))] lg:grid-cols-[repeat(auto-fill,minmax(184px,1fr))]">
                  {visibleBooks.map((book) => (
                    <BookCard
                      key={book.id}
                      book={book}
                      progress={progress.get(book.id)}
                      onOpen={() => void openLibraryBook(book)}
                      onMenu={() => setEditingBook(book)}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>

      <footer className="hairline-t px-5 py-5 pb-safe text-caption text-label-3 sm:px-8">
        <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center justify-between gap-x-6 gap-y-1">
          <span data-testid="storage-footer">
            {estimate && estimate.quota > 0
              ? `Spazio usato: ${formatBytes(estimate.usage)} di ${formatBytes(estimate.quota)} disponibili`
              : 'Spazio disponibile: sconosciuto'}
          </span>
          <span>{books?.length ?? 0} nella libreria</span>
          <a className="hover:text-label" href={SITE_URL} target="_blank" rel="noopener">
            {new URL(SITE_URL).host}
          </a>
          <span className="font-mono tabular-nums" data-testid="app-version">
            Versione {__APP_VERSION__} ({__APP_BUILD__})
          </span>
        </div>
        {showInstallHint && (
          <p className="mx-auto mt-3 w-full max-w-[1400px] text-footnote text-label-2" data-testid="install-hint">
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
          onClose={() => {
            setImportItems(null)
            if (!coverBook) beginCoverSuggestions()
          }}
        />
      )}

      {viewMenu && (
        <Dialog
          title="Ordina e filtra"
          onClose={() => setViewMenu(false)}
          actions={
            <DialogAction primary onClick={() => setViewMenu(false)} testId="library-view-done">
              Fine
            </DialogAction>
          }
        >
          <div className="space-y-5 pt-1">
            <div>
              <div className="eyebrow mb-2">Mostra</div>
              <Segmented<ReadingFilter>
                label="Filtra per stato di lettura"
                idPrefix="filter"
                className="w-full"
                value={view.filter}
                options={[...READING_FILTERS]}
                onChange={(filter) => updateView({ filter })}
              />
            </div>
            <div>
              <div className="eyebrow mb-2">Ordina per</div>
              <Segmented<LibrarySort> label="Ordina" idPrefix="sort" className="w-full" value={view.sort} options={[...LIBRARY_SORTS]} onChange={(sort) => updateView({ sort })} />
            </div>
            <p className="text-footnote text-label-3">
              Recenti: l’ultimo aperto per primo. Aggiunti: l’ultimo importato per primo. Titolo: in ordine alfabetico, con i numeri in
              ordine naturale.
            </p>
          </div>
        </Dialog>
      )}

      {libraryMenu && (
        <Dialog
          title="Backup della libreria"
          onClose={() => setLibraryMenu(false)}
          actions={
            <>
              <DialogAction primary onClick={() => void exportBackup()} testId="export-backup">
                Esporta backup
              </DialogAction>
              <DialogAction
                onClick={() => {
                  setLibraryMenu(false)
                  restoreInput.current?.click()
                }}
                testId="restore-backup"
              >
                Ripristina da backup…
              </DialogAction>
              <DialogAction onClick={() => setLibraryMenu(false)}>Annulla</DialogAction>
            </>
          }
        >
          <p>
            Il backup è un file JSON con titoli, collezioni, copertine scelte, segnalibri e impostazioni di lettura: non
            contiene i file CBZ/CBR. Ripristinato su un altro iPad o dopo una reinstallazione, riconosce i volumi dal nome e
            dalla dimensione del file quando li importi di nuovo.
          </p>
        </Dialog>
      )}

      {restoreResult && (
        <Dialog
          title="Backup ripristinato"
          onClose={() => setRestoreResult(null)}
          actions={
            <>
              {restoreResult.pending > 0 && (
                <DialogAction
                  primary
                  onClick={() => {
                    setRestoreResult(null)
                    importInput.current?.click()
                  }}
                >
                  Importa file
                </DialogAction>
              )}
              <DialogAction primary={restoreResult.pending === 0} onClick={() => setRestoreResult(null)} testId="restore-close">
                {restoreResult.pending > 0 ? 'Più tardi' : 'OK'}
              </DialogAction>
            </>
          }
        >
          <ul className="space-y-1.5" data-testid="restore-summary">
            {restoreResult.updated > 0 && <li>{restoreResult.updated === 1 ? '1 volume già in libreria aggiornato.' : `${restoreResult.updated} volumi già in libreria aggiornati.`}</li>}
            {restoreResult.pending > 0 && (
              <li>
                {restoreResult.pending === 1 ? '1 volume da importare di nuovo' : `${restoreResult.pending} volumi da importare di nuovo`}: titoli, collezioni,
                copertine e segnalibri verranno riapplicati importando gli stessi file.
              </li>
            )}
            {restoreResult.collectionsCreated > 0 && (
              <li>{restoreResult.collectionsCreated === 1 ? '1 collezione creata.' : `${restoreResult.collectionsCreated} collezioni create.`}</li>
            )}
            {restoreResult.settingsRestored && <li>Impostazioni di lettura ripristinate.</li>}
            {restoreResult.updated === 0 && restoreResult.pending === 0 && restoreResult.collectionsCreated === 0 && !restoreResult.settingsRestored && (
              <li>Il backup non conteneva nulla da aggiungere.</li>
            )}
          </ul>
        </Dialog>
      )}

      {showPending && (
        <Dialog
          title="Volumi del backup da importare"
          onClose={() => setShowPending(false)}
          actions={
            <>
              <DialogAction
                primary
                onClick={() => {
                  setShowPending(false)
                  importInput.current?.click()
                }}
              >
                Importa file
              </DialogAction>
              <DialogAction destructive onClick={() => void dismissPendingRestores()} testId="dismiss-pending">
                Ignora tutti
              </DialogAction>
              <DialogAction onClick={() => setShowPending(false)}>Chiudi</DialogAction>
            </>
          }
        >
          <ul className="space-y-1" data-testid="pending-list">
            {pendingRestores.map((item) => (
              <li key={item.key} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-label" title={item.fileName}>
                  {item.title}
                </span>
                <span className="shrink-0 text-caption text-label-3 tabular-nums">{formatBytes(item.fileSize)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-footnote text-label-3">«Ignora tutti» dimentica questi dati del backup; i file già in libreria non vengono toccati.</p>
        </Dialog>
      )}

      {coverConsentPending && (
        <Dialog
          title="Cercare copertine online?"
          onClose={declineCoverSuggestions}
          actions={
            <>
              <DialogAction primary onClick={acceptCoverSuggestions} testId="accept-cover-search">
                Cerca online
              </DialogAction>
              <DialogAction onClick={declineCoverSuggestions}>Non ora</DialogAction>
            </>
          }
        >
          <p>
            Per suggerire più alternative, l’app invierà i titoli dei volumi appena importati a Open Library e
            AniList. Le immagini di Open Library vengono scaricate tramite il proxy CORS images.weserv.nl. I file e
            le pagine non vengono inviati.
          </p>
        </Dialog>
      )}

      {creatingCollection && (
        <CollectionDialog
          existingNames={['Senza collezione', 'Tutti i libri', ...collections.map((collection) => collection.name)]}
          onSave={createCollection}
          onCancel={() => setCreatingCollection(false)}
        />
      )}

      {editingCollection && (
        <CollectionDialog
          collection={editingCollection}
          existingNames={[
            'Senza collezione',
            'Tutti i libri',
            ...collections.filter((collection) => collection.id !== editingCollection.id).map((collection) => collection.name),
          ]}
          onSave={(name, icon, iconImage) => updateCollection(editingCollection, name, icon, iconImage)}
          onCancel={() => setEditingCollection(null)}
        />
      )}

      {editingBook && (
        <BookEditDialog
          book={editingBook}
          collections={collections}
          onSave={(title, collectionId) => void saveBookEdits(editingBook, title, collectionId)}
          onCoverSearch={(title, collectionId) => void searchCoverFromEditor(editingBook, title, collectionId)}
          onDelete={() => {
            setToDelete(editingBook)
            setEditingBook(null)
          }}
          onCancel={() => setEditingBook(null)}
        />
      )}

      {coverBook && (
        <CoverSearchDialog
          key={coverBook.id}
          book={coverBook}
          onApply={applyCover}
          onClose={() => {
            setCoverBook(null)
            showNextCoverSuggestion()
          }}
        />
      )}

      {collectionMenu && (
        <Dialog
          title={collectionMenu.name}
          onClose={() => setCollectionMenu(null)}
          actions={
            <>
              <DialogAction
                primary
                onClick={() => {
                  setEditingCollection(collections.find((collection) => collection.id === collectionMenu.id) ?? null)
                  setCollectionMenu(null)
                }}
              >
                Modifica collezione
              </DialogAction>
              <DialogAction
                destructive
                onClick={() => {
                  setCollectionToDelete(collectionMenu)
                  setCollectionMenu(null)
                }}
              >
                Elimina collezione
              </DialogAction>
              <DialogAction onClick={() => setCollectionMenu(null)}>Annulla</DialogAction>
            </>
          }
        >
          <p>Scegli come gestire questa collezione.</p>
        </Dialog>
      )}

      {collectionToDelete && (
        <Dialog
          title="Eliminare la collezione?"
          onClose={() => setCollectionToDelete(null)}
          actions={
            <>
              <DialogAction destructive onClick={() => void confirmDeleteCollection()} testId="confirm-delete-collection">
                Elimina collezione
              </DialogAction>
              <DialogAction primary onClick={() => setCollectionToDelete(null)}>
                Annulla
              </DialogAction>
            </>
          }
        >
          <p>“{collectionToDelete.name}” verrà eliminata. I suoi volumi torneranno in “Senza collezione”.</p>
        </Dialog>
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
