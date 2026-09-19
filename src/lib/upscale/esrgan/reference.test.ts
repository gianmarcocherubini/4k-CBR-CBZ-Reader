import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runSrvggReference } from './reference'
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
    // Every value is a finite half: no overflow happened while converting.
    for (const l of w.layers) for (const v of l.weight) expect(Number.isFinite(f16ToF32(v))).toBe(true)
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

describe('SRVGG reference implementation', () => {
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

  it('produces the x2 result as a 2x2 box of the x4 one', () => {
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
    const x2 = runSrvggReference(weights, rgba, w, h, 2)
    for (let y = 0; y < h * 2; y++) {
      for (let x = 0; x < w * 2; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0
          for (let by = 0; by < 2; by++) for (let bx = 0; bx < 2; bx++) sum += x4[((y * 2 + by) * w * 4 + x * 2 + bx) * 4 + c]!
          expect(Math.abs(x2[(y * w * 2 + x) * 4 + c]! - sum / 4)).toBeLessThanOrEqual(2)
        }
      }
    }
  })
})
