export const BOOKS_DIR = 'books'
const activeBookWrites = new Set<string>()
const IMPORT_LEASE_PREFIX = 'reader.opfs-import.'
const IMPORT_LOCK_PREFIX = 'reader:opfs-import:'
const IMPORT_LEASE_MAX_AGE_MS = 5 * 60 * 1000
const IMPORT_LEASE_HEARTBEAT_MS = 30 * 1000
export const ORPHAN_RETRY_MS = 6 * 60 * 1000

const lockManager = (): LockManager | undefined => (navigator as Navigator & { locks?: LockManager }).locks

function writeFallbackLease(bookId: string): void {
  try {
    localStorage.setItem(`${IMPORT_LEASE_PREFIX}${bookId}`, String(Date.now()))
  } catch {
    // The in-memory marker still protects this tab.
  }
}

/** Holds a crash-released Web Lock (or heartbeat lease on old engines) through copy + DB commit. */
export async function beginOpfsBookWrite(bookId: string): Promise<() => void> {
  activeBookWrites.add(bookId)
  const locks = lockManager()
  let released = false
  const finish = () => {
    if (released) return
    released = true
    activeBookWrites.delete(bookId)
    try {
      localStorage.removeItem(`${IMPORT_LEASE_PREFIX}${bookId}`)
    } catch {
      // ignore
    }
  }
  if (locks) {
    let releaseLock!: () => void
    const held = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    let acquiredResolve!: () => void
    let acquiredReject!: (error: unknown) => void
    const acquired = new Promise<void>((resolve, reject) => {
      acquiredResolve = resolve
      acquiredReject = reject
    })
    void locks
      .request(`${IMPORT_LOCK_PREFIX}${bookId}`, async () => {
        acquiredResolve()
        await held
      })
      .catch(acquiredReject)
    try {
      await acquired
    } catch (e) {
      finish()
      throw e
    }
    return () => {
      releaseLock()
      finish()
    }
  }
  writeFallbackLease(bookId)
  const heartbeat = setInterval(() => writeFallbackLease(bookId), IMPORT_LEASE_HEARTBEAT_MS)
  return () => {
    clearInterval(heartbeat)
    finish()
  }
}

function hasFreshImportLease(bookId: string): boolean {
  if (activeBookWrites.has(bookId)) return true
  try {
    const started = Number(localStorage.getItem(`${IMPORT_LEASE_PREFIX}${bookId}`))
    return Number.isFinite(started) && started > 0 && Date.now() - started < IMPORT_LEASE_MAX_AGE_MS
  } catch {
    return false
  }
}

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

/**
 * Removes files left by a browser/process crash during import. The book record is committed only
 * after the OPFS copy finishes, so a file without a matching OPFS book is always incomplete.
 */
export async function cleanupOrphanedBookFiles(
  validBookIds: ReadonlySet<string>,
  isPersisted?: (bookId: string) => Promise<boolean>,
): Promise<number> {
  try {
    const locks = lockManager()
    const dir = await booksDirectory(false)
    const names: string[] = []
    for await (const name of (dir as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }).keys()) names.push(name)
    let removed = 0
    for (const name of names) {
      if (validBookIds.has(name)) continue
      const remove = async () => {
        // The first list can race another tab committing its book; recheck while holding the same
        // lock an importer needs from before file creation through the DB commit.
        if (isPersisted && (await isPersisted(name))) return false
        await dir.removeEntry(name)
        try {
          localStorage.removeItem(`${IMPORT_LEASE_PREFIX}${name}`)
        } catch {
          // ignore
        }
        return true
      }
      if (locks) {
        const didRemove = await locks.request(`${IMPORT_LOCK_PREFIX}${name}`, { ifAvailable: true }, async (lock) => (lock ? remove() : false))
        if (didRemove) removed++
      } else if (!activeBookWrites.has(name) && !hasFreshImportLease(name) && (await remove())) {
        removed++
      }
    }
    return removed
  } catch (e) {
    if ((e as DOMException)?.name === 'NotFoundError') return 0
    return 0
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
