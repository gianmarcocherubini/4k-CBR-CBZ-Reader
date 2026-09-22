import { type DBSchema, type IDBPDatabase, openDB } from 'idb'
import type { Book, Collection, PageSize, PendingRestore, Progress } from '../../types'
import { normalizeCollectionGlyph } from '../collections'
import { pendingRestoreKey } from './backup'

/**
 * Small images (covers, collection icons) are stored as bytes inside the record, not as Blobs.
 * WebKit keeps IndexedDB Blobs as separate files that a home-screen web app can lose after a
 * restart or a purge: the record survives, the Blob becomes unreadable and the cover shows as a
 * broken image. Bytes live in the record itself and come back as an in-memory Blob every time.
 * Records written by earlier versions still carry Blobs and are converted the first time they
 * are read; a Blob that cannot be read any more is dropped, and the library rebuilds the cover
 * from the first page.
 */
interface StoredImage {
  bytes: ArrayBuffer
  type: string
}
type StoredBook = Omit<Book, 'cover'> & { cover?: Blob; coverData?: StoredImage }
type StoredCollection = Omit<Collection, 'iconImage'> & { iconImage?: Blob; iconData?: StoredImage }
type StoredPendingRestore = Omit<PendingRestore, 'cover'> & { cover?: Blob; coverData?: StoredImage }

interface ReaderDB extends DBSchema {
  books: {
    key: string
    value: StoredBook
    indexes: { byAdded: number }
  }
  progress: {
    key: string
    value: Progress
  }
  pageSizes: {
    key: string
    value: { bookId: string; sizes: Array<PageSize | null> }
  }
  files: {
    key: string
    value: { bookId: string; file: Blob }
  }
  collections: {
    key: string
    value: StoredCollection
    indexes: { byCreated: number }
  }
  /** Books of a restored backup whose file is not in the library yet, keyed by file name and size. */
  pendingRestores: {
    key: string
    value: StoredPendingRestore
  }
}

/** A dead IndexedDB Blob may reject or never answer: either way the image is gone. */
const BLOB_READ_TIMEOUT_MS = 8000

async function packImage(blob: Blob | undefined): Promise<StoredImage | undefined> {
  if (!blob) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const bytes = await Promise.race([
      blob.arrayBuffer(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Blob non leggibile')), BLOB_READ_TIMEOUT_MS)
      }),
    ])
    return { bytes, type: blob.type }
  } finally {
    clearTimeout(timer)
  }
}

const unpackImage = (image: StoredImage | undefined): Blob | undefined => (image ? new Blob([image.bytes], { type: image.type }) : undefined)

/** Reads a legacy Blob field; `undefined` (and `changed`) when it is unreadable. */
async function migrateBlob(blob: Blob): Promise<StoredImage | undefined> {
  try {
    return await packImage(blob)
  } catch {
    return undefined
  }
}

async function toStoredBook(book: Book): Promise<StoredBook> {
  const { cover, ...rest } = book
  const coverData = await packImage(cover)
  return coverData ? { ...rest, coverData } : rest
}

function fromStoredBook(stored: StoredBook): Book {
  const { coverData, cover, ...rest } = stored
  const blob = unpackImage(coverData) ?? cover
  return blob ? { ...rest, cover: blob } : rest
}

async function toStoredCollection(collection: Collection): Promise<StoredCollection> {
  const { iconImage, ...rest } = collection
  const iconData = await packImage(iconImage)
  return iconData ? { ...rest, iconData } : rest
}

function fromStoredCollection(stored: StoredCollection): Collection {
  const { iconData, iconImage, ...rest } = stored
  const blob = unpackImage(iconData) ?? iconImage
  return blob ? { ...rest, iconImage: blob } : rest
}

async function toStoredPendingRestore(item: PendingRestore): Promise<StoredPendingRestore> {
  const { cover, ...rest } = item
  const coverData = await packImage(cover)
  return coverData ? { ...rest, coverData } : rest
}

function fromStoredPendingRestore(stored: StoredPendingRestore): PendingRestore {
  const { coverData, cover, ...rest } = stored
  const blob = unpackImage(coverData) ?? cover
  return blob ? { ...rest, cover: blob } : rest
}

let dbPromise: Promise<IDBPDatabase<ReaderDB>> | null = null
export class DatabaseBlockedError extends Error {
  constructor() {
    super('Database bloccato da un’altra scheda')
    this.name = 'DatabaseBlockedError'
  }
}

export function getDB(): Promise<IDBPDatabase<ReaderDB>> {
  if (!dbPromise) {
    let timedOut = false
    const opening = openDB<ReaderDB>('cbz-reader', 3, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const books = db.createObjectStore('books', { keyPath: 'id' })
          books.createIndex('byAdded', 'addedAt')
          db.createObjectStore('progress', { keyPath: 'bookId' })
          db.createObjectStore('pageSizes', { keyPath: 'bookId' })
          db.createObjectStore('files', { keyPath: 'bookId' })
        }
        if (oldVersion < 2) {
          const collections = db.createObjectStore('collections', { keyPath: 'id' })
          collections.createIndex('byCreated', 'createdAt')
        }
        if (oldVersion < 3) {
          db.createObjectStore('pendingRestores', { keyPath: 'key' })
        }
      },
      // A tab running this version must not block a later schema upgrade.
      blocking() {
        const current = dbPromise
        dbPromise = null
        void current?.then((db) => db.close(), () => undefined)
      },
      terminated() {
        dbPromise = null
      },
    })
    const guarded = new Promise<IDBPDatabase<ReaderDB>>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true
        reject(new DatabaseBlockedError())
      }, 8000)
      opening.then(
        (db) => {
          clearTimeout(timer)
          if (timedOut) db.close()
          else resolve(db)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
    dbPromise = guarded.catch((error) => {
      dbPromise = null
      throw error
    })
  }
  return dbPromise
}

/**
 * Brings a stored book record up to date: scrubs fields that early builds briefly persisted (ZIP
 * passwords, decrypted covers of protected books) and moves a legacy Blob cover into the record.
 * Returns the record to write back, or null when nothing changed.
 */
async function upgradeStoredBook(stored: StoredBook): Promise<StoredBook | null> {
  const legacy = stored as StoredBook & { archivePassword?: unknown }
  const hasLegacyBlob = legacy.cover instanceof Blob
  const scrub = Object.hasOwn(legacy, 'archivePassword') || (legacy.passwordProtected && (legacy.cover || legacy.coverData) && legacy.coverSource !== 'remote')
  if (!hasLegacyBlob && !scrub) return null
  const next = { ...legacy } as StoredBook & { archivePassword?: unknown }
  if (Object.hasOwn(next, 'archivePassword')) {
    delete next.archivePassword
    next.passwordProtected = true
  }
  if (next.passwordProtected && next.coverSource !== 'remote') {
    delete next.cover
    delete next.coverData
    delete next.coverSource
  }
  if (next.cover instanceof Blob) {
    const packed = await migrateBlob(next.cover)
    delete next.cover
    if (packed) next.coverData = packed
    else delete next.coverSource
  }
  return next
}

export async function listBooks(): Promise<Book[]> {
  const db = await getDB()
  const stored = await db.getAllFromIndex('books', 'byAdded')
  const books = await Promise.all(
    stored.map(async (record) => {
      const upgraded = await upgradeStoredBook(record)
      if (upgraded) await db.put('books', upgraded)
      return fromStoredBook(upgraded ?? record)
    }),
  )
  return books.sort((a, b) => b.lastReadAt - a.lastReadAt || b.addedAt - a.addedAt)
}

export async function getBook(id: string): Promise<Book | undefined> {
  const db = await getDB()
  const stored = await db.get('books', id)
  if (!stored) return undefined
  const upgraded = await upgradeStoredBook(stored)
  if (upgraded) await db.put('books', upgraded)
  return fromStoredBook(upgraded ?? stored)
}

export async function putBook(book: Book): Promise<void> {
  const stored = await toStoredBook(book)
  await (await getDB()).put('books', stored)
}

export async function listCollections(): Promise<Collection[]> {
  const db = await getDB()
  const collections = await db.getAllFromIndex('collections', 'byCreated')
  return Promise.all(
    collections.map(async (stored) => {
      const icon = normalizeCollectionGlyph(stored.icon)
      const hasLegacyBlob = stored.iconImage instanceof Blob
      if (icon === stored.icon && !hasLegacyBlob) return fromStoredCollection(stored)
      const migrated: StoredCollection = { ...stored, icon }
      if (hasLegacyBlob) {
        const packed = await migrateBlob(stored.iconImage!)
        delete migrated.iconImage
        if (packed) migrated.iconData = packed
      }
      await db.put('collections', migrated)
      return fromStoredCollection(migrated)
    }),
  )
}

export async function putCollection(collection: Collection): Promise<void> {
  const stored = await toStoredCollection(collection)
  await (await getDB()).put('collections', stored)
}

/** Deleting a collection moves its books back to the built-in default collection. */
export async function deleteCollection(collectionId: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(['collections', 'books'], 'readwrite')
  const books = await tx.objectStore('books').getAll()
  await Promise.all([
    ...books.filter((book) => book.collectionId === collectionId).map((book) => tx.objectStore('books').put({ ...book, collectionId: undefined })),
    tx.objectStore('collections').delete(collectionId),
    tx.done,
  ])
}

export async function deleteBookRecord(id: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(['books', 'progress', 'pageSizes', 'files'], 'readwrite')
  await Promise.all([
    tx.objectStore('books').delete(id),
    tx.objectStore('progress').delete(id),
    tx.objectStore('pageSizes').delete(id),
    tx.objectStore('files').delete(id),
    tx.done,
  ])
}

export async function getProgress(bookId: string): Promise<Progress | undefined> {
  return (await getDB()).get('progress', bookId)
}

export async function putProgress(progress: Progress): Promise<void> {
  await (await getDB()).put('progress', progress)
}

export async function getAllProgress(): Promise<Map<string, Progress>> {
  const all = await (await getDB()).getAll('progress')
  return new Map(all.map((p) => [p.bookId, p]))
}

export async function getPageSizes(bookId: string): Promise<Array<PageSize | null> | undefined> {
  return (await (await getDB()).get('pageSizes', bookId))?.sizes
}

export async function putPageSizes(bookId: string, sizes: Array<PageSize | null>): Promise<void> {
  await (await getDB()).put('pageSizes', { bookId, sizes })
}

/** Commits the IDB fallback bytes and their visible book record atomically. */
export async function putFileAndBook(book: Book, file: Blob): Promise<void> {
  const db = await getDB()
  // Packed before the transaction: an await with no request in flight would auto-commit it.
  const stored = await toStoredBook(book)
  const tx = db.transaction(['files', 'books'], 'readwrite')
  await Promise.all([tx.objectStore('files').put({ bookId: book.id, file }), tx.objectStore('books').put(stored), tx.done])
}

export async function getFile(bookId: string): Promise<Blob | undefined> {
  return (await (await getDB()).get('files', bookId))?.file
}

export async function deleteFile(bookId: string): Promise<void> {
  await (await getDB()).delete('files', bookId)
}

export async function listPendingRestores(): Promise<PendingRestore[]> {
  const all = await (await getDB()).getAll('pendingRestores')
  return all.map(fromStoredPendingRestore).sort((a, b) => a.fileName.localeCompare(b.fileName, 'it', { numeric: true, sensitivity: 'base' }))
}

export async function getPendingRestore(fileName: string, fileSize: number): Promise<PendingRestore | undefined> {
  const stored = await (await getDB()).get('pendingRestores', pendingRestoreKey(fileName, fileSize))
  return stored ? fromStoredPendingRestore(stored) : undefined
}

export async function putPendingRestores(items: readonly PendingRestore[]): Promise<void> {
  if (items.length === 0) return
  const db = await getDB()
  const stored = await Promise.all(items.map(toStoredPendingRestore))
  const tx = db.transaction('pendingRestores', 'readwrite')
  await Promise.all([...stored.map((item) => tx.store.put(item)), tx.done])
}

export async function deletePendingRestore(key: string): Promise<void> {
  await (await getDB()).delete('pendingRestores', key)
}

export async function clearPendingRestores(): Promise<void> {
  await (await getDB()).clear('pendingRestores')
}

/** Applies a restored backup in one transaction: collections, merged books and their bookmarks. */
export async function applyRestore(collections: readonly Collection[], books: readonly Book[], progress: readonly Progress[]): Promise<void> {
  const db = await getDB()
  const [storedCollections, storedBooks] = await Promise.all([Promise.all(collections.map(toStoredCollection)), Promise.all(books.map(toStoredBook))])
  const tx = db.transaction(['collections', 'books', 'progress'], 'readwrite')
  await Promise.all([
    ...storedCollections.map((collection) => tx.objectStore('collections').put(collection)),
    ...storedBooks.map((book) => tx.objectStore('books').put(book)),
    ...progress.map((p) => tx.objectStore('progress').put(p)),
    tx.done,
  ])
}
