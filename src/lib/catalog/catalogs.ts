import { normalizeCatalogUrl } from './webCatalog'

/** A web catalogue the user added: its origin and the name shown in the app. */
export interface Catalog {
  id: string
  name: string
  url: string
  addedAt: number
}

const KEY = 'reader.catalogs.v1'

export function normalizeCatalogs(stored: unknown): Catalog[] {
  if (!Array.isArray(stored)) return []
  const out: Catalog[] = []
  const seen = new Set<string>()
  for (const item of stored) {
    if (!item || typeof item !== 'object') continue
    const { id, name, url, addedAt } = item as Record<string, unknown>
    if (typeof url !== 'string') continue
    let origin: string
    try {
      origin = normalizeCatalogUrl(url)
    } catch {
      continue
    }
    if (seen.has(origin)) continue
    seen.add(origin)
    out.push({
      id: typeof id === 'string' && id ? id : origin,
      name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : new URL(origin).host,
      url: origin,
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
