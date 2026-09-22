import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { f16ToF32, parseWeights } from './weights'
import { f32ToF16, transformInput, transformKernel, transformOutput, winogradWeights } from './winograd'

const here = dirname(fileURLToPath(import.meta.url))

/** Direct 3x3 correlation of a 4x4 tile: the 2x2 output Winograd must reproduce. */
function direct(d: Float32Array, g: Float32Array): Float32Array {
  const y = new Float32Array(4)
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      let s = 0
      for (let ky = 0; ky < 3; ky++) for (let kx = 0; kx < 3; kx++) s += g[ky * 3 + kx]! * d[(i + ky) * 4 + j + kx]!
      y[i * 2 + j] = s
    }
  }
  return y
}

function random(n: number, seed: number): Float32Array {
  const out = new Float32Array(n)
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = s / 0x7fffffff - 0.5
  }
  return out
}

describe('Winograd F(2x2, 3x3)', () => {
  it('reproduces the direct 3x3 correlation on random tiles and kernels', () => {
    for (let trial = 0; trial < 50; trial++) {
      const d = random(16, 7 + trial)
      const g = random(9, 1000 + trial)
      const u = transformKernel(g)
      const v = transformInput(d)
      const m = new Float32Array(16)
      for (let p = 0; p < 16; p++) m[p] = u[p]! * v[p]!
      const y = transformOutput(m)
      const ref = direct(d, g)
      for (let k = 0; k < 4; k++) expect(Math.abs(y[k]! - ref[k]!)).toBeLessThan(1e-5)
    }
  })

  it('is linear in the channels: summing element-wise products over inputs equals the summed convolution', () => {
    const cin = 5
    const ds = Array.from({ length: cin }, (_, c) => random(16, 300 + c))
    const gs = Array.from({ length: cin }, (_, c) => random(9, 500 + c))
    const m = new Float32Array(16)
    const ref = new Float32Array(4)
    for (let c = 0; c < cin; c++) {
      const u = transformKernel(gs[c]!)
      const v = transformInput(ds[c]!)
      for (let p = 0; p < 16; p++) m[p] = m[p]! + u[p]! * v[p]!
      const y = direct(ds[c]!, gs[c]!)
      for (let k = 0; k < 4; k++) ref[k] = ref[k]! + y[k]!
    }
    const y = transformOutput(m)
    for (let k = 0; k < 4; k++) expect(Math.abs(y[k]! - ref[k]!)).toBeLessThan(1e-5)
  })

  it('converts binary32 to binary16 with round-to-nearest-even', () => {
    expect(f32ToF16(1)).toBe(0x3c00)
    expect(f32ToF16(-2)).toBe(0xc000)
    expect(f32ToF16(0.5)).toBe(0x3800)
    expect(f32ToF16(65504)).toBe(0x7bff)
    expect(f32ToF16(1e6)).toBe(0x7bff) // saturates instead of producing infinity
    expect(f32ToF16(0)).toBe(0)
    expect(f16ToF32(f32ToF16(2 ** -24))).toBeCloseTo(2 ** -24, 12) // smallest subnormal
    expect(f16ToF32(f32ToF16(6.1e-5))).toBeCloseTo(6.1e-5, 7)
    // Round trip of every finite half is exact.
    for (let h = 0; h < 0x7c00; h += 37) expect(f32ToF16(f16ToF32(h))).toBe(h)
    // A value halfway between two halves rounds to the even one.
    expect(f32ToF16(f16ToF32(0x3c00) + (f16ToF32(0x3c01) - f16ToF32(0x3c00)) / 2)).toBe(0x3c00)
    expect(f32ToF16(f16ToF32(0x3c01) + (f16ToF32(0x3c02) - f16ToF32(0x3c01)) / 2)).toBe(0x3c02)
  })

  it('transforms the shipped v3 weights within the f16 range, laid out [p][cin][cout]', () => {
    const b = readFileSync(join(here, 'realesr-animevideov3.f16.bin'))
    const weights = parseWeights(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
    const layer = weights.layers[1]!
    const u = winogradWeights(layer)
    expect(u.length).toBe(16 * layer.cin * layer.cout)
    let maxAbs = 0
    let nonFinite = 0
    for (const v of u) {
      if (!Number.isFinite(v)) nonFinite++
      maxAbs = Math.max(maxAbs, Math.abs(v))
    }
    expect(nonFinite).toBe(0)
    expect(maxAbs).toBeLessThan(200) // every value also fits a half when the kernels run in f16
    // Position 0 of the transform is the top-left tap itself.
    const ci = 3
    const co = 10
    expect(u[(0 * layer.cin + ci) * layer.cout + co]!).toBeCloseTo(f16ToF32(layer.weight[(0 * layer.cin + ci) * layer.cout + co]!), 6)
    // Position 15 (row 3, column 3) is the bottom-right tap.
    expect(u[(15 * layer.cin + ci) * layer.cout + co]!).toBeCloseTo(f16ToF32(layer.weight[(8 * layer.cin + ci) * layer.cout + co]!), 6)
  })
})
