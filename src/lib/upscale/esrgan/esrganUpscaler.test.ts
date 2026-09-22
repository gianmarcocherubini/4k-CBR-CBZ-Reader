import { describe, expect, it } from 'vitest'
import { MAX_OUTPUT_PIXELS } from '../backend'
import { esrganFactor, paddedWidth, planBands, workPixels } from './esrganUpscaler'
import { CONTEXT } from './weights'

const F16_BYTES_PER_PIXEL = 16 * 8
const MAX_ACT = 48 * 1024 * 1024

describe('esrganFactor', () => {
  it('uses x4 when it fits the canvas cap, x2 when only x2 fits, x1 for larger pages, and refuses only huge ones', () => {
    expect(esrganFactor({ w: 800, h: 1200 })).toBe(4)
    expect(esrganFactor({ w: 1000, h: 1500 })).toBe(2)
    // High-resolution digital releases (2000x3000 and the like) are larger than any screen: the
    // network still restores them, at their own size.
    expect(esrganFactor({ w: 2000, h: 3000 })).toBe(1)
    expect(esrganFactor({ w: 1700, h: 2500 })).toBe(1)
    expect(esrganFactor({ w: 3000, h: 4200 })).toBe(1)
    expect(esrganFactor({ w: 8000, h: 4000 })).toBeNull()
    for (const [w, h] of [
      [800, 1200],
      [1024, 1024],
      [1000, 1500],
      [2000, 2000],
      [2000, 3000],
      [3000, 5000],
    ]) {
      const f = esrganFactor({ w, h })
      if (f) expect(w * h * f * f).toBeLessThanOrEqual(MAX_OUTPUT_PIXELS)
    }
  })

  it('at x1 the padded copy of the page the run starts from must fit the cap too', () => {
    // 4000x4190 is under 16.8 MP, but padded by CONTEXT on every side it is not.
    expect(4000 * 4190).toBeLessThanOrEqual(MAX_OUTPUT_PIXELS)
    expect(paddedWidth(4000) * (4190 + 2 * CONTEXT)).toBeGreaterThan(MAX_OUTPUT_PIXELS)
    expect(esrganFactor({ w: 4000, h: 4190 })).toBeNull()
    expect(esrganFactor({ w: 4000, h: 4000 })).toBe(1)
  })
})

describe('planBands', () => {
  it('cuts a typical page into bands that cover every row exactly once', () => {
    const size = { w: 800, h: 1200 }
    const plan = planBands(size, F16_BYTES_PER_PIXEL, MAX_ACT)!
    expect(plan.bw).toBe(800 + 2 * CONTEXT)
    // Odd widths are padded to a multiple of 4 (sub-range alignment of the activation buffers).
    expect(planBands({ w: 801, h: 1200 }, F16_BYTES_PER_PIXEL, MAX_ACT)!.bw).toBe(852)
    expect(plan.coreRows).toBeGreaterThan(0)
    expect(plan.bands).toBe(Math.ceil(1200 / plan.coreRows))
    expect((plan.bands - 1) * plan.coreRows).toBeLessThan(1200)
    // Each band's activations stay within the buffer cap.
    expect(plan.bw * (plan.coreRows + 2 * CONTEXT) * F16_BYTES_PER_PIXEL).toBeLessThanOrEqual(48 * 1024 * 1024)
  })

  it('shrinks the bands for wide pages and gives up when even a few rows do not fit', () => {
    const wide = planBands({ w: 2400, h: 1600 }, F16_BYTES_PER_PIXEL, MAX_ACT)!
    const normal = planBands({ w: 800, h: 1200 }, F16_BYTES_PER_PIXEL, MAX_ACT)!
    expect(wide.coreRows).toBeLessThan(normal.coreRows)
    expect(planBands({ w: 2400, h: 1600 }, F16_BYTES_PER_PIXEL, 1024 * 1024)).toBeNull()
  })

  it('a small image is a single band and f32 activations halve the rows', () => {
    const tiny = planBands({ w: 40, h: 56 }, F16_BYTES_PER_PIXEL, MAX_ACT)!
    expect(tiny.bands).toBe(1)
    expect(tiny.coreRows).toBe(56)
    const f16 = planBands({ w: 3000, h: 1200 }, F16_BYTES_PER_PIXEL, MAX_ACT)!
    const f32 = planBands({ w: 3000, h: 1200 }, F16_BYTES_PER_PIXEL * 2, MAX_ACT)!
    expect(f32.coreRows).toBeLessThan(f16.coreRows)
  })
})

describe('workPixels', () => {
  it('counts the context of every band, so the cost estimate scales with what the GPU really does', () => {
    const size = { w: 800, h: 1200 }
    const plan = planBands(size, F16_BYTES_PER_PIXEL, MAX_ACT)!
    const px = workPixels(size, F16_BYTES_PER_PIXEL, MAX_ACT)
    expect(px).toBeGreaterThan(size.w * size.h)
    expect(px).toBe(plan.bw * (size.h + plan.bands * 2 * CONTEXT))
  })
})

describe('RRDB band planning', () => {
  it('fits a typical page in bands of about 150 rows under the 128 MB trunk budget', () => {
    const rrdbBytesPerPixel = (16 * 4 + 32 + 8 + 16) * 8
    const plan = planBands({ w: 800, h: 1200 }, rrdbBytesPerPixel, 128 * 1024 * 1024)!
    expect(plan.coreRows).toBeGreaterThanOrEqual(100)
    expect(plan.coreRows).toBeLessThanOrEqual(160)
    expect(plan.bw * (plan.coreRows + 2 * CONTEXT) * rrdbBytesPerPixel).toBeLessThanOrEqual(128 * 1024 * 1024)
  })
})
