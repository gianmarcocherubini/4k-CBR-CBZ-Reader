import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Anime4KLevel, UpscaleBackend, UpscaleOptions, UpscaleResult } from './backend'
import { SrEngine, type SrPlan } from './srEngine'

/**
 * The engine runs in the browser; here the GPU is a fake whose "time" per page is scripted and a
 * controllable clock stands in for performance.now(). Bitmaps are stubs that only track close().
 */
class FakeBitmap {
  closed = false
  constructor(
    public width: number,
    public height: number,
  ) {}
  close() {
    this.closed = true
    this.width = 0
    this.height = 0
  }
}

let now = 0
/** Wall time the fake GPU takes for one 2x pass at `level` over a 800x1200 page (ms). */
let passMs: Record<Anime4KLevel, number> = { M: 200, VL: 400, UL: 900 }
const calls: Array<{ level: Anime4KLevel; target: string }> = []

function fakeBackend(): UpscaleBackend {
  return {
    kind: 'webgpu',
    info: { adapter: 'fake', maxTextureDimension: 8192 },
    isLost: false,
    onLost: null,
    canUpscale: () => true,
    prepare: async () => false,
    upscale: async (source: ImageBitmap, opts: UpscaleOptions): Promise<UpscaleResult> => {
      calls.push({ level: opts.level, target: `${opts.target.w}x${opts.target.h}` })
      // Cost scales with the input area (the second x4 pass runs over a 2x larger input).
      now += passMs[opts.level] * ((source.width * source.height) / (800 * 1200))
      return { data: new Uint8ClampedArray(4), width: opts.target.w, height: opts.target.h }
    },
    dispose: () => undefined,
  }
}

const PAGE = { w: 800, h: 1200 }
const source = () => Promise.resolve(new FakeBitmap(800, 1200) as unknown as ImageBitmap)

beforeEach(() => {
  now = 0
  calls.length = 0
  vi.useFakeTimers()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('ImageData', class {
    constructor(
      public data: Uint8ClampedArray,
      public width: number,
      public height: number,
    ) {}
  })
  vi.stubGlobal('createImageBitmap', async (src: { width: number; height: number }) => new FakeBitmap(src.width, src.height))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function enhance(engine: SrEngine, index: number, size = PAGE) {
  const plan = engine.plan(size) as SrPlan
  engine.setWanted([index])
  return engine.enhance(index, plan, source)
}

describe('SrEngine automatic level', () => {
  it('probes at VL, settles once, and never re-enhances a page because the level moved', async () => {
    // A GPU where UL costs more than the cost model assumes, right around the 800 ms budget: the
    // old per-sample decision flipped between UL and VL on every page and redid the visible ones.
    // Probe: VL 160 ms + second pass M over 4x the area 280 ms = 440 ms -> UL predicted at 710 ms.
    passMs = { M: 70, VL: 160, UL: 640 }
    const engine = SrEngine.withBackend(fakeBackend())
    const first = await enhance(engine, 0)
    expect(first.level).toBe('VL')
    expect(engine.currentAutoLevel).toBe('UL')
    // Same page, plan now says UL: the VL result is kept, nothing is recomputed.
    const again = await enhance(engine, 0)
    expect(again).toBe(first)
    expect(calls).toHaveLength(2) // the two x4 passes of the probe only
    // Following pages run at the settled level and it does not oscillate.
    const levels: string[] = []
    for (let i = 1; i <= 6; i++) levels.push((await enhance(engine, i)).level)
    expect(levels).toEqual(['UL', 'UL', 'UL', 'UL', 'UL', 'UL'])
    expect(engine.currentAutoLevel).toBe('UL')
  })

  it('steps the level down when a page runs far over budget and never steps it back up', async () => {
    passMs = { M: 70, VL: 160, UL: 640 }
    const engine = SrEngine.withBackend(fakeBackend())
    await enhance(engine, 0)
    expect(engine.currentAutoLevel).toBe('UL')
    passMs = { M: 70, VL: 160, UL: 1400 } // thermal throttling: UL x4 now takes 1680 ms > 1.5 x budget
    expect((await enhance(engine, 1)).level).toBe('UL')
    expect(engine.currentAutoLevel).toBe('VL')
    passMs = { M: 70, VL: 160, UL: 640 } // fast again: no upgrade within the session
    for (let i = 2; i <= 4; i++) expect((await enhance(engine, i)).level).toBe('VL')
    expect(engine.currentAutoLevel).toBe('VL')
  })

  it('a manual level is applied as asked and re-probes only when the settings change the cost', async () => {
    const engine = SrEngine.withBackend(fakeBackend())
    await enhance(engine, 0)
    engine.setOptions({ level: 'M', scale: 'auto', restore: false, clean: false })
    expect((await enhance(engine, 0)).level).toBe('M')
    engine.setOptions({ level: 'auto', scale: 'auto', restore: false, clean: false })
    // Back to auto: the settled level is still known, the M result satisfies the page.
    expect(engine.currentAutoLevel).not.toBeUndefined()
    const kept = await enhance(engine, 0)
    expect(kept.level).toBe('M')
    engine.setOptions({ level: 'auto', scale: 'auto', restore: true, clean: false })
    expect(engine.currentAutoLevel).toBeUndefined()
  })
})

describe('SrEngine cache', () => {
  it('never evicts or closes the results of the pages on screen', async () => {
    const engine = SrEngine.withBackend(fakeBackend())
    // x4 results of 800x1200 are 61 MB each: five of them exceed the 256 MB budget of this environment.
    const results = []
    for (let i = 0; i < 5; i++) results.push(await enhance(engine, i))
    engine.setWanted([3, 4])
    vi.advanceTimersByTime(5000)
    const plan = engine.plan(PAGE) as SrPlan
    expect(engine.peek(3, plan)).toBe(results[3])
    expect(engine.peek(4, plan)).toBe(results[4])
    expect((results[3]!.bitmap as unknown as FakeBitmap).closed).toBe(false)
    expect((results[4]!.bitmap as unknown as FakeBitmap).closed).toBe(false)
    expect(engine.peek(0, plan)).toBeUndefined()
    expect((results[0]!.bitmap as unknown as FakeBitmap).closed).toBe(true)
  })

  it('closes replaced bitmaps only after a grace period, so a frame still painting them is safe', async () => {
    const engine = SrEngine.withBackend(fakeBackend())
    const before = await enhance(engine, 0)
    engine.setOptions({ level: 'M', scale: 'auto', restore: false, clean: false })
    const after = await enhance(engine, 0)
    expect(after).not.toBe(before)
    expect((before.bitmap as unknown as FakeBitmap).closed).toBe(false)
    vi.advanceTimersByTime(2000)
    expect((before.bitmap as unknown as FakeBitmap).closed).toBe(true)
    expect((after.bitmap as unknown as FakeBitmap).closed).toBe(false)
  })
})
