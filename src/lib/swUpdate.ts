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
