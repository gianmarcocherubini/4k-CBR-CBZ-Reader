import { useEffect, useState } from 'react'
import { EsrganEngine } from '../../lib/upscale/esrgan/esrganEngine'
import type { MaxQualityModel } from '../../types'

export type MaxQualityStatus = 'off' | 'init' | 'ready' | 'unavailable'

export interface MaxQualityHandle {
  engine: EsrganEngine | null
  status: MaxQualityStatus
  /** Why the tier is unavailable (no WebGPU, shader compilation failure, …). */
  error: string | null
  /** What the initialisation is doing right now (weights download, shader compilation, probe). */
  progress: string | null
  /** Increments whenever the engine finishes work, to trigger re-renders. */
  tick: number
}

const MAX_RECOVERIES = 3
const RECOVERY_DELAY_MS = 800

/** Owns the Real-ESRGAN engine of the selected model while "Qualità massima" is on: weights, GPU device, pipelines, probe. */
export function useMaxQuality(enabled: boolean, model: MaxQualityModel): MaxQualityHandle {
  const [engine, setEngine] = useState<EsrganEngine | null>(null)
  const [status, setStatus] = useState<MaxQualityStatus>(enabled ? 'init' : 'off')
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (!enabled) {
      setStatus('off')
      setError(null)
      setEngine(null)
      return
    }
    let cancelled = false
    let created: EsrganEngine | null = null
    setStatus('init')
    setError(null)
    EsrganEngine.create(model, (message) => {
      if (!cancelled) setProgress(message)
    })
      .then((e) => {
        if (cancelled) {
          e?.dispose()
          return
        }
        created = e
        if (!e) {
          setStatus('unavailable')
          setError('WebGPU assente (su iPad serve iPadOS 26 o successivo)')
          return
        }
        e.onChange = () => setTick((t) => t + 1)
        setEngine(e)
        setStatus('ready')
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setStatus('unavailable')
        setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
      created?.dispose()
      created = null
    }
  }, [enabled, model, generation])

  useEffect(() => {
    if (!engine || engine.available) return
    setStatus('unavailable')
    setError('dispositivo GPU perso')
    setEngine(null)
    if (generation >= MAX_RECOVERIES) return
    const t = setTimeout(() => setGeneration((g) => g + 1), RECOVERY_DELAY_MS)
    return () => clearTimeout(t)
  }, [engine, tick, generation])

  return { engine, status, error, progress, tick }
}
