import type { MaxQualityModel } from '../../../types'
import { loadWeights } from './esrganEngine'
import { createUpscaler, type EsrganFactor } from './esrganUpscaler'
import { runRrdbReference, runSrvggEnsembleReference, runSrvggReference } from './reference'
import { type EnsembleSize, ensembleTransforms } from './transforms'

export interface SelfTestOptions {
  width?: number
  height?: number
  /** Force bands of few rows so the seam logic runs even on a tiny image. */
  smallBands?: boolean
  /** Self-ensemble passes to compare against the CPU ensemble (default 1). */
  ensemble?: EnsembleSize
  /** Network to test (default the compact v3). */
  model?: MaxQualityModel
}

export interface SelfTestResult {
  model: MaxQualityModel
  adapter: string
  precision: 'f16' | 'f32'
  bands: number
  ensemble: EnsembleSize
  x4: { psnr: number; maxDiff: number; ms: number }
  x2: { psnr: number; maxDiff: number; ms: number }
}

function synthetic(w: number, h: number): Uint8ClampedArray<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(new ArrayBuffer(w * h * 4))
  let seed = 12345
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      let r = (x / (w - 1)) * 255
      let g = (y / (h - 1)) * 255
      let b = 128 + 127 * Math.sin(x * 0.7 + y * 0.3)
      if (x >= w * 0.25 && x < w * 0.25 + 2 && y > h * 0.2 && y < h * 0.8) r = g = b = 12 // vertical stroke
      if (y >= h * 0.5 && y < h * 0.5 + 2 && x > w * 0.1 && x < w * 0.9) r = g = b = 25 // horizontal stroke
      if (x > w * 0.6 && x < w * 0.85 && y > h * 0.1 && y < h * 0.3) r = g = b = 242 // light block
      const n = (rnd() - 0.5) * 16
      rgba[i] = r + n
      rgba[i + 1] = g + n
      rgba[i + 2] = b + n
      rgba[i + 3] = 255
    }
  }
  return rgba
}

function compare(a: Uint8ClampedArray, b: Uint8ClampedArray): { psnr: number; maxDiff: number } {
  let se = 0
  let maxDiff = 0
  let n = 0
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a[i + c]! - b[i + c]!)
      se += d * d
      if (d > maxDiff) maxDiff = d
      n++
    }
  }
  const mse = se / n
  return { psnr: mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse), maxDiff }
}

/**
 * Runs the WebGPU kernels and the float32 reference on the same synthetic image and compares them
 * (dev / ?test only, through window.__reader.esrganSelfTest). Validates shader compilation on the
 * current browser, the weight layout, the pixel shuffle, the residual and the band seams.
 */
export async function esrganSelfTest(opts: SelfTestOptions = {}): Promise<SelfTestResult> {
  const model = opts.model ?? 'v3'
  const w = opts.width ?? 40
  const h = opts.height ?? 56
  const weights = await loadWeights(model)
  const upscaler = await createUpscaler(weights)
  if (!upscaler) throw new Error('WebGPU non disponibile')
  try {
    if (opts.smallBands) {
      // 8 core rows per band: (w + 48) * (8 + 48) pixels of activations.
      upscaler.maxActBytes = (w + 48) * (8 + 48) * upscaler.bytesPerPixel
    }
    const rgba = synthetic(w, h)
    const canvas = new OffscreenCanvas(w, h)
    canvas.getContext('2d')!.putImageData(new ImageData(rgba, w, h), 0, 0)
    const ensemble: EnsembleSize = upscaler.supportsEnsemble ? (opts.ensemble ?? 1) : 1
    const run = async (factor: EsrganFactor) => {
      const bitmap = await createImageBitmap(canvas)
      const t0 = performance.now()
      let steps = 0
      const out = await upscaler.upscale(bitmap, factor, { ensemble, onProgress: (_d: number, total: number) => (steps = total) })
      const ms = performance.now() - t0
      bitmap.close()
      const ref =
        weights.header.arch === 'rrdb'
          ? runRrdbReference(weights, rgba, w, h, factor, 'clamp')
          : ensemble === 1
            ? runSrvggReference(weights, rgba, w, h, factor)
            : runSrvggEnsembleReference(weights, rgba, w, h, factor, ensembleTransforms(ensemble))
      return { ...compare(out.data, ref), ms, bands: steps / ensemble }
    }
    const x4 = await run(4)
    const x2 = await run(2)
    return { model, adapter: upscaler.info.adapter, precision: upscaler.info.precision, bands: x4.bands, ensemble, x4, x2 }
  } finally {
    upscaler.dispose()
  }
}
