# AI super-resolution of manga pages in a Safari/iPadOS PWA — feasibility spike

Date: 2026-09-17 · Prototype: branch `spike/ai-upscaling` (Vite + TypeScript, no PR) · Media: [`media/upscaling-spike/`](../media/upscaling-spike/)

Question: can a home-screen PWA on iPad upscale 1100–1600 px manga pages 2x (target 2360x1640 – 2732x2048 displays) with AI, entirely in the browser?
Answer: **yes for Anime4K-class shaders (ship as default), maybe for waifu2x-class CNNs (experimental, cached/prefetched), no for Real-ESRGAN-class models (leave on the PC).**

## Recommendation

| Tier | What | Why |
|---|---|---|
| **Default** | **Anime4K `Upscale_CNN_x2` (VL; UL on M-series) via WebGPU compute** using [`anime4k-webgpu`](https://www.npmjs.com/package/anime4k-webgpu) (MIT, 0.9 MB gzipped, weights inlined). Run at render time on the GPU texture and draw straight to the canvas — no CPU readback, nothing to cache. Fallback: canvas bicubic (or the WebGL2 port [monyone/Anime4K.js](https://github.com/monyone/Anime4K.js), MIT) on iPadOS < 26. | +8–10 dB PSNR over bicubic on line art (27.5 vs 18.9 dB synthetic; 28.9 vs 21.0 dB real page). Cost ≈ 22–50 GMAC/page → estimated **~50–250 ms/page on an iPad GPU** (see extrapolation). Lines and lettering come out crisp; screentones get slightly flattened to gray (see crops). |
| **Experimental (opt-in, iPadOS 26+, M-series)** | **waifu2x CUNet `art/scale2x`** ([nunif](https://github.com/nagadomi/nunif) ONNX, MIT, 5 MB) through `onnxruntime-web` WebGPU EP, tiled 256 px, run in a Worker on the *next* pages and cached as 2x JPEG/WebP in OPFS. WASM fallback only as a "batch upscale this volume while charging" job (needs Wake Lock). | Best quality of everything tested (**32.5 dB synthetic, 32.1 dB real page**; keeps screentone texture). But ≈2.4 TMAC/page → **~4–9 s/page on an M1 GPU estimate**, 20–45 s/page on 4 WASM threads here, 70–100 s single-threaded; plus a 25 MB (≈6 MB gzipped) runtime download. Never on the page-turn path. |
| **Leave on the PC** | RealESRGAN_x4plus_anime_6B, realesr-animevideov3, waifu2x swin_unet. Use realesrgan-ncnn-vulkan / chaiNNer / nunif GUI offline and import the upscaled CBZ. | 6B: 19 TMAC/page (5 min/page on 4 WASM threads here; ~40–70 s even on an M1 GPU estimate) **and it erases screentones into white blotches** (full-page PSNR 14.5 dB, below nearest-neighbour). animevideov3: cheap-ish but no better than Anime4K UL (25.9 vs 27.5 dB) at 35x the cost. swin_unet: 20 MB, 1.9 s/tile, transformer ops (ScatterND/Gather) are a WebGPU-EP fallback risk, quality ≤ CUNet. |

Implementation notes for the default tier: keep one Anime4K pipeline per page size (shader build is a one-off 0.3–1.8 s); the library keeps every intermediate `rgba16float` texture alive (≈22 MB each at 1400x2000 → ~0.3 GB (M) to ~0.65 GB (UL) resident) so on 3–4 GB iPads prefer M/VL or process in horizontal strips; feature-detect `navigator.gpu` and fall back to bicubic.

## Measured numbers

Environment caveat: this VM has **no GPU** (4 vCPU Intel Xeon, 16 GB, headless Chrome 148). WebGPU ran on Chrome's SwiftShader software Vulkan adapter, so all "GPU" timings below are CPU-emulated and only useful to validate the analytical MAC counts; iPad GPU numbers are extrapolations. WASM timings are real CPU numbers (SIMD, 4 threads vs 1).

### Quality (luma PSNR dB / SSIM, higher is better)

| Method | Synthetic page 1400x2000, JPEG q90 in, GT = 2x vector render | Real page 540x720 → 1080x1440, GT = original | Cost per page (2.8 MP input) |
|---|---|---|---|
| Nearest 2x | 17.5 / 0.91 | 20.1 / — | — |
| Bicubic 2x (canvas `imageSmoothingQuality: high`) | 18.9 / 0.914 | 21.0 / 0.898 | ~10 ms |
| **A: Anime4K CNNx2 M** | 25.0 / 0.978 | 27.1 / 0.967 | 5.8 GMAC |
| **A: Anime4K CNNx2 VL** | 27.0 / 0.985 | 28.2 / 0.973 | 22 GMAC |
| **A: Anime4K CNNx2 UL** | **27.5 / 0.987** | **28.9 / 0.976** | 50 GMAC |
| A: Anime4K Mode A preset (restore + upscale) | 23.0 / 0.967 | 24.0 / 0.939 | ~55 GMAC |
| B: realesr-animevideov3 x4 → box 2x | 25.9 / 0.986 | 26.8 / 0.962 | 1.7 TMAC |
| **B: waifu2x CUNet art 2x** | **32.5 / 0.993** | **32.1 / 0.980** | 2.4 TMAC |
| B: waifu2x swin_unet art_scan 2x | 31.2 / 0.995 | 28.7 / 0.976 | 3.8 TMAC |
| B: RealESRGAN_x4plus_anime_6B x4 → box 2x | **14.5** / 0.867 (screentones erased) | 24.8 / 0.951 | 19 TMAC |

Notes: PSNR against a near-binary vector ground truth rewards edge re-sharpening, which is exactly what line art needs, but read it together with the crops. The 6B model scored 25.9 dB on a 512² crop without dense tones and collapsed on the full page: it removes halftone dots as if they were compression noise.

### Latency and memory measured here

Anime4K on SwiftShader (full 1400x2000 page, steady-state median of 3): M 2.2 s · VL 6.6 s · UL 12.6 s · Mode A 12.8 s. Pipeline build (shader compile, once per size): 0.27 / 0.9 / 1.8 s. Implied throughput 2.6–4 GMAC/s — consistent with the analytical MAC counts (M 2.1k, VL 8.0k, UL 17.8k MAC per input pixel, counted from the GLSL). GPU-process RSS peaked at +0.65 GB (M) to +1.4 GB (UL) over baseline on SwiftShader.

onnxruntime-web 1.30, WASM EP, SIMD, per tile (median):

| Model | Tile | 4 threads | 1 thread | Full page 1400x2000 (4 thr) | Peak renderer RSS |
|---|---|---|---|---|---|
| realesr-animevideov3 x4 (2.4 MB) | 256 → 1024 | 0.57 s | 2.19 s | 54 tiles, **39 s** | 0.65–0.75 GB |
| waifu2x CUNet 2x (5.1 MB) | 256 → 440 | 0.61 s | 2.29 s | 70 tiles, **43 s** | 0.9 GB |
| waifu2x swin_unet art_scan 2x (20 MB) | 256 → 480 | 1.94 s | 5.88 s | 54 tiles, **107 s** | 2.4 GB |
| RealESRGAN x4plus anime 6B (17 MB) | 192 → 768 | 2.97 s | 12.2 s | 96 tiles, **287 s** | 2.4 GB |

The WASM heap never shrinks, so swin_unet/6B leave the tab at 2–2.5 GB — above what Safari tolerates on 3–4 GB iPads (jetsam). CUNet/animevideov3 stay under 1 GB.

ORT WebGPU EP (native Dawn-in-WASM build) functional check: realesr-animevideov3 and waifu2x CUNet run and match the WASM EP output within rounding (68.9 dB, max diff 5/255); swin_unet runs but ORT warns that some nodes were not assigned to WebGPU (CPU fallback). On SwiftShader it needs `env.webgpu.forceFallbackAdapter = true` (otherwise session creation hangs) and takes 25–30 s per 128 px tile — 50x slower than the WASM CPU path — so it was not used for timing.

Download sizes (raw / gzip / brotli): ORT WebGPU runtime `ort-wasm-simd-threaded.asyncify.wasm` 25.5 / 6.3 / 4.5 MB; WASM-only runtime 13.6 / 3.5 / 2.6 MB; anime4k-webgpu 3.3 / 0.9 / 0.85 MB; models compress <10% (sizes above). All cacheable by the service worker; GitHub Pages compression of `.wasm` should be verified.

### iPad extrapolation (estimates, not measurements)

Method: analytical MACs per page × assumed effective throughput. Apple does not publish FLOPS; commonly cited FP32 peaks: A14/A15-class iPad Air 4 / mini 6 ≈ 1–1.5 TFLOPS, M1/M2 iPad Air 5 / Pro ≈ 2.6–3.6 TFLOPS, M4 iPad Pro ≈ 4+ TFLOPS. Assumed efficiency: 15–30% for Anime4K's texture-sampling compute shaders, 20–40% for ORT's WGSL conv kernels. CPU: one M1 performance core ≈ 1.5–2x this Xeon vCPU on WASM SIMD; 4 threads require cross-origin isolation (see platform facts).

| | A14/A15 iPad | M1/M2 iPad | M4 iPad Pro |
|---|---|---|---|
| Anime4K VL (22 GMAC) | 50–150 ms | 20–55 ms | 15–35 ms |
| Anime4K UL (50 GMAC) | 110–330 ms | 45–125 ms | 30–80 ms |
| waifu2x CUNet, ORT WebGPU (2.4 TMAC) | 10–25 s | 4–9 s | 3–6 s |
| waifu2x CUNet, ORT WASM 1 thread | 100–150 s | 70–100 s | 50–80 s |
| waifu2x CUNet, ORT WASM 4 threads (COOP/COEP) | 40–60 s | 20–35 s | 15–25 s |
| RealESRGAN 6B, ORT WebGPU (19 TMAC) | 80–200 s | 35–75 s | 25–50 s |

Reading: Anime4K fits inside a page turn on every iPad that has WebGPU (iPadOS 26+). CUNet is a prefetch/batch feature even on M-series. The 6B model is not viable on device regardless of quality.

## Visual comparisons

All crops are 300x170 px windows of the 2x output shown at 2x nearest magnification; columns: original (nearest), bicubic, Anime4K M, Anime4K UL, waifu2x CUNet, waifu2x swin_unet, realesr-animevideov3, RealESRGAN 6B, ground truth when available.

Synthetic page (line art + dot/line screentones + 8–16 px text, JPEG q90 input, vector ground truth):
- [synthetic-text-11px-9px.png](../media/upscaling-spike/synthetic-text-11px-9px.png) — 11 px serif and 9 px sans captions: Anime4K/CUNet re-sharpen glyphs; Real-ESRGAN rounds them.
- [synthetic-screentone-dots.png](../media/upscaling-spike/synthetic-screentone-dots.png) — fine dot tones: CUNet keeps dots, Anime4K flattens, 6B erases.
- [synthetic-face-lineart.png](../media/upscaling-spike/synthetic-face-lineart.png) — eyes/hair strokes over speed lines.
- [synthetic-tiny-text-8px.png](../media/upscaling-spike/synthetic-tiny-text-8px.png) — furigana-size 8 px text (the readability limit).
- [synthetic-fullpage-gt-vs-cunet-vs-realesrgan6b.png](../media/upscaling-spike/synthetic-fullpage-gt-vs-cunet-vs-realesrgan6b.png) — whole page at 1/4 scale: the 6B screentone erasure.

Real digital manga page (Go Go! Encyclopedia Girls p.3, CC BY-SA 4.0, 1080x1440):
- [gogohalf-face-vs-original.png](../media/upscaling-spike/gogohalf-face-vs-original.png), [gogohalf-bubble-text-vs-original.png](../media/upscaling-spike/gogohalf-bubble-text-vs-original.png) — 540x720 input upscaled back to 1080x1440 next to the original (with PSNR).
- [gogo-face-screentone.png](../media/upscaling-spike/gogo-face-screentone.png), [gogo-bubble-text.png](../media/upscaling-spike/gogo-bubble-text.png), [gogo-sfx-and-uniform.png](../media/upscaling-spike/gogo-sfx-and-uniform.png) — native 1080 → 2160 (no ground truth; visual only).

Real 1902 scan (Kitazawa Rakuten, *Tagosaku to Mokube*, public domain; only 600x853 available — a real scan with paper texture and print halftone, but below the target resolution):
- [tagosaku-1902-scan-text.png](../media/upscaling-spike/tagosaku-1902-scan-text.png), [tagosaku-1902-scan-face.png](../media/upscaling-spike/tagosaku-1902-scan-face.png) — vertical Japanese text and brush lines.

Qualitative summary: bicubic is soft; Anime4K gives the crispest lines and lettering but slightly "cleans" halftone tones into flat gray (UL keeps dots better than M); waifu2x CUNet is the most faithful overall (edges + tones); swin_unet is similar but slower; realesr-animevideov3 and 6B produce smooth, plastic-looking art and remove screentones (6B catastrophically on dense tones, where it also hallucinates a diagonal line pattern and alters 8 px glyph shapes). The RGB Real-ESRGAN models also add colour moiré (purple/blue) on gray pages — any B path should feed luma only or convert the output back to grayscale.

## Platform facts (primary sources)

- **WebGPU on iPadOS**: shipped enabled by default in **Safari 26.0 / iPadOS 26 (released 2025-09-15)**; before that only behind a feature flag. Sources: [WebKit Features in Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/), [Safari 26.0 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes) ("Added support for WebGPU"), [MDN BCD `api.GPU`: Safari iOS 26](https://developer.mozilla.org/docs/Web/API/GPU), [caniuse webgpu](https://caniuse.com/webgpu) (ios_saf 26.0 = y). Also available in workers (`WorkerNavigator.gpu`, Safari 26). Users on iPadOS 17/18 get no WebGPU → bicubic/WebGL fallback required.
- **OPFS**: `navigator.storage.getDirectory()`, `FileSystemFileHandle.createSyncAccessHandle()` (workers only) and `FileSystemSyncAccessHandle` since **Safari 15.2**; `createWritable()` / `FileSystemWritableFileStream` only since **Safari 26**. Sources: MDN BCD [`createSyncAccessHandle`](https://developer.mozilla.org/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle), [`createWritable`](https://developer.mozilla.org/docs/Web/API/FileSystemFileHandle/createWritable), [`getDirectory`](https://developer.mozilla.org/docs/Web/API/StorageManager/getDirectory). The File System *Access* API (pickers, `showOpenFilePicker`) is not in Safari ([caniuse native-filesystem-api](https://caniuse.com/native-filesystem-api)).
- **Storage quota (Safari 17+ / iPadOS 17+)**: per WebKit's [Updates to Storage Policy (2023-08-10)](https://webkit.org/blog/14403/updates-to-storage-policy/): in a browser app (Safari) the **origin quota is up to 60% of total disk** and the overall quota 80%; in other WebKit apps (in-app browsers) 15% / 20%; **a Home Screen web app gets the same quota as the site in Safari**; Safari 17 no longer prompts for more space; `navigator.storage.estimate()` is supported and `persist()` is granted heuristically (e.g. when installed to the Home Screen). Eviction is LRU per origin under overall-quota/storage pressure, and by ITP: [7-day cap on script-writable storage](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/) (IndexedDB, localStorage, Cache, SW) after 7 days of Safari use without interaction — **explicitly not intended to apply to web apps added to the Home Screen**, which keep their own usage counter. Practical consequence: install to Home Screen, call `persist()`, and expect tens of GB on a 256 GB iPad.
- **WASM for onnxruntime-web on Safari**: SharedArrayBuffer and WASM threads since 15.2 (requires COOP/COEP; GitHub Pages cannot set headers → use a `coi-serviceworker`), fixed-width SIMD since 16.4; JS Promise Integration (ORT's `jspi` build) is listed by MDN BCD as Safari 27. ORT 1.30's WebGPU EP is the native Dawn build (Asyncify); the older JSEP binary no longer loads through the webgpu bundle.

## Caveats and risks

- No real GPU was available; everything GPU-side is SwiftShader-validated + analytical. First thing to do on the actual iPad: run the prototype page (`npm run dev`, open on the iPad over LAN with HTTPS or `localhost` tunnelling) and read `window.spike.anime4k('synthetic','CNNx2UL')` / `window.spike.ort('synthetic-crop','waifu2x_cunet_art_2x','webgpu')` timings.
- Safari WebGPU is new (26.0); anime4k-webgpu compute shaders are plain WGSL and should work, but ORT's WebGPU kernels (f16, subgroups, large storage buffers) have not been tested on WebKit here — treat tier 2 as unverified until run on device.
- Memory is the binding constraint on non-M iPads: keep Anime4K to M/VL or strip-tile it; keep ORT to ≤256 px tiles and the small models; never run 6B/swin_unet in the tab.
- Anime4K de-tones slightly; if screentone fidelity matters more than crisp lines, CUNet is the better default *when it can be prefetched*.
- The only public-domain real scan found was 600 px wide; the 1080 px CC BY-SA digital page stands in for a typical CBZ page. Both behave like the synthetic page.

## Reproduce

```bash
git checkout spike/ai-upscaling && npm install && npm run setup   # fetches the 4 ONNX models (46 MB) + copies ORT binaries
npm run dev                                                         # http://127.0.0.1:47317 — UI + window.spike API
node scripts/bench.mjs --sources synthetic,gogo-half --only base,a4k,ort --eps wasm --threads 4   # results -> out/results.json, PNGs -> out/png
python3 scripts/compare.py                                          # crops -> out/compare
python3 scripts/model-macs.py                                       # analytical MACs per tile
```

Raw results of this run: `out/results.json` is not committed; the numbers above are copied from it (run of 2026-09-17, Chrome 148 headless, SwiftShader).
