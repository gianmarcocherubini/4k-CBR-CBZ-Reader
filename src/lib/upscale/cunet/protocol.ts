import type { HeavyModel } from '../../../types'

export type CunetEp = 'webgpu' | 'wasm'

/** How a heavy model is tiled and interpreted by the worker. */
export interface ModelSpec {
  id: HeavyModel
  /** File under public/models. */
  file: string
  /** Network scale factor (output = scale × input). */
  scale: 2 | 4
  /** Input tile edge, px. */
  tile: number
  /** Source pixels of context on each side of a tile that are discarded (receptive field). */
  cropIn: number
  /** Total pixels the network itself removes from the output edge (CUNet: 72 = 2 × 36, i.e. its 18 px context × scale). */
  shrink: number
}

export const MODEL_SPECS: Record<HeavyModel, ModelSpec> = {
  // nunif waifu2x CUNet art/scale2x: 256 → 440 (2×256 − 72); the model crops its own 18 px context.
  cunet: { id: 'cunet', file: 'waifu2x_cunet_art_scale2x.onnx', scale: 2, tile: 256, cropIn: 18, shrink: 72 },
  // Real-ESRGAN x4plus anime 6B (RRDB, 6 blocks): 192 → 768, padded convolutions; 16 px of context dropped.
  esrgan6b: { id: 'esrgan6b', file: 'realesrgan_x4plus_anime_6b.onnx', scale: 4, tile: 192, cropIn: 16, shrink: 0 },
}

export type CunetRequest =
  | { type: 'init'; id: number; modelUrl: string; ortPath: string; preferGpu: boolean; spec: ModelSpec }
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

/** Sanitised, collision-resistant OPFS directory name for a book id (and model, except the original CUNet). */
export function cacheKeyFor(bookId: string, model: HeavyModel = 'cunet'): string {
  let h = 5381
  for (let i = 0; i < bookId.length; i++) h = ((h << 5) + h + bookId.charCodeAt(i)) | 0
  const base = `${bookId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)}-${(h >>> 0).toString(16)}`
  return model === 'cunet' ? base : `${base}.${model}`
}

export const CUNET_CACHE_DIR = 'sr-cache'
