import { ARCHIVE_CATALOG_ID, ARCHIVE_CATALOG_NAME, ARCHIVE_ORIGIN } from './internetArchive'
import { normalizeCatalogUrl } from './webCatalog'

/** site = a web site read the way Safari would (generic parser); archive = Internet Archive through its APIs. */
export type CatalogKind = 'site' | 'archive'

/** A catalogue the user added: its origin and the name shown in the app. */
export interface Catalog {
  id: string
  name: string
  url: string
  kind: CatalogKind
  addedAt: number
}

/** The Internet Archive entry, offered in the catalogue list until it is added. */
export const ARCHIVE_CATALOG: Omit<Catalog, 'addedAt'> = { id: ARCHIVE_CATALOG_ID, name: ARCHIVE_CATALOG_NAME, url: ARCHIVE_ORIGIN, kind: 'archive' }

const KEY = 'reader.catalogs.v1'

export function normalizeCatalogs(stored: unknown): Catalog[] {
  if (!Array.isArray(stored)) return []
  const out: Catalog[] = []
  const seen = new Set<string>()
  for (const item of stored) {
    if (!item || typeof item !== 'object') continue
    const { id, name, url, kind, addedAt } = item as Record<string, unknown>
    if (typeof url !== 'string') continue
    let origin: string
    try {
      origin = normalizeCatalogUrl(url)
    } catch {
      continue
    }
    if (seen.has(origin)) continue
    seen.add(origin)
    const archive = kind === 'archive' || origin === ARCHIVE_ORIGIN
    out.push({
      id: archive ? ARCHIVE_CATALOG_ID : typeof id === 'string' && id ? id : origin,
      name: archive ? ARCHIVE_CATALOG_NAME : typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : new URL(origin).host,
      url: origin,
      kind: archive ? 'archive' : 'site',
      addedAt: typeof addedAt === 'number' && Number.isFinite(addedAt) ? addedAt : 0,
    })
  }
  return out
}

export function loadCatalogs(): Catalog[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? normalizeCatalogs(JSON.parse(raw)) : []
  } catch {
    return []
  }
}

export function saveCatalogs(catalogs: readonly Catalog[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(catalogs))
  } catch {
    // Private mode / quota: the list just does not persist.
  }
}

/** Display name of a site: its host without "www." ("manga.example"). */
export function catalogNameFor(origin: string): string {
  return new URL(origin).host.replace(/^www\./, '')
}
