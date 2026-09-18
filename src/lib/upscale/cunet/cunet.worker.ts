/// <reference lib="webworker" />
/// <reference types="@webgpu/types" />
import type { InferenceSession, Tensor } from 'onnxruntime-web'
import { assertSafeEncodedImage } from '../../imageDimensions'
import {
  cacheDirFor,
  CUNET_CACHE_DIR,
  type CunetEp,
  type CunetInitResult,
  type CunetRequest,
  type CunetResponse,
  type HeavyFactor,
  heavyFactor,
  MODEL_SPECS,
  type ModelSpec,
} from './protocol'
import { GpuTileRunner } from './gpuTileRunner'

/**
 * Heavy models (waifu2x CUNet art/scale2x, Real-ESRGAN anime 6B; nunif/official ONNX) through
 * onnxruntime-web. Tiled with a receptive-field crop per side, replicate padding, single-colour
 * tile shortcut and a grayscale guard against colour drift. The result is a fixed factor of the
 * source: x4 is Real-ESRGAN's native output or two passes of CUNet; x2 is CUNet's native output
 * or a 2x2 box of Real-ESRGAN's. Results are encoded as WebP and stored in OPFS under
 * sr-cache/<book>[.model][.x4]/<page> so they are computed once, forever.
 */

type Ort = typeof import('onnxruntime-web')

/** Tiling derived from the model spec (set by `init`). */
let spec: ModelSpec = MODEL_SPECS.cunet
let TILE = spec.tile
let CROP_IN = spec.cropIn
let STEP = TILE - 2 * CROP_IN // source px advance per tile
function applySpec(s: ModelSpec): void {
  spec = s
  TILE = s.tile
  CROP_IN = s.cropIn
  STEP = TILE - 2 * CROP_IN
}

let ort: Ort | null = null
let session: InferenceSession | null = null
let gpuRunner: GpuTileRunner | null = null
let activeGpuDevice: GPUDevice | null = null
let activeModelUrl = ''
let fp32ModelUrl = ''
let activePrecision: 'fp16' | 'fp32' = 'fp32'
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

interface GpuProbe {
  adapter: GPUAdapter | null
  shaderF16: boolean
}

async function probeGpu(): Promise<GpuProbe> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu
  if (!gpu) return { adapter: null, shaderF16: false }
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) return { adapter: null, shaderF16: false }
    const a = adapter as GPUAdapter & { info?: GPUAdapterInfo; isFallbackAdapter?: boolean }
    const desc = `${a.info?.vendor ?? ''} ${a.info?.architecture ?? ''} ${a.info?.description ?? ''}`
    if (a.isFallbackAdapter === true || a.info?.isFallbackAdapter === true || /swiftshader|llvmpipe|software|lavapipe/i.test(desc)) {
      return { adapter: null, shaderF16: false }
    }
    return { adapter, shaderF16: adapter.features.has('shader-f16') }
  } catch {
    return { adapter: null, shaderF16: false }
  }
}

const currentInfo = (): CunetInitResult => ({
  ep,
  threads,
  crossOriginIsolated: self.crossOriginIsolated === true,
  precision: activePrecision,
  graphCapture: gpuRunner !== null,
})

async function init(modelUrl: string, ortPath: string, preferGpu: boolean, modelSpec: ModelSpec): Promise<CunetInitResult> {
  applySpec(modelSpec)
  gpuRunner?.dispose()
  gpuRunner = null
  if (session) await session.release()
  session = null
  activeGpuDevice?.destroy()
  activeGpuDevice = null
  activeModelUrl = modelUrl
  fp32ModelUrl = modelUrl
  activePrecision = 'fp32'
  const head = await fetch(modelUrl, { method: 'HEAD' })
  if (!head.ok) {
    const err = new Error(`Modello non trovato (${head.status})`) as Error & { code: string }
    err.code = 'model-missing'
    throw err
  }
  const gpu = preferGpu ? await probeGpu() : { adapter: null, shaderF16: false }
  if (gpu.adapter) {
    try {
      const requiredFeatures: GPUFeatureName[] = gpu.shaderF16 ? ['shader-f16'] : []
      activeGpuDevice = await gpu.adapter.requestDevice({ requiredFeatures })
    } catch {
      activeGpuDevice = null
    }
  }
  const useGpu = activeGpuDevice !== null
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
  if (useGpu) ort.env.webgpu.powerPreference = 'high-performance'
  let selectedModelUrl = modelUrl
  if (activeGpuDevice?.features.has('shader-f16') && modelSpec.fp16File) {
    const fp16Url = new URL(modelSpec.fp16File, new URL('.', modelUrl)).href
    try {
      const fp16Head = await fetch(fp16Url, { method: 'HEAD' })
      if (fp16Head.ok) {
        selectedModelUrl = fp16Url
        activePrecision = 'fp16'
      }
    } catch {
      // FP32 is always the quality-safe fallback.
    }
  }
  activeModelUrl = selectedModelUrl
  const options: InferenceSession.SessionOptions = {
    graphOptimizationLevel: 'all',
    // Passing the device on the EP is the supported ORT 1.30 binding; env.webgpu.adapter alone
    // can let ORT select a different adapter than the one whose FP16 support we probed.
    executionProviders: [ep === 'webgpu' ? { name: 'webgpu', device: activeGpuDevice! } : 'wasm'],
  }
  try {
    if (ep === 'webgpu' && modelSpec.id === 'esrgan6b') {
      const outEdge = modelSpec.scale * modelSpec.tile - modelSpec.shrink
      // All tiles have the same shape. External GPU tensors plus fixed free dimensions let ORT
      // capture and replay the graph instead of rebuilding 320-node command streams 40–70 times.
      session = await ort.InferenceSession.create(selectedModelUrl, {
        ...options,
        enableGraphCapture: true,
        preferredOutputLocation: 'gpu-buffer',
        freeDimensionOverrides: {
          n: 1,
          h: modelSpec.tile,
          w: modelSpec.tile,
          h4: outEdge,
          w4: outEdge,
        },
      })
      gpuRunner = await GpuTileRunner.create(ort, session, activeGpuDevice!, modelSpec)
    } else {
      session = await ort.InferenceSession.create(selectedModelUrl, options)
    }
  } catch (e) {
    if (ep !== 'webgpu') throw e
    console.warn('GAN GPU graph-capture init non disponibile; fallback WebGPU compatibile.', e)
    // Graph capture / external GPU buffers are optional. Keep WebGPU with the proven CPU-I/O
    // pipeline first; only fall back to WASM when the WebGPU session itself cannot be created.
    gpuRunner?.dispose()
    gpuRunner = null
    if (session) await session.release().catch(() => undefined)
    session = null
    try {
      session = await ort.InferenceSession.create(selectedModelUrl, options)
    } catch (selectedError) {
      // A device can advertise shader-f16 while one model operator still rejects FP16. Retry the
      // same WebGPU adapter with the canonical FP32 model before considering the CPU.
      if (selectedModelUrl !== modelUrl) {
        try {
          activePrecision = 'fp32'
          activeModelUrl = modelUrl
          session = await ort.InferenceSession.create(modelUrl, options)
        } catch {
          ep = 'wasm'
          activeGpuDevice?.destroy()
          activeGpuDevice = null
          session = await ort.InferenceSession.create(modelUrl, { ...options, executionProviders: ['wasm'] })
        }
      } else {
        console.warn('Sessione WebGPU non disponibile; fallback CPU.', selectedError)
        ep = 'wasm'
        activeGpuDevice?.destroy()
        activeGpuDevice = null
        activePrecision = 'fp32'
        activeModelUrl = modelUrl
        session = await ort.InferenceSession.create(modelUrl, { ...options, executionProviders: ['wasm'] })
      }
    }
  }
  return { ...currentInfo(), crossOriginIsolated: isolated }
}

/** A first-run graph-capture failure must never make the model unavailable. */
async function disableGpuFastPath(): Promise<void> {
  if (!gpuRunner || !ort) return
  gpuRunner.dispose()
  gpuRunner = null
  const released = session
  session = null
  if (released) await released.release().catch(() => undefined)
  const webGpuOptions: InferenceSession.SessionOptions = {
    graphOptimizationLevel: 'all',
    executionProviders: [{ name: 'webgpu', device: activeGpuDevice! }],
  }
  try {
    session = await ort.InferenceSession.create(activeModelUrl, webGpuOptions)
  } catch (selectedError) {
    if (activeModelUrl !== fp32ModelUrl) {
      try {
        activeModelUrl = fp32ModelUrl
        activePrecision = 'fp32'
        session = await ort.InferenceSession.create(fp32ModelUrl, webGpuOptions)
      } catch {
        ep = 'wasm'
        activeGpuDevice?.destroy()
        activeGpuDevice = null
        session = await ort.InferenceSession.create(fp32ModelUrl, {
          graphOptimizationLevel: 'all',
          executionProviders: ['wasm'],
        })
      }
    } else {
      console.warn('Fallback WebGPU compatibile non disponibile; uso la CPU.', selectedError)
      ep = 'wasm'
      activeGpuDevice?.destroy()
      activeGpuDevice = null
      activePrecision = 'fp32'
      session = await ort.InferenceSession.create(fp32ModelUrl, {
        graphOptimizationLevel: 'all',
        executionProviders: ['wasm'],
      })
    }
  }
  post({ type: 'mode', info: currentInfo() })
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

const tilesFor = (W: number, H: number) => Math.ceil(W / STEP) * Math.ceil(H / STEP)

/**
 * One pass of the network over `src`, producing `outFactor` × src (outFactor ≤ the model scale;
 * a x4 model asked for x2 gets a 2x2 box filter). `onTile` is called after every tile.
 */
async function runNetworkCpu(id: number, src: ImageData, gray: boolean, outFactor: HeavyFactor, onTile: () => void): Promise<ImageData> {
  if (!ort || !session) throw Object.assign(new Error('Motore non inizializzato'), { code: 'unavailable' })
  const { width: W, height: H } = src
  const blocksW = Math.ceil(W / STEP)
  const blocksH = Math.ceil(H / STEP)
  const padW = blocksW * STEP + 2 * CROP_IN
  const padH = blocksH * STEP + 2 * CROP_IN
  const padded = replicatePad(src, CROP_IN, CROP_IN, padW, padH)

  const outW = W * outFactor
  const outH = H * outFactor
  const outTile = STEP * outFactor
  const out = new Uint8ClampedArray(outW * outH * 4)
  const input = new Float32Array(3 * TILE * TILE)
  // Network output geometry: edge = scale*TILE - shrink; the valid (non-context) region starts at
  // scale*CROP_IN - shrink/2 and spans scale*STEP pixels; `sub` output pixels per stored pixel.
  const outEdge = spec.scale * TILE - spec.shrink
  const validOff = spec.scale * CROP_IN - spec.shrink / 2
  const sub = spec.scale / outFactor
  const plane = outEdge * outEdge

  for (let bi = 0; bi < blocksH; bi++) {
    for (let bj = 0; bj < blocksW; bj++) {
      if (cancelled.has(id)) throw Object.assign(new Error('Annullato'), { code: 'aborted' })
      const x0 = bj * STEP
      const y0 = bi * STEP
      // Extract the tile as planar RGB in [0,1]; detect single-colour tiles on the way.
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
      let resultTensor: Tensor | null = null
      if (!single) {
        const inputTensor = new ort.Tensor('float32', input, [1, 3, TILE, TILE])
        try {
          const result = await session.run({ [session.inputNames[0]!]: inputTensor })
          resultTensor = result[session.outputNames[0]!] as Tensor
          tile = (resultTensor.location === 'cpu' ? resultTensor.data : await resultTensor.getData(true)) as Float32Array
        } finally {
          inputTensor.dispose()
        }
      }
      // Place the output tile (clipped to the page).
      const ox0 = bj * outTile
      const oy0 = bi * outTile
      for (let y = 0; y < outTile; y++) {
        const oy = oy0 + y
        if (oy >= outH) break
        for (let x = 0; x < outTile; x++) {
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
      resultTensor?.dispose()
      onTile()
    }
  }
  return new ImageData(out, outW, outH)
}

async function runNetwork(id: number, src: ImageData, gray: boolean, outFactor: HeavyFactor, onTile: () => void): Promise<ImageData> {
  const runner = gpuRunner
  if (!runner) return runNetworkCpu(id, src, gray, outFactor, onTile)
  const { width: W, height: H } = src
  const blocksW = Math.ceil(W / STEP)
  const blocksH = Math.ceil(H / STEP)
  const padW = blocksW * STEP + 2 * CROP_IN
  const padH = blocksH * STEP + 2 * CROP_IN
  const padded = replicatePad(src, CROP_IN, CROP_IN, padW, padH)
  let completed = 0
  try {
    const result = await runner.run(
      padded,
      padW,
      W,
      H,
      blocksW,
      blocksH,
      CROP_IN,
      STEP,
      gray,
      outFactor,
      () => cancelled.has(id),
      () => completed++,
    )
    for (let i = 0; i < completed; i++) onTile()
    return result
  } catch (e) {
    if ((e as { code?: string })?.code === 'aborted') throw e
    console.warn('Percorso GAN GPU-resident non disponibile; uso il fallback compatibile.', e)
    await disableGpuFastPath()
    return runNetworkCpu(id, src, gray, outFactor, onTile)
  }
}

async function process(
  id: number,
  cacheKeyBase: string,
  page: number,
  blob: Blob,
  maxFactor: HeavyFactor,
  persist: boolean,
): Promise<Blob> {
  if (!ort || !session) throw Object.assign(new Error('Motore non inizializzato'), { code: 'unavailable' })
  if (cancelled.has(id)) throw Object.assign(new Error('Annullato'), { code: 'aborted' })
  await assertSafeEncodedImage(blob)
  const bitmap = await createImageBitmap(blob)
  const W = bitmap.width
  const H = bitmap.height
  const factor = heavyFactor(W, H, maxFactor)
  if (factor === null) {
    bitmap.close()
    throw Object.assign(new Error(`Pagina ${W}×${H} troppo grande per l'output GAN`), { code: 'unavailable' })
  }
  const cacheKey = cacheDirFor(cacheKeyBase, factor)
  // Another request (reading ahead vs. batch) may have produced this page while we waited.
  const hit = persist ? await cached(cacheKey, page) : null
  if (hit) {
    bitmap.close()
    return hit
  }
  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const src = ctx.getImageData(0, 0, W, H)
  const gray = isGrayscale(src)

  // A x2 model reaches x4 with a second pass over its own output (4x the tiles).
  const stages: HeavyFactor[] = spec.scale === 4 ? [factor] : factor === 4 ? [2, 2] : [2]
  let tilesTotal = 0
  {
    let w = W
    let h = H
    for (const s of stages) {
      tilesTotal += tilesFor(w, h)
      w *= s
      h *= s
    }
  }
  let tilesDone = 0
  let lastProgressAt = 0
  post({ type: 'progress', id, tilesDone, tilesTotal })
  let img = src
  for (const s of stages) {
    img = await runNetwork(id, img, gray, s, () => {
      tilesDone++
      const now = performance.now()
      // A React render and a cross-worker message per tile do not improve the progress bar.
      if (tilesDone === tilesTotal || now - lastProgressAt >= 100) {
        lastProgressAt = now
        post({ type: 'progress', id, tilesDone, tilesTotal })
      }
    })
  }

  const outCanvas = new OffscreenCanvas(img.width, img.height)
  outCanvas.getContext('2d')!.putImageData(img, 0, 0)
  let encoded = await outCanvas.convertToBlob({ type: 'image/webp', quality: 0.92 })
  if (encoded.type !== 'image/webp') encoded = await outCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
  if (persist) await store(cacheKey, page, encoded)
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
        result = await serialized(() => process(msg.id, msg.cacheKeyBase, msg.page, msg.blob, msg.maxFactor, msg.persist))
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
