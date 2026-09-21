import type { ReaderSettings } from '../../types'
import { loadSettings, normalizeSettings, saveSettings } from '../settings'
import { BackupError, backupFileName, parseBackup, planRestore, type RestoreSummary, serializeBackup, summarizeRestore } from './backup'
import { applyRestore, getAllProgress, listBooks, listCollections, putPendingRestores } from './db'

/** The library and the settings as a JSON file, named after today's date. */
export async function createBackupFile(): Promise<File> {
  const [books, collections, progress] = await Promise.all([listBooks(), listCollections(), getAllProgress()])
  const backup = await serializeBackup({ books, collections, progress }, loadSettings(), { version: __APP_VERSION__, origin: location.origin })
  return new File([JSON.stringify(backup)], backupFileName(), { type: 'application/json' })
}

/**
 * Hands the backup to the user: the share sheet where it exists (on an iPad: Salva su File,
 * AirDrop, iCloud Drive…), otherwise a download. Resolves to false if the user dismissed the sheet.
 */
export async function shareOrDownload(file: File): Promise<boolean> {
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean; share?: (data: ShareData) => Promise<void> }
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: 'Backup di Mangadana' })
      return true
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return false
      // Sharing refused (a desktop browser without file targets, for instance): download instead.
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = file.name
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
  return true
}

const MAX_BACKUP_BYTES = 256 * 1024 * 1024

export interface RestoreResult extends RestoreSummary {
  settings?: ReaderSettings
}

/** Reads, validates and merges a backup file into the library. Throws BackupError for the user. */
export async function restoreBackupFile(file: File): Promise<RestoreResult> {
  if (file.size > MAX_BACKUP_BYTES) throw new BackupError('Il file è troppo grande per essere un backup di Mangadana.')
  const backup = parseBackup(await file.text())
  const [books, collections, progress] = await Promise.all([listBooks(), listCollections(), getAllProgress()])
  const settings = backup.settings ? normalizeSettings(backup.settings) : undefined
  const plan = planRestore(backup, { books, collections, progress }, settings)
  await applyRestore(plan.collections, plan.books, plan.progress)
  await putPendingRestores(plan.pending)
  if (plan.settings) saveSettings(plan.settings)
  return { ...summarizeRestore(plan), ...(plan.settings ? { settings: plan.settings } : {}) }
}
