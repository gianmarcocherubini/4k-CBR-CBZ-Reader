import type { MaxQualityModel } from '../../../types'
import { loadWeights } from './esrganEngine'
import { createUpscaler, type EsrganFactor } from './esrganUpscaler'
import { runEnsembleReference, runRrdbReference, runSrvggReference } from './reference'
import { type EnsembleSize, ensembleTransforms, inverseTransformRgba, transformedSize, transformRgba } from './transforms'
import type { ConvRows } from './wgsl'

export interface SelfTestOptions {
  width?: number
  height?: number
  /** Force bands of few rows so the seam logic runs even on a tiny image. */
  smallBands?: boolean
  /** Self-ensemble passes to compare against the CPU ensemble (default 1). */
  ensemble?: EnsembleSize
  /** Network to test (default the compact v3). */
  model?: MaxQualityModel
  /** Convolution kernel variant (output rows per thread), default 1. */
  variant?: ConvRows
  /**
   * Ensemble reference computed by the GPU itself: single passes on the transformed images, mapped
   * back and averaged. Checks the ensemble plumbing (transposed input, output mapping,
   * accumulation) in seconds where the CPU network would take minutes.
   */
  gpuReference?: boolean
}

export interface SelfTestResult {
  model: MaxQualityModel
  variant: ConvRows
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
  upscaler.variant = opts.variant ?? 1
  try {
    if (opts.smallBands) {
      // 8 core rows per band: (w + 48) * (8 + 48) pixels of activations.
      upscaler.maxActBytes = (w + 48) * (8 + 48) * upscaler.bytesPerPixel
    }
    const rgba = synthetic(w, h)
    const canvas = new OffscreenCanvas(w, h)
    canvas.getContext('2d')!.putImageData(new ImageData(rgba, w, h), 0, 0)
    const ensemble: EnsembleSize = upscaler.supportsEnsemble ? (opts.ensemble ?? 1) : 1
    const single: (img: Uint8ClampedArray, iw: number, ih: number, f: EsrganFactor) => Uint8ClampedArray =
      weights.header.arch === 'rrdb' ? (img, iw, ih, f) => runRrdbReference(weights, img, iw, ih, f, 'clamp') : (img, iw, ih, f) => runSrvggReference(weights, img, iw, ih, f)
    const gpuSingle = async (img: Uint8ClampedArray, iw: number, ih: number, factor: EsrganFactor): Promise<Uint8ClampedArray> => {
      const c = new OffscreenCanvas(iw, ih)
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img), iw, ih), 0, 0)
      const bitmap = await createImageBitmap(c)
      // Reference passes run whole (the forced small bands apply to the run under test only).
      const cap = upscaler.maxActBytes
      upscaler.maxActBytes = Number.MAX_SAFE_INTEGER
      try {
        return (await upscaler.upscale(bitmap, factor, { ensemble: 1 })).data
      } finally {
        upscaler.maxActBytes = cap
        bitmap.close()
      }
    }
    const gpuEnsembleReference = async (factor: EsrganFactor): Promise<Uint8ClampedArray> => {
      const outW = w * factor
      const outH = h * factor
      const sum = new Float64Array(outW * outH * 4)
      const transforms = ensembleTransforms(ensemble)
      for (const t of transforms) {
        const { w: tw, h: th } = transformedSize(w, h, t)
        const back = inverseTransformRgba(await gpuSingle(transformRgba(rgba, w, h, t), tw, th, factor), outW, outH, t)
        for (let i = 0; i < back.length; i++) sum[i] = sum[i]! + back[i]!
      }
      const result = new Uint8ClampedArray(outW * outH * 4)
      for (let i = 0; i < result.length; i++) result[i] = Math.round(sum[i]! / transforms.length)
      return result
    }
    const run = async (factor: EsrganFactor) => {
      const bitmap = await createImageBitmap(canvas)
      const t0 = performance.now()
      let steps = 0
      const out = await upscaler.upscale(bitmap, factor, { ensemble, onProgress: (_d: number, total: number) => (steps = total) })
      const ms = performance.now() - t0
      bitmap.close()
      const ref =
        ensemble === 1
          ? single(rgba, w, h, factor)
          : opts.gpuReference
            ? await gpuEnsembleReference(factor)
            : runEnsembleReference(single, rgba, w, h, factor, ensembleTransforms(ensemble))
      return { ...compare(out.data, ref), ms, bands: steps / ensemble }
    }
    const x4 = await run(4)
    const x2 = await run(2)
    return { model, variant: upscaler.variant, adapter: upscaler.info.adapter, precision: upscaler.info.precision, bands: x4.bands, ensemble, x4, x2 }
  } finally {
    upscaler.dispose()
  }
}
