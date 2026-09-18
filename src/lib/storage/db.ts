import { type DBSchema, type IDBPDatabase, openDB } from 'idb'
import type { Book, Collection, PageSize, Progress } from '../../types'

interface ReaderDB extends DBSchema {
  books: {
    key: string
    value: Book
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
    value: Collection
    indexes: { byCreated: number }
  }
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
    const opening = openDB<ReaderDB>('cbz-reader', 2, {
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

export async function listBooks(): Promise<Book[]> {
  const db = await getDB()
  const stored = await db.getAllFromIndex('books', 'byAdded')
  const books = await Promise.all(
    stored.map(async (book) => {
      const legacy = book as Book & { archivePassword?: unknown }
      if (
        !Object.hasOwn(legacy, 'archivePassword') &&
        !(legacy.passwordProtected && legacy.cover && legacy.coverSource !== 'remote')
      ) {
        return book
      }
      // One-time scrub for local/dev builds that briefly persisted ZIP passwords or decrypted
      // covers. Unknown fields survive IndexedDB unless explicitly removed.
      const cleaned = { ...legacy } as Book & { archivePassword?: unknown }
      const wasEncrypted = Object.hasOwn(cleaned, 'archivePassword')
      delete cleaned.archivePassword
      if (wasEncrypted) cleaned.passwordProtected = true
      if (cleaned.passwordProtected && cleaned.coverSource !== 'remote') {
        delete cleaned.cover
        delete cleaned.coverSource
      }
      await db.put('books', cleaned)
      return cleaned
    }),
  )
  return books.sort((a, b) => b.lastReadAt - a.lastReadAt || b.addedAt - a.addedAt)
}

export async function getBook(id: string): Promise<Book | undefined> {
  return (await getDB()).get('books', id)
}

export async function putBook(book: Book): Promise<void> {
  await (await getDB()).put('books', book)
}

export async function listCollections(): Promise<Collection[]> {
  return (await getDB()).getAllFromIndex('collections', 'byCreated')
}

export async function putCollection(collection: Collection): Promise<void> {
  await (await getDB()).put('collections', collection)
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
  const tx = db.transaction(['files', 'books'], 'readwrite')
  await Promise.all([tx.objectStore('files').put({ bookId: book.id, file }), tx.objectStore('books').put(book), tx.done])
}

export async function getFile(bookId: string): Promise<Blob | undefined> {
  return (await (await getDB()).get('files', bookId))?.file
}

export async function deleteFile(bookId: string): Promise<void> {
  await (await getDB()).delete('files', bookId)
}
