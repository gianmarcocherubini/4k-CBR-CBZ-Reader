import type { ArchiveEntry } from '../entries'
import type { DistributiveOmit, RarOpenResult, RarRequest, RarResponse } from './rar/protocol'
import { ArchiveError, type ArchiveReader, deserializeError } from './types'

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}

/**
 * CBR reader: proxies to a dedicated worker running unrar (WASM) over a Blob-backed
 * extractor. One worker per open archive; `close()` terminates it.
 */
export class RarArchiveReader implements ArchiveReader {
  readonly format = 'cbr' as const
  private readonly blob: Blob
  private worker: Worker | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private opening: Promise<ArchiveEntry[]> | null = null

  constructor(blob: Blob) {
    this.blob = blob
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./rar/rar.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (ev: MessageEvent<RarResponse>) => {
      const res = ev.data
      const p = this.pending.get(res.id)
      if (!p) return
      this.pending.delete(res.id)
      if (res.ok) p.resolve(res.result)
      else p.reject(deserializeError(res.error))
    }
    worker.onerror = (ev) => {
      const err = new ArchiveError('read', ev.message || 'Errore nel worker RAR')
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    }
    this.worker = worker
    return worker
  }

  private call<T>(req: DistributiveOmit<RarRequest, 'id'>): Promise<T> {
    const worker = this.ensureWorker()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      worker.postMessage({ ...req, id })
    })
  }

  entries(): Promise<ArchiveEntry[]> {
    if (!this.opening) {
      this.opening = this.call<RarOpenResult>({ type: 'open', blob: this.blob }).then((r) => r.entries)
      this.opening.catch(() => {
        this.opening = null
      })
    }
    return this.opening
  }

  async extract(name: string): Promise<Blob> {
    await this.entries()
    return this.call<Blob>({ type: 'extract', name })
  }

  async close(): Promise<void> {
    const worker = this.worker
    if (!worker) return
    try {
      await Promise.race([this.call({ type: 'close' }), new Promise((r) => setTimeout(r, 500))])
    } finally {
      worker.terminate()
      this.worker = null
      this.pending.clear()
      this.opening = null
    }
  }
}
