import { describe, expect, it } from 'vitest'
import { HEAVY_MAX_OUTPUT_PIXELS, heavyFactor } from './protocol'

describe('heavyFactor', () => {
  it('uses x4 when it fits, x2 when only x2 fits, and refuses an oversized output', () => {
    expect(heavyFactor(800, 1200, 4)).toBe(4)
    expect(heavyFactor(1000, 1500, 4)).toBe(2)
    expect(heavyFactor(8000, 4000, 4)).toBeNull()
  })

  it('never returns a factor whose output exceeds the shared pixel cap', () => {
    for (const [w, h] of [
      [800, 1200],
      [1000, 1500],
      [4000, 6000],
      [16_000, 2000],
    ]) {
      const factor = heavyFactor(w, h, 4)
      if (factor) expect(w * h * factor * factor).toBeLessThanOrEqual(HEAVY_MAX_OUTPUT_PIXELS)
    }
  })
})
