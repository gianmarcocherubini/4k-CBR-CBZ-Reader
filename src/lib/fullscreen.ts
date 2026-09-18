/**
 * Fullscreen helpers with the WebKit prefixes still needed on iPadOS. In full screen the iPad
 * status bar (clock, Wi-Fi, battery) and the home indicator disappear, so the page gets the
 * whole screen. Must be called from a user gesture.
 */
type FsDocument = Document & {
  webkitFullscreenEnabled?: boolean
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}
type FsElement = HTMLElement & {
  webkitRequestFullscreen?: (options?: FullscreenOptions) => Promise<void> | void
}

/** Installed to the home screen (iOS) or launched as a PWA window: the Fullscreen API is unavailable. */
export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    window.matchMedia?.('(display-mode: fullscreen)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

export function fullscreenSupported(): boolean {
  const d = document as FsDocument
  return Boolean(d.fullscreenEnabled || d.webkitFullscreenEnabled)
}

export function isFullscreen(): boolean {
  const d = document as FsDocument
  return Boolean(d.fullscreenElement || d.webkitFullscreenElement)
}

export async function enterFullscreen(): Promise<boolean> {
  if (!fullscreenSupported() || isFullscreen()) return isFullscreen()
  const el = document.documentElement as FsElement
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' })
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen()
    return isFullscreen()
  } catch {
    return false
  }
}

export async function exitFullscreen(): Promise<void> {
  if (!isFullscreen()) return
  const d = document as FsDocument
  try {
    if (d.exitFullscreen) await d.exitFullscreen()
    else if (d.webkitExitFullscreen) await d.webkitExitFullscreen()
  } catch {
    // already out
  }
}
