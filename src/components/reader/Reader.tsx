import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { openArchive, type OpenedArchive } from '../../lib/archive/openArchive'
import { ArchiveError, describeError, isArchiveError } from '../../lib/archive/types'
import { clampOffset, clampZoom, layoutSpread, type Size, zoomAround } from '../../lib/reader/layout'
import { PageCache } from '../../lib/reader/pageCache'
import { blankBefore, firstPage, isBlank, layoutSpreads, realPages, spreadIndexOf, spreadLabel } from '../../lib/spread'
import { getBook, getPageSizes, getProgress, putBook, putPageSizes, putProgress } from '../../lib/storage/db'
import { resolveBookBlob } from '../../lib/storage/importer'
import type { HeavyFactor } from '../../lib/upscale/cunet/protocol'
import { SrAborted, type SrOptions, type SrPlan, type SrResult } from '../../lib/upscale/srEngine'
import { type Book, GUTTER_FRACTION, type PageSize, type ReaderSettings } from '../../types'
import { MaxQualityControls } from './MaxQualityControls'
import { enterFullscreen, isFullscreen } from '../../lib/fullscreen'
import { SettingsPanel } from './SettingsPanel'
import { type PageState, type SpreadGhost, SpreadView, STAGE_BG } from './SpreadView'
import { Toolbars } from './Toolbars'
import { type TapZone, useGestures, type ViewState } from './useGestures'
import { useMaxQuality } from './useMaxQuality'
import { useSuperResolution } from './useSuperResolution'
import { useWakeLock } from './useWakeLock'

interface ReaderProps {
  bookId: string
  sessionBook?: Book
  settings: ReaderSettings
  updateSettings: (patch: Partial<ReaderSettings>) => void
  onClose: () => void
}

const BARS_HIDE_MS = 2500
const PRELOAD_AHEAD = 2
const PRELOAD_BEHIND = 1

function toArchiveError(e: unknown): ArchiveError {
  if (isArchiveError(e)) return e
  return new ArchiveError('read', e instanceof Error ? e.message : String(e))
}

export function Reader({ bookId, sessionBook, settings, updateSettings, onClose }: ReaderProps) {
  const [book, setBook] = useState<Book | null>(sessionBook ?? null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<ArchiveError | null>(null)
  const archiveRef = useRef<OpenedArchive | null>(null)
  const cacheRef = useRef<PageCache | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [sizes, setSizes] = useState<Array<PageSize | null>>([])
  const [currentPage, setCurrentPage] = useState(0)
  const [coverOffset, setCoverOffset] = useState(settings.coverOffset)
  const [blanks, setBlanks] = useState<ReadonlySet<number>>(() => new Set())
  const [pageStates, setPageStates] = useState<Map<number, PageState>>(() => new Map())
  const [view, setView] = useState<ViewState>({ zoom: 1, offset: { x: 0, y: 0 } })
  const [viewport, setViewport] = useState<Size>({ w: window.innerWidth, h: window.innerHeight })
  const [barsVisible, setBarsVisible] = useState(true)
  const [hoveringBars, setHoveringBars] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const sizesDirty = useRef(false)
  const dpr = window.devicePixelRatio || 1

  // ---- open the book -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const b = sessionBook ?? (await getBook(bookId))
      if (!b) throw new ArchiveError('missing', 'Libro non trovato nella libreria.')
      if (cancelled) return
      setBook(b)
      const blob = await resolveBookBlob(b)
      const opened = await openArchive(blob)
      if (cancelled) {
        await opened.reader.close()
        return
      }
      archiveRef.current = opened
      const n = opened.pages.length
      const [savedSizes, progress] = await Promise.all([getPageSizes(b.id), getProgress(b.id)])
      if (cancelled) return
      setSizes(savedSizes && savedSizes.length === n ? savedSizes : new Array<PageSize | null>(n).fill(null))
      setPageCount(n)
      if (progress) {
        setCurrentPage(Math.min(Math.max(0, progress.page), n - 1))
        if (progress.coverOffset !== undefined) setCoverOffset(progress.coverOffset)
        if (progress.blanks?.length) setBlanks(new Set(progress.blanks.filter((p) => p >= 0 && p < n)))
      }
      cacheRef.current = new PageCache(opened.reader, opened.pages, (index, size) => {
        setSizes((prev) => {
          const old = prev[index]
          if (old && old.w === size.w && old.h === size.h) return prev
          const next = [...prev]
          next[index] = size
          sizesDirty.current = true
          return next
        })
      })
      setStatus('ready')
      if (b.storage !== 'session') void putBook({ ...b, lastReadAt: Date.now() })
    }
    run().catch((e) => {
      if (cancelled) return
      setError(toArchiveError(e))
      setStatus('error')
    })
    return () => {
      cancelled = true
      cacheRef.current?.dispose()
      cacheRef.current = null
      void archiveRef.current?.reader.close()
      archiveRef.current = null
    }
  }, [bookId, sessionBook])

  // ---- viewport ------------------------------------------------------------------------------
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const update = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) setViewport({ w: r.width, h: r.height })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [status])

  // ---- layout --------------------------------------------------------------------------------
  const double = settings.pageMode === 'double' || (settings.pageMode === 'auto' && viewport.w > viewport.h)
  const spreads = useMemo(
    () => layoutSpreads(pageCount, sizes, { double, coverOffset, blanks }),
    [pageCount, sizes, double, coverOffset, blanks],
  )
  const spreadIndex = spreadIndexOf(spreads, currentPage)
  const spread = spreads[spreadIndex] ?? []
  const spreadPages = useMemo(() => realPages(spread), [spread])
  const spreadKey = spread.join(',')
  const spreadHasBlank = spread.some(isBlank)
  /** Insert a blank before the first page of the current spread, or remove the one shown. */
  const toggleBlankHere = useCallback(() => {
    setBlanks((prev) => {
      const next = new Set(prev)
      const blank = spread.find(isBlank)
      if (blank !== undefined) next.delete(blankBefore(blank))
      else {
        const first = firstPage(spread)
        if (first !== undefined) next.add(first)
      }
      return next
    })
  }, [spread])
  const clearBlanks = useCallback(() => setBlanks(new Set()), [])
  const gutter = GUTTER_FRACTION[settings.gutter] ?? 0
  const layout = useMemo(
    () => layoutSpread(spread, sizes, viewport, settings.fit, dpr, settings.direction, gutter),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spreadKey, sizes, viewport, settings.fit, dpr, settings.direction, gutter],
  )
  const content = useMemo(() => ({ w: layout.w * view.zoom, h: layout.h * view.zoom }), [layout.w, layout.h, view.zoom])

  // ---- page-turn transition -------------------------------------------------------------------
  // The leaving spread is kept as a "ghost" layer for one animation; the new one animates in.
  const [ghost, setGhost] = useState<SpreadGhost | null>(null)
  const [enterClass, setEnterClass] = useState<string | undefined>(undefined)
  const prevSpread = useRef<{ index: number; layout: typeof layout; view: ViewState; pages: Map<number, PageState>; enhanced: Map<number, SrResult> } | null>(null)
  const ghostTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ghostId = useRef(0)

  // Reset zoom when the spread changes; re-clamp the offset when the layout/viewport change.
  const lastSpreadKey = useRef(spreadKey)
  useEffect(() => {
    if (lastSpreadKey.current !== spreadKey) {
      lastSpreadKey.current = spreadKey
      setView({ zoom: 1, offset: clampOffset({ x: 0, y: 0 }, { w: layout.w, h: layout.h }, viewport) })
      const prev = prevSpread.current
      const mode = settings.transition
      if (prev && mode !== 'none' && status === 'ready' && prev.layout.pages.length > 0) {
        const forward = spreadIndex > prev.index
        // In RTL the next spread lies to the left: it enters from the left while the old one leaves rightwards.
        const fromLeft = forward === (settings.direction === 'rtl')
        const ready = prev.layout.pages.every((b) => b.index < 0 || prev.pages.get(b.index)?.status === 'ready')
        if (ready) {
          ghostId.current += 1
          setGhost({
            id: ghostId.current,
            layout: prev.layout,
            view: prev.view,
            pages: prev.pages,
            enhanced: prev.enhanced,
            exitClass: mode === 'fade' ? 'spread-out-fade' : fromLeft ? 'spread-out-right' : 'spread-out-left',
          })
        }
        setEnterClass(mode === 'fade' ? 'spread-in-fade' : fromLeft ? 'spread-in-left' : 'spread-in-right')
        if (ghostTimer.current) clearTimeout(ghostTimer.current)
        ghostTimer.current = setTimeout(() => {
          setGhost(null)
          setEnterClass(undefined)
        }, 300)
      }
      return
    }
    setView((v) => {
      const next = clampOffset(v.offset, { w: layout.w * v.zoom, h: layout.h * v.zoom }, viewport)
      return next.x === v.offset.x && next.y === v.offset.y ? v : { ...v, offset: next }
    })
  }, [spreadKey, layout.w, layout.h, viewport, status, spreadIndex, settings.transition, settings.direction])
  useEffect(
    () => () => {
      if (ghostTimer.current) clearTimeout(ghostTimer.current)
    },
    [],
  )

  // ---- page loading & preloading -------------------------------------------------------------
  useEffect(() => {
    const cache = cacheRef.current
    if (status !== 'ready' || !cache) return
    const wanted = new Set<number>(spreadPages)
    for (let k = 1; k <= PRELOAD_AHEAD; k++) for (const p of realPages(spreads[spreadIndex + k] ?? [])) wanted.add(p)
    for (let k = 1; k <= PRELOAD_BEHIND; k++) for (const p of realPages(spreads[spreadIndex - k] ?? [])) wanted.add(p)
    cache.protect(wanted)
    let cancelled = false
    const request = (index: number, visible: boolean) => {
      if (visible) {
        setPageStates((prev) => {
          const cur = prev.get(index)
          if (cur?.status === 'ready' || cur?.status === 'loading') return prev
          const hit = cache.peek(index)
          const next = new Map(prev)
          next.set(index, hit ? { status: 'ready', page: hit } : { status: 'loading' })
          return next
        })
      }
      cache.get(index).then(
        (page) => {
          if (cancelled || !visible) return
          setPageStates((prev) => new Map(prev).set(index, { status: 'ready', page }))
        },
        (e) => {
          if (cancelled || !visible) return
          const err = toArchiveError(e)
          if (err.code === 'aborted') return
          setPageStates((prev) => new Map(prev).set(index, { status: 'error', message: describeError(err.code) }))
        },
      )
    }
    for (const p of spreadPages) request(p, true)
    // Preloads start after the current spread has been requested.
    for (const p of wanted) if (!spreadPages.includes(p)) request(p, false)
    // Drop states outside the window to keep the map small.
    setPageStates((prev) => {
      let changed = false
      const next = new Map<number, PageState>()
      for (const [k, v] of prev) {
        if (wanted.has(k)) next.set(k, v)
        else changed = true
      }
      return changed ? next : prev
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, spreadKey, spreadIndex, spreads])

  const retryPage = useCallback((index: number) => {
    setPageStates((prev) => {
      const next = new Map(prev)
      next.delete(index)
      return next
    })
    const cache = cacheRef.current
    if (!cache) return
    cache.get(index).then(
      (page) => setPageStates((prev) => new Map(prev).set(index, { status: 'ready', page })),
      (e) => setPageStates((prev) => new Map(prev).set(index, { status: 'error', message: describeError(toArchiveError(e).code) })),
    )
  }, [])

  // ---- persistence ---------------------------------------------------------------------------
  // Progress is written after a short debounce, and flushed when the reader closes or the app
  // goes to the background (iPad app switch), so a quick exit never loses the bookmark.
  const pendingProgress = useRef<{ bookId: string; page: number; coverOffset: boolean; blanks: number[] } | null>(null)
  const flushProgress = useCallback(() => {
    const p = pendingProgress.current
    if (!p) return
    pendingProgress.current = null
    void putProgress({ bookId: p.bookId, page: p.page, updatedAt: Date.now(), coverOffset: p.coverOffset, blanks: p.blanks })
  }, [])
  useEffect(() => {
    if (status !== 'ready' || !book) return
    pendingProgress.current = { bookId: book.id, page: currentPage, coverOffset, blanks: [...blanks].sort((a, b) => a - b) }
    const t = setTimeout(flushProgress, 250)
    return () => clearTimeout(t)
  }, [status, book, currentPage, coverOffset, blanks, flushProgress])
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flushProgress()
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', flushProgress)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', flushProgress)
      flushProgress()
    }
  }, [flushProgress])

  useEffect(() => {
    if (status !== 'ready' || !book || !sizesDirty.current) return
    const t = setTimeout(() => {
      sizesDirty.current = false
      void putPageSizes(book.id, sizes)
    }, 500)
    return () => clearTimeout(t)
  }, [status, book, sizes])

  // ---- navigation ----------------------------------------------------------------------------
  const goToSpread = useCallback(
    (i: number) => {
      const target = spreads[Math.min(Math.max(0, i), spreads.length - 1)]
      const first = target ? firstPage(target) : undefined
      if (first !== undefined) setCurrentPage(first)
    },
    [spreads],
  )
  const goNext = useCallback(() => goToSpread(spreadIndex + 1), [goToSpread, spreadIndex])
  const goPrev = useCallback(() => goToSpread(spreadIndex - 1), [goToSpread, spreadIndex])
  const rtl = settings.direction === 'rtl'
  /** In RTL the next page lies to the left; a tap on that side advances. */
  const sideAction = useCallback((side: 'left' | 'right') => ((side === 'left') === rtl ? goNext() : goPrev()), [rtl, goNext, goPrev])

  // ---- toolbars auto-hide --------------------------------------------------------------------
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const armHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setBarsVisible(false), BARS_HIDE_MS)
  }, [])
  const showBars = useCallback(() => {
    setBarsVisible(true)
    armHide()
  }, [armHide])
  useEffect(() => {
    if (!barsVisible) return
    if (hoveringBars || settingsOpen) {
      if (hideTimer.current) clearTimeout(hideTimer.current)
      return
    }
    armHide()
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [barsVisible, hoveringBars, settingsOpen, armHide])

  // ---- gestures ------------------------------------------------------------------------------
  const onTap = useCallback(
    (zone: TapZone) => {
      if (settingsOpen) {
        setSettingsOpen(false)
        return
      }
      if (zone === 'center') {
        if (barsVisible) setBarsVisible(false)
        else showBars()
        return
      }
      sideAction(zone)
    },
    [settingsOpen, barsVisible, showBars, sideAction],
  )
  const onDoubleTap = useCallback(
    (point: { x: number; y: number }) => {
      setView((v) => {
        if (v.zoom > 1.01) return { zoom: 1, offset: clampOffset({ x: 0, y: 0 }, { w: layout.w, h: layout.h }, viewport) }
        const zoom = clampZoom(2.5)
        const offset = clampOffset(zoomAround(v.offset, point, v.zoom, zoom), { w: layout.w * zoom, h: layout.h * zoom }, viewport)
        return { zoom, offset }
      })
    },
    [layout.w, layout.h, viewport],
  )
  const onSwipe = useCallback(
    (dir: 'left' | 'right') => {
      // Swiping left drags the content left and reveals what lies on the right.
      if (dir === 'left') (rtl ? goPrev : goNext)()
      else (rtl ? goNext : goPrev)()
    },
    [rtl, goNext, goPrev],
  )
  const onWheelNav = useCallback((d: 1 | -1) => (d > 0 ? goNext() : goPrev()), [goNext, goPrev])
  const onView = useCallback((next: ViewState) => setView(next), [])
  useGestures(stageRef, canvasRef, view, content, viewport, {
    onTap,
    onDoubleTap,
    onSwipe,
    onWheelNav,
    onView,
    onActivity: showBars,
  })

  // ---- keyboard ------------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
      switch (e.key) {
        case 'ArrowLeft':
          sideAction('left')
          break
        case 'ArrowRight':
          sideAction('right')
          break
        case ' ':
        case 'PageDown':
        case 'ArrowDown':
          goNext()
          break
        case 'Backspace':
        case 'PageUp':
        case 'ArrowUp':
          goPrev()
          break
        case 'Home':
          goToSpread(0)
          break
        case 'End':
          goToSpread(spreads.length - 1)
          break
        case 'Escape':
          if (settingsOpen) setSettingsOpen(false)
          else onClose()
          break
        default:
          return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sideAction, goNext, goPrev, goToSpread, spreads.length, settingsOpen, onClose])

  useWakeLock(status === 'ready')

  // ---- "Qualità massima" (Real-ESRGAN anime 6B at x4; cached results take precedence) ---------
  // Coexists with the standard tier: Anime4K shows the page at once, the GAN result replaces it.
  const mq = useMaxQuality(status === 'ready' && settings.maxQuality, 'esrgan6b')
  const heavyLabel = 'GAN'
  /** The GAN's native factor; the worker drops to x2 only when x4 would exceed the canvas cap. */
  const heavyMaxFactor: HeavyFactor = 4
  const [cunetResults, setCunetResults] = useState<Map<number, SrResult>>(() => new Map())
  /** A heavy result as shown: its factor is read off the bitmap (x4 results are preferred when cached). */
  const heavyResult = useCallback(
    (index: number, bitmap: ImageBitmap): SrResult => {
      const size = sizes[index]
      return { bitmap, level: heavyLabel, factor: size ? Math.max(1, Math.round(bitmap.width / size.w)) : 4, ms: 0 }
    },
    [sizes],
  )
  /** Raw page bytes straight from the archive (no decode), for the heavy-model worker. */
  const pageBlob = useCallback(async (index: number): Promise<Blob> => {
    const opened = archiveRef.current
    if (!opened) throw new ArchiveError('aborted')
    const entry = opened.pages[index]
    if (!entry) throw new ArchiveError('missing')
    return opened.reader.extract(entry.name)
  }, [])
  useEffect(() => {
    const engine = mq.engine
    if (!engine || status !== 'ready' || !book) {
      setCunetResults((m) => (m.size ? new Map() : m))
      return
    }
    const wanted: number[] = [...spreadPages]
    for (let k = 1; k <= PRELOAD_AHEAD; k++) for (const p of realPages(spreads[spreadIndex + k] ?? [])) wanted.push(p)
    engine.prune(book.id, wanted)
    let cancelled = false
    const bookId = book.id
    const batchRunning = mq.batch.running
    for (const index of wanted) {
      const hit = engine.peek(bookId, index)
      if (hit) {
        setCunetResults((m) => (m.get(index)?.bitmap === hit ? m : new Map(m).set(index, heavyResult(index, hit))))
        continue
      }
      void engine.lookup(bookId, index).then((bitmap) => {
        if (cancelled) return
        if (bitmap) {
          setCunetResults((m) => new Map(m).set(index, heavyResult(index, bitmap)))
        } else if (engine.prefetchAllowed && !batchRunning) {
          // WebGPU: process the pages ahead while reading (the batch job covers them otherwise).
          engine
            .enhance(bookId, index, () => pageBlob(index), heavyMaxFactor)
            .then((b) => {
              if (!cancelled) setCunetResults((m) => new Map(m).set(index, heavyResult(index, b)))
            })
            .catch(() => undefined)
        }
      })
    }
    setCunetResults((m) => {
      let changed = false
      const next = new Map<number, SrResult>()
      for (const [k, v] of m) {
        if (wanted.includes(k)) next.set(k, v)
        else changed = true
      }
      return changed ? next : m
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mq.engine, mq.tick, mq.batch.running, status, book, spreadKey, spreads, spreadIndex, pageBlob])

  // ---- super resolution (Anime4K) ------------------------------------------------------------
  const srOptions = useMemo<SrOptions>(
    () => ({ level: settings.srLevel, scale: settings.srScale, restore: settings.srRestore, clean: settings.srClean }),
    [settings.srLevel, settings.srScale, settings.srRestore, settings.srClean],
  )
  const sr = useSuperResolution(status === 'ready' && settings.superResolution, srOptions)
  const [enhanced, setEnhanced] = useState<Map<number, SrResult>>(() => new Map())
  const [srPending, setSrPending] = useState<Set<number>>(() => new Set())
  const [srNative, setSrNative] = useState<Set<number>>(() => new Set())
  useEffect(() => {
    const engine = sr.engine
    if (!engine || status !== 'ready') {
      setEnhanced((m) => (m.size ? new Map() : m))
      return
    }
    // The result is a fixed factor of the source, so only the pages matter (not how large they
    // are shown): the current spread first, then the next spreads so they are ready on the turn.
    const targets = new Map<number, { size: PageSize; priority: number }>()
    for (const index of spreadPages) {
      const size = sizes[index]
      if (size) targets.set(index, { size, priority: 0 })
    }
    for (let k = 1; k <= PRELOAD_AHEAD; k++) {
      for (const index of realPages(spreads[spreadIndex + k] ?? [])) {
        const size = sizes[index]
        if (size && !targets.has(index)) targets.set(index, { size, priority: k })
      }
    }
    const wanted: number[] = []
    const plans = new Map<number, SrPlan>()
    const native = new Set<number>()
    for (const [index, t] of targets) {
      if (cunetResults.has(index)) continue // the heavy-tier result wins
      const decision = engine.plan(t.size)
      if (typeof decision === 'string') native.add(index)
      else {
        wanted.push(index)
        plans.set(index, decision)
      }
    }
    engine.setWanted(wanted)
    setSrNative(native)
    let cancelled = false
    const cache = cacheRef.current
    for (const index of wanted) {
      const t = targets.get(index)!
      const plan = plans.get(index)!
      const hit = engine.peek(index, plan)
      if (hit) {
        setEnhanced((m) => (m.get(index) === hit ? m : new Map(m).set(index, hit)))
        continue
      }
      if (!cache) continue
      setSrPending((s) => (s.has(index) ? s : new Set(s).add(index)))
      engine
        .enhance(index, plan, async () => createImageBitmap((await cache.get(index)).blob), t.priority)
        .then((result) => {
          if (cancelled) return
          setEnhanced((m) => new Map(m).set(index, result))
        })
        .catch((e) => {
          if (!(e instanceof SrAborted) && !cancelled) console.warn('SR fallita', e)
        })
        .finally(() => {
          setSrPending((s) => {
            if (!s.has(index)) return s
            const n = new Set(s)
            n.delete(index)
            return n
          })
        })
    }
    // Forget results the engine may have evicted or that are no longer relevant.
    setEnhanced((m) => {
      let changed = false
      const next = new Map<number, SrResult>()
      for (const [k, v] of m) {
        if (wanted.includes(k)) next.set(k, v)
        else changed = true
      }
      return changed ? next : m
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sr.engine, sr.tick, status, spreadKey, spreadPages, sizes, spreads, spreadIndex, srOptions, cunetResults])

  /** What the view shows: GAN results first, then Anime4K. */
  const displayed = useMemo(() => {
    if (cunetResults.size === 0) return enhanced
    const merged = new Map(enhanced)
    for (const [k, v] of cunetResults) merged.set(k, v)
    return merged
  }, [enhanced, cunetResults])
  const heavyEnabled = settings.maxQuality
  const showEnhanced = (settings.superResolution && !!sr.engine) || (heavyEnabled && cunetResults.size > 0)
  /** "Originale" held down: the plain page is shown instead of the enhanced one, to compare. */
  const [compare, setCompare] = useState(false)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'o' && !e.repeat && !settingsOpen) setCompare(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === 'o') setCompare(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [settingsOpen])

  // Snapshot of what is on screen, taken after every render: the source of the transition ghost.
  useEffect(() => {
    prevSpread.current = { index: spreadIndex, layout, view, pages: pageStates, enhanced: showEnhanced ? displayed : new Map() }
  })

  // Fallback for books opened without a synchronous gesture (session files): the first tap in
  // the reader requests full screen.
  useEffect(() => {
    const el = stageRef.current
    if (!el || !settings.fullscreenReading || status !== 'ready') return
    const onFirst = () => {
      if (!isFullscreen()) void enterFullscreen()
    }
    el.addEventListener('pointerdown', onFirst, { once: true })
    return () => el.removeEventListener('pointerdown', onFirst)
  }, [settings.fullscreenReading, status])

  const srBadge = (() => {
    const onScreen = spreadPages.filter((i) => pageStates.get(i)?.status === 'ready')
    if (onScreen.length > 0 && onScreen.every((i) => cunetResults.has(i))) {
      const f = Math.min(...onScreen.map((i) => cunetResults.get(i)!.factor))
      return `SR ×${f} ${heavyLabel}`
    }
    if (!settings.superResolution || sr.status === 'off') return heavyEnabled ? 'SR…' : undefined
    if (sr.status === 'init') return 'SR…'
    if (sr.status === 'unavailable' || !sr.engine) return 'SR n/d'
    if (onScreen.length === 0) return 'SR…'
    if (onScreen.some((i) => srPending.has(i))) return 'SR…'
    const results = onScreen.map((i) => displayed.get(i)).filter((r): r is SrResult => !!r)
    if (results.length > 0) {
      const last = results[results.length - 1]!
      return `SR ×${last.factor} ${last.level}${settings.srRestore ? '+' : ''}`
    }
    if (onScreen.every((i) => srNative.has(i))) return 'SR n/d'
    return 'SR…'
  })()

  const mqStatusLine = (() => {
    if (!heavyEnabled) return 'Disattivata. Attivandola vengono scaricati il motore (≈ 14–25 MB) e il modello (18 MB), una sola volta.'
    const modelName = 'Real-ESRGAN anime 6B (GAN)'
    switch (mq.status) {
      case 'idle':
      case 'loading':
        return `Caricamento del motore e del modello ${modelName}…`
      case 'model-missing':
        return `Modello ${modelName} non disponibile su questo server (manca public/models: eseguire npm run setup prima della build).`
      case 'unavailable':
        return `Non disponibile: ${mq.engine?.error ?? 'errore sconosciuto'}`
      case 'ready': {
        const i = mq.engine?.info
        if (!i) return 'Pronta.'
        return i.ep === 'webgpu'
          ? `${modelName} ×4 · WebGPU: le pagine seguenti vengono elaborate in background mentre leggi.`
          : `${modelName} ×4 · CPU (WebAssembly, ${i.threads} thread${i.crossOriginIsolated ? '' : ', isolamento cross-origin assente'}): troppo lenta durante la lettura, usa “Pre-elabora questo volume”.`
      }
    }
  })()

  const srStatusLine = (() => {
    if (!settings.superResolution) return 'Disattivata.'
    if (sr.status === 'init') return 'Inizializzazione della GPU…'
    if (sr.status === 'unavailable' || !sr.engine) return 'Non disponibile: WebGPU assente (su iPad serve iPadOS 26 o successivo). Le pagine usano il ridimensionamento del browser.'
    const first = spreadPages[0]
    const size = first !== undefined ? sizes[first] : undefined
    const decision = size ? sr.engine.plan(size) : undefined
    const est = size ? sr.engine.estimateMs(size) : undefined
    const parts = [`${sr.engine.backend === 'webgpu' ? 'WebGPU' : 'WebGL2'} · ${sr.engine.adapterName}`]
    if (decision && typeof decision !== 'string') {
      parts.push(`livello ${settings.srLevel === 'auto' ? `auto → ${decision.level}` : decision.level}`)
      parts.push(`×${decision.passes === 2 ? 4 : 2} → ${decision.target.w}×${decision.target.h} px, adattata allo schermo`)
    } else if (decision === 'too-big') parts.push('pagina troppo grande per la GPU, mostrata com’è')
    if (est !== undefined) parts.push(`≈ ${Math.round(est)} ms/pagina`)
    return parts.join(' · ')
  })()

  // ---- render --------------------------------------------------------------------------------
  if (status === 'error' && error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-grouped p-8 text-center pt-safe pb-safe">
        <div className="cover flex h-32 w-24 items-center justify-center bg-card">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-label-3" aria-hidden>
            <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18.6A2 2 0 0 0 3.5 21.6h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          </svg>
        </div>
        <h1 className="mt-3 text-title2">Impossibile aprire il volume</h1>
        <p className="max-w-md text-subhead text-label-2" data-testid="reader-error">
          {describeError(error.code, book?.fileName)}
        </p>
        <button type="button" className="btn-primary mt-3" onClick={onClose}>
          Torna alla libreria
        </button>
      </div>
    )
  }

  const label = spread.length ? spreadLabel(spread) : '–'
  /** Tiny corner indicator: green when the enhancement is applied to every page on screen. */
  const mini = (() => {
    if (!settings.srIndicator || !srBadge) return null
    if (srBadge.startsWith('SR ×')) return { state: 'applied' as const, text: srBadge.slice(3) }
    if (srBadge === 'SR…') return { state: 'pending' as const, text: '…' }
    return null
  })()

  return (
    <div
      className="relative h-full overflow-hidden bg-stage"
      style={{ background: STAGE_BG[settings.stageBackground] }}
      data-testid="reader"
      data-status={status}
    >
      <SpreadView
        stageRef={stageRef}
        canvasRef={canvasRef}
        layout={layout}
        view={view}
        pages={pageStates}
        enhanced={showEnhanced && !compare ? displayed : undefined}
        gutterColor={settings.gutterColor}
        background={settings.stageBackground}
        spreadKey={spreadKey}
        enterClass={enterClass}
        ghost={ghost}
        onRetry={retryPage}
      />
      {mini && !barsVisible && (
        <div
          className="material pointer-events-none absolute right-2 z-10 flex items-center gap-1 rounded-full px-1.5 py-[2px] text-[10px] leading-none font-semibold text-label-2 tabular-nums"
          style={{ top: 'calc(env(safe-area-inset-top, 0px) + 6px)' }}
          data-testid="sr-mini"
          data-state={mini.state}
          aria-hidden
        >
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${mini.state === 'applied' ? 'bg-green' : 'bg-label-3'}`} />
          {mini.text}
        </div>
      )}
      {status === 'loading' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="spinner" aria-label="Apertura del volume" />
        </div>
      )}
      <Toolbars
        visible={barsVisible}
        title={book?.title ?? ''}
        label={label}
        pageCount={pageCount}
        spreadIndex={spreadIndex}
        spreadCount={spreads.length}
        direction={settings.direction}
        double={double}
        coverOffset={coverOffset}
        blankHere={spreadHasBlank}
        badge={srBadge}
        compareAvailable={showEnhanced && spreadPages.some((i) => displayed.has(i))}
        comparing={compare}
        onCompare={setCompare}
        onBack={onClose}
        onSettings={() => setSettingsOpen((o) => !o)}
        onSeek={goToSpread}
        onToggleDouble={() => updateSettings({ pageMode: double ? 'single' : 'double' })}
        onToggleOffset={() => setCoverOffset((v) => !v)}
        onToggleBlank={toggleBlankHere}
        onHoverChange={setHoveringBars}
      />
      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          coverOffset={coverOffset}
          blankCount={blanks.size}
          onClearBlanks={clearBlanks}
          onChange={updateSettings}
          onCoverOffset={(v) => {
            setCoverOffset(v)
            updateSettings({ coverOffset: v })
          }}
          onClose={() => setSettingsOpen(false)}
          extra={<span data-testid="sr-status">{srStatusLine}</span>}
          maxQuality={
            <MaxQualityControls
              enabled={settings.maxQuality}
              statusLine={mqStatusLine}
              ready={mq.status === 'ready'}
              batch={mq.batch}
              pageCount={pageCount}
              onToggle={(v) => updateSettings({ maxQuality: v })}
              onStart={() => {
                if (!book) return
                mq.startBatch(book.id, Array.from({ length: pageCount }, (_, i) => i), pageBlob, heavyMaxFactor)
              }}
              onCancel={mq.cancelBatch}
            />
          }
        />
      )}
    </div>
  )
}
