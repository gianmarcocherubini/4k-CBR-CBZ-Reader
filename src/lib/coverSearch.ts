import { assertSafeEncodedImage } from './imageDimensions'
import { makeThumbnail } from './storage/thumbnail'

export interface CoverCandidate {
  id: string
  title: string
  author?: string
  year?: number
  imageUrl: string
  previewUrl: string
  source: 'Open Library' | 'AniList'
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
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new Error('Risposta online troppo grande')
  }
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

async function readJson(url: URL, source: string, signal?: AbortSignal, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal, mode: 'cors', referrerPolicy: 'no-referrer' })
  if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`)
  const bytes = await readBounded(response, 1024 * 1024, signal)
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

const words = (value: string) =>
  value
    .toLocaleLowerCase('en')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word && word !== 'volume' && word !== 'vol')

function relevantTitle(query: string, title: string): boolean {
  const expected = words(query)
  const actual = new Set(words(title))
  const textWords = expected.filter((word) => !/^\d+(?:\.\d+)?$/.test(word))
  const numbers = expected.filter((word) => /^\d+(?:\.\d+)?$/.test(word))
  return textWords.filter((word) => actual.has(word)).length >= Math.max(1, Math.ceil(textWords.length * 0.7)) && numbers.every((number) => actual.has(number))
}

function proxiedOpenLibraryCover(coverId: number, size: 'M' | 'L', width: number): string {
  const source = new URL(`https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg`)
  source.searchParams.set('default', 'false')
  const proxy = new URL('https://images.weserv.nl/')
  // Full HTTPS URL is intentional; stripping the scheme makes weserv use HTTP upstream.
  proxy.searchParams.set('url', source.href)
  proxy.searchParams.set('w', String(width))
  proxy.searchParams.set('fit', 'contain')
  proxy.searchParams.set('output', 'jpg')
  return proxy.href
}

async function searchOpenLibrary(cleaned: string, signal?: AbortSignal): Promise<CoverCandidate[]> {
  const url = new URL('https://openlibrary.org/search.json')
  // The general query understands volume numbers ("One Piece Volume 46"); `title=` often returns
  // zero for the same string because the catalogue title is "ONE PIECE 46".
  url.searchParams.set('q', cleaned)
  url.searchParams.set('limit', '12')
  url.searchParams.set('fields', 'key,title,author_name,first_publish_year,cover_i')
  const data = await readJson(url, 'Open Library', signal)
  if (!data || typeof data !== 'object' || !Array.isArray((data as { docs?: unknown }).docs)) throw new Error('Risposta Open Library non valida')
  const seen = new Set<number>()
  const results: CoverCandidate[] = []
  for (const value of (data as { docs: unknown[] }).docs.slice(0, 24)) {
    if (!value || typeof value !== 'object') continue
    const doc = value as Record<string, unknown>
    const coverId = doc.cover_i
    const title = doc.title
    if (
      !Number.isSafeInteger(coverId) ||
      (coverId as number) <= 0 ||
      typeof title !== 'string' ||
      !title.trim() ||
      title.length > 300 ||
      !relevantTitle(cleaned, title) ||
      seen.has(coverId as number)
    ) {
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
      imageUrl: proxiedOpenLibraryCover(coverId as number, 'L', 960),
      previewUrl: proxiedOpenLibraryCover(coverId as number, 'M', 320),
      source: 'Open Library',
    })
    if (results.length === 5) break
  }
  return results
}

function mangaQuery(title: string): { series: string; volume?: string } {
  const match = /\b(?:vol(?:ume)?\.?\s*)(\d+(?:\.\d+)?)/i.exec(title)
  return {
    series: title.replace(/\b(?:vol(?:ume)?\.?\s*)\d+(?:\.\d+)?/gi, ' ').replace(/\s+/g, ' ').trim(),
    volume: match?.[1],
  }
}

async function searchAniList(cleaned: string, signal?: AbortSignal): Promise<CoverCandidate[]> {
  const query = mangaQuery(cleaned)
  if (!query.series) return []
  const graphql = new URL('https://graphql.anilist.co')
  const payload = JSON.stringify({
    query:
      'query ($search: String) { Page(perPage: 8) { media(search: $search, type: MANGA, isAdult: false) { id title { romaji english native } coverImage { extraLarge large medium } startDate { year } } } }',
    variables: { search: query.series },
  })
  const data = await readJson(graphql, 'AniList', signal, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  })
  if (!data || typeof data !== 'object') return []
  const root = (data as Record<string, unknown>).data
  if (!root || typeof root !== 'object') return []
  const page = (root as Record<string, unknown>).Page
  if (!page || typeof page !== 'object' || !Array.isArray((page as Record<string, unknown>).media)) return []
  const results: CoverCandidate[] = []
  for (const value of ((page as Record<string, unknown>).media as unknown[]).slice(0, 8)) {
    if (!value || typeof value !== 'object') continue
    const item = value as Record<string, unknown>
    if (!Number.isSafeInteger(item.id) || !item.title || typeof item.title !== 'object' || !item.coverImage || typeof item.coverImage !== 'object') continue
    const title = ['english', 'romaji', 'native']
      .map((key) => (item.title as Record<string, unknown>)[key])
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 300)
    const images = item.coverImage as Record<string, unknown>
    const large = images.extraLarge ?? images.large
    const preview = images.large ?? images.medium
    if (!title || typeof large !== 'string' || typeof preview !== 'string') continue
    let imageUrl: URL
    let previewUrl: URL
    try {
      imageUrl = new URL(large)
      previewUrl = new URL(preview)
    } catch {
      continue
    }
    if (
      imageUrl.protocol !== 'https:' ||
      previewUrl.protocol !== 'https:' ||
      imageUrl.hostname !== 's4.anilist.co' ||
      previewUrl.hostname !== 's4.anilist.co' ||
      !imageUrl.pathname.startsWith('/file/anilistcdn/media/manga/cover/') ||
      !previewUrl.pathname.startsWith('/file/anilistcdn/media/manga/cover/')
    ) {
      continue
    }
    const startDate = item.startDate
    const year =
      startDate && typeof startDate === 'object' && Number.isSafeInteger((startDate as Record<string, unknown>).year)
        ? ((startDate as Record<string, unknown>).year as number)
        : undefined
    results.push({
      id: `anilist:${item.id}`,
      title: `${title}${query.volume ? ` · serie (ricerca Vol. ${query.volume})` : ''}`,
      year,
      imageUrl: imageUrl.href,
      previewUrl: previewUrl.href,
      source: 'AniList',
    })
  }
  return results
}

export async function searchCovers(query: string, signal?: AbortSignal): Promise<CoverCandidate[]> {
  const cleaned = coverQueryFromTitle(query)
  if (!cleaned) return []
  const [openLibrary, aniList] = await Promise.allSettled([searchOpenLibrary(cleaned, signal), searchAniList(cleaned, signal)])
  if (signal?.aborted) throw new DOMException('Annullato', 'AbortError')
  if (openLibrary.status === 'rejected' && aniList.status === 'rejected') {
    throw new Error(`${String((openLibrary.reason as Error)?.message ?? openLibrary.reason)}; ${String((aniList.reason as Error)?.message ?? aniList.reason)}`)
  }
  const combined = [
    ...(openLibrary.status === 'fulfilled' ? openLibrary.value.slice(0, 5) : []),
    ...(aniList.status === 'fulfilled' ? aniList.value.slice(0, 3) : []),
  ]
  const seen = new Set<string>()
  return combined.filter((candidate) => {
    const key = `${candidate.source}:${candidate.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function downloadAndNormalise(url: string, maxBytes: number, maxPixels: number, width: number, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { signal, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' })
  if (!response.ok) throw new Error(`Copertina: HTTP ${response.status}`)
  const final = new URL(response.url)
  if (!['https://images.weserv.nl', 'https://s4.anilist.co'].includes(final.origin)) throw new Error('Copertina da origine non autorizzata')
  const bytes = await readBounded(response, maxBytes, signal)
  const type = response.headers.get('content-type')?.split(';')[0] ?? ''
  if (type && !type.startsWith('image/')) throw new Error('Risposta non valida')
  const source = new Blob([bytes.buffer as ArrayBuffer], { type })
  const size = await assertSafeEncodedImage(source)
  if (size.w * size.h > maxPixels) throw new Error('Copertina con risoluzione eccessiva')
  const normalized = await makeThumbnail(source, width)
  if (normalized.size.w * normalized.size.h > maxPixels) throw new Error('Copertina con risoluzione eccessiva')
  if (signal?.aborted) throw new DOMException('Annullato', 'AbortError')
  return normalized.thumb
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
