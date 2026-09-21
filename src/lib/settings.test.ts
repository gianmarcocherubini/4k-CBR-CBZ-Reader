import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../types'
import { normalizeSettings } from './settings'

describe('normalizeSettings', () => {
  it('returns the defaults for nothing or junk', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings('x')).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({ direction: 'up', fit: 3, theme: null, antiSpoiler: 'yes', extra: true })).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps valid values and drops unknown fields', () => {
    const stored = { ...DEFAULT_SETTINGS, direction: 'ltr', fit: 'width', resolution: '4k', rendering: 'slow', theme: 'dark', antiSpoiler: false, srIndicator: false, extra: 'x' }
    const settings = normalizeSettings(stored)
    expect(settings).toMatchObject({ direction: 'ltr', fit: 'width', resolution: '4k', rendering: 'slow', theme: 'dark', antiSpoiler: false, srIndicator: false })
    expect('extra' in settings).toBe(false)
  })

  it('folds the fields of earlier versions into resolution, rendering and antiSpoiler', () => {
    expect(normalizeSettings({ maxQuality: true, maxQualityModel: '6b', maxQualityBlur: false })).toMatchObject({ resolution: '4k', rendering: 'slow', antiSpoiler: false })
    expect(normalizeSettings({ ganModel: true, maxQualityEnsemble: true })).toMatchObject({ resolution: '4k', rendering: 'medium', antiSpoiler: true })
    expect(normalizeSettings({ resolution: 'hd', maxQuality: true })).toMatchObject({ resolution: 'hd' })
  })
})
