import { type ArchiveEntry, isImageEntry, pageEntries } from '../entries'
import type { ArchiveReader } from './types'

/**
 * Fixed-layout EPUB (digital manga is often sold this way): a ZIP whose reading order is the OPF
 * spine, each spine item an XHTML page that shows one image. The pages of the book are those
 * images, in spine order; XHTML pages without an image (title, colophon, text) are skipped. When
 * the package cannot be read, the image entries in natural order are used instead.
 */

const MAX_XML_BYTES = 4 * 1024 * 1024
const MAX_PAGE_XHTML_BYTES = 2 * 1024 * 1024

export function isEpub(entries: readonly ArchiveEntry[]): boolean {
  return entries.some((e) => e.name === 'mimetype') && entries.some((e) => e.name === 'META-INF/container.xml')
}

const decodeEntities = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`(?:^|\\s)(?:[a-zA-Z]+:)?${name}\\s*=\\s*"([^"]*)"`).exec(tag) ?? new RegExp(`(?:^|\\s)(?:[a-zA-Z]+:)?${name}\\s*=\\s*'([^']*)'`).exec(tag)
  return m ? decodeEntities(m[1]!) : undefined
}

/** Resolves `href` against the directory of `from`, both paths inside the ZIP. */
export function resolveZipPath(from: string, href: string): string {
  const clean = decodeURIComponent(href.split('#')[0]!.split('?')[0]!)
  const base = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : ''
  const parts = (clean.startsWith('/') ? clean.slice(1) : base + clean).split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') out.pop()
    else if (part !== '.' && part !== '') out.push(part)
  }
  return out.join('/')
}

export function parseContainer(xml: string): string | undefined {
  const rootfile = /<rootfile\b[^>]*>/i.exec(xml)?.[0]
  return rootfile ? attr(rootfile, 'full-path') : undefined
}

export interface OpfPackage {
  /** Spine items in reading order: path inside the ZIP and media type. */
  spine: Array<{ path: string; mediaType: string }>
}

export function parseOpf(xml: string, opfPath: string): OpfPackage {
  const manifest = new Map<string, { path: string; mediaType: string }>()
  for (const [tag] of xml.matchAll(/<item\b[^>]*>/gi)) {
    const id = attr(tag, 'id')
    const href = attr(tag, 'href')
    if (!id || !href) continue
    manifest.set(id, { path: resolveZipPath(opfPath, href), mediaType: attr(tag, 'media-type') ?? '' })
  }
  const spine: OpfPackage['spine'] = []
  const spineXml = /<spine\b[^>]*>([\s\S]*?)<\/spine>/i.exec(xml)?.[1] ?? ''
  for (const [tag] of spineXml.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = attr(tag, 'idref')
    const item = idref ? manifest.get(idref) : undefined
    if (item && attr(tag, 'linear') !== 'no') spine.push(item)
  }
  return { spine }
}

/** Images referenced by a page: <img src>, SVG <image href|xlink:href>, in document order. */
export function pageImages(xhtml: string, pagePath: string): string[] {
  const out: string[] = []
  for (const [tag] of xhtml.matchAll(/<(?:img|image)\b[^>]*>/gi)) {
    const ref = attr(tag, 'src') ?? attr(tag, 'href')
    if (ref && !ref.startsWith('data:')) out.push(resolveZipPath(pagePath, ref))
  }
  return out
}

async function readText(reader: ArchiveReader, name: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const blob = await reader.extract(name, signal)
  if (blob.size > maxBytes) throw new Error(`${name}: troppo grande`)
  return new TextDecoder().decode(await blob.arrayBuffer())
}

/** The pages of an EPUB in spine order; falls back to all image entries when the package is unreadable. */
export async function epubPages(reader: ArchiveReader, entries: readonly ArchiveEntry[], signal?: AbortSignal): Promise<ArchiveEntry[]> {
  const byName = new Map(entries.filter((e) => !e.directory).map((e) => [e.name, e]))
  const fallback = () => pageEntries([...entries])
  let spine: OpfPackage['spine']
  try {
    const opfPath = parseContainer(await readText(reader, 'META-INF/container.xml', MAX_XML_BYTES, signal))
    if (!opfPath || !byName.has(opfPath)) return fallback()
    spine = parseOpf(await readText(reader, opfPath, MAX_XML_BYTES, signal), opfPath).spine
  } catch {
    return fallback()
  }
  const pages: ArchiveEntry[] = []
  const seen = new Set<string>()
  for (const item of spine) {
    const entry = byName.get(item.path)
    if (!entry) continue
    // A spine item may itself be an image (rare), or an XHTML page that shows one.
    if (isImageEntry(entry)) {
      if (!seen.has(entry.name)) pages.push(entry)
      seen.add(entry.name)
      continue
    }
    if (!/xhtml|html|xml/i.test(item.mediaType) && !/\.x?html?$/i.test(item.path)) continue
    let refs: string[]
    try {
      refs = pageImages(await readText(reader, item.path, MAX_PAGE_XHTML_BYTES, signal), item.path)
    } catch {
      continue
    }
    for (const ref of refs) {
      const image = byName.get(ref)
      if (image && isImageEntry(image) && !seen.has(image.name)) {
        pages.push(image)
        seen.add(image.name)
      }
    }
  }
  return pages.length > 0 ? pages : fallback()
}
