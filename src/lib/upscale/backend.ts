import type { PageSize } from '../../types'

export type Anime4KLevel = 'M' | 'VL' | 'UL'

/** Relative cost of each level (MACs per input pixel: M 2.1k, VL 8.0k, UL 17.8k). */
export const LEVEL_COST: Record<Anime4KLevel, number> = { M: 0.26, VL: 1, UL: 2.25 }

export const STRIP_ROWS = 288
export const OVERLAP = 24
export const CORE = STRIP_ROWS - 2 * OVERLAP
/** Safari caps canvas/bitmap area around 16.7 MP. */
export const MAX_OUTPUT_PIXELS = 16 * 1024 * 1024

export interface UpscaleResult {
  data: Uint8ClampedArray<ArrayBuffer>
  width: number
  height: number
}

export interface BackendInfo {
  adapter: string
  maxTextureDimension: number
}

/** A 2x Anime4K upscaler on some GPU API. Implementations process the page in strips. */
export interface UpscaleBackend {
  readonly kind: 'webgpu' | 'webgl2'
  readonly info: BackendInfo
  readonly isLost: boolean
  onLost: (() => void) | null
  canUpscale(size: PageSize): boolean
  /** Builds pipelines/programs for (level, width) if needed. Resolves true when it had to build. */
  prepare(level: Anime4KLevel, width: number): Promise<boolean>
  upscale(source: ImageBitmap, level: Anime4KLevel): Promise<UpscaleResult>
  dispose(): void
}

export function fitsLimits(size: PageSize, maxTextureDimension: number): boolean {
  const w = size.w * 2
  const h = size.h * 2
  return w <= maxTextureDimension && h <= maxTextureDimension && w * h <= MAX_OUTPUT_PIXELS
}

/**
 * Replicate-padded copy of the page: OVERLAP rows above, and enough rows below to complete the
 * last strip, so every strip is exactly STRIP_ROWS tall and edge pixels see real neighbours.
 */
export function padForStrips(source: ImageBitmap): { canvas: OffscreenCanvas; strips: number } {
  const W = source.width
  const H = source.height
  const strips = Math.ceil(H / CORE)
  const paddedH = strips * CORE + 2 * OVERLAP
  const canvas = new OffscreenCanvas(W, paddedH)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(source, 0, 0, W, 1, 0, 0, W, OVERLAP)
  ctx.drawImage(source, 0, OVERLAP)
  ctx.drawImage(source, 0, H - 1, W, 1, 0, OVERLAP + H, W, paddedH - OVERLAP - H)
  return { canvas, strips }
}
