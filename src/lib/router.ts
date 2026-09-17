export type Route = { view: 'library' } | { view: 'reader'; bookId: string }

export function parseRoute(hash: string): Route {
  const m = /^#\/read\/(.+)$/.exec(hash)
  if (m?.[1]) return { view: 'reader', bookId: decodeURIComponent(m[1]) }
  return { view: 'library' }
}

export function navigateTo(route: Route): void {
  location.hash = route.view === 'reader' ? `#/read/${encodeURIComponent(route.bookId)}` : '#/'
}
