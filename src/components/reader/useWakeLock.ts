import { useEffect } from 'react'

/** Keeps the screen on while reading (Safari 16.4+, Chrome). Re-acquired when the tab becomes visible. */
export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !('wakeLock' in navigator)) return
    let sentinel: WakeLockSentinel | null = null
    let cancelled = false
    const acquire = async () => {
      try {
        if (document.visibilityState !== 'visible') return
        sentinel = await navigator.wakeLock.request('screen')
      } catch {
        sentinel = null
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !cancelled) void acquire()
    }
    void acquire()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      void sentinel?.release().catch(() => undefined)
    }
  }, [enabled])
}
