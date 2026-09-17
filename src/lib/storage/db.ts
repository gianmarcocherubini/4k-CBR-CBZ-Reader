import { type DBSchema, type IDBPDatabase, openDB } from 'idb'
import type { Book, PageSize, Progress } from '../../types'

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
}

let dbPromise: Promise<IDBPDatabase<ReaderDB>> | null = null

export function getDB(): Promise<IDBPDatabase<ReaderDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ReaderDB>('cbz-reader', 1, {
      upgrade(db) {
        const books = db.createObjectStore('books', { keyPath: 'id' })
        books.createIndex('byAdded', 'addedAt')
        db.createObjectStore('progress', { keyPath: 'bookId' })
        db.createObjectStore('pageSizes', { keyPath: 'bookId' })
        db.createObjectStore('files', { keyPath: 'bookId' })
      },
    })
  }
  return dbPromise
}

export async function listBooks(): Promise<Book[]> {
  const db = await getDB()
  const books = await db.getAllFromIndex('books', 'byAdded')
  return books.sort((a, b) => b.lastReadAt - a.lastReadAt || b.addedAt - a.addedAt)
}

export async function getBook(id: string): Promise<Book | undefined> {
  return (await getDB()).get('books', id)
}

export async function putBook(book: Book): Promise<void> {
  await (await getDB()).put('books', book)
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

export async function putFile(bookId: string, file: Blob): Promise<void> {
  await (await getDB()).put('files', { bookId, file })
}

export async function getFile(bookId: string): Promise<Blob | undefined> {
  return (await (await getDB()).get('files', bookId))?.file
}

export async function deleteFile(bookId: string): Promise<void> {
  await (await getDB()).delete('files', bookId)
}
