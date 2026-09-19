import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { openArchive, type OpenedArchive } from '../../lib/archive/openArchive'
import { ArchiveError, describeError, isArchiveError } from '../../lib/archive/types'
import { clampOffset, clampZoom, layoutSpread, type Size, zoomAround } from '../../lib/reader/layout'
import { PageCache } from '../../lib/reader/pageCache'
import { blankBefore, firstPage, isBlank, layoutSpreads, realPages, spreadIndexOf, spreadLabel } from '../../lib/spread'
import { getBook, getPageSizes, getProgress, putBook, putPageSizes, putProgress } from '../../lib/storage/db'
import {
  type ArchivePasswordRequest,
  getArchivePassword,
  rememberArchivePassword,
  resolveBookBlob,
} from '../../lib/storage/importer'
import { type EnsembleSize, EsrganAborted, MODELS } from '../../lib/upscale/esrgan/esrganEngine'
import { SrAborted, type SrOptions, type SrPlan, type SrResult } from '../../lib/upscale/srEngine'
import { type Book, GUTTER_FRACTION, type PageSize, type ReaderSettings } from '../../types'
import { MaxQualityControls } from './MaxQualityControls'
import { enterFullscreen, isFullscreen } from '../../lib/fullscreen'
import { HdBadge } from './HdBadge'
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
  requestPassword: (request: ArchivePasswordRequest) => Promise<string | null>
}

const BARS_HIDE_MS = 2500
const PRELOAD_AHEAD = 2
const PRELOAD_BEHIND = 1

/** Same keys mapped to the same (identical) values: lets state setters keep the previous reference. */
function sameMap<K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

/** Safe-area insets as resolved by the browser (env() cannot be read from a custom property). */
function safeAreaInsets(): { top: number; bottom: number } {
  const probe = document.createElement('div')
  probe.className = 'pt-safe pb-safe'
  probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:0;height:0;visibility:hidden'
  document.body.appendChild(probe)
  const style = getComputedStyle(probe)
  const insets = { top: parseFloat(style.paddingTop) || 0, bottom: parseFloat(style.paddingBottom) || 0 }
  probe.remove()
  return insets
}

function describeViewport(viewport: Size, layout: { w: number; h: number }): string {
  const px = (v: number) => Math.round(v * 10) / 10
  const safe = safeAreaInsets()
  const parts = [
    `area di lettura ${px(viewport.w)}×${px(viewport.h)} px`,
    `pagine ${px(layout.w)}×${px(layout.h)} px`,
    `finestra ${window.innerWidth}×${window.innerHeight}`,
    `schermo ${screen.width}×${screen.height} (×${window.devicePixelRatio || 1})`,
    `margini sicuri alto ${px(safe.top)} / basso ${px(safe.bottom)}`,
  ]
  if (window.visualViewport) parts.push(`viewport visivo ${px(window.visualViewport.width)}×${px(window.visualViewport.height)}`)
  return parts.join(' · ')
}

function toArchiveError(e: unknown): ArchiveError {
  if (isArchiveError(e)) return e
  return new ArchiveError('read', e instanceof Error ? e.message : String(e))
}

export function Reader({ bookId, sessionBook, settings, updateSettings, onClose, requestPassword }: ReaderProps) {
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
    const controller = new AbortController()
    const run = async () => {
      let b = sessionBook ?? (await getBook(bookId))
      if (!b) throw new ArchiveError('missing', 'Libro non trovato nella libreria.')
      if (cancelled) return
      const legacy = b as Book & { archivePassword?: unknown }
      if (
        Object.hasOwn(legacy, 'archivePassword') ||
        (legacy.passwordProtected && legacy.cover && legacy.coverSource !== 'remote')
      ) {
        const cleaned = { ...legacy } as Book & { archivePassword?: unknown }
        delete cleaned.archivePassword
        cleaned.passwordProtected = true
        if (cleaned.coverSource !== 'remote') {
          delete cleaned.cover
          delete cleaned.coverSource
        }
        b = cleaned
        if (b.storage !== 'session') await putBook(b)
      }
      setBook(b)
      const blob = await resolveBookBlob(b)
      let password = getArchivePassword(b.id)
      let opened: OpenedArchive
      for (;;) {
        try {
          opened = await openArchive(blob, password, controller.signal)
          break
        } catch (e) {
          const err = toArchiveError(e)
          const canRetry = b.format === 'cbz' && (err.code === 'encrypted' || err.code === 'invalid-password')
          if (!canRetry) throw err
          const entered = await requestPassword({
            fileName: b.fileName,
            invalid: err.code === 'invalid-password',
            signal: controller.signal,
          })
          if (entered === null) {
            if (!cancelled) onClose()
            return
          }
          password = entered
        }
      }
      if (password !== undefined) {
        rememberArchivePassword(b.id, password)
        if (!b.passwordProtected || (b.cover && b.coverSource !== 'remote')) {
          const protectedBook = { ...b, passwordProtected: true }
          if (protectedBook.coverSource !== 'remote') {
            delete protectedBook.cover
            delete protectedBook.coverSource
          }
          b = protectedBook
          setBook(b)
          if (b.storage !== 'session') await putBook(b)
        }
      }
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
      controller.abort()
      cacheRef.current?.dispose()
      cacheRef.current = null
      void archiveRef.current?.reader.close()
      archiveRef.current = null
    }
  }, [bookId, sessionBook, onClose, requestPassword])

  // ---- viewport ------------------------------------------------------------------------------
  // The stage is measured, not assumed: on iPadOS the layout viewport of an installed app can
  // change after mount (status bar, safe areas, orientation), and not every change reaches the
  // ResizeObserver, so window and visual-viewport resizes re-measure too.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const update = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) setViewport((v) => (v.w === r.width && v.h === r.height ? v : { w: r.width, h: r.height }))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    window.visualViewport?.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      window.visualViewport?.removeEventListener('resize', update)
    }
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
    // Only pages currently on screen are unevictable. Read-ahead pages are opportunistic and must
    // never override the PageCache byte budget (two 32 MP pages already occupy ~256 MiB).
    cache.protect(spreadPages)
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

  // ---- enhancement of the visible spread ------------------------------------------------------
  // Only the pages on screen are ever processed: no read-ahead, no batch, no queue. "Qualità
  // massima" (Real-ESRGAN) runs when its measured throughput predicts the spread within the time
  // budget; otherwise, or when it is off or unavailable, the spread gets Anime4K.
  const mq = useMaxQuality(status === 'ready' && settings.maxQuality, settings.maxQualityModel)
  const srOptions = useMemo<SrOptions>(
    () => ({ level: settings.srLevel, scale: settings.srScale, restore: settings.srRestore, clean: settings.srClean }),
    [settings.srLevel, settings.srScale, settings.srRestore, settings.srClean],
  )
  const sr = useSuperResolution(status === 'ready' && settings.superResolution, srOptions)
  const [enhanced, setEnhanced] = useState<Map<number, SrResult>>(() => new Map())
  const [srPending, setSrPending] = useState<Set<number>>(() => new Set())
  const [srNative, setSrNative] = useState<Set<number>>(() => new Set())
  /** Why Real-ESRGAN was not used for the current spread (null = used, or off). */
  const [heavySkip, setHeavySkip] = useState<'slow' | 'too-big' | 'error' | null>(null)
  const [heavyError, setHeavyError] = useState<string | null>(null)
  /** Visible pages whose size is known, with the size baked into a key so the effect only re-runs on real changes. */
  const visibleKey = spreadPages.map((i) => `${i}:${sizes[i]?.w ?? '?'}x${sizes[i]?.h ?? '?'}`).join(',')
  const heavyBudgetMs = settings.maxQualityBudget * 1000
  /** "Sempre" has no limit for the model itself; the ensemble still sizes itself to this target. */
  const ensembleTargetMs = heavyBudgetMs > 0 ? heavyBudgetMs : 5000
  /** The tier decision is taken once per spread (and per budget), never revised by a later timing sample. */
  const heavyDecision = useRef<{ key: string; use: boolean; skip: 'slow' | 'too-big' | 'error' | null; ensemble: EnsembleSize } | null>(null)
  const [heavyEnsemble, setHeavyEnsemble] = useState<EnsembleSize>(1)
  /** Pages whose HD version Real-ESRGAN is computing right now (anti-spoiler blur). */
  const [heavyPending, setHeavyPending] = useState<Set<number>>(() => new Set())
  /** Pages whose HD version just landed: the canvas sharpens in. */
  const [revealing, setRevealing] = useState<Set<number>>(() => new Set())
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (revealTimer.current) clearTimeout(revealTimer.current)
    },
    [],
  )
  useEffect(() => {
    heavyDecision.current = null
    setHeavyError(null)
  }, [mq.engine])
  useEffect(() => {
    const light = sr.engine?.available ? sr.engine : null
    const heavy = mq.engine?.available ? mq.engine : null
    const cache = cacheRef.current
    if (status !== 'ready' || !book || !cache || (!light && !heavy)) {
      setEnhanced((m) => (m.size ? new Map() : m))
      setSrPending((s) => (s.size ? new Set() : s))
      setHeavyPending((s) => (s.size ? new Set() : s))
      setHeavySkip(null)
      return
    }
    const pages = spreadPages.filter((i) => sizes[i])
    const bookId = book.id
    const heavyKey = (index: number) => `${bookId}:${index}`
    const bitmapOf = async (index: number) => createImageBitmap((await cache.get(index)).blob)

    // Which tier serves this spread, and how many self-ensemble passes the time budget allows.
    let useHeavy = false
    let skip: 'slow' | 'too-big' | 'error' | null = null
    let ensemble: EnsembleSize = 1
    if (settings.maxQuality && heavy && pages.length > 0) {
      const decisionKey = `${visibleKey}|${heavyBudgetMs}|${settings.maxQualityEnsemble ? 'e' : '-'}|${heavyError ?? ''}`
      const prev = heavyDecision.current
      if (prev && prev.key === decisionKey) {
        useHeavy = prev.use
        skip = prev.skip
        ensemble = prev.ensemble
      } else {
        if (heavyError) skip = 'error'
        else if (pages.some((i) => heavy.factorFor(sizes[i]!) === null)) skip = 'too-big'
        else {
          const visible = pages.map((i) => sizes[i]!)
          const est = heavy.estimateMs(visible)
          if (heavyBudgetMs > 0 && est !== undefined && est > heavyBudgetMs) {
            skip = 'slow'
            // The estimate may have been taken while Anime4K kept the GPU busy: measure again so the
            // next spread decides on fresh numbers.
            heavy.reprobe()
          } else {
            useHeavy = true
            // Spare time goes into quality: more passes over flipped/rotated copies, averaged.
            ensemble = settings.maxQualityEnsemble ? heavy.ensembleFor(visible, ensembleTargetMs) : 1
          }
        }
        heavyDecision.current = { key: decisionKey, use: useHeavy, skip, ensemble }
      }
    }
    setHeavySkip(settings.maxQuality ? skip : null)
    setHeavyEnsemble(ensemble)

    let cancelled = false
    const initial = new Map<number, SrResult>()
    if (useHeavy && heavy) {
      light?.setWanted([])
      heavy.setWanted(pages.map(heavyKey))
      setSrNative(new Set())
      const hits = pages.map((i) => heavy.peek(heavyKey(i)))
      if (hits.every((h) => h)) {
        pages.forEach((i, k) => initial.set(i, hits[k]!))
        setEnhanced((m) => (sameMap(m, initial) ? m : initial))
        setSrPending((s) => (s.size ? new Set() : s))
        setHeavyPending((s) => (s.size ? new Set() : s))
      } else {
        // Both pages of a spread turn to HD together: nothing is shown until all are done.
        setEnhanced((m) => (m.size ? new Map() : m))
        setSrPending(new Set(pages))
        setHeavyPending(new Set(pages))
        Promise.all(pages.map((i, k) => hits[k] ?? heavy.enhance(heavyKey(i), sizes[i]!, () => bitmapOf(i), ensemble)))
          .then((results) => {
            if (cancelled) return
            const next = new Map<number, SrResult>()
            pages.forEach((i, k) => next.set(i, results[k]!))
            setEnhanced(next)
            setSrPending(new Set())
            setHeavyPending(new Set())
            // The HD canvas sharpens in from the blur it replaces.
            setRevealing(new Set(pages))
            if (revealTimer.current) clearTimeout(revealTimer.current)
            revealTimer.current = setTimeout(() => setRevealing(new Set()), 700)
          })
          .catch((e: unknown) => {
            if (cancelled || e instanceof EsrganAborted) return
            console.warn('Real-ESRGAN fallito', e)
            // Give the spread to Anime4K for the rest of the session and say why.
            setHeavyError(e instanceof Error ? e.message : String(e))
            setSrPending(new Set())
            setHeavyPending(new Set())
          })
      }
      return () => {
        cancelled = true
      }
    }

    setHeavyPending((s) => (s.size ? new Set() : s))
    heavy?.setWanted([])
    if (!light || !settings.superResolution) {
      setEnhanced((m) => (m.size ? new Map() : m))
      setSrPending((s) => (s.size ? new Set() : s))
      setSrNative(new Set())
      return
    }
    const plans = new Map<number, SrPlan>()
    const native = new Set<number>()
    for (const index of pages) {
      const decision = light.plan(sizes[index]!)
      if (typeof decision === 'string') native.add(index)
      else plans.set(index, decision)
    }
    light.setWanted(plans.keys())
    setSrNative(native)
    const pendingNow = new Set<number>()
    for (const [index, plan] of plans) {
      const hit = light.peek(index, plan)
      if (hit) initial.set(index, hit)
      else pendingNow.add(index)
    }
    // Cached pages appear at once; results still shown from another plan (e.g. the VL probe before
    // the auto level settles) stay until their replacement is ready, so there is no flash to plain.
    setEnhanced((m) => {
      const next = new Map<number, SrResult>()
      for (const index of pages) {
        const r = initial.get(index) ?? m.get(index)
        if (r) next.set(index, r)
      }
      return sameMap(m, next) ? m : next
    })
    setSrPending((s) => (s.size === pendingNow.size && [...pendingNow].every((i) => s.has(i)) ? s : pendingNow))
    for (const index of pendingNow) {
      light
        .enhance(index, plans.get(index)!, () => bitmapOf(index))
        .then((result) => {
          if (cancelled) return
          setEnhanced((m) => (m.get(index) === result ? m : new Map(m).set(index, result)))
        })
        .catch((e: unknown) => {
          if (!(e instanceof SrAborted) && !cancelled) console.warn('SR fallita', e)
        })
        .finally(() => {
          if (cancelled) return
          setSrPending((s) => {
            if (!s.has(index)) return s
            const n = new Set(s)
            n.delete(index)
            return n
          })
        })
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sr.engine, sr.tick, mq.engine, status, book, visibleKey, srOptions, settings.superResolution, settings.maxQuality, settings.maxQualityEnsemble, heavyBudgetMs, ensembleTargetMs, heavyError])

  const heavyLabel = 'GAN'
  const displayed = enhanced
  const showEnhanced = enhanced.size > 0

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

  const lightOn = settings.superResolution && sr.status !== 'off'
  const anyTierOn = lightOn || settings.maxQuality
  const srBadge = (() => {
    if (!anyTierOn) return undefined
    const onScreen = spreadPages.filter((i) => pageStates.get(i)?.status === 'ready')
    if (onScreen.length > 0 && onScreen.every((i) => displayed.get(i)?.level === heavyLabel)) {
      const f = Math.min(...onScreen.map((i) => displayed.get(i)!.factor))
      return `SR ×${f} ${heavyLabel}`
    }
    if (onScreen.some((i) => srPending.has(i))) return 'SR…'
    const results = onScreen.map((i) => displayed.get(i)).filter((r): r is SrResult => !!r)
    if (results.length > 0) {
      const last = results[results.length - 1]!
      return `SR ×${last.factor} ${last.level}${settings.srRestore ? '+' : ''}`
    }
    if (sr.status === 'init' || mq.status === 'init') return 'SR…'
    const lightUsable = lightOn && !!sr.engine
    const heavyUsable = settings.maxQuality && !!mq.engine && heavySkip === null
    if (!lightUsable && !heavyUsable) return 'SR n/d'
    if (onScreen.length === 0) return 'SR…'
    if (!heavyUsable && onScreen.every((i) => srNative.has(i))) return 'SR n/d'
    return 'SR…'
  })()

  const visibleSizes = spreadPages.map((i) => sizes[i]).filter((s): s is PageSize => !!s)
  const mqStatusLine = (() => {
    const modelName = MODELS[settings.maxQualityModel].label
    if (!settings.maxQuality) return `Disattivata. ${modelName} ×4 sulla GPU: più nitida della Super risoluzione, solo per le pagine sullo schermo.`
    switch (mq.status) {
      case 'off':
      case 'init':
        return `Inizializzazione di ${modelName}: ${mq.progress ?? 'avvio'}`
      case 'unavailable':
        return `Non disponibile: ${mq.error ?? 'errore sconosciuto'}. Le pagine usano la Super risoluzione.`
      case 'ready': {
        const engine = mq.engine
        if (!engine) return 'Pronta.'
        const parts = [`${modelName} ×4 · WebGPU ${engine.info.precision.toUpperCase()} · kernel 4×${engine.kernelVariant} · ${engine.info.adapter}`]
        if (engine.info.f16Error) parts.push(`kernel f16 rifiutati dalla GPU (${engine.info.f16Error})`)
        const shown = spreadPages.map((i) => displayed.get(i)).find((r) => r?.level === heavyLabel)
        const passes = shown?.ensemble ?? heavyEnsemble
        if (heavySkip === null && passes > 1) parts.push(`self-ensemble ×${passes} (${passes} passaggi mediati, più pulito)`)
        const est = engine.estimateMs(visibleSizes, heavySkip === null ? heavyEnsemble : 1)
        if (est !== undefined && visibleSizes.length > 0) {
          parts.push(`stimati ${(est / 1000).toFixed(1)} s per ${visibleSizes.length > 1 ? 'la coppia' : 'la pagina'} sullo schermo`)
        }
        if (shown && shown.ms > 0) parts.push(`ultima pagina ${(shown.ms / 1000).toFixed(1)} s`)
        if (heavySkip === 'slow') parts.push(`oltre l’attesa massima di ${settings.maxQualityBudget} s: queste pagine usano la Super risoluzione`)
        else if (heavySkip === 'too-big') parts.push('pagina troppo grande per il modello: usa la Super risoluzione')
        else if (heavySkip === 'error') parts.push(`errore (${heavyError ?? 'sconosciuto'}): uso la Super risoluzione`)
        return parts.join(' · ')
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
    if (settings.maxQuality && heavySkip === null && mq.status !== 'unavailable') parts.push('in attesa: usata quando Qualità massima non sta nell’attesa massima')
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
  /** Where the pixels go: measured stage vs. screen, window and safe areas (to read a black band). */
  const viewportDiagnostics = settingsOpen ? describeViewport(viewport, layout) : ''
  /** HD indicator: filled "HD" when the enhancement is on the page, dimmed while it works, struck when n/d. */
  const hdState: 'applied' | 'pending' | 'na' | null = !srBadge
    ? null
    : srBadge.startsWith('SR ×')
      ? 'applied'
      : srBadge === 'SR n/d'
        ? 'na'
        : 'pending'

  return (
    <div
      className="reader-shell overflow-hidden bg-stage"
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
        enhanced={showEnhanced ? displayed : undefined}
        gutterColor={settings.gutterColor}
        background={settings.stageBackground}
        spreadKey={spreadKey}
        enterClass={enterClass}
        ghost={ghost}
        onRetry={retryPage}
        blurred={settings.maxQuality && settings.maxQualityBlur ? heavyPending : undefined}
        revealing={settings.maxQuality && settings.maxQualityBlur ? revealing : undefined}
      />
      {settings.srIndicator && hdState && !barsVisible && (
        <div className="pointer-events-none absolute right-2 z-10" style={{ top: 'calc(env(safe-area-inset-top, 0px) + 6px)' }}>
          <HdBadge state={hdState} label={srBadge!} testId="sr-mini" floating />
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
        blankHere={spreadHasBlank}
        badge={srBadge}
        badgeState={hdState}
        onBack={onClose}
        onSettings={() => setSettingsOpen((o) => !o)}
        onSeek={goToSpread}
        onToggleDouble={() => updateSettings({ pageMode: double ? 'single' : 'double' })}
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
          viewportInfo={viewportDiagnostics}
          maxQuality={
            <MaxQualityControls
              enabled={settings.maxQuality}
              budget={settings.maxQualityBudget}
              model={settings.maxQualityModel}
              ensemble={settings.maxQualityEnsemble}
              blur={settings.maxQualityBlur}
              statusLine={mqStatusLine}
              onToggle={(v) => updateSettings({ maxQuality: v })}
              onBudget={(v) => updateSettings({ maxQualityBudget: v })}
              onModel={(v) => updateSettings({ maxQualityModel: v })}
              onEnsemble={(v) => updateSettings({ maxQualityEnsemble: v })}
              onBlur={(v) => updateSettings({ maxQualityBlur: v })}
            />
          }
        />
      )}
    </div>
  )
}
