import type { PageSize } from '../types'

/**
 * A spread is what is shown on screen at once: one page, or two portrait pages.
 * Items are 0-based page indices in reading order (first = the page read first).
 * A negative item is a virtual blank page inserted by the user to fix the pairing:
 * `-1 - i` means "blank page right before page i".
 */
export type Spread = readonly number[]

export interface SpreadOptions {
  /** Show two pages at once (false = one page per spread). */
  double: boolean
  /** Cover alone, then pairs (2-3, 4-5, ...). false = pairs start at the first page (1-2, 3-4, ...). */
  coverOffset: boolean
  /** Pages preceded by a user-inserted blank page (see `blankItem`). */
  blanks?: ReadonlySet<number>
}

export function blankItem(beforePage: number): number {
  return -1 - beforePage
}

export function isBlank(item: number): boolean {
  return item < 0
}

/** Page that follows a blank item. */
export function blankBefore(item: number): number {
  return -1 - item
}

export function realPages(spread: Spread): number[] {
  return spread.filter((p) => p >= 0)
}

/** First real page of a spread (the reader's position anchor). */
export function firstPage(spread: Spread): number | undefined {
  return spread.find((p) => p >= 0)
}

/** Landscape pages (w > h) are spreads by themselves and are never paired. */
export function isWide(size: PageSize | null | undefined): boolean {
  return !!size && size.w > size.h
}

/**
 * Deterministic smart pairing.
 *
 * Unknown sizes (pages not decoded yet) are treated as portrait: when jumping into an
 * unread region the layout may pair a page that later turns out to be wide, and re-syncs
 * once the size is known and persisted. This keeps the layout stable and cheap to compute
 * (no decoding of the whole book up front).
 *
 * User-inserted blanks take a slot like a portrait page, so everything after them shifts by
 * one; a blank that would end up alone (next to a wide page or at the end) is dropped.
 */
export function layoutSpreads(
  pageCount: number,
  sizes: ReadonlyArray<PageSize | null | undefined>,
  opts: SpreadOptions,
): Spread[] {
  const spreads: Spread[] = []
  if (pageCount <= 0) return spreads
  if (!opts.double) {
    for (let i = 0; i < pageCount; i++) spreads.push([i])
    return spreads
  }
  const items: number[] = []
  for (let i = 0; i < pageCount; i++) {
    if (opts.blanks?.has(i)) items.push(blankItem(i))
    items.push(i)
  }
  const wide = (item: number | undefined) => item !== undefined && item >= 0 && isWide(sizes[item])
  let k = 0
  if (opts.coverOffset && items[0] === 0 && !wide(0)) {
    spreads.push([0])
    k = 1
  }
  while (k < items.length) {
    const a = items[k]!
    const b = items[k + 1]
    if (wide(a)) {
      spreads.push([a])
      k += 1
      continue
    }
    if (isBlank(a) && (b === undefined || wide(b))) {
      k += 1 // a blank cannot stand alone
      continue
    }
    if (b !== undefined && !wide(b)) {
      spreads.push([a, b])
      k += 2
    } else {
      spreads.push([a])
      k += 1
    }
  }
  return spreads
}

/** Index of the spread that contains `page`, or the last spread if out of range. */
export function spreadIndexOf(spreads: Spread[], page: number): number {
  for (let s = 0; s < spreads.length; s++) {
    const sp = spreads[s]!
    if (sp.includes(page)) return s
    const first = firstPage(sp)
    if (first !== undefined && first > page) return Math.max(0, s - 1)
  }
  return Math.max(0, spreads.length - 1)
}

/** Human label for a spread: "12" or "12-13" (1-based, blanks ignored). */
export function spreadLabel(spread: Spread): string {
  const pages = realPages(spread)
  if (pages.length === 0) return '–'
  if (pages.length === 1) return String(pages[0]! + 1)
  return `${pages[0]! + 1}-${pages[pages.length - 1]! + 1}`
}
