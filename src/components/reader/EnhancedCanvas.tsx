import { useEffect, useRef } from 'react'

interface EnhancedCanvasProps {
  bitmap: ImageBitmap
  width: number
  height: number
  alt: string
}

/**
 * Shows an upscaled page. The cached ImageBitmap stays owned by the engine: a cheap GPU copy is
 * transferred into a bitmaprenderer canvas, which the browser then scales like an <img>.
 */
export function EnhancedCanvas({ bitmap, width, height, alt }: EnhancedCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    let cancelled = false
    createImageBitmap(bitmap)
      .then((copy) => {
        if (cancelled) {
          copy.close()
          return
        }
        const ctx = canvas.getContext('bitmaprenderer')
        if (ctx) {
          ctx.transferFromImageBitmap(copy)
        } else {
          canvas.width = copy.width
          canvas.height = copy.height
          canvas.getContext('2d')?.drawImage(copy, 0, 0)
          copy.close()
        }
      })
      // The source may have been evicted (closed) meanwhile, e.g. under a page-turn ghost.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [bitmap])
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
