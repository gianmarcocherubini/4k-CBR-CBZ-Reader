/// <reference lib="webworker" />
import type { CopyRequest, CopyResponse } from './copyProtocol'
import { readBlobSlices } from './blobSlices'

/**
 * Copies a picked File into OPFS with a sync access handle. Explicit serial Blob slices avoid
 * WebKit's Blob.stream() backpressure bug, which can retain hundreds of MB and kill an iPad PWA.
 */

const PROGRESS_EVERY_BYTES = 16 * 1024 * 1024
const PROGRESS_EVERY_MS = 120
/** Bound dirty OPFS/OS pages as well as JS heap growth during multi-GB copies. */
const FLUSH_EVERY_BYTES = 64 * 1024 * 1024

let aborted = false

const post = (msg: CopyResponse) => self.postMessage(msg)

async function copy(bookId: string, file: File, dirName: string): Promise<void> {
  if (typeof FileSystemFileHandle === 'undefined' || !('createSyncAccessHandle' in FileSystemFileHandle.prototype)) {
    post({ type: 'unsupported', reason: 'createSyncAccessHandle non disponibile' })
    return
  }
  let dir: FileSystemDirectoryHandle
  let handle: FileSystemFileHandle
  try {
    const root = await navigator.storage.getDirectory()
    dir = await root.getDirectoryHandle(dirName, { create: true })
    handle = await dir.getFileHandle(bookId, { create: true })
  } catch (e) {
    post({ type: 'unsupported', reason: (e as Error)?.message ?? String(e) })
    return
  }

  // Safari 15.2–16 returned promises from the sync handle methods: awaiting is harmless elsewhere.
  type MaybeAsyncHandle = {
    write(buffer: ArrayBufferView, options?: { at: number }): number | Promise<number>
    truncate(size: number): void | Promise<void>
    flush(): void | Promise<void>
    close(): void | Promise<void>
  }
  let access: MaybeAsyncHandle
  try {
    access = (await handle.createSyncAccessHandle()) as unknown as MaybeAsyncHandle
  } catch (e) {
    post({ type: 'unsupported', reason: (e as Error)?.message ?? String(e) })
    return
  }

  let offset = 0
  let lastFlush = 0
  let lastReport = 0
  let lastReportAt = performance.now()
  const report = (force = false) => {
    const now = performance.now()
    if (force || offset - lastReport >= PROGRESS_EVERY_BYTES || now - lastReportAt >= PROGRESS_EVERY_MS) {
      lastReport = offset
      lastReportAt = now
      post({ type: 'progress', bytes: offset, total: file.size })
    }
  }

  const writeChunk = async (chunk: Uint8Array) => {
    let written = 0
    while (written < chunk.byteLength) {
      const n = await access.write(chunk.subarray(written), { at: offset })
      if (!n || n <= 0) throw new DOMException('Scrittura fallita', 'QuotaExceededError')
      written += n
      offset += n
    }
  }

  try {
    await access.truncate(0)
    for await (const chunk of readBlobSlices(file)) {
      if (aborted) throw new DOMException('Annullato', 'AbortError')
      if (chunk.offset !== offset) throw new DOMException(`Offset sorgente ${chunk.offset}, destinazione ${offset}`, 'NotReadableError')
      await writeChunk(chunk.bytes)
      if (offset - lastFlush >= FLUSH_EVERY_BYTES) {
        await access.flush()
        lastFlush = offset
      }
      report()
    }
    await access.flush()
    await access.close()
    if (offset !== file.size) {
      throw new DOMException(`Copiati ${offset} byte su ${file.size}`, 'NotReadableError')
    }
    report(true)
    post({ type: 'done', bytes: offset })
  } catch (e) {
    try {
      await access.close()
    } catch {
      // ignore
    }
    try {
      await dir.removeEntry(bookId)
    } catch {
      // ignore
    }
    const name = (e as DOMException)?.name
    const message = (e as Error)?.message ?? String(e)
    if (name === 'AbortError') post({ type: 'error', code: 'aborted', message })
    else if (name === 'QuotaExceededError') post({ type: 'error', code: 'quota', message })
    else post({ type: 'error', code: 'read', message })
  }
}

self.onmessage = (ev: MessageEvent<CopyRequest>) => {
  const msg = ev.data
  if (msg.type === 'abort') {
    aborted = true
    return
  }
  aborted = false
  void copy(msg.bookId, msg.file, msg.dir)
}
