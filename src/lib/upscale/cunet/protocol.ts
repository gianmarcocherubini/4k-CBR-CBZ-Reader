import type { HeavyModel } from '../../../types'

export type CunetEp = 'webgpu' | 'wasm'
export type HeavyFactor = 2 | 4

/** How a heavy model is tiled and interpreted by the worker. */
export interface ModelSpec {
  id: HeavyModel
  /** File under public/models. */
  file: string
  /** Optional mixed-precision variant: FP16 internals with FP32 input/output. */
  fp16File?: string
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
  esrgan6b: {
    id: 'esrgan6b',
    file: 'realesrgan_x4plus_anime_6b.onnx',
    fp16File: 'realesrgan_x4plus_anime_6b.fp16.onnx',
    scale: 4,
    tile: 192,
    cropIn: 16,
    shrink: 0,
  },
}

/** Safari caps canvas/bitmap area around 16.7 MP: results must be encodable and decodable there. */
export const HEAVY_MAX_OUTPUT_PIXELS = 16 * 1024 * 1024

/**
 * Factor actually produced for a page: the requested maximum, unless a x4 result would exceed the
 * canvas cap (then x2). x4 is the native output of Real-ESRGAN and two passes of CUNet.
 */
export function heavyFactor(w: number, h: number, maxFactor: HeavyFactor): HeavyFactor | null {
  if (maxFactor === 4 && w * h * 16 <= HEAVY_MAX_OUTPUT_PIXELS) return 4
  if (w * h * 4 <= HEAVY_MAX_OUTPUT_PIXELS) return 2
  return null
}

export type CunetRequest =
  | { type: 'init'; id: number; modelUrl: string; ortPath: string; preferGpu: boolean; spec: ModelSpec }
  | { type: 'process'; id: number; cacheKeyBase: string; page: number; blob: Blob; maxFactor: HeavyFactor; persist: boolean }
  | { type: 'cancel'; id: number }
  | { type: 'list'; id: number; cacheKey: string }
  | { type: 'delete'; id: number; cacheKey: string }

export interface CunetInitResult {
  ep: CunetEp
  threads: number
  crossOriginIsolated: boolean
  precision: 'fp16' | 'fp32'
  graphCapture: boolean
}

export type CunetResponse =
  | { type: 'result'; id: number; ok: true; result: unknown }
  | { type: 'result'; id: number; ok: false; error: { code: 'model-missing' | 'unavailable' | 'aborted' | 'failed'; message: string } }
  | { type: 'progress'; id: number; tilesDone: number; tilesTotal: number }
  | { type: 'mode'; info: CunetInitResult }

/** Sanitised, collision-resistant OPFS directory name for a book id (and model, except the original CUNet). */
export function cacheKeyFor(bookId: string, model: HeavyModel = 'cunet'): string {
  let h = 5381
  for (let i = 0; i < bookId.length; i++) h = ((h << 5) + h + bookId.charCodeAt(i)) | 0
  const base = `${bookId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)}-${(h >>> 0).toString(16)}`
  return model === 'cunet' ? base : `${base}.${model}`
}

/** Directory of the results of one factor: x2 keeps the historical name, x4 gets a suffix. */
export function cacheDirFor(base: string, factor: HeavyFactor): string {
  return factor === 4 ? `${base}.x4` : base
}

export const HEAVY_FACTORS: readonly HeavyFactor[] = [4, 2]

export const CUNET_CACHE_DIR = 'sr-cache'
