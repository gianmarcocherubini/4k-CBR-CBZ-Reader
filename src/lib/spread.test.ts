import { describe, expect, it } from 'vitest'
import type { PageSize } from '../types'
import { blankItem, firstPage, layoutSpreads, realPages, spreadIndexOf, spreadLabel } from './spread'

const P: PageSize = { w: 800, h: 1200 }
const W: PageSize = { w: 1600, h: 1200 }

describe('layoutSpreads', () => {
  it('single mode: one page per spread', () => {
    expect(layoutSpreads(4, [P, W, P, P], { double: false, coverOffset: true })).toEqual([[0], [1], [2], [3]])
  })
  it('double with cover offset: cover alone, then pairs', () => {
    expect(layoutSpreads(6, [P, P, P, P, P, P], { double: true, coverOffset: true })).toEqual([
      [0],
      [1, 2],
      [3, 4],
      [5],
    ])
  })
  it('double without cover offset: pairs from the first page', () => {
    expect(layoutSpreads(5, [P, P, P, P, P], { double: true, coverOffset: false })).toEqual([[0, 1], [2, 3], [4]])
  })
  it('wide pages are alone and pairing resumes after them', () => {
    // pages 1..19 (1-based): 12 wide -> "12" alone, then "13-14"
    const sizes = Array.from({ length: 19 }, (_, i) => (i === 11 ? W : P))
    const spreads = layoutSpreads(19, sizes, { double: true, coverOffset: true })
    expect(spreads.map(spreadLabel)).toEqual(['1', '2-3', '4-5', '6-7', '8-9', '10-11', '12', '13-14', '15-16', '17-18', '19'])
  })
  it('a wide page before a portrait one breaks the pair', () => {
    expect(layoutSpreads(4, [P, P, W, P], { double: true, coverOffset: false })).toEqual([[0, 1], [2], [3]])
    expect(layoutSpreads(4, [P, W, P, P], { double: true, coverOffset: false })).toEqual([[0], [1], [2, 3]])
  })
  it('a wide cover is not offset', () => {
    expect(layoutSpreads(3, [W, P, P], { double: true, coverOffset: true })).toEqual([[0], [1, 2]])
  })
  it('unknown sizes count as portrait', () => {
    expect(layoutSpreads(3, [null, undefined, null], { double: true, coverOffset: false })).toEqual([[0, 1], [2]])
  })
  it('handles empty books', () => {
    expect(layoutSpreads(0, [], { double: true, coverOffset: true })).toEqual([])
  })
})

describe('user-inserted blank pages', () => {
  const sizes = Array.from({ length: 8 }, () => P)
  it('shifts the pairing from the blank onwards', () => {
    // Without blanks: 1 | 2-3 | 4-5 | 6-7 | 8. Blank before page 4 (index 3): 1 | 2-3 | ▢-4 | 5-6 | 7-8
    const spreads = layoutSpreads(8, sizes, { double: true, coverOffset: true, blanks: new Set([3]) })
    expect(spreads).toEqual([[0], [1, 2], [blankItem(3), 3], [4, 5], [6, 7]])
    expect(spreads.map(spreadLabel)).toEqual(['1', '2-3', '4', '5-6', '7-8'])
    expect(realPages(spreads[2]!)).toEqual([3])
    expect(firstPage(spreads[2]!)).toBe(3)
  })
  it('a blank at the very start replaces the cover offset', () => {
    const spreads = layoutSpreads(4, sizes, { double: true, coverOffset: false, blanks: new Set([0]) })
    expect(spreads).toEqual([[blankItem(0), 0], [1, 2], [3]])
    expect(spreadLabel(spreads[0]!)).toBe('1')
  })
  it('drops a blank that would sit alone next to a wide page or at the end', () => {
    expect(layoutSpreads(3, [P, P, W], { double: true, coverOffset: false, blanks: new Set([2]) })).toEqual([[0, 1], [2]])
    expect(layoutSpreads(3, [P, P, P], { double: true, coverOffset: false, blanks: new Set([2]) })).toEqual([[0, 1], [blankItem(2), 2]])
  })
  it('is ignored in single mode', () => {
    expect(layoutSpreads(3, sizes, { double: false, coverOffset: true, blanks: new Set([1]) })).toEqual([[0], [1], [2]])
  })
  it('spreadIndexOf finds pages next to blanks', () => {
    const spreads = layoutSpreads(8, sizes, { double: true, coverOffset: true, blanks: new Set([3]) })
    expect(spreadIndexOf(spreads, 3)).toBe(2)
    expect(spreadIndexOf(spreads, 4)).toBe(3)
  })
})

describe('spreadIndexOf', () => {
  const spreads = layoutSpreads(7, [P, P, P, P, P, P, P], { double: true, coverOffset: true })
  it('finds the spread containing a page', () => {
    expect(spreadIndexOf(spreads, 0)).toBe(0)
    expect(spreadIndexOf(spreads, 2)).toBe(1)
    expect(spreadIndexOf(spreads, 6)).toBe(3)
  })
  it('clamps out-of-range pages', () => {
    expect(spreadIndexOf(spreads, 99)).toBe(3)
    expect(spreadIndexOf([], 3)).toBe(0)
  })
})
