import type { PageSize } from '../../types'
import { FALLBACK_PAGE, type Size } from './layout'

/**
 * Vertical strip: every page fitted to one common width, one under the other, in reading order.
 * Positions are CSS pixels from the top of the strip. Pages whose size is not known yet get the
 * typical ratio of the pages that are (or a manga page's), so the strip has a plausible length
 * before anything is decoded and shifts as little as possible afterwards.
 */

export interface StripBox {
  index: number
  top: number
  height: number
}

export interface StripLayout {
  /** Width of every page and horizontal offset of the strip inside the viewport. */
  pageWidth: number
  left: number
  gap: number
  boxes: StripBox[]
  /** Total height of the strip. */
  height: number
}

/** Height/width ratio to assume for pages not decoded yet: the median of the known ones. */
export function fallbackRatio(sizes: ReadonlyArray<PageSize | null | undefined>): number {
  const ratios = sizes.filter((s): s is PageSize => !!s && s.w > 0 && s.h > 0).map((s) => s.h / s.w)
  if (ratios.length === 0) return FALLBACK_PAGE.h / FALLBACK_PAGE.w
  ratios.sort((a, b) => a - b)
  return ratios[ratios.length >> 1]!
}

/** Pinch/double-tap zoom of the strip, as a multiplier of the chosen width. */
export const MIN_STRIP_ZOOM = 1
export const MAX_STRIP_ZOOM = 4

export function layoutStrip(pageCount: number, sizes: ReadonlyArray<PageSize | null | undefined>, viewport: Size, widthFraction: number, gap: number): StripLayout {
  const pageWidth = Math.max(1, Math.floor(viewport.w * Math.min(MAX_STRIP_ZOOM, Math.max(0.2, widthFraction))))
  // Wider than the viewport (zoomed in): flush left, and the strip scrolls sideways.
  const left = Math.max(0, Math.floor((viewport.w - pageWidth) / 2))
  const ratio = fallbackRatio(sizes)
  const boxes: StripBox[] = []
  let top = 0
  for (let index = 0; index < pageCount; index++) {
    const size = sizes[index]
    const height = Math.max(1, Math.round(pageWidth * (size && size.w > 0 ? size.h / size.w : ratio)))
    boxes.push({ index, top, height })
    top += height + (index < pageCount - 1 ? gap : 0)
  }
  return { pageWidth, left, gap, boxes, height: top }
}

/** Index of the page whose box contains vertical position `y` (clamped to the strip). */
export function pageAt(layout: StripLayout, y: number): number {
  const { boxes } = layout
  if (boxes.length === 0) return 0
  if (y <= 0) return 0
  if (y >= layout.height) return boxes.length - 1
  let lo = 0
  let hi = boxes.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const box = boxes[mid]!
    if (y < box.top) hi = mid - 1
    else if (y >= box.top + box.height + layout.gap) lo = mid + 1
    else return mid
  }
  return Math.min(boxes.length - 1, Math.max(0, lo))
}

/**
 * The page being read: the one under the upper third of the viewport, except at the very end of
 * the strip, where the last page counts even when it is shorter than the viewport.
 */
export function currentPageAt(layout: StripLayout, scrollTop: number, viewportHeight: number): number {
  if (layout.boxes.length === 0) return 0
  if (scrollTop + viewportHeight >= layout.height - 2) return layout.boxes.length - 1
  return pageAt(layout, scrollTop + viewportHeight * 0.35)
}

/** Pages intersecting [scrollTop - margin, scrollTop + viewportHeight + margin], in order. */
export function pagesInRange(layout: StripLayout, scrollTop: number, viewportHeight: number, margin = 0): number[] {
  if (layout.boxes.length === 0) return []
  const first = pageAt(layout, scrollTop - margin)
  const last = pageAt(layout, scrollTop + viewportHeight + margin)
  const out: number[] = []
  for (let i = first; i <= last; i++) {
    const box = layout.boxes[i]!
    if (box.top < scrollTop + viewportHeight + margin && box.top + box.height > scrollTop - margin) out.push(i)
  }
  return out
}

/** How a scroll position relates to a page: index and position inside it (0 = top, 1 = bottom). */
export interface StripAnchor {
  index: number
  fraction: number
}

export function anchorAt(layout: StripLayout, scrollTop: number): StripAnchor {
  const index = pageAt(layout, scrollTop)
  const box = layout.boxes[index]
  if (!box) return { index: 0, fraction: 0 }
  return { index, fraction: Math.min(1, Math.max(0, (scrollTop - box.top) / Math.max(1, box.height))) }
}

/** The scroll position that puts `anchor` back where it was, in a (re)computed layout. */
export function scrollTopFor(layout: StripLayout, anchor: StripAnchor): number {
  const box = layout.boxes[Math.min(layout.boxes.length - 1, Math.max(0, anchor.index))]
  if (!box) return 0
  return box.top + anchor.fraction * box.height
}
