import { useCallback, useEffect, useState } from 'react'
import { Library } from './components/Library'
import { Reader } from './components/reader/Reader'
import { navigateTo, parseRoute, type Route } from './lib/router'
import { useSettings } from './lib/settings'
import type { Book } from './types'

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash))
  const [settings, updateSettings] = useSettings()
  /** Books opened with "Apri senza importare": not in IndexedDB, alive for this tab only. */
  const [sessionBooks, setSessionBooks] = useState<Map<string, Book>>(() => new Map())

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Appearance: "system" leaves it to prefers-color-scheme; light/dark force it (see index.css).
  useEffect(() => {
    const root = document.documentElement
    if (settings.theme === 'system') delete root.dataset.theme
    else root.dataset.theme = settings.theme
  }, [settings.theme])

  const addSessionBook = useCallback((book: Book) => {
    setSessionBooks((prev) => new Map(prev).set(book.id, book))
  }, [])
  const removeSessionBook = useCallback((id: string) => {
    setSessionBooks((prev) => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  if (route.view === 'reader') {
    return (
      <Reader
        key={route.bookId}
        bookId={route.bookId}
        sessionBook={sessionBooks.get(route.bookId)}
        settings={settings}
        updateSettings={updateSettings}
        onClose={() => navigateTo({ view: 'library' })}
      />
    )
  }
  return (
    <Library
      sessionBooks={[...sessionBooks.values()]}
      onOpen={(book) => navigateTo({ view: 'reader', bookId: book.id })}
      onSessionBook={addSessionBook}
      onRemoveSessionBook={removeSessionBook}
    />
  )
}
