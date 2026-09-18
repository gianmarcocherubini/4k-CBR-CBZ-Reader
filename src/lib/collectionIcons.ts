import { assertSafeEncodedImage } from './imageDimensions'
import { decodeImage } from './storage/thumbnail'

export const COLLECTION_ICONS = ['📖', '📚', '🏴‍☠️', '👒', '⚔️', '🔥', '🐉', '⭐', '🌙', '💥', '🧭', '🎨'] as const

const ICON_BYTES = 2 * 1024 * 1024
const ICON_PIXELS = 4 * 1024 * 1024
const ICON_EDGE = 128

export async function normalizeCollectionIcon(file: Blob): Promise<Blob> {
  if (file.size > ICON_BYTES) throw new Error('L’icona supera 2 MB')
  const size = await assertSafeEncodedImage(file)
  if (size.w * size.h > ICON_PIXELS) throw new Error('L’icona ha una risoluzione eccessiva')
  const { bitmap, size: decodedSize } = await decodeImage(file)
  try {
    if (decodedSize.w * decodedSize.h > ICON_PIXELS) throw new Error('L’icona ha una risoluzione eccessiva')
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(ICON_EDGE, ICON_EDGE)
        : Object.assign(document.createElement('canvas'), { width: ICON_EDGE, height: ICON_EDGE })
    const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
    if (!context) throw new Error('Canvas non disponibile')
    const scale = Math.min(ICON_EDGE / bitmap.width, ICON_EDGE / bitmap.height)
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, Math.round((ICON_EDGE - w) / 2), Math.round((ICON_EDGE - h) / 2), w, h)
    if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/png' })
    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Impossibile salvare l’icona'))), 'image/png'),
    )
  } finally {
    bitmap.close()
  }
}
