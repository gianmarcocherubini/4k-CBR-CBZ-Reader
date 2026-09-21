import { useCallback, useState } from 'react'
import { DEFAULT_SETTINGS, type ReaderSettings } from '../types'

const KEY = 'reader.settings.v1'

/** Fields of earlier versions, folded into `resolution` / `rendering` / `antiSpoiler`. */
interface LegacySettings {
  ganModel?: boolean
  maxQuality?: boolean
  maxQualityModel?: string
  maxQualityEnsemble?: boolean
  maxQualityBlur?: boolean
  superResolution?: boolean
  coverOffset?: boolean
  maxQualityBudget?: number
}

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback

export function loadSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<ReaderSettings> & LegacySettings
    const { ganModel, maxQuality, maxQualityModel, maxQualityEnsemble, maxQualityBlur, superResolution, coverOffset, maxQualityBudget, ...rest } = parsed
    void superResolution
    void coverOffset
    void maxQualityBudget
    const settings: ReaderSettings = { ...DEFAULT_SETTINGS, ...rest }
    // "Qualità massima" (+ model, self-ensemble, blur) became the 4K tier with a rendering speed.
    settings.resolution = pick(rest.resolution, ['hd', '4k'], maxQuality || ganModel ? '4k' : 'hd')
    settings.rendering = pick(rest.rendering, ['fast', 'medium', 'slow'], maxQualityModel === '6b' ? 'slow' : maxQualityEnsemble ? 'medium' : 'fast')
    if (typeof rest.antiSpoiler !== 'boolean') settings.antiSpoiler = typeof maxQualityBlur === 'boolean' ? maxQualityBlur : DEFAULT_SETTINGS.antiSpoiler
    settings.srLevel = pick(rest.srLevel, ['auto', 'M', 'VL', 'UL'], 'auto')
    settings.srScale = pick(rest.srScale, ['auto', 'x2', 'x4'], 'auto')
    return settings
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
