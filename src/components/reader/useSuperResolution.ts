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

/** Creates the Anime4K engine while SR is enabled; disposes it (and its GPU device) otherwise. */
export function useSuperResolution(enabled: boolean, options: SrOptions): SrHandle {
  const [engine, setEngine] = useState<SrEngine | null>(null)
  const [status, setStatus] = useState<SrStatus>(enabled ? 'init' : 'off')
  const [tick, setTick] = useState(0)

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
  }, [enabled])

  useEffect(() => {
    engine?.setOptions(options)
  }, [engine, options])

  useEffect(() => {
    if (engine && !engine.available) setStatus('unavailable')
  }, [engine, tick])

  return { status, engine, tick }
}
