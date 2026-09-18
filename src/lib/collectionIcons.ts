import { assertSafeEncodedImage } from './imageDimensions'
import { decodeImage } from './storage/thumbnail'

const ICON_BYTES = 2 * 1024 * 1024
const ICON_PIXELS = 4 * 1024 * 1024
const ICON_EDGE = 128
const ICONIFY_BYTES = 256 * 1024
const iconId = /^([a-z0-9-]+):([a-z0-9-]+)$/
const ICONIFY_PREFIXES = new Set(['lucide', 'tabler', 'ph', 'mdi'])
const previewChains: Array<Promise<unknown>> = [Promise.resolve(), Promise.resolve(), Promise.resolve()]
let nextPreviewSlot = 0

export interface OnlineCollectionIcon {
  id: string
  label: string
  previewUrl: string
  license?: string
}

function iconifyUrl(id: string): URL {
  const match = iconId.exec(id)
  if (!match || !ICONIFY_PREFIXES.has(match[1]!) || match[2]!.length > 100) throw new Error('Identificatore icona non valido')
  const url = new URL(`https://api.iconify.design/${match[1]}/${match[2]}.svg`)
  url.searchParams.set('height', '64')
  url.searchParams.set('color', '#f28c1e')
  return url
}

async function boundedBytes(response: Response, max: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`Iconify: HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel()
    throw new Error('Risposta Iconify troppo grande')
  }
  if (!response.body) throw new Error('Risposta Iconify vuota')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Annullato', 'AbortError')
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > max) {
        await reader.cancel()
        throw new Error('Risposta Iconify troppo grande')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export async function searchCollectionIcons(query: string, signal?: AbortSignal): Promise<OnlineCollectionIcon[]> {
  const cleaned = query.trim().slice(0, 100)
  if (!cleaned) return []
  const url = new URL('https://api.iconify.design/search')
  url.searchParams.set('query', cleaned)
  url.searchParams.set('limit', '32')
  url.searchParams.set('prefixes', 'lucide,tabler,ph,mdi')
  const response = await fetch(url, { signal, mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' })
  const data = JSON.parse(new TextDecoder().decode(await boundedBytes(response, ICONIFY_BYTES, signal))) as unknown
  if (!data || typeof data !== 'object' || !Array.isArray((data as { icons?: unknown }).icons)) throw new Error('Risposta Iconify non valida')
  const collections = (data as { collections?: unknown }).collections
  const metadata = collections && typeof collections === 'object' ? (collections as Record<string, unknown>) : {}
  const results: OnlineCollectionIcon[] = []
  for (const value of (data as { icons: unknown[] }).icons.slice(0, 32)) {
    if (typeof value !== 'string') continue
    const match = iconId.exec(value)
    if (!match || !ICONIFY_PREFIXES.has(match[1]!) || match[2]!.length > 100) continue
    const [, prefix, name] = match
    const set = metadata[prefix!] as Record<string, unknown> | undefined
    const licenseData = set?.license as Record<string, unknown> | undefined
    const license = typeof licenseData?.title === 'string' && licenseData.title.length <= 100 ? licenseData.title : undefined
    const preview = iconifyUrl(value)
    results.push({ id: value, label: name!.replace(/-/g, ' '), previewUrl: preview.href, license })
    if (results.length === 24) break
  }
  return results
}

async function canvasPng(bitmap: ImageBitmap): Promise<Blob> {
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(ICON_EDGE, ICON_EDGE)
      : Object.assign(document.createElement('canvas'), { width: ICON_EDGE, height: ICON_EDGE })
  const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
  if (!context) throw new Error('Canvas non disponibile')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0, ICON_EDGE, ICON_EDGE)
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/png' })
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Impossibile salvare l’icona'))), 'image/png'),
  )
}

async function sanitiseAndRasterizeSvg(bytes: Uint8Array, signal?: AbortSignal): Promise<Blob> {
  const source = new TextDecoder().decode(bytes)
  const documentSvg = new DOMParser().parseFromString(source, 'image/svg+xml')
  const root = documentSvg.documentElement
  if (root.localName !== 'svg' || documentSvg.querySelector('parsererror')) throw new Error('SVG Iconify non valido')
  const allowedElements = new Set(['svg', 'g', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse'])
  const allowedAttributes = new Set([
    'xmlns',
    'viewBox',
    'width',
    'height',
    'fill',
    'fill-rule',
    'clip-rule',
    'stroke',
    'stroke-width',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-miterlimit',
    'd',
    'cx',
    'cy',
    'r',
    'rx',
    'ry',
    'x',
    'y',
    'x1',
    'y1',
    'x2',
    'y2',
    'points',
    'transform',
    'opacity',
  ])
  const elements = [root, ...root.querySelectorAll('*')]
  if (elements.length > 200) throw new Error('SVG Iconify troppo complesso')
  for (const element of elements) {
    if (!allowedElements.has(element.localName)) throw new Error('SVG Iconify contiene elementi non ammessi')
    for (const attribute of [...element.attributes]) {
      if (!allowedAttributes.has(attribute.name) || attribute.value.length > 12_000) element.removeAttribute(attribute.name)
    }
  }
  root.setAttribute('width', String(ICON_EDGE))
  root.setAttribute('height', String(ICON_EDGE))
  const safe = new XMLSerializer().serializeToString(documentSvg)
  if (/(?:javascript:|data:|url\s*\()/i.test(safe)) throw new Error('SVG Iconify contiene riferimenti non ammessi')
  if (signal?.aborted) throw new DOMException('Annullato', 'AbortError')
  const blob = new Blob([safe], { type: 'image/svg+xml' })
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob)
  } catch {
    const objectUrl = URL.createObjectURL(blob)
    try {
      const image = new Image()
      image.src = objectUrl
      await image.decode()
      bitmap = await createImageBitmap(image)
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }
  try {
    if (signal?.aborted) throw new DOMException('Annullato', 'AbortError')
    return await canvasPng(bitmap)
  } finally {
    bitmap.close()
  }
}

export async function downloadCollectionIcon(candidate: OnlineCollectionIcon, signal?: AbortSignal): Promise<Blob> {
  const url = iconifyUrl(candidate.id)
  const response = await fetch(url, { signal, mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' })
  const finalUrl = new URL(response.url)
  if (finalUrl.origin !== 'https://api.iconify.design' || !finalUrl.pathname.startsWith('/')) throw new Error('Risposta Iconify da origine non valida')
  return sanitiseAndRasterizeSvg(await boundedBytes(response, 128 * 1024, signal), signal)
}

export function downloadCollectionIconPreview(candidate: OnlineCollectionIcon, signal?: AbortSignal): Promise<Blob> {
  const slot = nextPreviewSlot++ % previewChains.length
  const result = previewChains[slot]!
    .catch(() => undefined)
    .then(() => downloadCollectionIcon(candidate, signal))
  previewChains[slot] = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export async function normalizeCollectionIcon(file: Blob): Promise<Blob> {
  if (file.size > ICON_BYTES) throw new Error('L’icona supera 2 MB')
  const size = await assertSafeEncodedImage(file)
  if (size.w * size.h > ICON_PIXELS) throw new Error('L’icona ha una risoluzione eccessiva')
  const { bitmap, size: decodedSize } = await decodeImage(file)
  try {
    if (decodedSize.w * decodedSize.h > ICON_PIXELS) throw new Error('L’icona ha una risoluzione eccessiva')
    const scale = Math.min(ICON_EDGE / bitmap.width, ICON_EDGE / bitmap.height)
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    if (w === ICON_EDGE && h === ICON_EDGE) return canvasPng(bitmap)
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(ICON_EDGE, ICON_EDGE)
        : Object.assign(document.createElement('canvas'), { width: ICON_EDGE, height: ICON_EDGE })
    const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
    if (!context) throw new Error('Canvas non disponibile')
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
