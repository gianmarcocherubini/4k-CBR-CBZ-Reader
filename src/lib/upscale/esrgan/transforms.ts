/**
 * The eight symmetries of a rectangle (dihedral group), used for the geometric self-ensemble: the
 * network is not exactly symmetric, so averaging its output over transformed copies of the input
 * cancels direction-dependent artifacts. A transform is a transposition followed by flips.
 */
export interface Dihedral {
  /** Swap x and y first (the image becomes h × w). */
  swap: boolean
  /** Mirror horizontally (after the swap). */
  flipX: boolean
  /** Mirror vertically (after the swap). */
  flipY: boolean
}

export type EnsembleSize = 1 | 2 | 4 | 8

export const IDENTITY: Dihedral = { swap: false, flipX: false, flipY: false }

const T = (swap: boolean, flipX: boolean, flipY: boolean): Dihedral => ({ swap, flipX, flipY })

/** All eight, identity first. */
export const DIHEDRAL: readonly Dihedral[] = [
  T(false, false, false),
  T(false, true, false),
  T(false, false, true),
  T(false, true, true),
  T(true, false, false),
  T(true, true, false),
  T(true, false, true),
  T(true, true, true),
]

/** The transforms of an ensemble of `n` passes: identity first, the 180° rotation second, then the flips, then the transpositions. */
export function ensembleTransforms(n: EnsembleSize): Dihedral[] {
  switch (n) {
    case 1:
      return [DIHEDRAL[0]!]
    case 2:
      return [DIHEDRAL[0]!, DIHEDRAL[3]!]
    case 4:
      return DIHEDRAL.slice(0, 4)
    case 8:
      return [...DIHEDRAL]
  }
}

export function transformedSize(w: number, h: number, t: Dihedral): { w: number; h: number } {
  return t.swap ? { w: h, h: w } : { w, h }
}

/** Where pixel (x, y) of a w × h image lands after `t`. */
export function mapPoint(x: number, y: number, w: number, h: number, t: Dihedral): { x: number; y: number } {
  const { w: tw, h: th } = transformedSize(w, h, t)
  const u0 = t.swap ? y : x
  const v0 = t.swap ? x : y
  return { x: t.flipX ? tw - 1 - u0 : u0, y: t.flipY ? th - 1 - v0 : v0 }
}

/**
 * Canvas matrix (a, b, c, d, e, f) for `ctx.setTransform` so that drawing a w × h image at the
 * origin puts source pixel (x, y) at `mapPoint(x, y)` of the (transformed-size) canvas.
 */
export function canvasMatrix(w: number, h: number, t: Dihedral): [number, number, number, number, number, number] {
  const { w: tw, h: th } = transformedSize(w, h, t)
  // dest_x = a·x + c·y + e ; dest_y = b·x + d·y + f
  let [a, b, c, d, e, f] = t.swap ? [0, 1, 1, 0, 0, 0] : [1, 0, 0, 1, 0, 0]
  if (t.flipX) [a, c, e] = [-a, -c, tw - e]
  if (t.flipY) [b, d, f] = [-b, -d, th - f]
  return [a, b, c, d, e, f]
}

/** RGBA copy of the image transformed by `t` (CPU, for tests and the reference implementation). */
export function transformRgba(rgba: Uint8ClampedArray, w: number, h: number, t: Dihedral): Uint8ClampedArray {
  const { w: tw } = transformedSize(w, h, t)
  const out = new Uint8ClampedArray(rgba.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = mapPoint(x, y, w, h, t)
      const s = (y * w + x) * 4
      const d = (p.y * tw + p.x) * 4
      out[d] = rgba[s]!
      out[d + 1] = rgba[s + 1]!
      out[d + 2] = rgba[s + 2]!
      out[d + 3] = rgba[s + 3]!
    }
  }
  return out
}

/** Undoes `transformRgba`: `transformed` has the transformed size of a w × h image. */
export function inverseTransformRgba(transformed: Uint8ClampedArray, w: number, h: number, t: Dihedral): Uint8ClampedArray {
  const { w: tw } = transformedSize(w, h, t)
  const out = new Uint8ClampedArray(transformed.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = mapPoint(x, y, w, h, t)
      const s = (p.y * tw + p.x) * 4
      const d = (y * w + x) * 4
      out[d] = transformed[s]!
      out[d + 1] = transformed[s + 1]!
      out[d + 2] = transformed[s + 2]!
      out[d + 3] = transformed[s + 3]!
    }
  }
  return out
}
