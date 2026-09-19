import { describe, expect, it } from 'vitest'
import { MAX_OUTPUT_PIXELS } from '../backend'
import { esrganFactor, planBands, workPixels } from './esrganUpscaler'
import { CONTEXT } from './weights'

const F16_BYTES_PER_PIXEL = 16 * 8

describe('esrganFactor', () => {
  it('uses x4 when it fits the canvas cap, x2 when only x2 fits, and refuses oversized pages', () => {
    expect(esrganFactor({ w: 800, h: 1200 })).toBe(4)
    expect(esrganFactor({ w: 1000, h: 1500 })).toBe(2)
    expect(esrganFactor({ w: 8000, h: 4000 })).toBeNull()
    for (const [w, h] of [
      [800, 1200],
      [1024, 1024],
      [1000, 1500],
      [2000, 2000],
    ]) {
      const f = esrganFactor({ w, h })
      if (f) expect(w * h * f * f).toBeLessThanOrEqual(MAX_OUTPUT_PIXELS)
    }
  })
})

describe('planBands', () => {
  it('cuts a typical page into bands that cover every row exactly once', () => {
    const size = { w: 800, h: 1200 }
    const plan = planBands(size, F16_BYTES_PER_PIXEL)!
    expect(plan.bw).toBe(800 + 2 * CONTEXT)
    expect(plan.coreRows).toBeGreaterThan(0)
    expect(plan.bands).toBe(Math.ceil(1200 / plan.coreRows))
    expect((plan.bands - 1) * plan.coreRows).toBeLessThan(1200)
    // Each band's activations stay within the buffer cap.
    expect(plan.bw * (plan.coreRows + 2 * CONTEXT) * F16_BYTES_PER_PIXEL).toBeLessThanOrEqual(48 * 1024 * 1024)
  })

  it('shrinks the bands for wide pages and gives up when even a few rows do not fit', () => {
    const wide = planBands({ w: 2400, h: 1600 }, F16_BYTES_PER_PIXEL)!
    const normal = planBands({ w: 800, h: 1200 }, F16_BYTES_PER_PIXEL)!
    expect(wide.coreRows).toBeLessThan(normal.coreRows)
    expect(planBands({ w: 2400, h: 1600 }, F16_BYTES_PER_PIXEL, 1024 * 1024)).toBeNull()
  })

  it('a small image is a single band and f32 activations halve the rows', () => {
    const tiny = planBands({ w: 40, h: 56 }, F16_BYTES_PER_PIXEL)!
    expect(tiny.bands).toBe(1)
    expect(tiny.coreRows).toBe(56)
    const f16 = planBands({ w: 3000, h: 1200 }, F16_BYTES_PER_PIXEL)!
    const f32 = planBands({ w: 3000, h: 1200 }, F16_BYTES_PER_PIXEL * 2)!
    expect(f32.coreRows).toBeLessThan(f16.coreRows)
  })
})

describe('workPixels', () => {
  it('counts the context of every band, so the cost estimate scales with what the GPU really does', () => {
    const size = { w: 800, h: 1200 }
    const plan = planBands(size, F16_BYTES_PER_PIXEL)!
    const px = workPixels(size, F16_BYTES_PER_PIXEL)
    expect(px).toBeGreaterThan(size.w * size.h)
    expect(px).toBe(plan.bw * (size.h + plan.bands * 2 * CONTEXT))
  })
})
