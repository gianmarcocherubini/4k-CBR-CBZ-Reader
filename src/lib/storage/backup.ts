import type { Book, BookFormat, Collection, PendingRestore, Progress, ReaderSettings } from '../../types'
import { normalizeCollectionGlyph } from '../collections'
import { titleFromFileName } from '../detect'

/**
 * Library backup: everything the user has added on top of the files (titles, collections, chosen
 * covers, bookmarks, settings) in one JSON file. The archives themselves are not included: a volume
 * is identified by file name and size, the importer's duplicate key, so a backup restored on a
 * fresh install (a new iPad, the app moved to another address) re-attaches all of this as the
 * same files are imported again.
 */

export const BACKUP_FORMAT = 'mangadana-backup'
export const BACKUP_VERSION = 1
/** A cover in a backup is a small JPEG; anything bigger is not one of ours. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
const MAX_ITEMS = 50_000
const IMAGE_DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/

export interface BackupProgress {
  page: number
  updatedAt: number
  blanks?: number[]
  coverOffset?: boolean
}

export interface BackupBook {
  title: string
  fileName: string
  fileSize: number
  format: BookFormat
  pageCount: number
  addedAt: number
  lastReadAt: number
  collectionId?: string
  passwordProtected?: boolean
  /** Data URL of the user-chosen (remote) cover. Archive thumbnails are rebuilt on import. */
  cover?: string
  progress?: BackupProgress
}

export interface BackupCollection {
  id: string
  name: string
  createdAt: number
  icon?: string
  /** Data URL of the user-selected PNG. */
  iconImage?: string
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  createdAt: number
  app: { version: string; origin: string }
  settings?: Partial<ReaderSettings>
  collections: BackupCollection[]
  books: BackupBook[]
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupError'
  }
}

/** The importer's duplicate key: the same file name and size identify a volume across installs. */
export function pendingRestoreKey(fileName: string, fileSize: number): string {
  return `${fileSize}:${fileName}`
}

export function backupFileName(now = new Date()): string {
  return `Mangadana-backup-${now.toISOString().slice(0, 10)}.json`
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`
}

/** Only small raster images are accepted back; anything else in a cover field is dropped. */
export function dataUrlToBlob(dataUrl: unknown): Blob | undefined {
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_IMAGE_BYTES * 1.4) return undefined
  const m = IMAGE_DATA_URL.exec(dataUrl)
  if (!m) return undefined
  try {
    const binary = atob(m[2]!)
    if (binary.length > MAX_IMAGE_BYTES) return undefined
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new Blob([bytes], { type: m[1] })
  } catch {
    return undefined
  }
}

export interface LibrarySnapshot {
  books: readonly Book[]
  collections: readonly Collection[]
  progress: ReadonlyMap<string, Progress>
}

/** Builds the backup document. Session books (opened without importing) have no file to come back to. */
export async function serializeBackup(
  library: LibrarySnapshot,
  settings: ReaderSettings,
  app: { version: string; origin: string },
  now = Date.now(),
): Promise<BackupFile> {
  const collections: BackupCollection[] = await Promise.all(
    library.collections.map(async (collection) => ({
      id: collection.id,
      name: collection.name,
      createdAt: collection.createdAt,
      ...(collection.icon ? { icon: collection.icon } : {}),
      ...(collection.iconImage ? { iconImage: await blobToDataUrl(collection.iconImage) } : {}),
    })),
  )
  const known = new Set(library.collections.map((collection) => collection.id))
  const books: BackupBook[] = await Promise.all(
    library.books
      .filter((book) => book.storage !== 'session')
      .map(async (book) => {
        const progress = library.progress.get(book.id)
        return {
          title: book.title,
          fileName: book.fileName,
          fileSize: book.fileSize,
          format: book.format,
          pageCount: book.pageCount,
          addedAt: book.addedAt,
          lastReadAt: book.lastReadAt,
          ...(book.collectionId && known.has(book.collectionId) ? { collectionId: book.collectionId } : {}),
          ...(book.passwordProtected ? { passwordProtected: true } : {}),
          ...(book.cover && book.coverSource === 'remote' ? { cover: await blobToDataUrl(book.cover) } : {}),
          ...(progress
            ? {
                progress: {
                  page: progress.page,
                  updatedAt: progress.updatedAt,
                  ...(progress.blanks && progress.blanks.length > 0 ? { blanks: [...progress.blanks] } : {}),
                  ...(progress.coverOffset ? { coverOffset: true } : {}),
                },
              }
            : {}),
        }
      }),
  )
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: now, app, settings, collections, books }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, max) : undefined

/** Parses and validates a backup file. Throws BackupError with a message for the user. */
export function parseBackup(json: string): BackupFile {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new BackupError('Il file non è un backup di Mangadana (JSON non valido).')
  }
  if (!isRecord(raw) || raw.format !== BACKUP_FORMAT) throw new BackupError('Il file non è un backup di Mangadana.')
  if (raw.version !== BACKUP_VERSION) {
    throw new BackupError(`Questo backup è di una versione più recente dell’app (formato ${String(raw.version)}): aggiorna l’app e riprova.`)
  }
  if (!Array.isArray(raw.books) || !Array.isArray(raw.collections)) throw new BackupError('Il backup è incompleto: mancano volumi o collezioni.')
  if (raw.books.length > MAX_ITEMS || raw.collections.length > MAX_ITEMS) throw new BackupError('Il backup contiene troppe voci.')

  const collections: BackupCollection[] = []
  for (const item of raw.collections) {
    if (!isRecord(item)) continue
    const id = text(item.id, 64)
    const name = text(item.name, 120)
    if (!id || !name) continue
    const icon = normalizeCollectionGlyph(typeof item.icon === 'string' ? item.icon : undefined)
    collections.push({
      id,
      name,
      createdAt: finite(item.createdAt),
      ...(icon ? { icon } : {}),
      ...(typeof item.iconImage === 'string' && IMAGE_DATA_URL.test(item.iconImage) ? { iconImage: item.iconImage } : {}),
    })
  }
  const collectionIds = new Set(collections.map((collection) => collection.id))

  const books: BackupBook[] = []
  const seen = new Set<string>()
  for (const item of raw.books) {
    if (!isRecord(item)) continue
    const fileName = text(item.fileName, 512)
    const fileSize = finite(item.fileSize, -1)
    const format = item.format === 'cbr' ? 'cbr' : item.format === 'cbz' ? 'cbz' : undefined
    if (!fileName || fileSize < 0 || !Number.isInteger(fileSize) || !format) continue
    const key = pendingRestoreKey(fileName, fileSize)
    if (seen.has(key)) continue
    seen.add(key)
    const progress = isRecord(item.progress) ? item.progress : undefined
    const blanks = Array.isArray(progress?.blanks)
      ? progress.blanks.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0).slice(0, 10_000)
      : undefined
    books.push({
      title: text(item.title, 180) ?? titleFromFileName(fileName),
      fileName,
      fileSize,
      format,
      pageCount: Math.max(0, Math.floor(finite(item.pageCount))),
      addedAt: finite(item.addedAt),
      lastReadAt: finite(item.lastReadAt),
      ...(typeof item.collectionId === 'string' && collectionIds.has(item.collectionId) ? { collectionId: item.collectionId } : {}),
      ...(item.passwordProtected === true ? { passwordProtected: true } : {}),
      ...(typeof item.cover === 'string' && IMAGE_DATA_URL.test(item.cover) ? { cover: item.cover } : {}),
      ...(progress
        ? {
            progress: {
              page: Math.max(0, Math.floor(finite(progress.page))),
              updatedAt: finite(progress.updatedAt),
              ...(blanks && blanks.length > 0 ? { blanks } : {}),
              ...(progress.coverOffset === true ? { coverOffset: true } : {}),
            },
          }
        : {}),
    })
  }

  const app = isRecord(raw.app) ? raw.app : {}
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: finite(raw.createdAt),
    app: { version: text(app.version, 40) ?? '?', origin: text(app.origin, 200) ?? '?' },
    ...(isRecord(raw.settings) ? { settings: raw.settings as Partial<ReaderSettings> } : {}),
    collections,
    books,
  }
}

export interface RestorePlan {
  /** Collections to write: new ones from the backup (existing ones, matched by id or name, are reused). */
  collections: Collection[]
  /** Library books whose file is already here, with the backup's data merged in. */
  books: Book[]
  progress: Progress[]
  /** Backup books whose file is not in the library: applied when the same file is imported. */
  pending: PendingRestore[]
  settings?: ReaderSettings
}

export interface RestoreSummary {
  updated: number
  pending: number
  collectionsCreated: number
  settingsRestored: boolean
}

const sameName = (a: string, b: string) => a.trim().localeCompare(b.trim(), 'it', { sensitivity: 'base' }) === 0

/**
 * Merges a backup into the current library, without ever removing anything:
 * - a backup collection reuses the local one with the same id or name, otherwise it is created;
 * - a book whose file is in the library (same name and size) takes the backup's title and
 *   collection only if it was never edited here, the backup's cover if the local one is not a
 *   chosen one, and the more recent of the two bookmarks;
 * - the other books wait for their file as pending restores.
 */
export function planRestore(backup: BackupFile, library: LibrarySnapshot, settings: ReaderSettings | undefined, now = Date.now()): RestorePlan {
  const collectionIdMap = new Map<string, string>()
  const collections: Collection[] = []
  const localCollections = [...library.collections]
  for (const item of backup.collections) {
    const existing = localCollections.find((c) => c.id === item.id) ?? localCollections.find((c) => sameName(c.name, item.name))
    if (existing) {
      collectionIdMap.set(item.id, existing.id)
      continue
    }
    const iconImage = dataUrlToBlob(item.iconImage)
    const collection: Collection = {
      id: item.id,
      name: item.name,
      createdAt: item.createdAt || now,
      ...(item.icon ? { icon: item.icon } : {}),
      ...(iconImage ? { iconImage } : {}),
    }
    collections.push(collection)
    localCollections.push(collection)
    collectionIdMap.set(item.id, item.id)
  }

  const byKey = new Map(library.books.filter((book) => book.storage !== 'session').map((book) => [pendingRestoreKey(book.fileName, book.fileSize), book]))
  const books: Book[] = []
  const progress: Progress[] = []
  const pending: PendingRestore[] = []
  for (const item of backup.books) {
    const collectionId = item.collectionId ? collectionIdMap.get(item.collectionId) : undefined
    const cover = dataUrlToBlob(item.cover)
    const local = byKey.get(pendingRestoreKey(item.fileName, item.fileSize))
    if (!local) {
      pending.push({
        key: pendingRestoreKey(item.fileName, item.fileSize),
        fileName: item.fileName,
        fileSize: item.fileSize,
        title: item.title,
        pageCount: item.pageCount,
        addedAt: item.addedAt,
        lastReadAt: item.lastReadAt,
        ...(collectionId ? { collectionId } : {}),
        ...(cover ? { cover } : {}),
        ...(item.progress ? { progress: item.progress } : {}),
        restoredAt: now,
      })
      continue
    }
    const untouched = local.title === titleFromFileName(local.fileName) && !local.collectionId
    const merged: Book = {
      ...local,
      title: untouched ? item.title : local.title,
      collectionId: untouched ? collectionId : local.collectionId,
      lastReadAt: Math.max(local.lastReadAt, item.lastReadAt),
      addedAt: Math.min(local.addedAt, item.addedAt || local.addedAt),
    }
    if (cover && local.coverSource !== 'remote') {
      merged.cover = cover
      merged.coverSource = 'remote'
    }
    books.push(merged)
    const localProgress = library.progress.get(local.id)
    if (item.progress && (!localProgress || item.progress.updatedAt > localProgress.updatedAt)) {
      progress.push({ bookId: local.id, ...item.progress })
    }
  }

  return { collections, books, progress, pending, ...(settings ? { settings } : {}) }
}

export function summarizeRestore(plan: RestorePlan): RestoreSummary {
  return { updated: plan.books.length, pending: plan.pending.length, collectionsCreated: plan.collections.length, settingsRestored: plan.settings !== undefined }
}
