import { type Dihedral, inverseTransformRgba, transformedSize, transformRgba } from './transforms'
import { CONTEXT, f16ArrayToF32, type Layer, RECEPTIVE_FIELD, type SrvggWeights } from './weights'

/** Planar float32 activations: channel-major, then rows, then columns. */
interface Planes {
  data: Float32Array
  c: number
  w: number
  h: number
}

type PadMode = 'zero' | 'clamp'

/**
 * 3x3 convolution over planar activations. `zero` pads like PyTorch (for comparing with the
 * framework on a whole small image); `clamp` replicates the edge like the GPU tiles.
 */
function conv3x3(input: Planes, layer: Layer, pad: PadMode, activation: 'none' | 'lrelu'): Planes {
  const { w, h } = input
  const wt = f16ArrayToF32(layer.weight)
  const bias = f16ArrayToF32(layer.bias)
  const { cin, cout } = layer
  if (cin !== input.c) throw new Error(`${layer.name}: attesi ${cin} canali, trovati ${input.c}`)
  const n = w * h
  const out = new Float32Array(cout * n)
  // Neighbour index per tap offset (−1 = outside, zero padding).
  const xs = [-1, 0, 1].map((d) => Int32Array.from({ length: w }, (_, x) => (x + d < 0 || x + d >= w ? (pad === 'zero' ? -1 : Math.min(w - 1, Math.max(0, x + d))) : x + d)))
  const ys = [-1, 0, 1].map((d) => Int32Array.from({ length: h }, (_, y) => (y + d < 0 || y + d >= h ? (pad === 'zero' ? -1 : Math.min(h - 1, Math.max(0, y + d))) : y + d)))
  for (let co = 0; co < cout; co++) {
    const o = out.subarray(co * n, (co + 1) * n)
    o.fill(bias[co]!)
    for (let ci = 0; ci < cin; ci++) {
      const src = input.data.subarray(ci * n, (ci + 1) * n)
      for (let ky = 0; ky < 3; ky++) {
        const yIdx = ys[ky]!
        for (let kx = 0; kx < 3; kx++) {
          const wgt = wt[((ky * 3 + kx) * cin + ci) * cout + co]!
          if (wgt === 0) continue
          const xIdx = xs[kx]!
          for (let y = 0; y < h; y++) {
            const sy = yIdx[y]!
            if (sy < 0) continue
            const rowIn = sy * w
            const rowOut = y * w
            for (let x = 0; x < w; x++) {
              const sx = xIdx[x]!
              if (sx < 0) continue
              o[rowOut + x] = o[rowOut + x]! + wgt * src[rowIn + sx]!
            }
          }
        }
      }
    }
    if (activation === 'lrelu') for (let i = 0; i < n; i++) if (o[i]! < 0) o[i] = o[i]! * 0.2
  }
  return { data: out, c: cout, w, h }
}

function concat(...parts: Planes[]): Planes {
  const { w, h } = parts[0]!
  const c = parts.reduce((s, p) => s + p.c, 0)
  const data = new Float32Array(c * w * h)
  let offset = 0
  for (const p of parts) {
    data.set(p.data, offset)
    offset += p.data.length
  }
  return { data, c, w, h }
}

/** base + scale × x, channel by channel. */
function addScaled(base: Planes, x: Planes, scale: number): Planes {
  const data = new Float32Array(base.data.length)
  for (let i = 0; i < data.length; i++) data[i] = base.data[i]! + scale * x.data[i]!
  return { data, c: base.c, w: base.w, h: base.h }
}

function upsampleNearest2(p: Planes): Planes {
  const w = p.w * 2
  const h = p.h * 2
  const data = new Float32Array(p.c * w * h)
  for (let c = 0; c < p.c; c++) {
    for (let y = 0; y < h; y++) {
      const src = c * p.w * p.h + (y >> 1) * p.w
      const dst = c * w * h + y * w
      for (let x = 0; x < w; x++) data[dst + x] = p.data[src + (x >> 1)]!
    }
  }
  return { data, c: p.c, w, h }
}

function rgbaToPlanes(rgba: Uint8ClampedArray, w: number, h: number, pad: number): Planes {
  const pw = w + 2 * pad
  const ph = h + 2 * pad
  const n = pw * ph
  const data = new Float32Array(3 * n)
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(h - 1, Math.max(0, y - pad))
    for (let x = 0; x < pw; x++) {
      const sx = Math.min(w - 1, Math.max(0, x - pad))
      const s = (sy * w + sx) * 4
      const p = y * pw + x
      data[p] = rgba[s]! / 255
      data[n + p] = rgba[s + 1]! / 255
      data[2 * n + p] = rgba[s + 2]! / 255
    }
  }
  return { data, c: 3, w: pw, h: ph }
}

/**
 * Float32 implementation of RRDBNet (Real-ESRGAN x4plus anime 6B): conv_first, 6 × RRDB (3 dense
 * blocks of 5 convolutions, residual scaling 0.2), conv_body + skip, two nearest-upsample + conv
 * stages, conv_hr, conv_last. `pad = 'zero'` runs the whole image like PyTorch (for the fixture);
 * `'clamp'` replicate-pads the input by CONTEXT and clamps at every layer, like one GPU band.
 */
export function runRrdbReference(weights: SrvggWeights, rgba: Uint8ClampedArray, w: number, h: number, factor: 2 | 4, pad: PadMode = 'clamp'): Uint8ClampedArray {
  const context = pad === 'clamp' ? CONTEXT : 0
  const layer = (name: string) => {
    const l = weights.byName.get(name)
    if (!l) throw new Error(`Livello mancante: ${name}`)
    return l
  }
  const feat = conv3x3(rgbaToPlanes(rgba, w, h, context), layer('conv_first'), pad, 'none')
  let x = feat
  for (let i = 0; i < (weights.header.numBlock ?? 0); i++) {
    const x0 = x
    for (let j = 1; j <= 3; j++) {
      const p = `body.${i}.rdb${j}`
      const xin = x
      const x1 = conv3x3(xin, layer(`${p}.conv1`), pad, 'lrelu')
      const x2 = conv3x3(concat(xin, x1), layer(`${p}.conv2`), pad, 'lrelu')
      const x3 = conv3x3(concat(xin, x1, x2), layer(`${p}.conv3`), pad, 'lrelu')
      const x4 = conv3x3(concat(xin, x1, x2, x3), layer(`${p}.conv4`), pad, 'lrelu')
      const x5 = conv3x3(concat(xin, x1, x2, x3, x4), layer(`${p}.conv5`), pad, 'none')
      x = addScaled(xin, x5, 0.2)
    }
    x = addScaled(x0, x, 0.2)
  }
  const feat2 = addScaled(feat, conv3x3(x, layer('conv_body'), pad, 'none'), 1)
  const u1 = conv3x3(upsampleNearest2(feat2), layer('conv_up1'), pad, 'lrelu')
  const u2 = conv3x3(upsampleNearest2(u1), layer('conv_up2'), pad, 'lrelu')
  const hr = conv3x3(u2, layer('conv_hr'), pad, 'lrelu')
  const out = conv3x3(hr, layer('conv_last'), pad, 'none') // 4 channels, the 4th is padding
  // Crop the context (×4) and produce the requested factor (x2 = 2x2 box of the clamped x4).
  const outW = w * factor
  const outH = h * factor
  const result = new Uint8ClampedArray(outW * outH * 4)
  const sub = 4 / factor
  const n = out.w * out.h
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      const d = (oy * outW + ox) * 4
      for (let c = 0; c < 3; c++) {
        let sum = 0
        for (let by = 0; by < sub; by++) {
          for (let bx = 0; bx < sub; bx++) {
            const X = context * 4 + ox * sub + bx
            const Y = context * 4 + oy * sub + by
            sum += Math.min(1, Math.max(0, out.data[c * n + Y * out.w + X]!))
          }
        }
        result[d + c] = Math.round((sum / (sub * sub)) * 255)
      }
      result[d + 3] = 255
    }
  }
  return result
}

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
