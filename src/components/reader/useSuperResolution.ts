import { useEffect, useState } from 'react'
import { flags } from '../../lib/flags'
import { SrEngine, type SrOptions } from '../../lib/upscale/srEngine'

export type SrStatus = 'off' | 'init' | 'ready' | 'unavailable'

export interface SrHandle {
  status: SrStatus
  engine: SrEngine | null
  /** Increments whenever the engine finishes work, to trigger re-renders. */
  tick: number
}

/** How many times a lost GPU device is recreated (iPadOS drops it when the app is suspended). */
const MAX_RECOVERIES = 3
const RECOVERY_DELAY_MS = 800

/** Creates the Anime4K engine while SR is enabled; disposes it (and its GPU device) otherwise. */
export function useSuperResolution(enabled: boolean, options: SrOptions): SrHandle {
  const [engine, setEngine] = useState<SrEngine | null>(null)
  const [status, setStatus] = useState<SrStatus>(enabled ? 'init' : 'off')
  const [tick, setTick] = useState(0)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (!enabled || flags.sr === 'off') {
      setStatus('off')
      setEngine(null)
      return
    }
    let cancelled = false
    let created: SrEngine | null = null
    setStatus('init')
    const prefer = flags.sr === 'webgl2' || flags.sr === 'webgpu' ? flags.sr : 'auto'
    void SrEngine.create(prefer).then((e) => {
      if (cancelled) {
        e?.dispose()
        return
      }
      created = e
      if (!e) {
        setStatus('unavailable')
        return
      }
      e.onChange = () => setTick((t) => t + 1)
      setEngine(e)
      setStatus('ready')
    })
    return () => {
      cancelled = true
      created?.dispose()
      created = null
    }
  }, [enabled, generation])

  useEffect(() => {
    engine?.setOptions(options)
  }, [engine, options])

  // A lost device (app suspended in the background, GPU reset) is recreated instead of leaving
  // the rest of the session without super resolution.
  useEffect(() => {
    if (!engine || engine.available) return
    setStatus('unavailable')
    setEngine(null)
    if (generation >= MAX_RECOVERIES) return
    const t = setTimeout(() => setGeneration((g) => g + 1), RECOVERY_DELAY_MS)
    return () => clearTimeout(t)
  }, [engine, tick, generation])

  return { status, engine, tick }
}
