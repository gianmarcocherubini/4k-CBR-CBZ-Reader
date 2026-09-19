import { describe, expect, it } from 'vitest'
import { canvasMatrix, DIHEDRAL, ensembleTransforms, inverseTransformRgba, mapPoint, transformedSize, transformRgba } from './transforms'

const W = 5
const H = 3

describe('dihedral transforms', () => {
  it('lists eight distinct symmetries and picks identity-first subsets for each ensemble size', () => {
    expect(DIHEDRAL).toHaveLength(8)
    expect(new Set(DIHEDRAL.map((t) => `${t.swap}${t.flipX}${t.flipY}`)).size).toBe(8)
    expect(ensembleTransforms(1)).toEqual([DIHEDRAL[0]])
    expect(ensembleTransforms(2)).toEqual([DIHEDRAL[0], { swap: false, flipX: true, flipY: true }])
    expect(ensembleTransforms(4)).toHaveLength(4)
    expect(ensembleTransforms(4).every((t) => !t.swap)).toBe(true)
    expect(ensembleTransforms(8)).toHaveLength(8)
  })

  it('maps every pixel onto a distinct pixel of the transformed size (a permutation)', () => {
    for (const t of DIHEDRAL) {
      const { w, h } = transformedSize(W, H, t)
      expect(w * h).toBe(W * H)
      const seen = new Set<string>()
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const p = mapPoint(x, y, W, H, t)
          expect(p.x).toBeGreaterThanOrEqual(0)
          expect(p.x).toBeLessThan(w)
          expect(p.y).toBeGreaterThanOrEqual(0)
          expect(p.y).toBeLessThan(h)
          seen.add(`${p.x},${p.y}`)
        }
      }
      expect(seen.size).toBe(W * H)
    }
  })

  it('canvas matrices move pixel centres exactly where mapPoint says', () => {
    for (const t of DIHEDRAL) {
      const [a, b, c, d, e, f] = canvasMatrix(W, H, t)
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const sx = x + 0.5
          const sy = y + 0.5
          const dx = a * sx + c * sy + e
          const dy = b * sx + d * sy + f
          const p = mapPoint(x, y, W, H, t)
          expect(dx).toBeCloseTo(p.x + 0.5, 9)
          expect(dy).toBeCloseTo(p.y + 0.5, 9)
        }
      }
    }
  })

  it('transformRgba and inverseTransformRgba are inverses, and the identity is a copy', () => {
    const rgba = new Uint8ClampedArray(W * H * 4)
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 53) % 256
    expect(transformRgba(rgba, W, H, DIHEDRAL[0]!)).toEqual(rgba)
    for (const t of DIHEDRAL) {
      const forward = transformRgba(rgba, W, H, t)
      expect(inverseTransformRgba(forward, W, H, t)).toEqual(rgba)
    }
    // The 180° rotation (flip both) sends the first pixel to the last.
    const rot = transformRgba(rgba, W, H, { swap: false, flipX: true, flipY: true })
    expect(Array.from(rot.subarray((W * H - 1) * 4, W * H * 4))).toEqual(Array.from(rgba.subarray(0, 4)))
    // A transposition sends (x, y) to (y, x).
    const tr = transformRgba(rgba, W, H, { swap: true, flipX: false, flipY: false })
    expect(Array.from(tr.subarray((2 * H + 1) * 4, (2 * H + 1) * 4 + 4))).toEqual(Array.from(rgba.subarray((1 * W + 2) * 4, (1 * W + 2) * 4 + 4)))
  })
})
