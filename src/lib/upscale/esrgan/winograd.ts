import { f16ToF32, type Layer } from './weights'

/**
 * Winograd F(2x2, 3x3): a 3x3 correlation over a 4x4 input tile yields a 2x2 output tile with 16
 * multiplications per (input channel, output channel) pair instead of 36. With
 *
 *   Bᵀ = [[1, 0, -1, 0], [0, 1, 1, 0], [0, -1, 1, 0], [0, 1, 0, -1]]
 *   G  = [[1, 0, 0], [1/2, 1/2, 1/2], [1/2, -1/2, 1/2], [0, 0, 1]]
 *   Aᵀ = [[1, 1, 1, 0], [0, 1, -1, -1]]
 *
 * the output is Y = Aᵀ [ (G g Gᵀ) ⊙ (Bᵀ d B) ] A. The weights are transformed once here (CPU);
 * the input and output transforms run in the shaders. Position p = 4·row + column of the 4x4.
 */

const scratch32 = new Float32Array(1)
const scratchU32 = new Uint32Array(scratch32.buffer)

/** IEEE 754 binary32 → binary16 bits, round to nearest even (overflow saturates to the largest finite half). */
export function f32ToF16(value: number): number {
  scratch32[0] = value
  const x = scratchU32[0]!
  const sign = (x >>> 16) & 0x8000
  const exp = (x >>> 23) & 0xff
  const mant = x & 0x7fffff
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0)
  const e = exp - 127 + 15
  if (e >= 0x1f) return sign | 0x7bff
  // Round the 13 low mantissa bits to nearest even; a carry out of the mantissa bumps the exponent.
  const roundNearestEven = (m: number, shift: number) => {
    const kept = m >>> shift
    const mask = (1 << shift) - 1
    const half = 1 << (shift - 1)
    const discarded = m & mask
    return kept + (discarded > half || (discarded === half && (kept & 1) === 1) ? 1 : 0)
  }
  if (e <= 0) {
    if (e < -10) return sign
    // Subnormal half: the implicit bit joins the mantissa, shifted down by the exponent deficit.
    return sign | roundNearestEven(mant | 0x800000, 13 + (1 - e))
  }
  return sign | ((e << 10) + roundNearestEven(mant, 13))
}

/** U = G g Gᵀ for one 3x3 kernel g (row-major, g[ky*3 + kx]); returns 16 values, p = 4·r + c. */
export function transformKernel(g: ArrayLike<number>): Float32Array {
  const u = new Float32Array(16)
  // Gg: 4 rows x 3 columns
  const gg = new Float32Array(12)
  for (let kx = 0; kx < 3; kx++) {
    const g0 = g[kx]!
    const g1 = g[3 + kx]!
    const g2 = g[6 + kx]!
    gg[kx] = g0
    gg[3 + kx] = 0.5 * (g0 + g1 + g2)
    gg[6 + kx] = 0.5 * (g0 - g1 + g2)
    gg[9 + kx] = g2
  }
  for (let r = 0; r < 4; r++) {
    const a = gg[r * 3]!
    const b = gg[r * 3 + 1]!
    const c = gg[r * 3 + 2]!
    u[r * 4] = a
    u[r * 4 + 1] = 0.5 * (a + b + c)
    u[r * 4 + 2] = 0.5 * (a - b + c)
    u[r * 4 + 3] = c
  }
  return u
}

/** V = Bᵀ d B for one 4x4 input tile d (row-major); returns 16 values, p = 4·r + c. */
export function transformInput(d: ArrayLike<number>): Float32Array {
  const t = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    const d0 = d[c]!
    const d1 = d[4 + c]!
    const d2 = d[8 + c]!
    const d3 = d[12 + c]!
    t[c] = d0 - d2
    t[4 + c] = d1 + d2
    t[8 + c] = d2 - d1
    t[12 + c] = d1 - d3
  }
  const v = new Float32Array(16)
  for (let r = 0; r < 4; r++) {
    const t0 = t[r * 4]!
    const t1 = t[r * 4 + 1]!
    const t2 = t[r * 4 + 2]!
    const t3 = t[r * 4 + 3]!
    v[r * 4] = t0 - t2
    v[r * 4 + 1] = t1 + t2
    v[r * 4 + 2] = t2 - t1
    v[r * 4 + 3] = t1 - t3
  }
  return v
}

/** Y = Aᵀ M A for the 16 element-wise products m (p = 4·r + c); returns the 2x2 output [y00, y01, y10, y11]. */
export function transformOutput(m: ArrayLike<number>): Float32Array {
  const y = new Float32Array(4)
  const a0 = [1, 1, 1, 0]
  const a1 = [0, 1, -1, -1]
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const v = m[r * 4 + c]!
      y[0] = y[0]! + a0[r]! * a0[c]! * v
      y[1] = y[1]! + a0[r]! * a1[c]! * v
      y[2] = y[2]! + a1[r]! * a0[c]! * v
      y[3] = y[3]! + a1[r]! * a1[c]! * v
    }
  }
  return y
}

/**
 * Winograd weights of a layer in f32, laid out [p][cin][cout] so a shader reads, for one position
 * and one input channel, the output channels contiguously (like the direct weights). The layer's
 * weights are [tap][cin][cout] with tap = ky·3 + kx. The caller rounds to f16 where the kernels
 * run in half precision.
 */
export function winogradWeights(layer: Layer): Float32Array {
  const { cin, cout } = layer
  const w = layer.weight
  const out = new Float32Array(16 * cin * cout)
  const g = new Float32Array(9)
  for (let ci = 0; ci < cin; ci++) {
    for (let co = 0; co < cout; co++) {
      for (let tap = 0; tap < 9; tap++) g[tap] = f16ToF32(w[(tap * cin + ci) * cout + co]!)
      const u = transformKernel(g)
      for (let p = 0; p < 16; p++) out[(p * cin + ci) * cout + co] = u[p]!
    }
  }
  return out
}
