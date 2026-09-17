import { describe, expect, it } from 'vitest'
import { clampOffset, layoutSpread, zoomAround } from './layout'

const P = { w: 800, h: 1200 }
const W = { w: 1600, h: 1200 }
const vp = { w: 1180, h: 820 }

describe('layoutSpread', () => {
  it('fits a double spread to the screen and orders pages RTL', () => {
    const l = layoutSpread([2, 3], [null, null, P, P], vp, 'screen', 2, 'rtl')
    // Two 2:3 pages -> 4:3 spread; the viewport is wider than 4:3 so height limits.
    expect(l.h).toBeCloseTo(820)
    expect(l.w).toBeCloseTo(820 * (1600 / 1200))
    expect(l.pages.map((p) => p.index)).toEqual([3, 2]) // page 2 (read first) on the right
    expect(l.pages[0]!.x).toBe(0)
    expect(l.pages[1]!.x).toBeCloseTo(l.pages[0]!.w)
  })
  it('orders LTR and fits width', () => {
    const l = layoutSpread([0, 1], [P, P], vp, 'width', 1, 'ltr')
    expect(l.pages.map((p) => p.index)).toEqual([0, 1])
    expect(l.w).toBeCloseTo(1180)
    expect(l.h).toBeGreaterThan(vp.h) // overflows vertically, panning needed
  })
  it('fits height and maps original to device pixels', () => {
    const wide = layoutSpread([5], [null, null, null, null, null, W], vp, 'height', 2, 'rtl')
    expect(wide.h).toBeCloseTo(820)
    expect(wide.w).toBeCloseTo((820 * 1600) / 1200)
    const orig = layoutSpread([5], [null, null, null, null, null, W], vp, 'original', 2, 'rtl')
    expect(orig.w).toBe(800)
    expect(orig.h).toBe(600)
  })
  it('scales pages of different heights to a common height', () => {
    const l = layoutSpread([0, 1], [{ w: 800, h: 1200 }, { w: 1000, h: 1600 }], vp, 'screen', 1, 'ltr')
    expect(l.pages[0]!.h).toBeCloseTo(l.pages[1]!.h)
    expect(l.pages[0]!.w / l.pages[0]!.h).toBeCloseTo(800 / 1200)
    expect(l.pages[1]!.w / l.pages[1]!.h).toBeCloseTo(1000 / 1600)
  })
  it('gives a blank slot the size of its partner page', () => {
    const l = layoutSpread([-1 - 3, 3], [null, null, null, { w: 1000, h: 1500 }], vp, 'screen', 1, 'rtl')
    expect(l.pages.map((p) => p.index)).toEqual([3, -4]) // RTL: the blank (read first) sits on the right
    expect(l.pages[0]!.w).toBeCloseTo(l.pages[1]!.w)
    expect(l.w / l.h).toBeCloseTo(2000 / 1500)
  })
  it('leaves a centre margin between two pages, never around a single page', () => {
    const l = layoutSpread([2, 3], [null, null, P, P], vp, 'screen', 1, 'rtl', 0.03)
    // Total width = two pages + gutter, all scaled to fit the height.
    expect(l.h).toBeCloseTo(820)
    expect(l.gutter).toBeDefined()
    expect(l.gutter!.w).toBeCloseTo(820 * 0.03)
    const [right, left] = [l.pages[1]!, l.pages[0]!] // RTL: page 3 first (left), page 2 second (right)
    expect(left.index).toBe(3)
    expect(right.index).toBe(2)
    expect(right.x).toBeCloseTo(left.x + left.w + l.gutter!.w)
    expect(l.gutter!.x).toBeCloseTo(left.x + left.w)
    expect(l.w).toBeCloseTo(right.x + right.w)
    const single = layoutSpread([5], [null, null, null, null, null, P], vp, 'screen', 1, 'rtl', 0.03)
    expect(single.gutter).toBeUndefined()
    const none = layoutSpread([2, 3], [null, null, P, P], vp, 'screen', 1, 'ltr', 0)
    expect(none.gutter).toBeUndefined()
    expect(none.pages[1]!.x).toBeCloseTo(none.pages[0]!.w)
  })
  it('the margin counts towards width fitting', () => {
    const withGutter = layoutSpread([0, 1], [P, P], vp, 'width', 1, 'ltr', 0.06)
    expect(withGutter.w).toBeCloseTo(1180)
    const without = layoutSpread([0, 1], [P, P], vp, 'width', 1, 'ltr', 0)
    expect(withGutter.pages[0]!.w).toBeLessThan(without.pages[0]!.w)
  })
  it('returns an empty layout for an empty spread', () => {
    expect(layoutSpread([], [], vp, 'screen', 1, 'rtl')).toEqual({ w: 0, h: 0, pages: [] })
  })
  it('uses a fallback size for unknown pages', () => {
    const l = layoutSpread([0], [], vp, 'screen', 1, 'rtl')
    expect(l.w / l.h).toBeCloseTo(1400 / 2000)
  })
})

describe('clampOffset / zoomAround', () => {
  it('centres content smaller than the viewport', () => {
    expect(clampOffset({ x: -50, y: 30 }, { w: 400, h: 400 }, vp)).toEqual({ x: 390, y: 210 })
  })
  it('pins edges for content larger than the viewport', () => {
    expect(clampOffset({ x: 10, y: -5000 }, { w: 2000, h: 2000 }, vp)).toEqual({ x: 0, y: 820 - 2000 })
    expect(clampOffset({ x: -3000, y: -100 }, { w: 2000, h: 2000 }, vp)).toEqual({ x: 1180 - 2000, y: -100 })
  })
  it('keeps the focal point fixed when zooming', () => {
    const offset = { x: -100, y: -50 }
    const focal = { x: 300, y: 200 }
    const next = zoomAround(offset, focal, 1, 2)
    // Content point under focal before: (300+100, 200+50) = (400, 250) in content px at zoom 1
    // After zoom 2 it sits at 2*(400,250) = (800,500) from the content origin; focal - next must equal that.
    expect(focal.x - next.x).toBeCloseTo(800)
    expect(focal.y - next.y).toBeCloseTo(500)
  })
})
