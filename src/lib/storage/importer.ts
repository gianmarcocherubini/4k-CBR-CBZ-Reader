import type { Book, PageSize } from '../../types'
import { openArchive } from '../archive/openArchive'
import { ArchiveError, type ArchiveErrorCode, isArchiveError } from '../archive/types'
import { titleFromFileName } from '../detect'
import type { CopyRequest, CopyResponse } from './copyProtocol'
import { deleteBookRecord, getFile, listBooks, putBook, putFile, putPageSizes } from './db'
import { BOOKS_DIR, deleteOpfsFile, estimateStorage, getOpfsFile, opfsAvailable } from './opfs'
import { makeThumbnail } from './thumbnail'

export type ImportStage = 'verifica' | 'copia' | 'copertina' | 'completato' | 'errore'

export interface ImportStatus {
  fileName: string
  stage: ImportStage
  bytes: number
  total: number
  error?: { code: ArchiveErrorCode; message: string }
}

export interface ImportOptions {
  onStatus?: (status: ImportStatus) => void
  signal?: AbortSignal
  /** Test hook: skip OPFS and store the file in IndexedDB. */
  forceIdb?: boolean
}

const QUOTA_MARGIN = 32 * 1024 * 1024

/** Files opened with "Apri senza importare" live here for the current session only. */
const sessionFiles = new Map<string, File>()

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

function toArchiveError(e: unknown): ArchiveError {
  if (isArchiveError(e)) return e
  if ((e as DOMException)?.name === 'AbortError') return new ArchiveError('aborted')
  if ((e as DOMException)?.name === 'QuotaExceededError') return new ArchiveError('quota')
  return new ArchiveError('read', e instanceof Error ? e.message : String(e))
}

/** Opens the archive to validate it, count pages and grab the cover. */
async function inspect(file: File): Promise<{ format: Book['format']; pageCount: number; cover?: Blob; firstSize?: PageSize }> {
  const opened = await openArchive(file)
  try {
    let cover: Blob | undefined
    let firstSize: PageSize | undefined
    try {
      const first = await opened.reader.extract(opened.pages[0]!.name)
      const t = await makeThumbnail(first)
      cover = t.thumb
      firstSize = t.size
    } catch {
      // A missing cover must not block the import.
    }
    return { format: opened.format, pageCount: opened.pages.length, cover, firstSize }
  } finally {
    await opened.reader.close()
  }
}

function copyToOpfs(
  bookId: string,
  file: File,
  onProgress: (bytes: number, total: number) => void,
  signal?: AbortSignal,
): Promise<'ok' | 'unsupported'> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./copy.worker.ts', import.meta.url), { type: 'module' })
    const finish = () => {
      signal?.removeEventListener('abort', onAbort)
      worker.terminate()
    }
    const onAbort = () => worker.postMessage({ type: 'abort' } satisfies CopyRequest)
    signal?.addEventListener('abort', onAbort)
    worker.onmessage = (ev: MessageEvent<CopyResponse>) => {
      const msg = ev.data
      switch (msg.type) {
        case 'progress':
          onProgress(msg.bytes, msg.total)
          break
        case 'done':
          finish()
          resolve('ok')
          break
        case 'unsupported':
          finish()
          resolve('unsupported')
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
  try {
    status({ stage: 'verifica' })
    const existing = (await listBooks()).find((b) => b.fileName === file.name && b.fileSize === file.size)
    if (existing) throw new ArchiveError('duplicate')
    const info = await inspect(file)
    if (opts.signal?.aborted) throw new ArchiveError('aborted')

    const estimate = await estimateStorage()
    if (estimate && estimate.quota > 0 && estimate.quota - estimate.usage < file.size + QUOTA_MARGIN) {
      throw new ArchiveError('quota', `Liberi ${estimate.quota - estimate.usage} byte, servono ${file.size}`)
    }

    status({ stage: 'copia' })
    let result: 'ok' | 'unsupported' = 'unsupported'
    if (!opts.forceIdb && opfsAvailable()) {
      result = await copyToOpfs(id, file, (bytes, total) => status({ stage: 'copia', bytes, total }), opts.signal)
    }
    if (result === 'ok') {
      stored = 'opfs'
    } else {
      // Browsers without sync access handles: IndexedDB stores the File as a blob.
      await putFile(id, file)
      stored = 'idb'
    }
    if (opts.signal?.aborted) throw new ArchiveError('aborted')

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
    }
    await putBook(book)
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
    if (stored === 'opfs') await deleteOpfsFile(id).catch(() => undefined)
    if (stored === 'idb') await deleteBookRecord(id).catch(() => undefined)
    status({ stage: 'errore', error: { code: err.code, message: err.message } })
    throw err
  }
}

/** "Apri senza importare": validates the file and keeps it in memory for this session. */
export async function openSessionBook(file: File): Promise<Book> {
  const info = await inspect(file)
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
  }
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

export async function deleteBook(book: Book): Promise<void> {
  if (book.storage === 'opfs') await deleteOpfsFile(book.id).catch(() => undefined)
  if (book.storage === 'session') sessionFiles.delete(book.id)
  await deleteBookRecord(book.id)
  const { deleteCunetCache } = await import('../upscale/cunet/cunetEngine')
  await deleteCunetCache(book.id)
}
