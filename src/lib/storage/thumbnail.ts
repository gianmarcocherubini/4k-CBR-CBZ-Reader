import type { PageSize } from '../../types'
import { assertSafeEncodedImage, assertSafeImageSize } from '../imageDimensions'

export interface DecodedImage {
  bitmap: ImageBitmap
  size: PageSize
}

/** Decodes an image Blob. Falls back to an <img> element when createImageBitmap refuses the format. */
export async function decodeImage(blob: Blob): Promise<DecodedImage> {
  await assertSafeEncodedImage(blob)
  let bitmap: ImageBitmap
  let size: PageSize
  try {
    bitmap = await createImageBitmap(blob)
    size = { w: bitmap.width, h: bitmap.height }
  } catch {
    const url = URL.createObjectURL(blob)
    try {
      const img = new Image()
      img.decoding = 'async'
      img.src = url
      await img.decode()
      size = { w: img.naturalWidth, h: img.naturalHeight }
      bitmap = await createImageBitmap(img)
    } finally {
      URL.revokeObjectURL(url)
    }
  }
  try {
    assertSafeImageSize(size)
  } catch (e) {
    bitmap.close()
    throw e
  }
  return { bitmap, size }
}

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

async function canvasToBlob(canvas: OffscreenCanvas | HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality })
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob fallito'))), type, quality)
  })
}

/** Produces a JPEG thumbnail (max `maxWidth` px wide) plus the original page size. */
export async function makeThumbnail(blob: Blob, maxWidth = 320): Promise<{ thumb: Blob; size: PageSize }> {
  const { bitmap, size } = await decodeImage(blob)
  try {
    const scale = Math.min(1, maxWidth / bitmap.width)
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = makeCanvas(w, h)
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
    if (!ctx) throw new Error('Canvas 2D non disponibile')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, w, h)
    const thumb = await canvasToBlob(canvas, 'image/jpeg', 0.82)
    return { thumb, size }
  } finally {
    bitmap.close()
  }
}
