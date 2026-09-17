/// <reference lib="webworker" />
/// <reference types="@webgpu/types" />
import type { InferenceSession, Tensor } from 'onnxruntime-web'
import { CUNET_CACHE_DIR, type CunetEp, type CunetInitResult, type CunetRequest, type CunetResponse, MODEL_SPECS, type ModelSpec } from './protocol'

/**
 * waifu2x CUNet art/scale2x (nunif ONNX) through onnxruntime-web. Tiled 256 px with an 18 px
 * receptive-field crop per side (output tile 440 px), replicate padding, single-colour tile
 * shortcut and a grayscale guard against colour drift. Results are encoded as WebP and stored in
 * OPFS under sr-cache/<book>/<page>.webp so they are computed once, forever.
 */

type Ort = typeof import('onnxruntime-web')

/** Tiling derived from the model spec (set by `init`). Results are always stored at 2x. */
let spec: ModelSpec = MODEL_SPECS.cunet
let TILE = spec.tile
let CROP_IN = spec.cropIn
let STEP = TILE - 2 * CROP_IN // source px advance per tile
let OUT_TILE = STEP * 2 // stored (2x) output per tile
function applySpec(s: ModelSpec): void {
  spec = s
  TILE = s.tile
  CROP_IN = s.cropIn
  STEP = TILE - 2 * CROP_IN
  OUT_TILE = STEP * 2
}

let ort: Ort | null = null
let session: InferenceSession | null = null
let ep: CunetEp = 'wasm'
let threads = 1
let cancelled = new Set<number>()
/** ORT sessions must not run concurrently: every request goes through this chain. */
let chain: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

const post = (msg: CunetResponse) => self.postMessage(msg)

async function softwareGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu
  if (!gpu) return true
  try {
    const adapter = await gpu.requestAdapter()
    if (!adapter) return true
    const a = adapter as GPUAdapter & { info?: GPUAdapterInfo; isFallbackAdapter?: boolean }
    const desc = `${a.info?.vendor ?? ''} ${a.info?.architecture ?? ''} ${a.info?.description ?? ''}`
    return a.isFallbackAdapter === true || a.info?.isFallbackAdapter === true || /swiftshader|llvmpipe|software|lavapipe/i.test(desc)
  } catch {
    return true
  }
}

async function init(modelUrl: string, ortPath: string, preferGpu: boolean, modelSpec: ModelSpec): Promise<CunetInitResult> {
  applySpec(modelSpec)
  session = null
  const head = await fetch(modelUrl, { method: 'HEAD' })
  if (!head.ok) {
    const err = new Error(`Modello non trovato (${head.status})`) as Error & { code: string }
    err.code = 'model-missing'
    throw err
  }
  const useGpu = preferGpu && !(await softwareGpu())
  ep = useGpu ? 'webgpu' : 'wasm'
  // The runtime lives in public/ort (npm run setup) and is imported by URL: bundling
  // onnxruntime-web would make Vite emit duplicate copies of its wasm binaries.
  const bundleUrl = new URL(`${ortPath}${useGpu ? 'ort.webgpu.bundle.min.mjs' : 'ort.wasm.bundle.min.mjs'}`, self.location.origin).href
  try {
    ort = (await import(/* @vite-ignore */ bundleUrl)) as unknown as Ort
  } catch (e) {
    const err = new Error(`Motore non trovato (${bundleUrl}): eseguire npm run setup`) as Error & { code: string }
    err.code = 'model-missing'
    throw e instanceof Error && /model-missing/.test(String((e as { code?: string }).code)) ? e : err
  }
  const isolated = self.crossOriginIsolated === true
  threads = isolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1)) : 1
  ort.env.wasm.wasmPaths = ortPath
  ort.env.wasm.numThreads = threads
  ort.env.wasm.proxy = false
  const options: InferenceSession.SessionOptions = { graphOptimizationLevel: 'all', executionProviders: [ep === 'webgpu' ? { name: 'webgpu' } : 'wasm'] }
  try {
    session = await ort.InferenceSession.create(modelUrl, options)
  } catch (e) {
    if (ep !== 'webgpu') throw e
    // WebGPU EP failed (e.g. missing features): fall back to the CPU EP of the same bundle.
    ep = 'wasm'
    session = await ort.InferenceSession.create(modelUrl, { ...options, executionProviders: ['wasm'] })
  }
  return { ep, threads, crossOriginIsolated: isolated }
}

function replicatePad(src: ImageData, padL: number, padT: number, outW: number, outH: number): Uint8ClampedArray {
  const { width: W, height: H, data } = src
  const out = new Uint8ClampedArray(outW * outH * 4)
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(H - 1, Math.max(0, y - padT))
    const rowSrc = sy * W * 4
    const rowDst = y * outW * 4
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(W - 1, Math.max(0, x - padL))
      const s = rowSrc + sx * 4
      const d = rowDst + x * 4
      out[d] = data[s]!
      out[d + 1] = data[s + 1]!
      out[d + 2] = data[s + 2]!
      out[d + 3] = 255
    }
  }
  return out
}

function isGrayscale(img: ImageData): boolean {
  const d = img.data
  for (let i = 0; i < d.length; i += 4 * 7) {
    const r = d[i]!
    const g = d[i + 1]!
    const b = d[i + 2]!
    if (Math.abs(r - g) > 3 || Math.abs(g - b) > 3 || Math.abs(r - b) > 3) return false
  }
  return true
}

async function cached(cacheKey: string, page: number): Promise<Blob | null> {
  try {
    const dir = await cacheDir(cacheKey, false)
    const file = await (await dir.getFileHandle(`${page}`)).getFile()
    if (file.size === 0) return null
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
    const isWebp = head[0] === 0x52 && head[1] === 0x49 && head[8] === 0x57 && head[9] === 0x45
    return new Blob([file], { type: isWebp ? 'image/webp' : 'image/jpeg' })
  } catch {
    return null
  }
}

async function process(id: number, cacheKey: string, page: number, blob: Blob): Promise<Blob> {
  if (!ort || !session) throw Object.assign(new Error('Motore non inizializzato'), { code: 'unavailable' })
  if (cancelled.has(id)) throw Object.assign(new Error('Annullato'), { code: 'aborted' })
  // Another request (reading ahead vs. batch) may have produced this page while we waited.
  const hit = await cached(cacheKey, page)
  if (hit) return hit
  const bitmap = await createImageBitmap(blob)
  const W = bitmap.width
  const H = bitmap.height
  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const src = ctx.getImageData(0, 0, W, H)
  const gray = isGrayscale(src)

  const blocksW = Math.ceil(W / STEP)
  const blocksH = Math.ceil(H / STEP)
  const padW = blocksW * STEP + 2 * CROP_IN
  const padH = blocksH * STEP + 2 * CROP_IN
  const padded = replicatePad(src, CROP_IN, CROP_IN, padW, padH)

  const outW = W * 2
  const outH = H * 2
  const out = new Uint8ClampedArray(outW * outH * 4)
  const input = new Float32Array(3 * TILE * TILE)
  const tilesTotal = blocksW * blocksH
  let tilesDone = 0
  post({ type: 'progress', id, tilesDone, tilesTotal })

  for (let bi = 0; bi < blocksH; bi++) {
    for (let bj = 0; bj < blocksW; bj++) {
      if (cancelled.has(id)) throw Object.assign(new Error('Annullato'), { code: 'aborted' })
      const x0 = bj * STEP
      const y0 = bi * STEP
      // Extract the 256x256 tile as planar RGB in [0,1]; detect single-colour tiles on the way.
      let single = true
      const first = [padded[(y0 * padW + x0) * 4]!, padded[(y0 * padW + x0) * 4 + 1]!, padded[(y0 * padW + x0) * 4 + 2]!]
      for (let y = 0; y < TILE; y++) {
        const row = (y0 + y) * padW
        for (let x = 0; x < TILE; x++) {
          const s = (row + x0 + x) * 4
          const r = padded[s]!
          const g = padded[s + 1]!
          const b = padded[s + 2]!
          if (single && (r !== first[0] || g !== first[1] || b !== first[2])) single = false
          const p = y * TILE + x
          input[p] = r / 255
          input[TILE * TILE + p] = g / 255
          input[2 * TILE * TILE + p] = b / 255
        }
      }
      let tile: Float32Array | null = null
      // Network output geometry: edge = scale*TILE - shrink; the valid (non-context) region starts
      // at scale*CROP_IN - shrink/2 and spans scale*STEP pixels; x4 outputs are box-averaged to 2x.
      const outEdge = spec.scale * TILE - spec.shrink
      const validOff = spec.scale * CROP_IN - spec.shrink / 2
      const sub = spec.scale / 2 // 1 for x2 models, 2 for x4 (2x2 box filter)
      if (!single) {
        const feeds = { [session.inputNames[0]!]: new ort.Tensor('float32', input, [1, 3, TILE, TILE]) }
        const result = await session.run(feeds)
        const y = result[session.outputNames[0]!] as Tensor
        tile = y.data as Float32Array
      }
      // Place the (2x) output tile (clipped to the page).
      const ox0 = bj * OUT_TILE
      const oy0 = bi * OUT_TILE
      const plane = outEdge * outEdge
      for (let y = 0; y < OUT_TILE; y++) {
        const oy = oy0 + y
        if (oy >= outH) break
        for (let x = 0; x < OUT_TILE; x++) {
          const ox = ox0 + x
          if (ox >= outW) break
          const d = (oy * outW + ox) * 4
          let r: number
          let g: number
          let b: number
          if (tile) {
            if (sub === 1) {
              const p = (validOff + y) * outEdge + validOff + x
              r = tile[p]! * 255
              g = tile[plane + p]! * 255
              b = tile[2 * plane + p]! * 255
            } else {
              let ar = 0
              let ag = 0
              let ab = 0
              for (let sy = 0; sy < sub; sy++) {
                for (let sx = 0; sx < sub; sx++) {
                  const p = (validOff + y * sub + sy) * outEdge + validOff + x * sub + sx
                  ar += tile[p]!
                  ag += tile[plane + p]!
                  ab += tile[2 * plane + p]!
                }
              }
              const n = sub * sub
              r = (ar / n) * 255
              g = (ag / n) * 255
              b = (ab / n) * 255
            }
          } else {
            r = first[0]!
            g = first[1]!
            b = first[2]!
          }
          if (gray) {
            const l = (r + g + b) / 3
            r = g = b = l
          }
          out[d] = r
          out[d + 1] = g
          out[d + 2] = b
          out[d + 3] = 255
        }
      }
      tilesDone++
      post({ type: 'progress', id, tilesDone, tilesTotal })
    }
  }

  const outCanvas = new OffscreenCanvas(outW, outH)
  outCanvas.getContext('2d')!.putImageData(new ImageData(out, outW, outH), 0, 0)
  let encoded = await outCanvas.convertToBlob({ type: 'image/webp', quality: 0.92 })
  if (encoded.type !== 'image/webp') encoded = await outCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
  await store(cacheKey, page, encoded)
  return encoded
}

async function cacheDir(cacheKey: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  const base = await root.getDirectoryHandle(CUNET_CACHE_DIR, { create })
  return base.getDirectoryHandle(cacheKey, { create })
}

async function store(cacheKey: string, page: number, blob: Blob): Promise<void> {
  try {
    const dir = await cacheDir(cacheKey, true)
    const fh = await dir.getFileHandle(`${page}`, { create: true })
    type MaybeAsync = {
      truncate(n: number): void | Promise<void>
      write(b: ArrayBufferView, o?: { at: number }): number | Promise<number>
      flush(): void | Promise<void>
      close(): void | Promise<void>
    }
    const h = (await fh.createSyncAccessHandle()) as unknown as MaybeAsync
    try {
      await h.truncate(0)
      await h.write(new Uint8Array(await blob.arrayBuffer()), { at: 0 })
      await h.flush()
    } finally {
      await h.close()
    }
  } catch {
    // Cache is best effort: the result is still returned to the caller.
  }
}

async function list(cacheKey: string): Promise<number[]> {
  try {
    const dir = await cacheDir(cacheKey, false)
    const pages: number[] = []
    for await (const name of (dir as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }).keys()) {
      const n = Number(name)
      if (Number.isInteger(n)) pages.push(n)
    }
    return pages.sort((a, b) => a - b)
  } catch {
    return []
  }
}

async function remove(cacheKey: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    const base = await root.getDirectoryHandle(CUNET_CACHE_DIR, { create: false })
    await base.removeEntry(cacheKey, { recursive: true })
  } catch {
    // nothing cached
  }
}

self.onmessage = async (ev: MessageEvent<CunetRequest>) => {
  const msg = ev.data
  if (msg.type === 'cancel') {
    cancelled.add(msg.id)
    return
  }
  try {
    let result: unknown
    switch (msg.type) {
      case 'init':
        result = await serialized(() => init(msg.modelUrl, msg.ortPath, msg.preferGpu, msg.spec))
        break
      case 'process':
        result = await serialized(() => process(msg.id, msg.cacheKey, msg.page, msg.blob))
        break
      case 'list':
        result = await list(msg.cacheKey)
        break
      case 'delete':
        await remove(msg.cacheKey)
        result = null
        break
    }
    post({ type: 'result', id: msg.id, ok: true, result })
  } catch (e) {
    const code = ((e as { code?: string })?.code ?? 'failed') as 'model-missing' | 'unavailable' | 'aborted' | 'failed'
    post({ type: 'result', id: msg.id, ok: false, error: { code, message: e instanceof Error ? e.message : String(e) } })
  } finally {
    cancelled.delete(msg.id)
    if (cancelled.size > 64) cancelled = new Set()
  }
}
