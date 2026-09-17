// Fetches the assets of the "Qualità massima" tier, which are too large to commit:
//   public/models/waifu2x_cunet_art_scale2x.onnx  (5.2 MB, nunif, MIT) — extracted from the 700 MB
//                                                  release zip with HTTP range requests (only the entry is read)
//   public/ort/ort-wasm-simd-threaded*.{mjs,wasm}   onnxruntime-web binaries (served same-origin, cached by the SW)
// Usage: node scripts/fetch-models.mjs   (npm run setup). Idempotent; a failure leaves the app working without the tier.
import { BlobWriter, configure, HttpRangeReader, ZipReader } from '@zip.js/zip.js'
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

configure({ useWebWorkers: false })
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const modelsDir = join(root, 'public', 'models')
const ortDir = join(root, 'public', 'ort')
mkdirSync(modelsDir, { recursive: true })
mkdirSync(ortDir, { recursive: true })

const ZIP_URL = 'https://github.com/nagadomi/nunif/releases/download/0.0.0/waifu2x_onnx_models_20250502.zip'
const ENTRY = 'onnx_models/cunet/art/scale2x.onnx'
const MODEL = join(modelsDir, 'waifu2x_cunet_art_scale2x.onnx')

async function fetchModel() {
  if (existsSync(MODEL) && statSync(MODEL).size > 1_000_000) {
    console.log('model already present:', MODEL)
    return
  }
  const head = await fetch(ZIP_URL, { method: 'HEAD', redirect: 'follow' })
  if (!head.ok) throw new Error(`HEAD ${ZIP_URL}: ${head.status}`)
  const reader = new ZipReader(new HttpRangeReader(head.url, { useXHR: false }))
  const entries = await reader.getEntries()
  const entry = entries.find((e) => e.filename === ENTRY)
  if (!entry) throw new Error(`${ENTRY} not found in the archive`)
  const blob = await entry.getData(new BlobWriter())
  await reader.close()
  writeFileSync(MODEL, Buffer.from(await blob.arrayBuffer()))
  console.log(`model written: ${MODEL} (${blob.size} bytes)`)
}

function copyOrt() {
  const src = join(root, 'node_modules', 'onnxruntime-web', 'dist')
  // The two entry bundles are imported by URL at runtime (never bundled by Vite, which would
  // otherwise emit duplicate hashed copies of the 14–27 MB wasm files into dist/assets).
  const files = [
    'ort.webgpu.bundle.min.mjs',
    'ort.wasm.bundle.min.mjs',
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.wasm',
    'ort-wasm-simd-threaded.asyncify.mjs',
    'ort-wasm-simd-threaded.asyncify.wasm',
  ]
  for (const f of files) {
    copyFileSync(join(src, f), join(ortDir, f))
    console.log('copied', f)
  }
}

try {
  copyOrt()
  await fetchModel()
} catch (e) {
  console.error('setup incomplete:', e instanceof Error ? e.message : e)
  console.error('The app builds and runs without the "Qualità massima" tier; re-run `npm run setup` later.')
  process.exitCode = 0
}
