import { type Dihedral, inverseTransformRgba, transformedSize, transformRgba } from './transforms'
import { f16ArrayToF32, RECEPTIVE_FIELD, type SrvggWeights } from './weights'

/**
 * Geometric self-ensemble of the reference: the network runs on each transformed copy of the
 * image, the outputs are mapped back and averaged. What the GPU path computes for `ensemble > 1`.
 */
export function runSrvggEnsembleReference(
  weights: SrvggWeights,
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  factor: 2 | 4,
  transforms: readonly Dihedral[],
): Uint8ClampedArray {
  const outW = w * factor
  const outH = h * factor
  const sum = new Float64Array(outW * outH * 4)
  for (const t of transforms) {
    const { w: tw, h: th } = transformedSize(w, h, t)
    const out = runSrvggReference(weights, transformRgba(rgba, w, h, t), tw, th, factor)
    const back = inverseTransformRgba(out, outW, outH, t)
    for (let i = 0; i < back.length; i++) sum[i] = sum[i]! + back[i]!
  }
  const result = new Uint8ClampedArray(outW * outH * 4)
  for (let i = 0; i < result.length; i++) result[i] = Math.round(sum[i]! / transforms.length)
  return result
}

/**
 * Plain float32 implementation of the network, used to validate the WebGPU kernels (and the weight
 * file against PyTorch). Like the GPU tiles, the image is replicate-padded by the receptive field
 * before the network runs and the output is cropped back, so border pixels match a page processed
 * whole. Far too slow for real pages; only for tests on tiny images.
 */
export function runSrvggReference(weights: SrvggWeights, rgba: Uint8ClampedArray, w: number, h: number, factor: 2 | 4): Uint8ClampedArray {
  const pad = RECEPTIVE_FIELD
  const pw = w + 2 * pad
  const ph = h + 2 * pad
  const n = pw * ph
  const clampX = (x: number) => Math.min(w - 1, Math.max(0, x))
  const clampY = (y: number) => Math.min(h - 1, Math.max(0, y))
  let act = new Float32Array(3 * n)
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const s = (clampY(y - pad) * w + clampX(x - pad)) * 4
      const p = y * pw + x
      act[p] = rgba[s]! / 255
      act[n + p] = rgba[s + 1]! / 255
      act[2 * n + p] = rgba[s + 2]! / 255
    }
  }
  for (const layer of weights.layers) {
    const wt = f16ArrayToF32(layer.weight)
    const bias = f16ArrayToF32(layer.bias)
    const prelu = layer.prelu ? f16ArrayToF32(layer.prelu) : null
    const { cin, cout } = layer
    const out = new Float32Array(cout * n)
    const acc = new Float32Array(cout)
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        acc.set(bias)
        for (let ky = 0; ky < 3; ky++) {
          const sy = Math.min(ph - 1, Math.max(0, y + ky - 1))
          for (let kx = 0; kx < 3; kx++) {
            const sx = Math.min(pw - 1, Math.max(0, x + kx - 1))
            const tap = ky * 3 + kx
            const p = sy * pw + sx
            for (let ci = 0; ci < cin; ci++) {
              const v = act[ci * n + p]!
              if (v === 0) continue
              const wBase = (tap * cin + ci) * cout
              for (let co = 0; co < cout; co++) acc[co] = acc[co]! + v * wt[wBase + co]!
            }
          }
        }
        const o = y * pw + x
        for (let co = 0; co < cout; co++) {
          const a = acc[co]!
          out[co * n + o] = prelu && a < 0 ? a * prelu[co]! : a
        }
      }
    }
    act = out
  }
  // Pixel shuffle (x4) plus the nearest-neighbour residual, clamped; x2 is a 2x2 box of the x4 output.
  const up = weights.header.upscale
  const outW = w * factor
  const outH = h * factor
  const result = new Uint8ClampedArray(outW * outH * 4)
  const sub = up / factor
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const sx = Math.floor(ox / factor)
      const sy = Math.floor(oy / factor)
      const p = (sy + pad) * pw + sx + pad
      const d = (oy * outW + ox) * 4
      for (let c = 0; c < 3; c++) {
        const base = rgba[(sy * w + sx) * 4 + c]! / 255
        let sum = 0
        for (let by = 0; by < sub; by++) {
          for (let bx = 0; bx < sub; bx++) {
            const dy = (oy % factor) * sub + by
            const dx = (ox % factor) * sub + bx
            sum += Math.min(1, Math.max(0, act[(c * up * up + dy * up + dx) * n + p]! + base))
          }
        }
        result[d + c] = Math.round((sum / (sub * sub)) * 255)
      }
      result[d + 3] = 255
    }
  }
  return result
}
