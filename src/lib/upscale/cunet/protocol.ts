export type CunetEp = 'webgpu' | 'wasm'

export type CunetRequest =
  | { type: 'init'; id: number; modelUrl: string; ortPath: string; preferGpu: boolean }
  | { type: 'process'; id: number; cacheKey: string; page: number; blob: Blob }
  | { type: 'cancel'; id: number }
  | { type: 'list'; id: number; cacheKey: string }
  | { type: 'delete'; id: number; cacheKey: string }

export interface CunetInitResult {
  ep: CunetEp
  threads: number
  crossOriginIsolated: boolean
}

export type CunetResponse =
  | { type: 'result'; id: number; ok: true; result: unknown }
  | { type: 'result'; id: number; ok: false; error: { code: 'model-missing' | 'unavailable' | 'aborted' | 'failed'; message: string } }
  | { type: 'progress'; id: number; tilesDone: number; tilesTotal: number }

/** Sanitised, collision-resistant OPFS directory name for a book id. */
export function cacheKeyFor(bookId: string): string {
  let h = 5381
  for (let i = 0; i < bookId.length; i++) h = ((h << 5) + h + bookId.charCodeAt(i)) | 0
  return `${bookId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)}-${(h >>> 0).toString(16)}`
}

export const CUNET_CACHE_DIR = 'sr-cache'
