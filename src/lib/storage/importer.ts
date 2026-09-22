import type { Book, PageSize } from '../../types'
import { openArchive } from '../archive/openArchive'
import { ArchiveError, type ArchiveErrorCode, isArchiveError } from '../archive/types'
import { detectBlob, titleFromFileName } from '../detect'
import type { CopyRequest, CopyResponse } from './copyProtocol'
import { deleteBookRecord, deletePendingRestore, getFile, getPendingRestore, listBooks, listCollections, putBook, putFileAndBook, putPageSizes, putProgress } from './db'
import {
  beginOpfsBookWrite,
  BOOKS_DIR,
  deleteOpfsFile,
  estimateStorage,
  getOpfsFile,
  opfsAvailable,
  requestPersistentStorage,
} from './opfs'
import { makeThumbnail } from './thumbnail'

export type ImportStage = 'verifica' | 'copia' | 'copertina' | 'completato' | 'errore'

export interface ImportStatus {
  fileName: string
  stage: ImportStage
  bytes: number
  total: number
  error?: { code: ArchiveErrorCode; message: string }
}

export interface ArchivePasswordRequest {
  fileName: string
  invalid: boolean
  signal?: AbortSignal
}

export interface ImportOptions {
  onStatus?: (status: ImportStatus) => void
  signal?: AbortSignal
  /** Test hook: skip OPFS and store the file in IndexedDB. */
  forceIdb?: boolean
  /** Called when an encrypted ZIP needs a password, and again after a wrong password. */
  requestPassword?: (request: ArchivePasswordRequest) => Promise<string | null>
}

const MIN_QUOTA_MARGIN = 32 * 1024 * 1024
const LARGE_QUOTA_MARGIN = 256 * 1024 * 1024
/** IndexedDB Blob puts can materialise the value and kill a mobile renderer; OPFS is mandatory above this. */
const MAX_SAFE_IDB_FILE = 256 * 1024 * 1024

/** Files opened with "Apri senza importare" live here for the current session only. */
const sessionFiles = new Map<string, File>()
/** Passwords deliberately live only for the lifetime of this page, never in IndexedDB/OPFS. */
const archivePasswords = new Map<string, string>()

export function newId(): string {
  const c = globalThis.crypto as Crypto & { randomUUID?: () => string }
  if (typeof c.randomUUID === 'function') return c.randomUUID()
  const bytes = new Uint8Array(16)
  c.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function sessionBookId(file: File): string {
  return `session:${file.name}|${file.size}|${file.lastModified}`
}

export function getSessionFile(bookId: string): File | undefined {
  return sessionFiles.get(bookId)
}

export function getArchivePassword(bookId: string): string | undefined {
  return archivePasswords.get(bookId)
}

export function rememberArchivePassword(bookId: string, password: string): void {
  archivePasswords.set(bookId, password)
}

function toArchiveError(e: unknown): ArchiveError {
  if (isArchiveError(e)) return e
  if ((e as DOMException)?.name === 'AbortError') return new ArchiveError('aborted')
  if ((e as DOMException)?.name === 'QuotaExceededError') return new ArchiveError('quota')
  return new ArchiveError('read', e instanceof Error ? e.message : String(e))
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ArchiveError('aborted')
}

/** Opens the archive to validate it, count pages and grab the cover. */
async function inspect(
  file: File,
  password?: string,
  signal?: AbortSignal,
): Promise<{ format: Book['format']; pageCount: number; cover?: Blob; firstSize?: PageSize }> {
  const opened = await openArchive(file, password, signal)
  try {
    let cover: Blob | undefined
    let firstSize: PageSize | undefined
    try {
      const first = await opened.reader.extract(opened.pages[0]!.name, signal)
      const t = await makeThumbnail(first)
      // A cover would be a decrypted derivative persisted beside the encrypted archive.
      cover = password === undefined ? t.thumb : undefined
      firstSize = t.size
    } catch (e) {
      if (isArchiveError(e) && (e.code === 'invalid-password' || e.code === 'encrypted')) throw e
      // A missing cover must not block the import.
    }
    return { format: opened.format, pageCount: opened.pages.length, cover, firstSize }
  } finally {
    await opened.reader.close()
  }
}

async function inspectWithPassword(
  file: File,
  opts: Pick<ImportOptions, 'requestPassword' | 'signal'>,
): Promise<{ info: Awaited<ReturnType<typeof inspect>>; password?: string }> {
  const kind = await detectBlob(file)
  let password: string | undefined
  for (;;) {
    throwIfAborted(opts.signal)
    try {
      return { info: await inspect(file, password, opts.signal), password }
    } catch (e) {
      const err = toArchiveError(e)
      // Password support is implemented for ZIP/CBZ only; encrypted RAR errors keep their
      // existing message instead of opening a prompt that can never succeed.
      const canRetry = kind === 'zip' && (err.code === 'invalid-password' || (err.code === 'encrypted' && password === undefined))
      if (!canRetry || !opts.requestPassword) throw err
      const entered = await opts.requestPassword({ fileName: file.name, invalid: err.code === 'invalid-password', signal: opts.signal })
      throwIfAborted(opts.signal)
      if (entered === null) throw new ArchiveError('aborted')
      password = entered
    }
  }
}

function copyToOpfs(
  bookId: string,
  file: File,
  onProgress: (bytes: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ status: 'ok' } | { status: 'unsupported'; reason: string }> {
  if (signal?.aborted) return Promise.reject(new ArchiveError('aborted'))
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./copy.worker.ts', import.meta.url), { type: 'module' })
    const finish = () => {
      signal?.removeEventListener('abort', onAbort)
      worker.terminate()
    }
    const onAbort = () => worker.postMessage({ type: 'abort' } satisfies CopyRequest)
    signal?.addEventListener('abort', onAbort)
    if (signal?.aborted) onAbort()
    worker.onmessage = (ev: MessageEvent<CopyResponse>) => {
      const msg = ev.data
      switch (msg.type) {
        case 'progress':
          onProgress(msg.bytes, msg.total)
          break
        case 'done':
          finish()
          resolve({ status: 'ok' })
          break
        case 'unsupported':
          finish()
          resolve({ status: 'unsupported', reason: msg.reason })
          break
        case 'error':
          finish()
          reject(new ArchiveError(msg.code, msg.message))
          break
      }
    }
    worker.onerror = (ev) => {
      finish()
      reject(new ArchiveError('read', ev.message || 'Errore nel worker di copia'))
    }
    worker.postMessage({ type: 'copy', bookId, file, dir: BOOKS_DIR } satisfies CopyRequest)
  })
}

/** Imports a file into the library (OPFS copy, IndexedDB fallback). Throws ArchiveError. */
export async function importFile(file: File, opts: ImportOptions = {}): Promise<Book> {
  const status = (partial: Partial<ImportStatus> & { stage: ImportStage }) =>
    opts.onStatus?.({ fileName: file.name, bytes: 0, total: file.size, ...partial })
  const id = newId()
  let stored: Book['storage'] | null = null
  let releaseOpfsLease: (() => void) | null = null
  try {
    throwIfAborted(opts.signal)
    status({ stage: 'verifica' })
    const existing = (await listBooks()).find((b) => b.fileName === file.name && b.fileSize === file.size)
    if (existing) throw new ArchiveError('duplicate')
    const { info, password } = await inspectWithPassword(file, opts)
    throwIfAborted(opts.signal)

    // Ask before (not after) a multi-GB write, then re-read the quota the browser actually granted.
    await requestPersistentStorage()
    throwIfAborted(opts.signal)
    const estimate = await estimateStorage()
    throwIfAborted(opts.signal)
    const quotaMargin = file.size >= 1024 * 1024 * 1024 ? LARGE_QUOTA_MARGIN : MIN_QUOTA_MARGIN
    if (estimate && estimate.quota > 0 && estimate.quota - estimate.usage < file.size + quotaMargin) {
      throw new ArchiveError('quota', `Liberi ${estimate.quota - estimate.usage} byte, servono ${file.size}`)
    }

    status({ stage: 'copia' })
    let result: { status: 'ok' } | { status: 'unsupported'; reason: string } = {
      status: 'unsupported',
      reason: 'OPFS non disponibile',
    }
    if (!opts.forceIdb && opfsAvailable()) {
      releaseOpfsLease = await beginOpfsBookWrite(id)
      result = await copyToOpfs(id, file, (bytes, total) => status({ stage: 'copia', bytes, total }), opts.signal)
    }
    if (result.status === 'ok') {
      stored = 'opfs'
    } else {
      // Browsers without sync access handles: IndexedDB stores the File as a blob.
      await deleteOpfsFile(id).catch(() => undefined)
      if (file.size > MAX_SAFE_IDB_FILE) throw new ArchiveError('storage', result.reason)
      throwIfAborted(opts.signal)
      stored = 'idb'
    }
    throwIfAborted(opts.signal)

    status({ stage: 'copertina', bytes: file.size })
    const book: Book = {
      id,
      title: titleFromFileName(file.name),
      fileName: file.name,
      fileSize: file.size,
      format: info.format,
      storage: stored,
      pageCount: info.pageCount,
      addedAt: Date.now(),
      lastReadAt: 0,
      cover: info.cover,
      coverSource: info.cover ? 'archive' : undefined,
      passwordProtected: password !== undefined,
    }
    // A restored backup listed this file: give the volume back its title, collection, cover and bookmark.
    const pending = await getPendingRestore(file.name, file.size).catch(() => undefined)
    if (pending) {
      book.title = pending.title
      book.lastReadAt = pending.lastReadAt
      if (pending.addedAt > 0) book.addedAt = pending.addedAt
      if (pending.collectionId && (await listCollections()).some((collection) => collection.id === pending.collectionId)) {
        book.collectionId = pending.collectionId
      }
      if (pending.cover) {
        book.cover = pending.cover
        book.coverSource = 'remote'
      }
    }
    if (stored === 'idb') await putFileAndBook(book, file)
    else await putBook(book)
    throwIfAborted(opts.signal)
    if (pending) {
      if (pending.progress && info.pageCount > 0) {
        await putProgress({ bookId: id, ...pending.progress, page: Math.min(pending.progress.page, info.pageCount - 1) })
      }
      await deletePendingRestore(pending.key)
    }
    if (password !== undefined) rememberArchivePassword(id, password)
    if (info.firstSize) {
      const sizes: Array<PageSize | null> = new Array(info.pageCount).fill(null)
      sizes[0] = info.firstSize
      await putPageSizes(id, sizes)
    }
    status({ stage: 'completato', bytes: file.size })
    return book
  } catch (e) {
    const err = toArchiveError(e)
    // Clean up partial copies.
    await deleteOpfsFile(id).catch(() => undefined)
    await deleteBookRecord(id).catch(() => undefined)
    archivePasswords.delete(id)
    status({ stage: 'errore', error: { code: err.code, message: err.message } })
    throw err
  } finally {
    releaseOpfsLease?.()
  }
}

/** "Apri senza importare": validates the file and keeps it in memory for this session. */
export async function openSessionBook(file: File, opts: Pick<ImportOptions, 'requestPassword'> = {}): Promise<Book> {
  const { info, password } = await inspectWithPassword(file, opts)
  const id = sessionBookId(file)
  sessionFiles.set(id, file)
  const book: Book = {
    id,
    title: titleFromFileName(file.name),
    fileName: file.name,
    fileSize: file.size,
    format: info.format,
    storage: 'session',
    pageCount: info.pageCount,
    addedAt: Date.now(),
    lastReadAt: Date.now(),
    cover: info.cover,
    coverSource: info.cover ? 'archive' : undefined,
    passwordProtected: password !== undefined,
  }
  if (password !== undefined) rememberArchivePassword(id, password)
  return book
}

/** Resolves the archive bytes of a book. Throws ArchiveError('missing') when gone. */
export async function resolveBookBlob(book: Book): Promise<Blob> {
  switch (book.storage) {
    case 'opfs': {
      try {
        return await getOpfsFile(book.id)
      } catch (e) {
        throw new ArchiveError('missing', (e as Error)?.message)
      }
    }
    case 'idb': {
      const blob = await getFile(book.id)
      if (!blob) throw new ArchiveError('missing')
      return blob
    }
    case 'session': {
      const file = sessionFiles.get(book.id)
      if (!file) throw new ArchiveError('missing', 'Il file della sessione non è più disponibile: riaprilo.')
      return file
    }
  }
}

/**
 * Rebuilds the default cover of a library volume, the thumbnail of its first page, when the stored
 * one is missing or was lost (an unreadable Blob of an earlier version). Protected archives keep
 * no persisted cover; session books have no record to update.
 */
export async function regenerateCover(book: Book): Promise<Book | null> {
  if (book.storage === 'session' || book.passwordProtected) return null
  const blob = await resolveBookBlob(book)
  const opened = await openArchive(blob, undefined)
  try {
    const first = opened.pages[0]
    if (!first) return null
    const { thumb } = await makeThumbnail(await opened.reader.extract(first.name))
    const updated: Book = { ...book, cover: thumb, coverSource: 'archive' }
    await putBook(updated)
    return updated
  } finally {
    await opened.reader.close()
  }
}

export async function deleteBook(book: Book): Promise<void> {
  if (book.storage === 'opfs') await deleteOpfsFile(book.id).catch(() => undefined)
  if (book.storage === 'session') sessionFiles.delete(book.id)
  archivePasswords.delete(book.id)
  await deleteBookRecord(book.id)
}
