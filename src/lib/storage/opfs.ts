export const BOOKS_DIR = 'books'

export function opfsAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage && typeof navigator.storage.getDirectory === 'function'
}

export async function booksDirectory(create = true): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(BOOKS_DIR, { create })
}

export async function getOpfsFile(bookId: string): Promise<File> {
  const dir = await booksDirectory(true)
  const handle = await dir.getFileHandle(bookId)
  return handle.getFile()
}

export async function deleteOpfsFile(bookId: string): Promise<void> {
  try {
    const dir = await booksDirectory(false)
    await dir.removeEntry(bookId)
  } catch (e) {
    if ((e as DOMException)?.name !== 'NotFoundError') throw e
  }
}

export interface StorageEstimate {
  usage: number
  quota: number
}

export async function estimateStorage(): Promise<StorageEstimate | null> {
  try {
    if (!navigator.storage?.estimate) return null
    const { usage, quota } = await navigator.storage.estimate()
    return { usage: usage ?? 0, quota: quota ?? 0 }
  } catch {
    return null
  }
}

/** Asks the browser to protect the origin's data from eviction (granted heuristically on iOS). */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const storage = navigator.storage as StorageManager & {
      persist?: () => Promise<boolean>
      persisted?: () => Promise<boolean>
    }
    if (!storage?.persist || !storage.persisted) return false
    if (await storage.persisted()) return true
    return await storage.persist()
  } catch {
    return false
  }
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '–'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const digits = v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2
  return `${v.toLocaleString('it-IT', { maximumFractionDigits: digits, minimumFractionDigits: 0 })} ${units[i]}`
}
