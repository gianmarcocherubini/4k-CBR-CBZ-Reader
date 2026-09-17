/// <reference lib="webworker" />
import { getUnrar } from 'node-unrar-js/esm/js/unrar.singleton'
import wasmUrl from 'node-unrar-js/esm/js/unrar.wasm?url'
import { type ArchiveEntry, mimeForName } from '../../entries'
import { ArchiveError, serializeError } from '../types'
import { BlobExtractor, type SyncSource } from './blobExtractor'
import type { RarOpenResult, RarRequest, RarResponse } from './protocol'

type UnrarModule = { HEAPU8: Uint8Array; extractor?: unknown }

let unrarModule: UnrarModule | null = null
let extractor: BlobExtractor | null = null

async function loadUnrar(): Promise<UnrarModule> {
  if (!unrarModule) {
    const response = await fetch(wasmUrl)
    if (!response.ok) throw new ArchiveError('read', `Impossibile caricare unrar.wasm (${response.status})`)
    const wasmBinary = await response.arrayBuffer()
    unrarModule = (await getUnrar({ wasmBinary })) as UnrarModule
  }
  return unrarModule
}

/** Blob → synchronous random access (FileReaderSync exists only in workers). */
function blobSource(blob: Blob): SyncSource {
  const fr = new FileReaderSync()
  return {
    size: blob.size,
    read: (start, end) => new Uint8Array(fr.readAsArrayBuffer(blob.slice(start, end))),
  }
}

function mapUnrarError(e: unknown): ArchiveError {
  if (e instanceof ArchiveError) return e
  const reason = (e as { reason?: string })?.reason
  const message = e instanceof Error ? e.message : String(e)
  switch (reason) {
    case 'ERAR_MISSING_PASSWORD':
    case 'ERAR_BAD_PASSWORD':
      return new ArchiveError('encrypted', message)
    case 'ERAR_EOPEN':
    case 'ERAR_EREAD':
      return new ArchiveError('read', message)
    case 'ERAR_BAD_ARCHIVE':
    case 'ERAR_UNKNOWN_FORMAT':
      return new ArchiveError('unsupported', message)
    default:
      return new ArchiveError('corrupt', reason ? `${reason}: ${message}` : message)
  }
}

function open(blob: Blob, password?: string): RarOpenResult {
  if (!unrarModule) throw new ArchiveError('read', 'unrar non inizializzato')
  extractor = new BlobExtractor(unrarModule, blobSource(blob), password)
  unrarModule.extractor = extractor
  const { arcHeader, fileHeaders } = extractor.getFileList()
  if (arcHeader.flags.volume) {
    // Drain the generator so the archive handle is released.
    for (const _ of fileHeaders) void _
    throw new ArchiveError('multivolume')
  }
  if (arcHeader.flags.solid) {
    for (const _ of fileHeaders) void _
    throw new ArchiveError('solid')
  }
  const entries: ArchiveEntry[] = []
  for (const h of fileHeaders) {
    entries.push({
      name: h.name,
      size: h.unpSize,
      directory: h.flags.directory,
      encrypted: h.flags.encrypted,
    })
  }
  return { entries }
}

function extract(name: string): Blob {
  if (!extractor) throw new ArchiveError('read', 'Archivio non aperto')
  const { files } = extractor.extract({ files: [name] })
  let chunks: Uint8Array[] | undefined
  // Iterate to completion: the generator releases the archive handle only when done.
  for (const file of files) {
    if (file.fileHeader.name === name) chunks = file.extraction
  }
  if (!chunks) throw new ArchiveError('missing', `Voce non trovata: ${name}`)
  return new Blob(chunks as BlobPart[], { type: mimeForName(name) })
}

async function handle(msg: RarRequest): Promise<unknown> {
  switch (msg.type) {
    case 'open':
      await loadUnrar()
      return open(msg.blob, msg.password)
    case 'extract':
      return extract(msg.name)
    case 'close':
      extractor?.clearOutputs()
      extractor = null
      if (unrarModule) unrarModule.extractor = undefined
      return null
  }
}

self.onmessage = async (ev: MessageEvent<RarRequest>) => {
  const msg = ev.data
  let response: RarResponse
  try {
    response = { id: msg.id, ok: true, result: await handle(msg) }
  } catch (e) {
    response = { id: msg.id, ok: false, error: serializeError(mapUnrarError(e)) }
  }
  self.postMessage(response)
}
