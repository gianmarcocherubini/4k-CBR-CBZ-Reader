import { useEffect, useRef } from 'react'

interface EnhancedCanvasProps {
  bitmap: ImageBitmap
  /** Displayed size, CSS px. */
  width: number
  height: number
  alt: string
}

/** Delay before the backing store follows a size change (continuous zoom scales the old one via CSS). */
const RESIZE_DEBOUNCE_MS = 120

/**
 * Fits `src` into w×h with the best filter available. `createImageBitmap` with resize options runs
 * a real Lanczos resampler off the main thread (Chromium, WebKit); where the options are ignored
 * the fallback halves the image with exact 2x2 boxes and finishes with one bilinear step, which
 * avoids both the aliasing of plain bilinear and the blur of trilinear mipmaps.
 */
async function fit(src: ImageBitmap, w: number, h: number): Promise<ImageBitmap> {
  try {
    const out = await createImageBitmap(src, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
    if (out.width === w && out.height === h) return out
    out.close()
  } catch {
    // unsupported options: fall through
  }
  let cur: ImageBitmap | OffscreenCanvas = src
  let cw = src.width
  let ch = src.height
  while (cw >= 2 * w && ch >= 2 * h) {
    const half = new OffscreenCanvas(Math.round(cw / 2), Math.round(ch / 2))
    const ctx = half.getContext('2d')!
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'medium'
    ctx.drawImage(cur, 0, 0, half.width, half.height)
    cur = half
    cw = half.width
    ch = half.height
  }
  const last = new OffscreenCanvas(w, h)
  const ctx = last.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(cur, 0, 0, w, h)
  return last.transferToImageBitmap()
}

/**
 * Fitted versions of each engine bitmap (the last two sizes). Lets a re-mounted view, such as the
 * ghost of a page turn, paint synchronously, and dies with the source bitmap.
 */
const fitCache = new WeakMap<ImageBitmap, Array<{ key: string; fitted: ImageBitmap }>>()

function fittedFor(src: ImageBitmap, w: number, h: number): ImageBitmap | undefined {
  return fitCache.get(src)?.find((e) => e.key === `${w}x${h}`)?.fitted
}

async function fitCached(src: ImageBitmap, w: number, h: number): Promise<ImageBitmap> {
  const key = `${w}x${h}`
  const hit = fittedFor(src, w, h)
  if (hit) return hit
  const fitted = await fit(src, w, h)
  const list = fitCache.get(src) ?? []
  const raced = list.find((e) => e.key === key)
  if (raced) {
    fitted.close()
    return raced.fitted
  }
  list.push({ key, fitted })
  while (list.length > 2) list.shift()!.fitted.close()
  fitCache.set(src, list)
  return fitted
}

/**
 * Shows an enhanced page. The engines produce a fixed factor of the source (x2 or x4); this
 * component "fits" it: the canvas holds exactly the displayed device pixels (never more than the
 * bitmap itself), filled with a high-quality resample of the result. Downsampling a x4 result this
 * way is what gives clean, anti-aliased lines. The cached bitmap stays owned by the engine and is
 * reused at every zoom level. A quick resample is drawn at once so no frame is ever blank; the
 * Lanczos version replaces it as soon as it is ready.
 */
export function EnhancedCanvas({ bitmap, width, height, alt }: EnhancedCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  const painted = useRef<{ bitmap: ImageBitmap; w: number; h: number } | null>(null)
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const bw = Math.max(1, Math.min(bitmap.width, Math.round(width * dpr)))
  const bh = Math.max(1, Math.min(bitmap.height, Math.round(height * dpr)))

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    // A closed ImageBitmap reports 0x0: it cannot be drawn, and resizing the canvas for it would
    // wipe what is on screen. Keep the last painted pixels until a live bitmap arrives.
    if (bitmap.width === 0 || bitmap.height === 0) return
    let cancelled = false
    const paint = async () => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw
        canvas.height = bh
      }
      painted.current = { bitmap, w: bw, h: bh }
      const ready = fittedFor(bitmap, bw, bh)
      if (ready) {
        ctx.drawImage(ready, 0, 0)
        return
      }
      try {
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.drawImage(bitmap, 0, 0, bw, bh)
        const fitted = await fitCached(bitmap, bw, bh)
        if (!cancelled) ctx.drawImage(fitted, 0, 0)
      } catch {
        // The engine evicted (closed) the source meanwhile, e.g. under a transition ghost.
      }
    }
    const prev = painted.current
    // New content (or first paint): draw right away. Only a size change is debounced.
    if (!prev || prev.bitmap !== bitmap) {
      void paint()
      return () => {
        cancelled = true
      }
    }
    if (prev.w === bw && prev.h === bh) return
    const t = setTimeout(() => void paint(), RESIZE_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [bitmap, bw, bh])

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={alt}
      className="block h-full w-full"
      style={{ width, height }}
      data-testid="enhanced"
      data-sr-width={bitmap.width}
    />
  )
}
