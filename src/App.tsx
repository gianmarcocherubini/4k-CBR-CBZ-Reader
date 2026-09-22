import { useCallback, useEffect, useRef, useState } from 'react'
import { Library } from './components/Library'
import { PasswordDialog } from './components/PasswordDialog'
import { Reader } from './components/reader/Reader'
import { enterFullscreen, exitFullscreen } from './lib/fullscreen'
import { navigateTo, parseRoute, type Route } from './lib/router'
import { useSettings } from './lib/settings'
import { useServiceWorkerUpdate, useUpdateChecksOnForeground } from './lib/swUpdate'
import type { ArchivePasswordRequest } from './lib/storage/importer'
import type { Book } from './types'

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash))
  const [settings, updateSettings] = useSettings()
  /** Books opened with "Apri senza importare": not in IndexedDB, alive for this tab only. */
  const [sessionBooks, setSessionBooks] = useState<Map<string, Book>>(() => new Map())
  const [passwordRequest, setPasswordRequest] = useState<ArchivePasswordRequest | null>(null)
  const passwordResolver = useRef<((password: string | null) => void) | null>(null)
  const passwordAbortCleanup = useRef<(() => void) | null>(null)
  const updateReady = useServiceWorkerUpdate()
  useUpdateChecksOnForeground()

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

  const settlePassword = useCallback((password: string | null) => {
    passwordAbortCleanup.current?.()
    passwordAbortCleanup.current = null
    const resolve = passwordResolver.current
    passwordResolver.current = null
    setPasswordRequest(null)
    resolve?.(password)
  }, [])

  const requestPassword = useCallback(
    (request: ArchivePasswordRequest) =>
      new Promise<string | null>((resolve) => {
        settlePassword(null)
        if (request.signal?.aborted) {
          resolve(null)
          return
        }
        passwordResolver.current = resolve
        setPasswordRequest(request)
        if (request.signal) {
          const onAbort = () => settlePassword(null)
          request.signal.addEventListener('abort', onAbort, { once: true })
          passwordAbortCleanup.current = () => request.signal?.removeEventListener('abort', onAbort)
        }
      }),
    [settlePassword],
  )

  useEffect(
    () => () => {
      passwordResolver.current?.(null)
      passwordResolver.current = null
      passwordAbortCleanup.current?.()
    },
    [],
  )

  const openBook = useCallback(
    (book: Book) => {
      // Called from the tap on the book: a user gesture, which the Fullscreen API requires.
      if (settings.fullscreenReading) void enterFullscreen()
      navigateTo({ view: 'reader', bookId: book.id })
    },
    [settings.fullscreenReading],
  )
  const closeBook = useCallback(() => {
    void exitFullscreen()
    navigateTo({ view: 'library' })
  }, [])

  const content =
    route.view === 'reader' ? (
      <Reader
        key={route.bookId}
        bookId={route.bookId}
        sessionBook={sessionBooks.get(route.bookId)}
        settings={settings}
        updateSettings={updateSettings}
        onClose={closeBook}
        requestPassword={requestPassword}
      />
    ) : (
      <Library
        sessionBooks={[...sessionBooks.values()]}
        updateReady={updateReady}
        onOpen={openBook}
        onSessionBook={addSessionBook}
        onRemoveSessionBook={removeSessionBook}
        requestPassword={requestPassword}
        onRestoreSettings={updateSettings}
      />
    )

  return (
    <>
      {content}
      {passwordRequest && (
        <PasswordDialog
          key={`${passwordRequest.fileName}:${passwordRequest.invalid}`}
          fileName={passwordRequest.fileName}
          invalid={passwordRequest.invalid}
          onSubmit={(password) => settlePassword(password)}
          onCancel={() => settlePassword(null)}
        />
      )}
    </>
  )
}
