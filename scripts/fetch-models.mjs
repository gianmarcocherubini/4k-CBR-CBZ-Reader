// Fetches the assets of the "Qualità massima" tier, which are too large to commit:
//   public/models/realesrgan_x4plus_anime_6b.onnx   (17 MB) Real-ESRGAN anime 6B, see below
//   public/ort/ort-wasm-simd-threaded*.{mjs,wasm}   onnxruntime-web binaries (served same-origin, cached by the SW)
// Usage: node scripts/fetch-models.mjs   (npm run setup). Idempotent; a failure leaves the app working without the tier.
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const modelsDir = join(root, 'public', 'models')
const ortDir = join(root, 'public', 'ort')
mkdirSync(modelsDir, { recursive: true })
mkdirSync(ortDir, { recursive: true })

// Dynamic-shape ONNX export of RealESRGAN_x4plus_anime_6B.pth (xinntao/Real-ESRGAN, BSD-3),
// published as a release asset of this repository (see the models-v1 release notes).
const GAN_URL = 'https://github.com/gianmarcocherubini/4k-CBR-CBZ-Reader/releases/download/models-v1/realesrgan_x4plus_anime_6b.onnx'
const GAN_MODEL = join(modelsDir, 'realesrgan_x4plus_anime_6b.onnx')

async function fetchGan() {
  if (existsSync(GAN_MODEL) && statSync(GAN_MODEL).size > 10_000_000) {
    console.log('GAN model already present:', GAN_MODEL)
    return
  }
  const res = await fetch(GAN_URL, { redirect: 'follow' })
  if (!res.ok) throw new Error(`GET ${GAN_URL}: ${res.status}`)
  writeFileSync(GAN_MODEL, Buffer.from(await res.arrayBuffer()))
  console.log(`GAN model written: ${GAN_MODEL} (${statSync(GAN_MODEL).size} bytes)`)
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
  await fetchGan()
} catch (e) {
  console.error('setup incomplete:', e instanceof Error ? e.message : e)
  console.error('The app builds and runs without the "Qualità massima" tier; re-run `npm run setup` later.')
  process.exitCode = 0
}
