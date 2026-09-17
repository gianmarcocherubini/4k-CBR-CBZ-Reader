import type { ArchiveEntry } from '../entries'

export type ArchiveErrorCode =
  | 'corrupt'
  | 'encrypted'
  | 'unsupported'
  | 'empty'
  | 'solid'
  | 'multivolume'
  | 'read'
  | 'missing'
  | 'quota'
  | 'aborted'
  | 'duplicate'

export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode
  constructor(code: ArchiveErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'ArchiveError'
    this.code = code
  }
}

export function isArchiveError(e: unknown): e is ArchiveError {
  return e instanceof ArchiveError || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'ArchiveError')
}

/** Serializable form used across the worker boundary. */
export interface SerializedError {
  code: ArchiveErrorCode
  message: string
}

export function serializeError(e: unknown): SerializedError {
  if (isArchiveError(e)) return { code: e.code, message: e.message }
  const message = e instanceof Error ? e.message : String(e)
  return { code: 'corrupt', message }
}

export function deserializeError(e: SerializedError): ArchiveError {
  return new ArchiveError(e.code, e.message)
}

/** Italian user-facing message for an error code. */
export function describeError(code: ArchiveErrorCode, fileName?: string): string {
  const f = fileName ? `“${fileName}”` : 'Il file'
  switch (code) {
    case 'corrupt':
      return `${f} è danneggiato o incompleto.`
    case 'encrypted':
      return `${f} è protetto da password: gli archivi cifrati non sono supportati.`
    case 'unsupported':
      return `${f} non è un archivio CBZ (ZIP) o CBR (RAR). Formati come 7z o PDF non sono supportati.`
    case 'empty':
      return `${f} non contiene immagini.`
    case 'solid':
      return `${f} è un archivio RAR “solido”: non può essere letto pagina per pagina. Ricomprimilo senza l’opzione solido.`
    case 'multivolume':
      return `${f} è un archivio RAR multi-volume: non supportato.`
    case 'read':
      return `Errore durante la lettura di ${fileName ? `“${fileName}”` : 'del file'}.`
    case 'missing':
      return `${f} non è più presente nell’archiviazione dell’app.`
    case 'quota':
      return `Spazio insufficiente per importare ${fileName ? `“${fileName}”` : 'il file'}. Libera spazio o usa “Apri senza importare”.`
    case 'aborted':
      return 'Operazione annullata.'
    case 'duplicate':
      return `${f} è già nella libreria.`
  }
}

/** Common interface of CBZ and CBR readers. Memory-bounded: never loads the whole archive. */
export interface ArchiveReader {
  readonly format: 'cbz' | 'cbr'
  /** Lists every entry of the archive (directories included). */
  entries(): Promise<ArchiveEntry[]>
  /** Extracts a single entry as a Blob. */
  extract(name: string): Promise<Blob>
  close(): Promise<void>
}
