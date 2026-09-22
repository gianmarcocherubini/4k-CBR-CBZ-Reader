import { type MutableRefObject, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Size } from '../../lib/reader/layout'
import { anchorAt, currentPageAt, MAX_STRIP_ZOOM, MIN_STRIP_ZOOM, pagesInRange, scrollTopFor, type StripLayout } from '../../lib/reader/scrollLayout'
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
  /** Current zoom (a multiplier of the chosen width, baked into `layout`) and how to change it. */
  zoom: number
  onZoom: (zoom: number) => void
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
/** Share of the viewport a tap in the upper or lower zone scrolls by. */
const TAP_SCROLL_SCREENS = 0.85
/** Duration of a programmatic scroll (tap zones, keys). */
const GLIDE_MS = 320
const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_DIST = 40
/** A single tap waits this long for a possible second one. */
const SINGLE_TAP_DELAY = 250
const DOUBLE_TAP_ZOOM = 2.5

const sameList = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i])
const clampZoom = (z: number) => Math.min(MAX_STRIP_ZOOM, Math.max(MIN_STRIP_ZOOM, z))

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

/** A point of the content, as the page under it and the position inside that page (0..1 on both axes). */
interface ContentAnchor {
  index: number
  fraction: number
  xFraction: number
  /** Where that point was in the viewport. */
  focal: { x: number; y: number }
}

function anchorAtFocal(layout: StripLayout, el: HTMLElement, focal: { x: number; y: number }): ContentAnchor {
  const { index, fraction } = anchorAt(layout, el.scrollTop + focal.y)
  const xFraction = Math.min(1.5, Math.max(-0.5, (el.scrollLeft + focal.x - layout.left) / Math.max(1, layout.pageWidth)))
  return { index, fraction, xFraction, focal }
}

function restoreAnchor(layout: StripLayout, el: HTMLElement, anchor: ContentAnchor): void {
  el.scrollTop = scrollTopFor(layout, { index: anchor.index, fraction: anchor.fraction }) - anchor.focal.y
  el.scrollLeft = layout.left + anchor.xFraction * layout.pageWidth - anchor.focal.x
}

interface Pinch {
  startDist: number
  startZoom: number
  mid: { x: number; y: number }
  scale: number
}

/**
 * Webtoon-style reading: one vertical strip, native scrolling (momentum, rubber band, the scroll
 * bar), pages fitted to a common width. Only the pages near the viewport are in the DOM; the
 * others are empty space of the right height. The page under the upper third of the viewport is
 * the one being read; sizes discovered while reading re-flow the strip without moving what the
 * reader is looking at. Pinch, double tap or Ctrl+wheel zoom the strip: the gesture scales the
 * content as a transient transform, then the zoom is baked into the layout (wider pages, the
 * strip scrolls sideways too) with the point under the fingers kept in place.
 */
export function ScrollView({ stageRef, api, layout, viewport, zoom, onZoom, pages, enhanced, background, currentPage, onCurrentPage, onVisibleChange, onTap, onRetry, blurred, revealing }: ScrollViewProps) {
  const [range, setRange] = useState<number[]>([])
  const stripRef = useRef<HTMLDivElement>(null)
  const reported = useRef<number>(currentPage)
  const visible = useRef<number[]>([])
  const prevLayout = useRef<StripLayout | null>(null)
  const restored = useRef(false)
  const frame = useRef<number | null>(null)
  const layoutRef = useRef(layout)
  const viewportRef = useRef(viewport)
  const zoomRef = useRef(zoom)
  const callbacks = useRef({ onCurrentPage, onVisibleChange, onTap, onZoom })
  /** Set when a zoom is committed: the next layout is placed so this content point stays under the focal. */
  const pendingAnchor = useRef<ContentAnchor | null>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<Pinch | null>(null)
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null)
  const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useLayoutEffect(() => {
    layoutRef.current = layout
    viewportRef.current = viewport
    zoomRef.current = zoom
    callbacks.current = { onCurrentPage, onVisibleChange, onTap, onZoom }
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
      if (tapTimer.current) clearTimeout(tapTimer.current)
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

  // Layout changes (sizes decoded, width setting, zoom, rotation): keep the reader's place, or
  // take the bookmark's on the first usable layout. A committed zoom keeps the pinched point.
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
    if (pendingAnchor.current) {
      restoreAnchor(layout, el, pendingAnchor.current)
      pendingAnchor.current = null
      if (stripRef.current) stripRef.current.style.transform = ''
    } else if (prev && prev !== layout && (prev.height !== layout.height || prev.pageWidth !== layout.pageWidth)) {
      el.scrollTop = scrollTopFor(layout, anchorAt(prev, el.scrollTop))
    }
    schedule()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, viewport.h])

  // The reader moved the bookmark (slider, keys): follow.
  useEffect(() => {
    if (restored.current && currentPage !== reported.current) scrollToPage(currentPage)
  }, [currentPage, scrollToPage])

  // ---- zoom -----------------------------------------------------------------------------------
  /** Commits a zoom around a viewport point: the layout follows, and the anchor puts that point back. */
  const commitZoom = useCallback(
    (next: number, focal: { x: number; y: number }) => {
      const el = stageRef.current
      if (!el) return
      const target = clampZoom(next)
      if (Math.abs(target - zoomRef.current) < 0.001) {
        if (stripRef.current) stripRef.current.style.transform = ''
        return
      }
      stopGlide(el)
      pendingAnchor.current = anchorAtFocal(layoutRef.current, el, focal)
      callbacks.current.onZoom(target)
    },
    [stageRef],
  )

  const local = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    stopGlide(e.currentTarget)
    if (e.pointerType !== 'touch') return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      const p1 = local({ clientX: a!.x, clientY: a!.y })
      const p2 = local({ clientX: b!.x, clientY: b!.y })
      pinch.current = {
        startDist: Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y)),
        startZoom: zoomRef.current,
        mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
        scale: 1,
      }
      if (tapTimer.current) {
        clearTimeout(tapTimer.current)
        tapTimer.current = null
      }
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const p = pinch.current
    if (!p || pointers.current.size < 2) return
    const [a, b] = [...pointers.current.values()]
    const p1 = local({ clientX: a!.x, clientY: a!.y })
    const p2 = local({ clientX: b!.x, clientY: b!.y })
    const dist = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y))
    // The scale is bounded so the transient view never shows more than the committed zoom will.
    p.scale = clampZoom(p.startZoom * (dist / p.startDist)) / p.startZoom
    const el = e.currentTarget
    const strip = stripRef.current
    if (strip) {
      strip.style.transformOrigin = `${el.scrollLeft + p.mid.x}px ${el.scrollTop + p.mid.y}px`
      strip.style.transform = `scale(${p.scale})`
    }
  }

  const endPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.delete(e.pointerId)
    const p = pinch.current
    if (p && pointers.current.size < 2) {
      pinch.current = null
      commitZoom(p.startZoom * p.scale, p.mid)
    }
  }

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    stopGlide(e.currentTarget)
    if (!e.ctrlKey) return
    // Ctrl+wheel (or a trackpad pinch, which browsers report the same way): zoom around the cursor.
    e.preventDefault()
    const factor = Math.exp(-e.deltaY * 0.0022)
    commitZoom(zoomRef.current * factor, local(e))
  }

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return
    const point = local(e)
    const now = performance.now()
    const previous = lastTap.current
    lastTap.current = { t: now, x: point.x, y: point.y }
    if (previous && now - previous.t < DOUBLE_TAP_MS && Math.hypot(point.x - previous.x, point.y - previous.y) < DOUBLE_TAP_DIST) {
      // Double tap: zoom in around the point, or back to the chosen width.
      if (tapTimer.current) {
        clearTimeout(tapTimer.current)
        tapTimer.current = null
      }
      lastTap.current = null
      commitZoom(zoomRef.current > 1.01 ? 1 : DOUBLE_TAP_ZOOM, point)
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const y = point.y / Math.max(1, rect.height)
    const zone: ScrollTapZone = y < 0.3 ? 'up' : y > 0.7 ? 'down' : 'center'
    if (tapTimer.current) clearTimeout(tapTimer.current)
    tapTimer.current = setTimeout(() => {
      tapTimer.current = null
      if (zone !== 'center') api.current?.scrollByScreens(zone === 'up' ? -TAP_SCROLL_SCREENS : TAP_SCROLL_SCREENS)
      callbacks.current.onTap(zone)
    }, SINGLE_TAP_DELAY)
  }

  // Wheel zoom must be able to preventDefault: React registers wheel listeners as passive.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const block = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault()
    }
    el.addEventListener('wheel', block, { passive: false })
    return () => el.removeEventListener('wheel', block)
  }, [stageRef])

  const stripWidth = Math.max(viewport.w, layout.pageWidth)
  return (
    <div
      ref={stageRef}
      className="reader-stage absolute inset-0 overflow-auto bg-stage select-none"
      style={{ touchAction: 'pan-x pan-y', overscrollBehavior: 'contain', background: STAGE_BG[background] }}
      onScroll={schedule}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onWheel={onWheel}
      onClick={onClick}
      data-testid="stage"
      data-mode="scroll"
      data-zoom={zoom.toFixed(2)}
      data-background={background}
    >
      <div ref={stripRef} className="relative will-change-transform" style={{ height: layout.height, width: stripWidth }} data-testid="scroll-strip">
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
