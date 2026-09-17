import { useCallback, useState } from 'react'
import { DEFAULT_SETTINGS, type ReaderSettings } from '../types'

const KEY = 'reader.settings.v1'

export function loadSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<ReaderSettings>
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: ReaderSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    // Private mode / quota: settings just do not persist.
  }
}

export function useSettings(): [ReaderSettings, (patch: Partial<ReaderSettings>) => void] {
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings)
  const update = useCallback((patch: Partial<ReaderSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      saveSettings(next)
      return next
    })
  }, [])
  return [settings, update]
}
