---
cursor:
  subagentId: "bc-86e9febf-67a5-5993-99f8-ca47629cf557"
---

# Reader v2 — AI super resolution (build report)

Branch: `cursor/ai-upscaling-f557`, stacked on `cursor/comic-reader-pwa-f557` (3 commits: Anime4K tier, waifu2x tier + service worker, polish). Pushed to the current remote; no PR (no GitHub repo yet). Follows [`docs/ai-upscaling-feasibility.md`](../docs/ai-upscaling-feasibility.md); reused the spike's tiling logic (`cropIn=18`, 256 px tiles, replicate padding), model choice and ORT setup; the Anime4K integration was rewritten around strips.

## What shipped

### Part A — "Super risoluzione" (default on)
- `anime4k-webgpu` `CNNx2` on WebGPU; **WebGL2 fallback runs the official Anime4K GLSL hook shaders** (M/VL/UL files vendored under `src/lib/upscale/shaders/anime4k/`, MIT) through a small in-repo mpv-hook runner (`glslHooks.ts` + `webgl2Backend.ts`) — same approach as monyone/Anime4K.js, but it slots into the same strip/composite pipeline. Validated against the WebGPU output: **64.4 dB PSNR** between the two backends on the same page. No GPU path → plain high-quality browser scaling and the settings say so (`SR n/d`).
- Target = displayed device pixels (CSS × zoom × DPR), capped at 2× the source, 16 MP canvas area and `maxTextureDimension2D`; pages already at display resolution are left alone (`SR nativo`). Zoom bake re-runs at the larger target; results within 15 % are reused.
- **Strips**: pages are processed in 288-row bands with 24-row overlap; one pipeline (and one set of `rgba16float` intermediates) per page width, reused for every band and page → GPU memory tens of MB instead of 0.3–0.65 GB; pipeline build cost paid once per width. Output composited with 2×2 supersampling into an `rgba8unorm` texture and read back through a buffer (`transferToImageBitmap` on a WebGPU canvas destroyed the device under SwiftShader, so it is not used).
- **Auto level**: starts at **VL**; after the first timed page, the strongest level whose estimated cost stays under 100 ms/page (UL only when the probe allows), capped to M/VL when `navigator.deviceMemory` ≤ 2/4 GB. Manual M/VL/UL override. Engine: priority queue (current spread before preloads), LRU of 4 enhanced canvases, per-level ms/MP EMA.
- UI: toggle + level control + status line in the settings panel; badge in the bottom bar (`SR ×2 VL`, `SR…`, `SR nativo`, `SR n/d`, `SR ×2 CUNet`). Test hooks: `?sr=webgl2`, `?sr=off`.

### Part B — "Qualità massima (lenta)" (experimental, off by default)
- waifu2x **CUNet art/scale2x** (nunif ONNX, 5.3 MB, fetched by `scripts/fetch-models.sh` into git-ignored `public/models/`, also in the deploy workflow; build tolerates a failed download).
- `onnxruntime-web` 1.30 in a dedicated worker: WebGPU EP when a non-software adapter exists (webgpu bundle + 27 MB asyncify wasm), otherwise WASM EP (wasm bundle + 14 MB wasm), threads = min(4, cores) when `crossOriginIsolated`. 256 px tiles, replicate padding, grayscale pages forced back to gray (colour drift guard from the report). Result encoded as WebP (JPEG fallback) and written to **OPFS `sr-cache/<book>/<page>`**; served from there forever; book deletion removes the folder.
- WebGPU EP: next pages prefetched while reading. WASM EP: only the **"Pre-elabora questo volume"** batch job (progress pages/tiles/s-per-page, cancel, Wake Lock while running). Cached results take precedence over Anime4K for the displayed page (badge `SR ×2 CUNet`).
- **COOP/COEP via our own service worker**: switched vite-plugin-pwa to `injectManifest` (`src/sw.ts`, own tsconfig): app-shell precache (30 entries, 4.9 MB incl. the Anime4K chunk), `CacheFirst` runtime cache for `ort-wasm-simd-threaded*.wasm` and `models/*.onnx` (never precached), and injection of `Cross-Origin-Embedder-Policy: require-corp` / `Cross-Origin-Opener-Policy: same-origin` / CORP on same-origin responses. Dev/preview servers send the same headers.

### README
New sections: super risoluzione, qualità massima, offline upscaling on the PC (realesrgan-ncnn-vulkan / chaiNNer / nunif + import the upscaled CBZ), setup (`npm run setup`), flags for testing, Pages note about COOP/COEP from the SW, iPadOS 26 note.

## Measured here (Chrome 148 headless, SwiftShader software GPU, 4 vCPU — CPU-emulated GPU, only for validation)
| Item | Result |
|---|---|
| Anime4K 800×1200 → 1573×2360, WebGPU | M ≈ 1.2–2.0 s, VL ≈ 2.8–3.6 s, UL ≈ 6.8–7.8 s (1.3 s/MP for M) |
| Same, WebGL2 runner | M ≈ 1.0 s; output identical to WebGPU (64.4 dB) |
| Downsampled enhanced vs source (tiling/orientation check) | 38.2 dB (bicubic round-trip reference 32.4 dB) |
| Auto level | starts VL → probe measures ~3.6 s → settles on M (budget 100 ms) |
| Preload | next page enhanced 6–19 ms after turning |
| waifu2x CUNet, WASM EP, 4 threads | 800×1200 page = 24 tiles ≈ 15–16 s/page; 6-page volume batched in 92 s; runtime+model ready in 0.5 s locally |
| SW/COI (headers stripped to mimic GitHub Pages) | not isolated on first load → SW active → isolated after one reload; OPFS import OK under COEP; ORT wasm + model in `ai-assets-v1`, absent from precache; offline shell + library OK |
| Peak (no regressions) | v1 flow e2e still green with SR on; 47 unit tests; lint/typecheck/build clean |

Extrapolations for iPad are the report's (Anime4K VL 20–150 ms, UL 45–330 ms; CUNet WebGPU 4–25 s/page, WASM 4-thread 15–60 s/page).

## Needs a real iPad
- Safari 26 WebGPU: `rgba16float` storage textures with 24+ compute passes per strip, `copyTextureToBuffer` readback, `requestAdapter` in the ORT worker, ORT WebGPU EP kernels on WebKit (report flagged f16/subgroups risk).
- WebGL2 path on iPadOS 17/18: `EXT_color_buffer_float`, 25 fragment programs (UL) compile time, OffscreenCanvas `transferToImageBitmap`.
- Frame-time probe → real auto level; whether UL fits under 100 ms on M-series.
- COOP/COEP injected by the SW → `crossOriginIsolated` and SharedArrayBuffer on iPadOS; WASM thread count; WebP encoding via `OffscreenCanvas.convertToBlob` (JPEG fallback in place).
- Memory under jetsam with the 4-canvas LRU (≈ 32 MB each at 8 MP) + OPFS-cached 2× pages.

## Deviations from the report (deliberate)
- WebGL2 fallback uses the official GLSL through an in-repo runner instead of the monyone/Anime4K.js package (video-centric API, no strip tiling); equivalent output proven numerically.
- Anime4K output goes through buffer readback + 2D canvas instead of a WebGPU canvas (device loss seen with `transferToImageBitmap`).

## Media (all verified present)
`/cursor/stores/bc-e49a8089-4724-43a1-8857-0f717e022522/media/reader-v2-upscaling/`
- `super_resolution_toggle_levels_and_max_quality_batch_walkthrough.mp4` (1:50; ~18 s idle at start, ~8 s at end)
- `comparison_crops_original_bicubic_anime4k_vl_ul_cunet.png` (3 regions × 5 columns, 2× output at 2× nearest magnification)
- `screenshot_sr_settings_enhanced_vl_zoomed.png`, `screenshot_sr_toggle_off_same_zoom.png`, `screenshot_sr_double_page_zoomed_ipad_portrait.png`, `screenshot_sr_webgl2_fallback_settings.png`, `screenshot_sr_unavailable_no_gpu.png`, `screenshot_max_quality_batch_progress_cunet_badge.png`, `screenshot_max_quality_batch_ipad_portrait.png`

Same files under `/opt/cursor/artifacts/`.
