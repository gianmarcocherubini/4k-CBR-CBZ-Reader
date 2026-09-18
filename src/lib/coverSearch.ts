import { assertSafeEncodedImage } from './imageDimensions'
import { makeThumbnail } from './storage/thumbnail'

export interface CoverCandidate {
  id: string
  title: string
  author?: string
  year?: number
  imageUrl: string
  previewUrl: string
}

const COVER_MAX_PIXELS = 16 * 1024 * 1024
const PREVIEW_MAX_PIXELS = 4 * 1024 * 1024
const previewChains: Array<Promise<unknown>> = [Promise.resolve(), Promise.resolve()]
let nextPreviewSlot = 0

/** Removes release-group noise while retaining series, volume and number. */
export function coverQueryFromTitle(title: string): string {
  return title
    .replace(/\[[^\]]+]/g, ' ')
    .replace(/\b(?:digital\s+colored?\s+comics?|digital|scan|scans|cbr|cbz|zip)\b/gi, ' ')
    .replace(/[_–—-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function readBounded(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Risposta online troppo grande')
  if (!response.body) throw new Error('Risposta online senza contenuto')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Annullato', 'AbortError')
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('Risposta online troppo grande')
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

export async function searchCovers(query: string, signal?: AbortSignal): Promise<CoverCandidate[]> {
  const cleaned = coverQueryFromTitle(query)
  if (!cleaned) return []
  const url = new URL('https://openlibrary.org/search.json')
  // The general query understands volume numbers ("One Piece Volume 46"); `title=` often returns
  // zero for the same string because the catalogue title is "ONE PIECE 46".
  url.searchParams.set('q', cleaned)
  url.searchParams.set('limit', '12')
  url.searchParams.set('fields', 'key,title,author_name,first_publish_year,cover_i')
  const response = await fetch(url, { signal, mode: 'cors', referrerPolicy: 'no-referrer' })
  if (!response.ok) throw new Error(`Open Library: HTTP ${response.status}`)
  const bytes = await readBounded(response, 1024 * 1024, signal)
  const data = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  if (!data || typeof data !== 'object' || !Array.isArray((data as { docs?: unknown }).docs)) throw new Error('Risposta Open Library non valida')
  const seen = new Set<number>()
  const results: CoverCandidate[] = []
  for (const value of (data as { docs: unknown[] }).docs.slice(0, 24)) {
    if (!value || typeof value !== 'object') continue
    const doc = value as Record<string, unknown>
    const coverId = doc.cover_i
    const title = doc.title
    if (!Number.isSafeInteger(coverId) || (coverId as number) <= 0 || typeof title !== 'string' || !title.trim() || title.length > 300 || seen.has(coverId as number)) {
      continue
    }
    const authors = Array.isArray(doc.author_name)
      ? doc.author_name.filter((author): author is string => typeof author === 'string' && author.length <= 200).slice(0, 2)
      : []
    const year = Number.isSafeInteger(doc.first_publish_year) ? (doc.first_publish_year as number) : undefined
    const key = typeof doc.key === 'string' && doc.key.length <= 300 ? doc.key : String(coverId)
    seen.add(coverId as number)
    results.push({
      id: key,
      title: title.trim(),
      author: authors.length ? authors.join(', ') : undefined,
      year,
      imageUrl: `https://covers.openlibrary.org/b/id/${coverId}-L.jpg`,
      previewUrl: `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`,
    })
    if (results.length === 8) break
  }
  return results
}

async function downloadAndNormalise(url: string, maxBytes: number, maxPixels: number, width: number, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { signal, mode: 'cors', referrerPolicy: 'no-referrer' })
  if (!response.ok) throw new Error(`Copertina: HTTP ${response.status}`)
  const bytes = await readBounded(response, maxBytes, signal)
  const type = response.headers.get('content-type')?.split(';')[0] ?? ''
  if (type && !type.startsWith('image/')) throw new Error('Risposta non valida')
  const source = new Blob([bytes.buffer as ArrayBuffer], { type })
  const size = await assertSafeEncodedImage(source)
  if (size.w * size.h > maxPixels) throw new Error('Copertina con risoluzione eccessiva')
  const thumb = (await makeThumbnail(source, width)).thumb
  if (signal?.aborted) throw new DOMException('Annullato', 'AbortError')
  return thumb
}

/** Downloads, validates and normalises a selected remote cover into a compact local JPEG. */
export function downloadCover(candidate: CoverCandidate, signal?: AbortSignal): Promise<Blob> {
  return downloadAndNormalise(candidate.imageUrl, 12 * 1024 * 1024, COVER_MAX_PIXELS, 640, signal)
}

/** Safe local Blob used by previews instead of pointing <img> at an unbounded remote response. */
export function downloadCoverPreview(candidate: CoverCandidate, signal?: AbortSignal): Promise<Blob> {
  const slot = nextPreviewSlot++ % previewChains.length
  const result = previewChains[slot]!
    .catch(() => undefined)
    .then(() => downloadAndNormalise(candidate.previewUrl, 2 * 1024 * 1024, PREVIEW_MAX_PIXELS, 320, signal))
  previewChains[slot] = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}
