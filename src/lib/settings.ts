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

/**
 * Settings as stored (any version, any origin: localStorage or a backup file) → the current shape.
 * Unknown values fall back to the defaults; fields of earlier versions are folded into the current ones.
 */
export function normalizeSettings(stored: unknown): ReaderSettings {
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_SETTINGS }
  const parsed = stored as Partial<ReaderSettings> & LegacySettings
  const { ganModel, maxQuality, maxQualityModel, maxQualityEnsemble, maxQualityBlur, superResolution, coverOffset, maxQualityBudget, ...rest } = parsed
  void superResolution
  void coverOffset
  void maxQualityBudget
  const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback)
  const d = DEFAULT_SETTINGS
  return {
    direction: pick(rest.direction, ['rtl', 'ltr'], d.direction),
    pageMode: pick(rest.pageMode, ['single', 'double', 'auto'], d.pageMode),
    fit: pick(rest.fit, ['screen', 'height', 'width', 'original'], d.fit),
    // "Qualità massima" (+ model, self-ensemble, blur) became the 4K tier with a rendering speed.
    resolution: pick(rest.resolution, ['hd', '4k'], maxQuality || ganModel ? '4k' : 'hd'),
    rendering: pick(rest.rendering, ['fast', 'medium', 'slow'], maxQualityModel === '6b' ? 'slow' : maxQualityEnsemble ? 'medium' : 'fast'),
    antiSpoiler: bool(rest.antiSpoiler, bool(maxQualityBlur, d.antiSpoiler)),
    srLevel: pick(rest.srLevel, ['auto', 'M', 'VL', 'UL'], 'auto'),
    srScale: pick(rest.srScale, ['auto', 'x2', 'x4'], 'auto'),
    srRestore: bool(rest.srRestore, d.srRestore),
    srClean: bool(rest.srClean, d.srClean),
    theme: pick(rest.theme, ['system', 'light', 'dark'], d.theme),
    stageBackground: pick(rest.stageBackground, ['default', 'black', 'white'], d.stageBackground),
    gutter: pick(rest.gutter, ['none', 's', 'm', 'l'], d.gutter),
    gutterColor: pick(rest.gutterColor, ['white', 'paper', 'dark'], d.gutterColor),
    transition: pick(rest.transition, ['none', 'fade', 'slide'], d.transition),
    fullscreenReading: bool(rest.fullscreenReading, d.fullscreenReading),
    srIndicator: bool(rest.srIndicator, d.srIndicator),
  }
}

export function loadSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    return normalizeSettings(JSON.parse(raw))
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
