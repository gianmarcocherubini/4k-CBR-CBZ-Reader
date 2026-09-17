import type { Direction, FitMode, PageSize } from '../../types'
import { isBlank, type Spread } from '../spread'

export interface Size {
  w: number
  h: number
}

export interface Point {
  x: number
  y: number
}

export interface PageBox {
  index: number
  x: number
  y: number
  w: number
  h: number
}

/** Layout of a spread at zoom 1, in CSS pixels. */
export interface SpreadLayout {
  w: number
  h: number
  pages: PageBox[]
  /** Centre margin between two pages (absent for single pages or gutter "none"). */
  gutter?: { x: number; w: number }
}

/** Typical manga page ratio, used for pages whose size is not known yet. */
export const FALLBACK_PAGE: PageSize = { w: 1400, h: 2000 }

export const MIN_ZOOM = 1
export const MAX_ZOOM = 8

/**
 * Places the pages of a spread side by side at a common height and fits the result in the
 * viewport according to `fit`. `original` maps one image pixel to one device pixel.
 * `gutterFraction` (of the common page height) leaves a centre margin between two pages.
 */
export function layoutSpread(
  spread: Spread,
  sizes: ReadonlyArray<PageSize | null | undefined>,
  viewport: Size,
  fit: FitMode,
  dpr: number,
  direction: Direction,
  gutterFraction = 0,
): SpreadLayout {
  if (spread.length === 0) return { w: 0, h: 0, pages: [] }
  // A blank slot mirrors the real page next to it so the spread looks like an open book.
  const partner = spread.find((i) => !isBlank(i))
  const natural = spread.map((i) => (isBlank(i) ? (partner !== undefined ? sizes[partner] : undefined) : sizes[i]) ?? FALLBACK_PAGE)
  const H = Math.max(...natural.map((s) => s.h))
  const widths = natural.map((s) => (s.w * H) / s.h)
  const gutterW = spread.length > 1 ? H * Math.max(0, gutterFraction) : 0
  const totalW = widths.reduce((a, b) => a + b, 0) + gutterW
  let scale: number
  switch (fit) {
    case 'screen':
      scale = Math.min(viewport.w / totalW, viewport.h / H)
      break
    case 'height':
      scale = viewport.h / H
      break
    case 'width':
      scale = viewport.w / totalW
      break
    case 'original':
      scale = 1 / Math.max(1, dpr)
      break
  }
  if (!Number.isFinite(scale) || scale <= 0) scale = 1
  const order = direction === 'rtl' ? [...spread].reverse() : [...spread]
  let x = 0
  let gutter: SpreadLayout['gutter']
  const pages: PageBox[] = order.map((index, k) => {
    const w = widths[spread.indexOf(index)]! * scale
    const box = { index, x, y: 0, w, h: H * scale }
    x += w
    if (k === 0 && gutterW > 0) {
      gutter = { x, w: gutterW * scale }
      x += gutterW * scale
    }
    return box
  })
  return gutter ? { w: totalW * scale, h: H * scale, pages, gutter } : { w: totalW * scale, h: H * scale, pages }
}

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
}

/**
 * Keeps the (zoomed) content inside the viewport: centred when smaller, edges pinned when larger.
 */
export function clampOffset(offset: Point, content: Size, viewport: Size): Point {
  const x = content.w <= viewport.w ? (viewport.w - content.w) / 2 : Math.min(0, Math.max(viewport.w - content.w, offset.x))
  const y = content.h <= viewport.h ? (viewport.h - content.h) / 2 : Math.min(0, Math.max(viewport.h - content.h, offset.y))
  return { x, y }
}

/** New offset that keeps the content point under `focal` fixed while zoom goes from `from` to `to`. */
export function zoomAround(offset: Point, focal: Point, from: number, to: number): Point {
  const k = to / from
  return { x: focal.x - k * (focal.x - offset.x), y: focal.y - k * (focal.y - offset.y) }
}
