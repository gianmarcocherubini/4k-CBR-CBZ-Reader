import { describe, expect, it } from 'vitest'
import { naturalCompare, naturalSort } from './naturalSort'

describe('naturalCompare', () => {
  it('orders digit runs numerically', () => {
    const names = ['p10.jpg', 'p2.jpg', 'p1.jpg', 'p100.jpg', 'p20.jpg']
    expect(naturalSort(names, (s) => s)).toEqual(['p1.jpg', 'p2.jpg', 'p10.jpg', 'p20.jpg', 'p100.jpg'])
  })
  it('handles zero padding and mixed padding consistently', () => {
    expect(naturalSort(['009.png', '10.png', '08.png', '1.png'], (s) => s)).toEqual([
      '1.png',
      '08.png',
      '009.png',
      '10.png',
    ])
  })
  it('is case-insensitive and stable across folders', () => {
    const names = ['Ch2/001.jpg', 'ch1/002.jpg', 'ch1/001.jpg', 'Ch10/001.jpg']
    expect(naturalSort(names, (s) => s)).toEqual(['ch1/001.jpg', 'ch1/002.jpg', 'Ch2/001.jpg', 'Ch10/001.jpg'])
  })
  it('sorts digits before letters and shorter before longer', () => {
    expect(naturalCompare('1', 'a')).toBeLessThan(0)
    expect(naturalCompare('page', 'page1')).toBeLessThan(0)
    expect(naturalCompare('x', 'x')).toBe(0)
  })
  it('does not overflow on huge numbers', () => {
    expect(naturalCompare('99999999999999999999', '100000000000000000000')).toBeLessThan(0)
  })
})
