import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react'
import { clampOffset, clampZoom, MAX_ZOOM, MIN_ZOOM, type Point, type Size, zoomAround } from '../../lib/reader/layout'

export interface ViewState {
  zoom: number
  offset: Point
}

export type TapZone = 'left' | 'center' | 'right'

export interface GestureCallbacks {
  onTap: (zone: TapZone, point: Point) => void
  onDoubleTap: (point: Point) => void
  onSwipe: (direction: 'left' | 'right') => void
  onWheelNav: (delta: 1 | -1) => void
  /** Commit a new zoom/offset (gesture end, wheel). */
  onView: (view: ViewState) => void
  /** Any pointer activity (used to reveal the toolbars on mouse move). */
  onActivity: () => void
}

interface TrackedPointer {
  id: number
  x: number
  y: number
  startX: number
  startY: number
  t0: number
  type: string
}

const TAP_MAX_DIST = 10
const TAP_MAX_MS = 350
const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_DIST = 40
const SINGLE_TAP_DELAY = 220
const SWIPE_MIN_DIST = 60
const SWIPE_MAX_MS = 700
const PAN_START_DIST = 6

export function transformFor(view: ViewState, scale = 1): string {
  return `translate3d(${view.offset.x}px, ${view.offset.y}px, 0) scale(${scale})`
}

/**
 * Pointer + wheel gestures for the reader stage. Transient pinch/pan transforms are written
 * straight to the canvas element for smoothness; the final state is committed via `onView`
 * and re-rendered ("baked") into the layout so images are re-rasterised sharp.
 */
export function useGestures(
  stageRef: RefObject<HTMLElement | null>,
  canvasRef: RefObject<HTMLElement | null>,
  view: ViewState,
  content: Size,
  viewport: Size,
  callbacks: GestureCallbacks,
  /** Off in scroll mode, where the strip scrolls natively; the listeners re-attach when it comes back. */
  enabled = true,
): void {
  const viewRef = useRef(view)
  const contentRef = useRef(content)
  const viewportRef = useRef(viewport)
  const cbRef = useRef(callbacks)
  useLayoutEffect(() => {
    viewRef.current = view
    contentRef.current = content
    viewportRef.current = viewport
    cbRef.current = callbacks
  })

  useEffect(() => {
    const stage = stageRef.current
    if (!stage || !enabled) return
    const pointers = new Map<number, TrackedPointer>()
    let pinch: { startDist: number; startMid: Point; startView: ViewState; scale: number; mid: Point } | null = null
    let pan: { startOffset: Point; offset: Point; moved: boolean } | null = null
    let suppressTapUntil = 0
    let lastTap: { t: number; x: number; y: number } | null = null
    let tapTimer: ReturnType<typeof setTimeout> | null = null
    let wheelAccum = 0
    let wheelLastNav = 0

    const canvas = () => canvasRef.current
    /** Commit optimistically: later events in the same frame must see the new view, not the stale render. */
    const commit = (next: ViewState) => {
      const prev = viewRef.current
      if (prev.zoom > 0 && next.zoom !== prev.zoom) {
        const c = contentRef.current
        contentRef.current = { w: (c.w / prev.zoom) * next.zoom, h: (c.h / prev.zoom) * next.zoom }
      }
      viewRef.current = next
      cbRef.current.onView(next)
    }
    const local = (e: { clientX: number; clientY: number }): Point => {
      const r = stage.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const overflows = () => {
      const c = contentRef.current
      const v = viewportRef.current
      return { x: c.w > v.w + 0.5, y: c.h > v.h + 0.5 }
    }
    const setTransform = (t: string) => {
      const el = canvas()
      if (el) el.style.transform = t
    }
    const resetTransform = () => setTransform(transformFor(viewRef.current))

    const startPinch = () => {
      const [a, b] = [...pointers.values()]
      if (!a || !b) return
      const p1 = local({ clientX: a.x, clientY: a.y })
      const p2 = local({ clientX: b.x, clientY: b.y })
      pinch = {
        startDist: Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y)),
        startMid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
        startView: viewRef.current,
        scale: 1,
        mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
      }
      pan = null
      if (tapTimer) {
        clearTimeout(tapTimer)
        tapTimer = null
      }
    }

    const updatePinch = () => {
      if (!pinch) return
      const [a, b] = [...pointers.values()]
      if (!a || !b) return
      const p1 = local({ clientX: a.x, clientY: a.y })
      const p2 = local({ clientX: b.x, clientY: b.y })
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y)
      const z0 = pinch.startView.zoom
      const s = Math.min(MAX_ZOOM / z0, Math.max(MIN_ZOOM / z0, dist / pinch.startDist))
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
      pinch.scale = s
      pinch.mid = mid
      const O = pinch.startView.offset
      const t = { x: mid.x - O.x - s * (pinch.startMid.x - O.x), y: mid.y - O.y - s * (pinch.startMid.y - O.y) }
      setTransform(`translate3d(${O.x + t.x}px, ${O.y + t.y}px, 0) scale(${s})`)
    }

    const endPinch = () => {
      if (!pinch) return
      const { startView, scale, mid, startMid } = pinch
      pinch = null
      const zoom = clampZoom(startView.zoom * scale)
      const k = zoom / startView.zoom
      const raw = { x: mid.x - k * (startMid.x - startView.offset.x), y: mid.y - k * (startMid.y - startView.offset.y) }
      const contentNow = { w: (contentRef.current.w / startView.zoom) * zoom, h: (contentRef.current.h / startView.zoom) * zoom }
      const offset = clampOffset(raw, contentNow, viewportRef.current)
      suppressTapUntil = performance.now() + 400
      commit({ zoom, offset })
      resetTransform()
    }

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      try {
        stage.setPointerCapture(e.pointerId)
      } catch {
        // synthetic or already-released pointer
      }
      pointers.set(e.pointerId, {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        startX: e.clientX,
        startY: e.clientY,
        t0: performance.now(),
        type: e.pointerType,
      })
      if (pointers.size === 2) startPinch()
      else if (pointers.size === 1) pan = { startOffset: viewRef.current.offset, offset: viewRef.current.offset, moved: false }
    }

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') cbRef.current.onActivity()
      const p = pointers.get(e.pointerId)
      if (!p) return
      p.x = e.clientX
      p.y = e.clientY
      if (pinch) {
        updatePinch()
        return
      }
      if (pan && pointers.size === 1) {
        const dx = p.x - p.startX
        const dy = p.y - p.startY
        const ov = overflows()
        if (!pan.moved && Math.hypot(dx, dy) < PAN_START_DIST) return
        if (!ov.x && !ov.y) return // nothing to pan: this is a swipe or a tap
        pan.moved = true
        const next = clampOffset(
          { x: pan.startOffset.x + (ov.x ? dx : 0), y: pan.startOffset.y + (ov.y ? dy : 0) },
          contentRef.current,
          viewportRef.current,
        )
        pan.offset = next
        setTransform(transformFor({ zoom: viewRef.current.zoom, offset: next }))
      }
    }

    const finishPointer = (e: PointerEvent, cancelled: boolean) => {
      const p = pointers.get(e.pointerId)
      if (!p) return
      pointers.delete(e.pointerId)
      try {
        stage.releasePointerCapture(e.pointerId)
      } catch {
        // already released
      }
      if (pinch) {
        if (pointers.size < 2) endPinch()
        return
      }
      const now = performance.now()
      if (pointers.size > 0) return
      if (cancelled) {
        pan = null
        resetTransform()
        return
      }
      const dx = p.x - p.startX
      const dy = p.y - p.startY
      const dist = Math.hypot(dx, dy)
      const dt = now - p.t0
      if (pan?.moved) {
        const offset = pan.offset
        pan = null
        commit({ zoom: viewRef.current.zoom, offset })
        resetTransform()
        return
      }
      pan = null
      if (now < suppressTapUntil) return
      const ov = overflows()
      if (dist >= SWIPE_MIN_DIST && Math.abs(dx) > 2 * Math.abs(dy) && dt < SWIPE_MAX_MS && !ov.x) {
        cbRef.current.onSwipe(dx > 0 ? 'right' : 'left')
        return
      }
      if (dist <= TAP_MAX_DIST && dt <= TAP_MAX_MS) {
        const point = local({ clientX: p.x, clientY: p.y })
        const w = viewportRef.current.w || 1
        const zone: TapZone = point.x < w * 0.3 ? 'left' : point.x > w * 0.7 ? 'right' : 'center'
        if (zone !== 'center') {
          // Side taps turn pages immediately: fast flipping must never be mistaken for a double tap.
          lastTap = null
          cbRef.current.onTap(zone, point)
          return
        }
        if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(point.x - lastTap.x, point.y - lastTap.y) < DOUBLE_TAP_DIST) {
          lastTap = null
          if (tapTimer) {
            clearTimeout(tapTimer)
            tapTimer = null
          }
          cbRef.current.onDoubleTap(point)
          return
        }
        lastTap = { t: now, x: point.x, y: point.y }
        if (tapTimer) clearTimeout(tapTimer)
        tapTimer = setTimeout(() => {
          tapTimer = null
          cbRef.current.onTap('center', point)
        }, SINGLE_TAP_DELAY)
      }
    }

    const onPointerUp = (e: PointerEvent) => finishPointer(e, false)
    const onPointerCancel = (e: PointerEvent) => finishPointer(e, true)

    const onWheel = (e: WheelEvent) => {
      cbRef.current.onActivity()
      const v = viewRef.current
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const zoom = clampZoom(v.zoom * Math.exp(-e.deltaY * 0.0025))
        if (zoom === v.zoom) return
        const focal = local(e)
        const contentNow = { w: (contentRef.current.w / v.zoom) * zoom, h: (contentRef.current.h / v.zoom) * zoom }
        const offset = clampOffset(zoomAround(v.offset, focal, v.zoom, zoom), contentNow, viewportRef.current)
        commit({ zoom, offset })
        return
      }
      const ov = overflows()
      if (ov.x || ov.y) {
        e.preventDefault()
        const offset = clampOffset(
          { x: v.offset.x - (ov.x ? e.deltaX : 0), y: v.offset.y - (ov.y ? e.deltaY : 0) },
          contentRef.current,
          viewportRef.current,
        )
        commit({ zoom: v.zoom, offset })
        return
      }
      e.preventDefault()
      const now = performance.now()
      wheelAccum += e.deltaY
      if (now - wheelLastNav < 300) return
      if (Math.abs(wheelAccum) >= 40) {
        wheelLastNav = now
        cbRef.current.onWheelNav(wheelAccum > 0 ? 1 : -1)
        wheelAccum = 0
      }
    }

    const preventGesture = (e: Event) => e.preventDefault()

    stage.addEventListener('pointerdown', onPointerDown)
    stage.addEventListener('pointermove', onPointerMove)
    stage.addEventListener('pointerup', onPointerUp)
    stage.addEventListener('pointercancel', onPointerCancel)
    stage.addEventListener('wheel', onWheel, { passive: false })
    stage.addEventListener('contextmenu', preventGesture)
    // Safari: stop the page itself from zooming on pinch.
    document.addEventListener('gesturestart', preventGesture)
    document.addEventListener('gesturechange', preventGesture)
    return () => {
      stage.removeEventListener('pointerdown', onPointerDown)
      stage.removeEventListener('pointermove', onPointerMove)
      stage.removeEventListener('pointerup', onPointerUp)
      stage.removeEventListener('pointercancel', onPointerCancel)
      stage.removeEventListener('wheel', onWheel)
      stage.removeEventListener('contextmenu', preventGesture)
      document.removeEventListener('gesturestart', preventGesture)
      document.removeEventListener('gesturechange', preventGesture)
      if (tapTimer) clearTimeout(tapTimer)
    }
  }, [stageRef, canvasRef, enabled])
}
