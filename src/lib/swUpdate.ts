import { useEffect, useState } from 'react'

/**
 * True once a new service worker has taken control of this page (the SW calls skipWaiting +
 * clientsClaim, so a deployed update activates at the first launch that finds it). The running
 * page still uses the previous assets until it reloads.
 */
export function useServiceWorkerUpdate(): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const sw = navigator.serviceWorker
    // A page that had no controller at load is being installed for the first time, not updated.
    let hadController = sw.controller !== null
    const onChange = () => {
      if (hadController) setReady(true)
      hadController = true
    }
    sw.addEventListener('controllerchange', onChange)
    return () => sw.removeEventListener('controllerchange', onChange)
  }, [])
  return ready
}

/**
 * Outcome of an update check: `updated` = a newer version was downloaded and is now in control
 * (a reload shows it); `current` = nothing newer on the server; `offline` = the server could not
 * be reached; `unavailable` = no service worker on this page (development, or a browser without).
 */
export type UpdateCheck = 'updated' | 'current' | 'offline' | 'unavailable'

/**
 * Asks the browser to re-fetch the service worker script now, instead of waiting for the next
 * launch. A home-screen web app can stay open, or suspended, for days: without this the check at
 * start-up never runs again. When a new worker installs, our SW skips waiting and takes over on
 * its own; this resolves once it has.
 */
export async function checkForUpdates(timeoutMs = 25_000): Promise<UpdateCheck> {
  if (!('serviceWorker' in navigator)) return 'unavailable'
  const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined)
  if (!registration) return 'unavailable'
  if (typeof navigator.onLine === 'boolean' && !navigator.onLine) return 'offline'
  try {
    await registration.update()
  } catch {
    return 'offline'
  }
  const worker = registration.installing ?? registration.waiting
  if (!worker) return 'current'
  return new Promise<UpdateCheck>((resolve) => {
    const finish = (outcome: UpdateCheck) => {
      clearTimeout(timer)
      worker.removeEventListener('statechange', onState)
      resolve(outcome)
    }
    const onState = () => {
      if (worker.state === 'activated') finish('updated')
      else if (worker.state === 'redundant') finish('current')
    }
    // Installing precaches the whole app; on a slow link it may outlast the timeout and still
    // finish: by then the worker is in control anyway, so the answer is the same.
    const timer = setTimeout(() => finish('updated'), timeoutMs)
    worker.addEventListener('statechange', onState)
    onState()
  })
}

/** Checks again each time the app comes back to the foreground, at most every `minIntervalMs`. */
export function useUpdateChecksOnForeground(minIntervalMs = 10 * 60_000): void {
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
    let last = Date.now()
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < minIntervalMs) return
      last = Date.now()
      void checkForUpdates().catch(() => undefined)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [minIntervalMs])
}
