import { type MutableRefObject, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Size } from '../../lib/reader/layout'
import { anchorAt, currentPageAt, pagesInRange, scrollTopFor, type StripLayout } from '../../lib/reader/scrollLayout'
import type { SrResult } from '../../lib/upscale/srEngine'
import type { StageBackground } from '../../types'
import { PageContent, type PageState } from './PageContent'
import { STAGE_BG } from './SpreadView'

export type ScrollTapZone = 'up' | 'center' | 'down'

/** What the reader can ask of the strip (keys, slider). */
export interface ScrollApi {
  scrollToPage: (index: number, smooth?: boolean) => void
  /** Scrolls by a share of the viewport height (negative = up). */
  scrollByScreens: (screens: number) => void
}

interface ScrollViewProps {
  /** The scrolling element; the reader measures it for the viewport, like the paged stage. */
  stageRef: RefObject<HTMLDivElement | null>
  api: MutableRefObject<ScrollApi | null>
  layout: StripLayout
  viewport: Size
  pages: ReadonlyMap<number, PageState>
  enhanced?: ReadonlyMap<number, SrResult>
  background: StageBackground
  /** The page being read. Changed from outside (slider, keys, restored bookmark), the strip scrolls to it. */
  currentPage: number
  onCurrentPage: (index: number) => void
  /** Pages intersecting the viewport, in order: what the reader loads, protects and enhances. */
  onVisibleChange: (indices: number[]) => void
  onTap: (zone: ScrollTapZone) => void
  onRetry: (index: number) => void
  blurred?: ReadonlySet<number>
  revealing?: ReadonlySet<number>
}

/** Pages kept in the DOM beyond the viewport, in viewport heights, so a flick never meets an empty strip. */
const RENDER_MARGIN_SCREENS = 1.5
/** Duration of a programmatic scroll (tap zones, keys). */
const GLIDE_MS = 320

/**
 * Scrolls `el` to `to` with an ease-out over GLIDE_MS, one animation per element; a new glide,
 * or the reader's own finger or wheel, replaces it. Deliberately not the browser's
 * `behavior: 'smooth'`: Chromium drops such a request when it follows an instant jump closely,
 * and WebKit's timing differs; this is the same everywhere.
 */
const glides = new WeakMap<HTMLElement, number>()
function glideTo(el: HTMLElement, to: number): void {
  const previous = glides.get(el)
  if (previous !== undefined) cancelAnimationFrame(previous)
  const from = el.scrollTop
  const target = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, to))
  if (Math.abs(target - from) < 1) return
  const start = performance.now()
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / GLIDE_MS)
    const eased = 1 - (1 - t) ** 3
    el.scrollTop = from + (target - from) * eased
    if (t < 1) glides.set(el, requestAnimationFrame(step))
    else glides.delete(el)
  }
  glides.set(el, requestAnimationFrame(step))
}
function stopGlide(el: HTMLElement): void {
  const running = glides.get(el)
  if (running !== undefined) {
    cancelAnimationFrame(running)
    glides.delete(el)
  }
}
/** Share of the viewport a tap in the upper or lower zone scrolls by. */
const TAP_SCROLL_SCREENS = 0.85

const sameList = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i])

/**
 * Webtoon-style reading: one vertical strip, native scrolling (momentum, rubber band, the scroll
 * bar), pages fitted to a common width. Only the pages near the viewport are in the DOM; the
 * others are empty space of the right height. The page under the upper third of the viewport is
 * the one being read; sizes discovered while reading re-flow the strip without moving what the
 * reader is looking at.
 */
export function ScrollView({ stageRef, api, layout, viewport, pages, enhanced, background, currentPage, onCurrentPage, onVisibleChange, onTap, onRetry, blurred, revealing }: ScrollViewProps) {
  const [range, setRange] = useState<number[]>([])
  const reported = useRef<number>(currentPage)
  const visible = useRef<number[]>([])
  const prevLayout = useRef<StripLayout | null>(null)
  const restored = useRef(false)
  const frame = useRef<number | null>(null)
  const layoutRef = useRef(layout)
  const viewportRef = useRef(viewport)
  const callbacks = useRef({ onCurrentPage, onVisibleChange })
  useLayoutEffect(() => {
    layoutRef.current = layout
    viewportRef.current = viewport
    callbacks.current = { onCurrentPage, onVisibleChange }
  })

  /** Reads the scroll position and updates: rendered window, visible pages, page being read. */
  const measure = useCallback(() => {
    frame.current = null
    const el = stageRef.current
    const l = layoutRef.current
    if (!el || l.boxes.length === 0) return
    const top = el.scrollTop
    const vh = viewportRef.current.h || el.clientHeight
    const window_ = pagesInRange(l, top, vh, vh * RENDER_MARGIN_SCREENS)
    setRange((r) => (sameList(r, window_) ? r : window_))
    const now = pagesInRange(l, top, vh)
    if (!sameList(visible.current, now)) {
      visible.current = now
      callbacks.current.onVisibleChange(now)
    }
    const current = currentPageAt(l, top, vh)
    if (current !== reported.current) {
      reported.current = current
      callbacks.current.onCurrentPage(current)
    }
  }, [stageRef])

  const schedule = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(measure)
  }, [measure])

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    },
    [],
  )

  const scrollToPage = useCallback(
    (index: number, smooth = false) => {
      const el = stageRef.current
      const box = layoutRef.current.boxes[Math.min(layoutRef.current.boxes.length - 1, Math.max(0, index))]
      if (!el || !box) return
      reported.current = box.index
      if (smooth) glideTo(el, box.top)
      else {
        stopGlide(el)
        el.scrollTop = box.top
      }
      schedule()
    },
    [stageRef, schedule],
  )

  useLayoutEffect(() => {
    api.current = {
      scrollToPage,
      scrollByScreens: (screens) => {
        const el = stageRef.current
        if (el) glideTo(el, el.scrollTop + screens * (viewportRef.current.h || el.clientHeight))
      },
    }
    return () => {
      api.current = null
    }
  }, [api, scrollToPage, stageRef])

  // Layout changes (sizes decoded, width setting, rotation): keep the reader's place, or take the
  // bookmark's on the first usable layout.
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el || layout.boxes.length === 0) return
    const prev = prevLayout.current
    prevLayout.current = layout
    if (!restored.current) {
      restored.current = true
      scrollToPage(currentPage)
      return
    }
    if (prev && prev !== layout && (prev.height !== layout.height || prev.pageWidth !== layout.pageWidth)) {
      el.scrollTop = scrollTopFor(layout, anchorAt(prev, el.scrollTop))
    }
    schedule()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, viewport.h])

  // The reader moved the bookmark (slider, keys): follow.
  useEffect(() => {
    if (restored.current && currentPage !== reported.current) scrollToPage(currentPage)
  }, [currentPage, scrollToPage])

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return
    const rect = e.currentTarget.getBoundingClientRect()
    const y = (e.clientY - rect.top) / Math.max(1, rect.height)
    const zone: ScrollTapZone = y < 0.3 ? 'up' : y > 0.7 ? 'down' : 'center'
    if (zone !== 'center') api.current?.scrollByScreens(zone === 'up' ? -TAP_SCROLL_SCREENS : TAP_SCROLL_SCREENS)
    onTap(zone)
  }

  return (
    <div
      ref={stageRef}
      className="reader-stage absolute inset-0 overflow-x-hidden overflow-y-auto bg-stage select-none"
      style={{ touchAction: 'pan-y', overscrollBehavior: 'contain', background: STAGE_BG[background] }}
      onScroll={schedule}
      onPointerDown={(e) => stopGlide(e.currentTarget)}
      onWheel={(e) => stopGlide(e.currentTarget)}
      onClick={onClick}
      data-testid="stage"
      data-background={background}
      data-mode="scroll"
    >
      <div className="relative" style={{ height: layout.height, width: '100%' }} data-testid="scroll-strip">
        {range.map((index) => {
          const box = layout.boxes[index]
          if (!box) return null
          const state = pages.get(index)
          const sr = enhanced?.get(index)
          const isBlurred = !sr && blurred?.has(index) === true
          const isRevealing = !!sr && revealing?.has(index) === true
          return (
            <div
              key={index}
              className={`absolute ${isBlurred ? 'overflow-hidden' : ''} ${isRevealing ? 'hd-reveal' : ''}`}
              style={{ top: box.top, left: layout.left, width: layout.pageWidth, height: box.height }}
              data-testid="page"
              data-page={index + 1}
              data-sr={sr ? sr.level : undefined}
              data-blurred={isBlurred || undefined}
            >
              <PageContent index={index} state={state} sr={sr} width={layout.pageWidth} height={box.height} blurred={isBlurred} onRetry={onRetry} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
