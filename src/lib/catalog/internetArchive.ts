import { CatalogError } from './webCatalog'

/**
 * Internet Archive (archive.org) as a catalogue: a non-profit digital library with public JSON
 * APIs that send CORS headers, so the app can search it, read an item's file list and download a
 * comic file, all from the browser. Items are downloaded as they are (CBZ, CBR or PDF) and go
 * through the normal import: no repackaging.
 *
 *   search   https://archive.org/advancedsearch.php?q=…&output=json
 *   item     https://archive.org/metadata/<identifier>
 *   cover    https://archive.org/services/img/<identifier>
 *   file     https://archive.org/cors/<identifier>/<file>   (the documented CORS endpoint for files)
 *
 * The library mixes public-domain and freely licensed works with user uploads of copyrighted
 * books, which it takes down on request. The shelves offered by default are curated sets of the
 * first kind; free-text search covers the whole library, like archive.org's own search.
 */

export const ARCHIVE_ORIGIN = 'https://archive.org'
export const ARCHIVE_CATALOG_ID = 'archive.org'
export const ARCHIVE_CATALOG_NAME = 'Internet Archive'

/** Formats the reader opens, as archive.org labels them. */
const COMIC_FORMATS = ['Comic Book ZIP', 'Comic Book RAR', 'Text PDF', 'Image Container PDF']
const FORMAT_CLAUSE = `(${COMIC_FORMATS.map((f) => `format:"${f}"`).join(' OR ')})`
/** Every query: texts (not video, audio, software) that carry at least one comic file. */
const BASE_CLAUSE = `mediatype:texts AND ${FORMAT_CLAUSE}`

export interface ArchiveShelf {
  id: string
  label: string
  description: string
  /** Lucene clause selecting the shelf's items. */
  query: string
}

export const ARCHIVE_SHELVES: readonly ArchiveShelf[] = [
  {
    id: 'classics',
    label: 'Classici',
    description: 'Fumetti americani della Golden Age donati alla biblioteca, in gran parte di pubblico dominio.',
    query: 'collection:classiccomics',
  },
  {
    id: 'webcomics',
    label: 'Webcomic',
    description: 'Raccolta di fumetti pubblicati con licenza libera (Ace Comics e altri).',
    query: 'collection:webcomicuniverse',
  },
  {
    id: 'publicdomain',
    label: 'Pubblico dominio',
    description: 'Fumetti con una licenza dichiarata o anteriori al 1930, quindi di pubblico dominio negli Stati Uniti.',
    query: 'collection:comics AND (licenseurl:* OR date:[1800-01-01 TO 1929-12-31])',
  },
]

export const ARCHIVE_PAGE_SIZE = 40
/** Files beyond this are downloaded with Safari and imported by hand: the download lives in memory until imported. */
export const ARCHIVE_MAX_FILE_BYTES = 512 * 1024 * 1024

export type ArchiveFileKind = 'cbz' | 'cbr' | 'pdf'

export interface ArchiveItemSummary {
  identifier: string
  title: string
  creator?: string
  year?: number
  downloads: number
  /** Licence URL when the uploader declared one (Creative Commons, public domain mark). */
  licenseUrl?: string
  /** Comic formats the item carries, as archive.org labels them. */
  formats: string[]
  url: string
}

export interface ArchiveFile {
  name: string
  kind: ArchiveFileKind
  /** archive.org's label ("Comic Book ZIP", "Text PDF", …). */
  format: string
  size: number
  /** Scanned original, or a version archive.org derived from it (a PDF built from the page images). */
  source: 'original' | 'derivative'
}

export interface ArchiveItem extends ArchiveItemSummary {
  description?: string
  subjects: string[]
  files: ArchiveFile[]
}

export interface ArchiveSearchResult {
  items: ArchiveItemSummary[]
  total: number
  page: number
}

/** The words of a search, specials stripped (they are Lucene syntax on archive.org). */
export function searchWords(text: string): string[] {
  return text
    .replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
    .slice(0, 12)
}

/** User text as a Lucene clause: every word required. Empty text → undefined. */
export function searchClause(text: string): string | undefined {
  const words = searchWords(text)
  if (words.length === 0) return undefined
  return `(${words.join(' AND ')})`
}

/**
 * archive.org's relevance ranking is poor for this use (a children's book with three downloads
 * outranks the comic everybody reads), so results come sorted by downloads and the items whose
 * title carries every word of the search go first.
 */
export function rankSearchResults(items: readonly ArchiveItemSummary[], text: string): ArchiveItemSummary[] {
  const words = searchWords(text).map((w) => w.toLocaleLowerCase())
  if (words.length === 0) return [...items]
  const inTitle = (item: ArchiveItemSummary) => {
    const title = item.title.toLocaleLowerCase()
    return words.every((w) => title.includes(w))
  }
  return [...items].sort((a, b) => Number(inTitle(b)) - Number(inTitle(a)) || b.downloads - a.downloads)
}

export function buildQuery(options: { text?: string; shelf?: ArchiveShelf }): string {
  const clauses = [BASE_CLAUSE]
  if (options.shelf) clauses.push(options.shelf.query)
  const text = options.text !== undefined ? searchClause(options.text) : undefined
  if (text) clauses.unshift(text)
  return clauses.join(' AND ')
}

export function searchUrl(query: string, page: number, sort: 'relevance' | 'downloads'): string {
  const params = new URLSearchParams()
  params.set('q', query)
  for (const f of ['identifier', 'title', 'creator', 'date', 'year', 'downloads', 'licenseurl', 'format']) params.append('fl[]', f)
  if (sort === 'downloads') params.append('sort[]', 'downloads desc')
  params.set('rows', String(ARCHIVE_PAGE_SIZE))
  params.set('page', String(page))
  params.set('output', 'json')
  return `${ARCHIVE_ORIGIN}/advancedsearch.php?${params.toString()}`
}

export const itemUrl = (identifier: string) => `${ARCHIVE_ORIGIN}/metadata/${encodeURIComponent(identifier)}`
export const itemPageUrl = (identifier: string) => `${ARCHIVE_ORIGIN}/details/${encodeURIComponent(identifier)}`
export const coverUrl = (identifier: string) => `${ARCHIVE_ORIGIN}/services/img/${encodeURIComponent(identifier)}`
export const fileUrl = (identifier: string, name: string) => `${ARCHIVE_ORIGIN}/cors/${encodeURIComponent(identifier)}/${name.split('/').map(encodeURIComponent).join('/')}`

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v)
const text = (v: unknown, max = 300): string | undefined => {
  const s = first(v)
  return typeof s === 'string' && s.trim() ? s.trim().slice(0, max) : undefined
}
const number = (v: unknown): number => {
  const n = Number(first(v))
  return Number.isFinite(n) ? n : 0
}
const yearOf = (date: unknown, year: unknown): number | undefined => {
  const y = Number(first(year))
  if (Number.isInteger(y) && y > 1000) return y
  const m = /^(\d{4})/.exec(String(first(date) ?? ''))
  return m ? Number(m[1]) : undefined
}
const list = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map((x) => String(x))

function summaryOf(doc: Record<string, unknown>): ArchiveItemSummary | null {
  const identifier = text(doc.identifier, 200)
  if (!identifier) return null
  const formats = list(doc.format).filter((f) => COMIC_FORMATS.includes(f))
  return {
    identifier,
    title: text(doc.title, 200) ?? identifier,
    creator: text(doc.creator, 120),
    year: yearOf(doc.date, doc.year),
    downloads: number(doc.downloads),
    licenseUrl: text(doc.licenseurl, 300),
    formats,
    url: itemPageUrl(identifier),
  }
}

export function parseSearchResponse(json: unknown, page: number): ArchiveSearchResult {
  const response = (json as { response?: { docs?: unknown[]; numFound?: number } })?.response
  if (!response || !Array.isArray(response.docs)) throw new CatalogError('Risposta della ricerca non valida.')
  const items = response.docs.map((d) => (d && typeof d === 'object' ? summaryOf(d as Record<string, unknown>) : null)).filter((d): d is ArchiveItemSummary => !!d)
  return { items, total: Number(response.numFound) || items.length, page }
}

const kindOf = (name: string): ArchiveFileKind | null => {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return ext === 'cbz' || ext === 'cbr' || ext === 'pdf' ? ext : null
}

/** Plain text of archive.org's HTML descriptions. */
export function plainDescription(html: unknown, max = 600): string | undefined {
  const s = first(html)
  if (typeof s !== 'string') return undefined
  const plain = s
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, '’')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!plain) return undefined
  return plain.length > max ? `${plain.slice(0, max).replace(/\s+\S*$/, '')}…` : plain
}

export function parseItem(json: unknown): ArchiveItem {
  const data = json as { metadata?: Record<string, unknown>; files?: unknown[] }
  if (!data?.metadata || !Array.isArray(data.files)) throw new CatalogError('Elemento non trovato su archive.org.')
  const summary = summaryOf(data.metadata)
  if (!summary) throw new CatalogError('Elemento non valido.')
  const files: ArchiveFile[] = []
  for (const raw of data.files) {
    if (!raw || typeof raw !== 'object') continue
    const f = raw as Record<string, unknown>
    const name = typeof f.name === 'string' ? f.name : ''
    const kind = kindOf(name)
    const format = typeof f.format === 'string' ? f.format : ''
    // OCR-only text PDFs carry no page images; everything else the reader can open stays.
    if (!kind || format === 'Additional Text PDF') continue
    files.push({ name, kind, format: format || kind.toUpperCase(), size: number(f.size), source: f.source === 'derivative' ? 'derivative' : 'original' })
  }
  // Originals first (the scans), then archive.org's derivatives; natural order within each group.
  const collator = new Intl.Collator('it', { numeric: true, sensitivity: 'base' })
  files.sort((a, b) => (a.source === b.source ? collator.compare(a.name, b.name) : a.source === 'original' ? -1 : 1))
  const formats = [...new Set(files.map((f) => f.format))]
  return { ...summary, formats, description: plainDescription(data.metadata.description), subjects: list(data.metadata.subject).slice(0, 12), files }
}

/** Short licence label from the URL archive.org stores ("CC BY 3.0", "Pubblico dominio"). */
export function licenseLabel(url: string | undefined): string | undefined {
  if (!url) return undefined
  const m = /creativecommons\.org\/(licenses|publicdomain)\/([a-z-]+)\/?([\d.]+)?/i.exec(url)
  if (!m) return 'Licenza dichiarata'
  if (m[1] === 'publicdomain') return m[2] === 'zero' ? 'CC0 · pubblico dominio' : 'Pubblico dominio'
  return `CC ${m[2]!.toUpperCase()}${m[3] ? ` ${m[3]}` : ''}`
}

export function formatBadge(kind: ArchiveFileKind): string {
  return kind.toUpperCase()
}

const browserLikeInit = (signal?: AbortSignal): RequestInit => ({ mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal })

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { ...browserLikeInit(signal), headers: { accept: 'application/json' } })
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') throw e
    throw new CatalogError('archive.org non risponde. Controlla la connessione.')
  }
  if (!response.ok) throw new CatalogError(`archive.org risponde ${response.status}.`)
  try {
    return await response.json()
  } catch {
    throw new CatalogError('Risposta di archive.org non valida.')
  }
}

export async function searchArchive(options: { text?: string; shelf?: ArchiveShelf; page?: number }, signal?: AbortSignal): Promise<ArchiveSearchResult> {
  const page = Math.max(1, options.page ?? 1)
  const query = buildQuery(options)
  const result = parseSearchResponse(await fetchJson(searchUrl(query, page, 'downloads'), signal), page)
  return options.text ? { ...result, items: rankSearchResults(result.items, options.text) } : result
}

export async function loadArchiveItem(identifier: string, signal?: AbortSignal): Promise<ArchiveItem> {
  const item = parseItem(await fetchJson(itemUrl(identifier), signal))
  if (item.files.length === 0) throw new CatalogError('Questo elemento non contiene file CBZ, CBR o PDF.')
  return item
}

export interface ArchiveDownloadProgress {
  bytes: number
  total: number
}

/** A safe file name for the library: the item's title for a single-file item, else the file's own name. */
export function downloadFileName(item: ArchiveItem, file: ArchiveFile): string {
  if (item.files.length > 1) return file.name.split('/').pop() || file.name
  const safe = item.title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
  return `${safe || item.identifier}.${file.kind}`
}

/** Downloads one file whole through the CORS endpoint, reporting bytes as they arrive. */
export async function downloadArchiveFile(item: ArchiveItem, file: ArchiveFile, onProgress: (p: ArchiveDownloadProgress) => void, signal?: AbortSignal): Promise<File> {
  if (file.size > ARCHIVE_MAX_FILE_BYTES) {
    throw new CatalogError(`File troppo grande per il download dall’app (${Math.round(file.size / 1048576)} MB): scaricalo con Safari e importalo dalla libreria.`)
  }
  let response: Response
  try {
    response = await fetch(fileUrl(item.identifier, file.name), browserLikeInit(signal))
  } catch (e) {
    if ((e as DOMException)?.name === 'AbortError') throw e
    throw new CatalogError('Il download non parte. Controlla la connessione.')
  }
  if (!response.ok) throw new CatalogError(`archive.org risponde ${response.status} per questo file.`)
  const total = Number(response.headers.get('content-length') ?? 0) || file.size
  if (total > ARCHIVE_MAX_FILE_BYTES) throw new CatalogError('File troppo grande per il download dall’app.')
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  onProgress({ bytes, total })
  if (!reader) {
    const buffer = await response.arrayBuffer()
    chunks.push(new Uint8Array(buffer))
    bytes = buffer.byteLength
  } else {
    let lastReport = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      bytes += value.byteLength
      if (bytes > ARCHIVE_MAX_FILE_BYTES) {
        await reader.cancel()
        throw new CatalogError('File troppo grande per il download dall’app.')
      }
      const now = performance.now()
      if (now - lastReport > 100) {
        lastReport = now
        onProgress({ bytes, total: Math.max(total, bytes) })
      }
    }
  }
  onProgress({ bytes, total: Math.max(total, bytes) })
  if (bytes === 0) throw new CatalogError('Il file scaricato è vuoto.')
  const type = file.kind === 'pdf' ? 'application/pdf' : file.kind === 'cbr' ? 'application/vnd.rar' : 'application/vnd.comicbook+zip'
  return new File(chunks as BlobPart[], downloadFileName(item, file), { type })
}
