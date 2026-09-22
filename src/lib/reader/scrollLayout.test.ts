import { describe, expect, it } from 'vitest'
import type { PageSize } from '../../types'
import { anchorAt, currentPageAt, fallbackRatio, layoutStrip, pageAt, pagesInRange, scrollTopFor } from './scrollLayout'

const viewport = { w: 1000, h: 800 }
const portrait: PageSize = { w: 800, h: 1200 }
const wide: PageSize = { w: 1600, h: 1200 }

describe('layoutStrip', () => {
  it('fits every page to the common width and stacks them with the gap', () => {
    const layout = layoutStrip(3, [portrait, wide, portrait], viewport, 1, 8)
    expect(layout.pageWidth).toBe(1000)
    expect(layout.left).toBe(0)
    expect(layout.boxes).toEqual([
      { index: 0, top: 0, height: 1500 },
      { index: 1, top: 1508, height: 750 },
      { index: 2, top: 2266, height: 1500 },
    ])
    expect(layout.height).toBe(3766)
  })

  it('narrows and centres the strip', () => {
    const layout = layoutStrip(1, [portrait], viewport, 0.56, 0)
    expect(layout.pageWidth).toBe(560)
    expect(layout.left).toBe(220)
    expect(layout.boxes[0]!.height).toBe(840)
  })

  it('zoomed beyond the viewport, the strip is flush left and wider than the viewport', () => {
    const layout = layoutStrip(1, [portrait], viewport, 2.5, 0)
    expect(layout.pageWidth).toBe(2500)
    expect(layout.left).toBe(0)
    expect(layout.boxes[0]!.height).toBe(3750)
  })

  it('gives unknown pages the median ratio of the known ones, or a manga page’s', () => {
    expect(fallbackRatio([])).toBeCloseTo(2000 / 1400, 5)
    expect(fallbackRatio([portrait, wide, portrait])).toBe(1.5)
    const layout = layoutStrip(2, [null, portrait], viewport, 1, 0)
    expect(layout.boxes[0]!.height).toBe(1500)
  })
})

describe('positions', () => {
  const layout = layoutStrip(5, [portrait, portrait, wide, portrait, portrait], viewport, 1, 10)
  // tops: 0, 1510, 3020, 3780, 5290; height 6790

  it('finds the page under a position, gaps included, and clamps at both ends', () => {
    expect(pageAt(layout, -50)).toBe(0)
    expect(pageAt(layout, 0)).toBe(0)
    expect(pageAt(layout, 1499)).toBe(0)
    expect(pageAt(layout, 1505)).toBe(0) // inside the gap after page 1
    expect(pageAt(layout, 1510)).toBe(1)
    expect(pageAt(layout, 3025)).toBe(2)
    expect(pageAt(layout, 3779)).toBe(2)
    expect(pageAt(layout, 3780)).toBe(3)
    expect(pageAt(layout, 99_999)).toBe(4)
  })

  it('reads the current page under the upper third, and the last page at the end of the strip', () => {
    expect(currentPageAt(layout, 0, 800)).toBe(0)
    expect(currentPageAt(layout, 1300, 800)).toBe(1) // 1300 + 280 = 1580 → page 2 (index 1)
    expect(currentPageAt(layout, 5990, 800)).toBe(4) // bottom reached
  })

  it('lists the pages in a range with a margin', () => {
    expect(pagesInRange(layout, 0, 800)).toEqual([0])
    expect(pagesInRange(layout, 1400, 800)).toEqual([0, 1])
    expect(pagesInRange(layout, 1400, 800, 2000)).toEqual([0, 1, 2, 3])
    expect(pagesInRange(layout, 6500, 800)).toEqual([4])
  })

  it('keeps a position anchored across a relayout', () => {
    const anchor = anchorAt(layout, 1510 + 750) // half-way down page 2
    expect(anchor).toEqual({ index: 1, fraction: 0.5 })
    const narrower = layoutStrip(5, [portrait, portrait, wide, portrait, portrait], viewport, 0.5, 10)
    expect(scrollTopFor(narrower, anchor)).toBe(narrower.boxes[1]!.top + narrower.boxes[1]!.height / 2)
    expect(scrollTopFor(narrower, { index: 99, fraction: 0 })).toBe(narrower.boxes[4]!.top)
  })
})
