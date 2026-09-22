import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js'
import { assertSafeEncodedImage } from '../imageDimensions'

/**
 * Web catalogues: sites that publish series as chapters (or volumes) made of page images, the
 * way a browser sees them. Mangadana reads a catalogue's pages exactly as Safari would (same
 * requests, no credentials) and saves the units the reader picks as a CBZ in the library. The
 * site is configured by the user (an origin); nothing is hard-wired here. Fetches are bounded and
 * sequential: one page of the site at a time, a few images at a time, at most a handful of
 * units per download, so the app behaves like a reader, not like a crawler.
 */

export interface SeriesSummary {
  /** Path segment that identifies the series on the site (e.g. "one-piece"). */
  slug: string
  title: string
  author?: string
  /** One line about the edition: what is in colour, how many chapters. */
  blurb?: string
  /** Absolute URL of the cover image, if the card had one. */
  cover?: string
  url: string
}

export type UnitKind = 'chapter' | 'volume'
export type Edition = 'color' | 'partial' | 'bw' | 'unknown'

export interface UnitSummary {
  kind: UnitKind
  /** Chapter/volume number as written in the URL ("12", "12.5"). */
  number: string
  /** Numeric value of `number`, for ordering and ranges. */
  value: number
  name?: string
  pages?: number
  edition: Edition
  url: string
}

export interface SeriesDetail {
  series: SeriesSummary
  units: UnitSummary[]
}

export class CatalogError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CatalogError'
  }
}

/** Per download: chapters, or volumes (a volume is ten times a chapter). */
export const MAX_CHAPTERS_PER_DOWNLOAD = 10
export const MAX_VOLUMES_PER_DOWNLOAD = 2
const MAX_HTML_BYTES = 6 * 1024 * 1024
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_PAGES_PER_UNIT = 400
const IMAGE_CONCURRENCY = 3
/** Breath between two units of the same download. */
const PAUSE_BETWEEN_UNITS_MS = 600

const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, '’')
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…')
    .replace(/&rarr;/g, '→')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))

/** Text of an HTML fragment: tags become separators, whitespace collapses. */
function textOf(fragment: string): string[] {
  return decodeEntities(fragment.replace(/<[^>]+>/g, '\u0000'))
    .split('\u0000')
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 0)
}

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag) ?? new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i').exec(tag)
  return m ? decodeEntities(m[1]!) : undefined
}

const anchors = (html: string) => [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((m) => ({ tag: m[1]!, inner: m[2]!, href: attr(m[1]!, 'href') }))

/** Normalises what the user typed into an origin ("https://example.org"). */
export function normalizeCatalogUrl(input: string): string {
  let text = input.trim()
  if (!text) throw new CatalogError('Inserisci l’indirizzo del catalogo.')
  if (!/^[a-z]+:\/\//i.test(text)) text = `https://${text}`
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new CatalogError('Indirizzo non valido.')
  }
  if (url.protocol !== 'https:') throw new CatalogError('Il catalogo deve usare https.')
  return url.origin
}

/** Series cards: links to a single path segment that carry an image and a title. */
export function parseSeriesList(html: string, origin: string): SeriesSummary[] {
  const out = new Map<string, SeriesSummary>()
  for (const a of anchors(html)) {
    if (!a.href) continue
    const m = /^(?:https?:\/\/[^/]+)?\/([a-z0-9][a-z0-9-]*)\/?$/i.exec(a.href)
    if (!m) continue
    if (a.href.startsWith('http') && !a.href.startsWith(origin)) continue
    const slug = m[1]!.toLowerCase()
    const img = /<img\b[^>]*>/i.exec(a.inner)?.[0]
    if (!img) continue
    const texts = textOf(a.inner).filter((t) => !/^(read|browse|start|latest|→|·)/i.test(t) && t !== '·')
    const heading = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(a.inner)
    const title = (heading ? textOf(heading[1]!)[0] : undefined) ?? texts[0]
    if (!title) continue
    const rest = texts.filter((t) => t !== title)
    const cover = attr(img, 'src')
    const existing = out.get(slug)
    const summary: SeriesSummary = {
      slug,
      title,
      author: rest[0] && rest[0].length < 60 && !/\d/.test(rest[0]) ? rest[0] : undefined,
      blurb: rest.find((t) => /\d/.test(t) && t.length > 8) ?? rest[1],
      cover: cover ? new URL(cover, origin).href : undefined,
      url: `${origin}/${slug}`,
    }
    // Several cards may point at the same series (hero, grid): keep the most descriptive.
    if (!existing || (summary.blurb && !existing.blurb)) out.set(slug, summary)
  }
  return [...out.values()]
}

function editionOf(texts: string[]): Edition {
  const joined = texts.join(' ').toLowerCase()
  if (/\bpartial/.test(joined)) return 'partial'
  if (/b&w|black\s*&\s*white|black and white|\bbw\b/.test(joined)) return 'bw'
  if (/\bcolou?r/.test(joined)) return 'color'
  return 'unknown'
}

/** Chapters or volumes of a series: links to `/<slug>/chapter/<n>` or `/<slug>/volume/<n>`. */
export function parseUnitList(html: string, series: SeriesSummary): UnitSummary[] {
  const origin = new URL(series.url).origin
  const out = new Map<string, UnitSummary>()
  const pattern = new RegExp(`^(?:https?:\\/\\/[^/]+)?\\/${series.slug}\\/(chapter|volume)\\/(\\d+(?:\\.\\d+)?)\\/?$`, 'i')
  for (const a of anchors(html)) {
    if (!a.href) continue
    const m = pattern.exec(a.href)
    if (!m) continue
    const kind = m[1]!.toLowerCase() as UnitKind
    const number = m[2]!
    const texts = textOf(a.inner)
    // "51" and "pages ·" may be separate nodes: read the count from the joined text.
    const pagesMatch = /(\d+)\s*pages?\b/i.exec(texts.join(' '))
    const pages = pagesMatch ? Number(pagesMatch[1]) : undefined
    const edition = editionOf(texts)
    // "Chapter" "12" "Title" "24" "pages ·" "Arc" "Read →": the name is what is left once labels,
    // numbers, counts, editions and calls to action are removed.
    const candidates = texts.filter(
      (t) =>
        !/^(chapter|volume|ch\.?|vol\.?)$/i.test(t) &&
        !/^\d+(\.\d+)?$/.test(t) &&
        !/pages?\b/i.test(t) &&
        !/^(read|start|latest|browse|open)\b/i.test(t) &&
        !/[→·]$/.test(t) &&
        !/^(partial|full)?\s*colou?r(ed)?$|^b&w$|^black\s*&\s*white$/i.test(t),
    )
    const dedup = candidates.filter((t, i) => candidates.indexOf(t) === i)
    // A volume often starts with the chapters it spans ("Ch. 8–17"): keep it together with its title.
    const name = dedup.length === 0 ? undefined : /^ch\.?\s*\d/i.test(dedup[0]!) && dedup[1] ? `${dedup[0]} · ${dedup[1]}` : dedup[0]
    const unit: UnitSummary = { kind, number, value: Number(number), name, pages, edition, url: `${origin}/${series.slug}/${kind}/${number}` }
    const key = `${kind}:${number}`
    const existing = out.get(key)
    // Navigation shortcuts ("Start · Chapter 1 →") say less than the list entry: keep the richer one.
    const score = (u: UnitSummary) => (u.name ? 1 : 0) + (u.pages ? 1 : 0) + (u.edition !== 'unknown' ? 1 : 0)
    if (!existing || score(unit) > score(existing)) out.set(key, unit)
  }
  return [...out.values()].sort((a, b) => a.value - b.value || a.kind.localeCompare(b.kind))
}

const NOT_A_PAGE = /(logo|icon|favicon|avatar|badge|sprite|\/covers?\/|apple-touch)/i

/** Page images of a unit: absolute-URL <img> inside <main> (or the whole document), in order. */
export function parseUnitPages(html: string, unitUrl: string): string[] {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? html
  const pages: string[] = []
  const seen = new Set<string>()
  for (const [tag] of main.matchAll(/<img\b[^>]*>/gi)) {
    const src = attr(tag, 'src') ?? attr(tag, 'data-src') ?? attr(tag, 'srcset')?.split(',')[0]?.trim().split(/\s+/)[0]
    if (!src || src.startsWith('data:')) continue
    let url: string
    try {
      url = new URL(src, unitUrl).href
    } catch {
      continue
    }
    if (!/^https:/.test(url) || NOT_A_PAGE.test(url) || seen.has(url)) continue
    const w = Number(attr(tag, 'width') ?? 0)
    const h = Number(attr(tag, 'height') ?? 0)
    // Thumbnails and UI images declare small sizes; pages are either large or unsized.
    if ((w && w < 200) || (h && h < 200)) continue
    seen.add(url)
    pages.push(url)
    if (pages.length >= MAX_PAGES_PER_UNIT) break
  }
  return pages
}

async function readBounded(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maxBytes) throw new CatalogError('Risposta troppo grande.')
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array(await response.arrayBuffer())
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    if (signal?.aborted) {
      await reader.cancel()
      throw new DOMException('Annullato', 'AbortError')
    }
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new CatalogError('Risposta troppo grande.')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

const browserLikeInit = (signal?: AbortSignal): RequestInit => ({ mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal })

export async function fetchHtml(url: string, signal?: AbortSignal): Promise<string> {
  let response: Response
  try {
    response = await fetch(url, { ...browserLikeInit(signal), headers: { accept: 'text/html' } })
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') throw e
    throw new CatalogError('Il sito non risponde o non permette la lettura dall’app (CORS).')
  }
  if (!response.ok) throw new CatalogError(`Il sito risponde ${response.status}.`)
  const type = response.headers.get('content-type') ?? ''
  if (type && !/text\/html|application\/xhtml/.test(type)) throw new CatalogError('La pagina non è HTML.')
  return new TextDecoder().decode(await readBounded(response, MAX_HTML_BYTES, signal))
}

export async function loadSeriesList(origin: string, signal?: AbortSignal): Promise<SeriesSummary[]> {
  const list = parseSeriesList(await fetchHtml(`${origin}/`, signal), origin)
  if (list.length === 0) throw new CatalogError('Nessuna serie trovata: il sito non ha la struttura che Mangadana sa leggere.')
  return list
}

export async function loadSeries(series: SeriesSummary, signal?: AbortSignal): Promise<SeriesDetail> {
  const units = parseUnitList(await fetchHtml(series.url, signal), series)
  if (units.length === 0) throw new CatalogError('Nessun capitolo o volume trovato in questa serie.')
  return { series, units }
}

const EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif' }

async function fetchPage(url: string, signal?: AbortSignal): Promise<{ blob: Blob; ext: string }> {
  let response: Response
  try {
    response = await fetch(url, browserLikeInit(signal))
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') throw e
    throw new CatalogError('Una pagina non si scarica (rete o CORS).')
  }
  if (!response.ok) throw new CatalogError(`Pagina non disponibile (${response.status}).`)
  const bytes = await readBounded(response, MAX_IMAGE_BYTES, signal)
  const declared = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: declared.startsWith('image/') ? declared : '' })
  // Sniffs the real format and refuses absurd sizes, whatever the server declared.
  await assertSafeEncodedImage(blob)
  const ext = EXTENSIONS[blob.type] ?? (declared ? 'img' : 'img')
  return { blob, ext }
}

export interface DownloadProgress {
  unitIndex: number
  unitCount: number
  unit: UnitSummary
  page: number
  pageCount: number
  bytes: number
}

const pad = (n: string | number, width = 3) => {
  const [int, frac] = String(n).split('.')
  return frac ? `${int!.padStart(width, '0')}.${frac}` : int!.padStart(width, '0')
}

/** File name of the CBZ: "Series — Cap. 001-010" (natural sort keeps the batches in order). */
export function downloadFileName(series: SeriesSummary, units: readonly UnitSummary[]): string {
  const kind = units[0]!.kind === 'volume' ? 'Vol.' : 'Cap.'
  const first = pad(units[0]!.number)
  const last = pad(units[units.length - 1]!.number)
  const safeTitle = series.title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
  return `${safeTitle} — ${kind} ${first === last ? first : `${first}-${last}`}.cbz`
}

/**
 * Downloads the given units, in order, into one CBZ (stored entries: pages are already compressed
 * images). Pages of a unit go in a folder named after it, so the reader's natural sort keeps the
 * order: "Cap. 001/001.webp".
 */
export async function downloadUnits(
  series: SeriesSummary,
  units: readonly UnitSummary[],
  onProgress: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<File> {
  if (units.length === 0) throw new CatalogError('Scegli almeno un capitolo.')
  const limit = units[0]!.kind === 'volume' ? MAX_VOLUMES_PER_DOWNLOAD : MAX_CHAPTERS_PER_DOWNLOAD
  if (units.length > limit) throw new CatalogError(`Al massimo ${limit} ${units[0]!.kind === 'volume' ? 'volumi' : 'capitoli'} per volta.`)
  const writer = new ZipWriter(new BlobWriter('application/vnd.comicbook+zip'), { level: 0, keepOrder: true })
  let bytes = 0
  let totalPages = 0
  try {
    for (const [unitIndex, unit] of units.entries()) {
      if (signal?.aborted) throw new DOMException('Annullato', 'AbortError')
      if (unitIndex > 0) await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_UNITS_MS))
      const pages = parseUnitPages(await fetchHtml(unit.url, signal), unit.url)
      if (pages.length === 0) throw new CatalogError(`${unit.kind === 'volume' ? 'Volume' : 'Capitolo'} ${unit.number}: nessuna pagina trovata.`)
      const folder = `${unit.kind === 'volume' ? 'Vol.' : 'Cap.'} ${pad(unit.number)}`
      const results = new Array<{ blob: Blob; ext: string }>(pages.length)
      let next = 0
      let done = 0
      const report = () => onProgress({ unitIndex, unitCount: units.length, unit, page: done, pageCount: pages.length, bytes })
      report()
      const worker = async () => {
        for (;;) {
          const i = next++
          if (i >= pages.length) return
          const page = await fetchPage(pages[i]!, signal)
          results[i] = page
          bytes += page.blob.size
          done++
          report()
        }
      }
      await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, pages.length) }, worker))
      for (const [i, page] of results.entries()) {
        await writer.add(`${folder}/${pad(i + 1)}.${page.ext}`, new BlobReader(page.blob), { level: 0 })
      }
      totalPages += pages.length
    }
    const blob = await writer.close()
    if (totalPages === 0) throw new CatalogError('Nessuna pagina scaricata.')
    return new File([blob], downloadFileName(series, units), { type: 'application/vnd.comicbook+zip' })
  } catch (e) {
    await writer.close().catch(() => undefined)
    throw e
  }
}
