import type { ArchiveEntry } from '../entries'

export type ArchiveErrorCode =
  | 'corrupt'
  | 'encrypted'
  | 'invalid-password'
  | 'unsupported'
  | 'empty'
  | 'solid'
  | 'multivolume'
  | 'read'
  | 'missing'
  | 'quota'
  | 'storage'
  | 'memory'
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
      return `${f} è protetto da password.`
    case 'invalid-password':
      return `La password inserita per ${f} non è corretta.`
    case 'unsupported':
      return `${f} non è un formato supportato: CBZ (ZIP), CBR (RAR), CBT (tar), PDF o EPUB. Il 7z non è supportato.`
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
    case 'storage':
      return `${f} è troppo grande per il metodo di archiviazione disponibile in questo browser. Installa l’app sulla schermata Home o usa “Apri senza importare”.`
    case 'memory':
      return 'La pagina richiede troppa memoria insieme alle altre pagine visibili. Passa alla modalità pagina singola.'
    case 'aborted':
      return 'Operazione annullata.'
    case 'duplicate':
      return `${f} è già nella libreria.`
  }
}

/** Common interface of the container readers. Memory-bounded: never loads the whole file. */
export interface ArchiveReader {
  readonly format: 'cbz' | 'cbr' | 'cbt' | 'pdf'
  /** Lists every entry of the archive (directories included). */
  entries(): Promise<ArchiveEntry[]>
  /** Extracts a single entry as a Blob. */
  extract(name: string, signal?: AbortSignal): Promise<Blob>
  /** Fully authenticates one encrypted entry without retaining its data, when supported. */
  validatePassword?(name: string, signal?: AbortSignal): Promise<void>
  close(): Promise<void>
}
