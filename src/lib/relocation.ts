import { useEffect, useState } from 'react'
import { SITE_URL } from '../components/Brand'

const SESSION_KEY = 'reader.relocation.v1'
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * An install that is not at the canonical address (the github.io project site before the
 * domain) can never follow the app there: its storage belongs to the old origin and, once GitHub
 * redirects it, its service worker cannot update any more. It keeps working from its cache, so the
 * library tells the user where the app now lives and how to move the library. "Lives" means the
 * new address answers with this app: the manifest is fetched once per session (GitHub Pages sends
 * CORS headers). Skipped in development and on local previews (the end-to-end tests).
 */
export async function detectRelocation(signal?: AbortSignal): Promise<boolean> {
  const canonical = new URL(SITE_URL)
  if (!import.meta.env.PROD || location.hostname === canonical.hostname || LOCAL_HOSTS.has(location.hostname)) return false
  try {
    const cached = sessionStorage.getItem(SESSION_KEY)
    if (cached !== null) return cached === 'yes'
  } catch {
    // Probe anyway.
  }
  let moved = false
  try {
    const res = await fetch(`${SITE_URL}/manifest.webmanifest`, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
    if (res.ok) {
      const manifest = (await res.json()) as { name?: unknown }
      moved = manifest?.name === 'Mangadana'
    }
  } catch {
    moved = false
  }
  if (signal?.aborted) return false
  try {
    sessionStorage.setItem(SESSION_KEY, moved ? 'yes' : 'no')
  } catch {
    // Probed again next launch.
  }
  return moved
}

export function useRelocationNotice(): boolean {
  const [moved, setMoved] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void detectRelocation(controller.signal).then((result) => {
      if (!controller.signal.aborted && result) setMoved(true)
    })
    return () => controller.abort()
  }, [])
  return moved
}
