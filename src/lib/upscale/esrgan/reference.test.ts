import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runRrdbReference, runSrvggReference } from './reference'
import { f16ToF32, parseWeights } from './weights'

const here = dirname(fileURLToPath(import.meta.url))
const load = (name: string) => {
  const b = readFileSync(join(here, name))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}

describe('SRVGG weight file', () => {
  it('parses the shipped realesr-animevideov3 weights', () => {
    const w = parseWeights(load('realesr-animevideov3.f16.bin'))
    expect(w.header.model).toBe('realesr-animevideov3')
    expect(w.header.numFeat).toBe(64)
    expect(w.header.numConv).toBe(16)
    expect(w.header.upscale).toBe(4)
    expect(w.layers).toHaveLength(18)
    expect(w.layers[0]).toMatchObject({ name: 'conv_first', cin: 3, cout: 64 })
    expect(w.layers[17]).toMatchObject({ name: 'conv_last', cin: 64, cout: 48, prelu: null })
    for (const l of w.layers.slice(1, 17)) expect(l).toMatchObject({ cin: 64, cout: 64 })
    expect(w.layers[1]!.prelu).not.toBeNull()
    // Every value is a finite half: no overflow happened while converting. Counted in one pass:
    // an expect() per value (621k of them) took seconds and timed out on a busy CI runner.
    let nonFinite = 0
    for (const l of w.layers) for (const v of l.weight) if (!Number.isFinite(f16ToF32(v))) nonFinite++
    expect(nonFinite).toBe(0)
  })

  it('decodes binary16', () => {
    expect(f16ToF32(0x3c00)).toBe(1)
    expect(f16ToF32(0xc000)).toBe(-2)
    expect(f16ToF32(0x3555)).toBeCloseTo(0.33325, 5)
    expect(f16ToF32(0x0001)).toBeCloseTo(2 ** -24, 12)
    expect(f16ToF32(0x7c00)).toBe(Number.POSITIVE_INFINITY)
    expect(Number.isNaN(f16ToF32(0x7e00))).toBe(true)
  })
})

describe('SRVGG reference implementation', { timeout: 60_000 }, () => {
  // Fixture produced with PyTorch (torch.nn Conv2d/PReLU/PixelShuffle) from the same f16 weights:
  // a 32x24 synthetic image, replicate-padded by 24 px, run through the network, cropped back.
  it('matches the PyTorch output of the same network', () => {
    const weights = parseWeights(load('realesr-animevideov3.f16.bin'))
    const w = 32
    const h = 24
    const rgb = new Uint8Array(load('__fixtures__/srvgg-input-32x24.rgb'))
    const expected = new Uint8Array(load('__fixtures__/srvgg-expected-128x96.rgb'))
    const rgba = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = rgb[i * 3]!
      rgba[i * 4 + 1] = rgb[i * 3 + 1]!
      rgba[i * 4 + 2] = rgb[i * 3 + 2]!
      rgba[i * 4 + 3] = 255
    }
    const out = runSrvggReference(weights, rgba, w, h, 4)
    expect(out.length).toBe(w * 4 * h * 4 * 4)
    let maxDiff = 0
    let se = 0
    for (let i = 0; i < w * h * 16; i++) {
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(out[i * 4 + c]! - expected[i * 3 + c]!)
        maxDiff = Math.max(maxDiff, d)
        se += d * d
      }
    }
    const psnr = 10 * Math.log10((255 * 255) / (se / (w * h * 16 * 3)))
    expect(maxDiff).toBeLessThanOrEqual(2)
    expect(psnr).toBeGreaterThan(55)
  })

  it('produces the x2 result as a 2x2 box of the x4 one, and x1 as a 4x4 box', () => {
    const weights = parseWeights(load('realesr-animevideov3.f16.bin'))
    const w = 8
    const h = 6
    const rgba = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = (i * 37) % 256
      rgba[i * 4 + 1] = (i * 91) % 256
      rgba[i * 4 + 2] = (i * 13) % 256
      rgba[i * 4 + 3] = 255
    }
    const x4 = runSrvggReference(weights, rgba, w, h, 4)
    for (const factor of [2, 1] as const) {
      const out = runSrvggReference(weights, rgba, w, h, factor)
      const sub = 4 / factor
      expect(out.length).toBe(w * factor * h * factor * 4)
      for (let y = 0; y < h * factor; y++) {
        for (let x = 0; x < w * factor; x++) {
          for (let c = 0; c < 3; c++) {
            let sum = 0
            for (let by = 0; by < sub; by++) for (let bx = 0; bx < sub; bx++) sum += x4[((y * sub + by) * w * 4 + x * sub + bx) * 4 + c]!
            expect(Math.abs(out[(y * w * factor + x) * 4 + c]! - sum / (sub * sub))).toBeLessThanOrEqual(2)
          }
        }
      }
    }
  })
})

describe('RRDB (x4plus anime 6B) weight file and reference implementation', { timeout: 60_000 }, () => {
  it('parses the shipped 6B weights: 6 blocks x 15 convolutions plus the six head/tail layers', () => {
    const w = parseWeights(load('realesrgan-x4plus-anime-6b.f16.bin'))
    expect(w.header.arch).toBe('rrdb')
    expect(w.header.numBlock).toBe(6)
    expect(w.header.numGrowCh).toBe(32)
    expect(w.layers).toHaveLength(96)
    expect(w.byName.get('body.0.rdb1.conv2')).toMatchObject({ cin: 96, cout: 32 })
    expect(w.byName.get('body.5.rdb3.conv5')).toMatchObject({ cin: 192, cout: 64 })
    expect(w.byName.get('conv_last')).toMatchObject({ cin: 64, cout: 4, realCout: 3 })
    // The padding channel of conv_last is exactly zero.
    const last = w.byName.get('conv_last')!
    for (let i = 3; i < last.weight.length; i += 4) expect(last.weight[i]).toBe(0)
  })

  // Fixture produced with PyTorch (RRDBNet as in Real-ESRGAN, zero padding) from the same f16 weights.
  it('matches the PyTorch output of RRDBNet on a whole small image', () => {
    const weights = parseWeights(load('realesrgan-x4plus-anime-6b.f16.bin'))
    const w = 16
    const h = 12
    const rgb = new Uint8Array(load('__fixtures__/rrdb-input-16x12.rgb'))
    const expected = new Uint8Array(load('__fixtures__/rrdb-expected-64x48.rgb'))
    const rgba = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = rgb[i * 3]!
      rgba[i * 4 + 1] = rgb[i * 3 + 1]!
      rgba[i * 4 + 2] = rgb[i * 3 + 2]!
      rgba[i * 4 + 3] = 255
    }
    const out = runRrdbReference(weights, rgba, w, h, 4, 'zero')
    let maxDiff = 0
    let se = 0
    for (let i = 0; i < w * h * 16; i++) {
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(out[i * 4 + c]! - expected[i * 3 + c]!)
        maxDiff = Math.max(maxDiff, d)
        se += d * d
      }
    }
    const psnr = 10 * Math.log10((255 * 255) / (se / (w * h * 16 * 3)))
    expect(maxDiff).toBeLessThanOrEqual(2)
    expect(psnr).toBeGreaterThan(55)
  })
})
