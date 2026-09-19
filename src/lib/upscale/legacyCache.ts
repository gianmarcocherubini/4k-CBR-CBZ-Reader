/** OPFS directory where earlier versions stored persistent "Qualità massima" results. */
const LEGACY_DIR = 'sr-cache'
const DONE_KEY = 'reader.legacy-sr-cache-removed.v1'

/**
 * Earlier versions pre-processed whole volumes and kept the results forever in OPFS. That storage
 * is now unused: free it once, best effort (nothing depends on it any more).
 */
export async function removeLegacySrCache(): Promise<void> {
  try {
    if (localStorage.getItem(DONE_KEY)) return
  } catch {
    // no localStorage: just try
  }
  try {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(LEGACY_DIR, { recursive: true })
  } catch {
    // nothing there, or OPFS unavailable
  }
  try {
    localStorage.setItem(DONE_KEY, '1')
  } catch {
    // private mode: it will simply be retried next time
  }
}
