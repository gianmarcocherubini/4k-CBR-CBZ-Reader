import { useCallback, useEffect, useRef, useState } from 'react'
import { type BatchProgress, CunetAborted, CunetEngine, type CunetStatus } from '../../lib/upscale/cunet/cunetEngine'
import type { HeavyFactor } from '../../lib/upscale/cunet/protocol'
import type { HeavyModel } from '../../types'

export interface BatchState {
  running: boolean
  progress: BatchProgress | null
  error: string | null
  finished: boolean
}

export interface MaxQualityHandle {
  engine: CunetEngine | null
  status: CunetStatus
  tick: number
  batch: BatchState
  startBatch: (bookId: string, pages: number[], source: (page: number) => Promise<Blob>, maxFactor: HeavyFactor) => void
  cancelBatch: () => void
}

/** Owns the heavy-tier engine (CUNet or the GAN model) while enabled, plus the state of the batch job. */
export function useMaxQuality(enabled: boolean, model: HeavyModel): MaxQualityHandle {
  const [engine, setEngine] = useState<CunetEngine | null>(null)
  const [tick, setTick] = useState(0)
  const [batch, setBatch] = useState<BatchState>({ running: false, progress: null, error: null, finished: false })
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!enabled) {
      setEngine(null)
      return
    }
    const e = new CunetEngine(model)
    e.onChange = () => setTick((t) => t + 1)
    setEngine(e)
    setBatch({ running: false, progress: null, error: null, finished: false })
    // Start loading the runtime and the model right away so the status line is informative.
    e.init().catch(() => undefined)
    return () => {
      abortRef.current?.abort()
      e.dispose()
    }
  }, [enabled, model])

  const startBatch = useCallback(
    (bookId: string, pages: number[], source: (page: number) => Promise<Blob>, maxFactor: HeavyFactor) => {
      if (!engine || batch.running) return
      const controller = new AbortController()
      abortRef.current = controller
      setBatch({ running: true, progress: null, error: null, finished: false })
      engine
        .preprocess(bookId, pages, source, maxFactor, (progress) => setBatch((b) => ({ ...b, progress })), controller.signal)
        .then(() => setBatch((b) => ({ ...b, running: false, finished: true })))
        .catch((e) =>
          setBatch((b) => ({
            ...b,
            running: false,
            error: e instanceof CunetAborted ? null : e instanceof Error ? e.message : String(e),
          })),
        )
        .finally(() => {
          if (abortRef.current === controller) abortRef.current = null
        })
    },
    [engine, batch.running],
  )

  const cancelBatch = useCallback(() => abortRef.current?.abort(), [])

  return { engine, status: engine?.status ?? 'idle', tick, batch, startBatch, cancelBatch }
}
