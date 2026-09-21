/** URL flags used for testing: ?storage=idb, ?sr=off|webgl2|webgpu, ?test */
const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '')

export const flags = {
  /** Force the IndexedDB import path instead of OPFS. */
  forceIdb: params.get('storage') === 'idb',
  /** Super-resolution backend override. */
  sr: params.get('sr') as 'off' | 'webgl2' | 'webgpu' | null,
  /** Test override of the 4K sanity cap (ms): a spread predicted to take longer stays in HD. */
  mqCapMs: params.has('mqcap') ? Number(params.get('mqcap')) : undefined,
  /** Expose window.__reader test hooks (always on in dev). */
  test: params.has('test') || import.meta.env.DEV,
}

export function isIOS(): boolean {
  const ua = navigator.userAgent
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

export function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}
