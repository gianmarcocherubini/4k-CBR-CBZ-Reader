---
cursor:
  subagentId: "bc-86e9febf-67a5-5993-99f8-ca47629cf557"
---

# Reader v1 build report (iPad CBZ/CBR PWA)

Branch: `cursor/comic-reader-pwa-f557` (6 commits on top of `main`, pushed).
Draft PR: **not created** — the PR tool refused: the project has no repository yet (remote is a temporary agent repo, `repoKind="agent_temp"`). Once the user creates the repository (Create repo pill), open the PR with the body in the last section.

## Delivered

- Vite 8 + React 19 + TS + Tailwind 4 + vite-plugin-pwa at repo root (official `create-vite` scaffold moved up). Dev server `127.0.0.1:4877`, preview `4878`.
- Library: import via file picker / drag&drop, magic-byte detection (ZIP, RAR4, RAR5; 7z/PDF named as unsupported), cover thumbnails, progress, delete, storage footer, install hint. `accept` filter disabled on iOS (unknown UTIs grey out files in the Files picker).
- 10 GB files, memory-bounded end to end:
  - Import = OPFS copy in a worker (`createSyncAccessHandle`, BYOB `Blob.stream()` reader reusing one 8 MB buffer, byte progress, pre-flight quota check, cleanup on failure); fallback IndexedDB `put(File)`; both paths e2e-tested.
  - "Apri senza importare" session mode (reads the picked File directly; progress keyed by name|size|mtime in localStorage).
  - CBZ: zip.js `BlobReader`, ZIP64, per-entry extraction.
  - CBR: node-unrar-js WASM in a worker with a **custom Blob-backed `Extractor`** (lazy `FileReaderSync` slices, 64 KB LRU header cache ≤ 24 MB, 0.5–8 MB read-ahead window, 64-bit offsets). Fresh extractor per page (the lib retains outputs otherwise). Solid and multi-volume RARs rejected with Italian messages.
  - **libarchive.js rejected**: 2.0.2 worker does `file.arrayBuffer()` + `archive_read_open_memory`; not WORKERFS, wasm32 4 GB cap. Not usable for the 10 GB requirement.
- Reader: RTL default, tap zones / swipe / keyboard / wheel, slider + counter, deterministic smart pairing (`layoutSpreads`: portrait paired, wide alone, offset toggle "Sfasa coppie" + settings toggle), single/double/auto, fit height/width/original (DPR-aware), pinch/pan/double-tap/ctrl-wheel zoom with **bake-to-layout on gesture end** (sharp re-raster), preload next 2 spreads + prev 1, LRU cache of 8 pages with object URL revocation, Wake Lock, auto-hide toolbars (mouse move/hover keeps them), page sizes persisted per book so pairing is stable across sessions.
- States: empty, import/copy progress, corrupt, unsupported, encrypted, empty archive, quota exceeded, missing file, page error + retry.
- Deploy: `.github/workflows/deploy.yml` (lint, typecheck, tests, build, Pages), `base` from `GITHUB_REPOSITORY`, `VITE_BASE` override. README (Italian): run, Pages setup, iPad install, **home-screen storage is separate from Safari's**.

## Verified (Chrome 148, Linux)

| Area | How | Result |
|---|---|---|
| Lint / typecheck / build | oxlint, `tsc -b`, `vite build` | clean; base-path build (`/repo/`) correct for manifest, worker + WASM URLs |
| Unit tests | Vitest, 32 tests | detect, natural sort, entry filter, ZIP/ZIP64/encrypted/empty/truncated, RAR5+RAR4 list/extract/partial reads/encryption, pairing |
| E2E flow | Playwright headless (1180×820 @2x), dev server + prod preview, OPFS and forced-IDB | import batch incl. corrupt/protected/non-archive → dialog text; 3 books × 19 pages; RTL tap zones (p2 right of p3); wide spread alone (`12`), pairing resumes `13-14`; offset toggle `1`↔`1-2`; zoom grows layout / reset; single mode; reload restores page; library `Pagina 17 di 19`; CBR native 1600×2400 incl. PNG page; RAR4 book; session mode leaves DB untouched; delete; SW active + offline shell; 0 console errors |
| Large files | 4.5 GB ZIP64 CBZ + 4.5 GB RAR5 CBR, pages after 4.5 GB padding, persistent profile | OPFS import ~38 s with byte progress; total Chrome RSS growth ≈ 340 MB (renderer JS heap ≈ 20 MB); pages at offsets > 4 GiB decode in both formats; CBR opened directly in 0.1 s. Before the BYOB fix the renderer spiked to 1.3 GB of garbage ArrayBuffers |
| Ephemeral quota | Playwright default context (~3 GB quota) | pre-flight check refused the 4.5 GB import with the Italian quota message (expected) |
| GUI walkthrough | headed Chrome on the desktop, recorded | see media |

## Not verified (no iPad)

Safari/iPadOS: OPFS sync-handle async quirks on iPadOS 15–16 (awaited defensively), `Blob.stream()` BYOB support (fallback present), Files-app picker, Wake Lock (16.4+), safe-area insets in standalone, real quota for the home-screen app, real touch pinch feel, Safari image-decoder downsampling of >16 MP images.

## Caveats to relay

- iPad quota is OS-decided; pre-17 iPadOS quotas were small. Escape hatch: "Apri senza importare". Home-screen app storage ≠ Safari storage (README + footer hint).
- CBR: memory bounded, but page N extraction re-scans N headers (cached after first pass); solid RAR refused; > 4 GiB relies on decoder 64-bit offsets (tested at 4.5 GB in Chrome only).
- Pairing when jumping into an unread region treats unknown pages as portrait; layout re-syncs once pages decode and sizes are persisted (design trade-off, documented in `spread.ts`).
- Fixture note for the video: printed labels skip "13" (wide image = pages 12–13), so labels after it read counter+1.

## Media (all verified present)

Store: `/cursor/stores/bc-e49a8089-4724-43a1-8857-0f717e022522/media/reader-v1/`
- `manga_reader_import_rtl_double_page_zoom_persistence_walkthrough.mp4` (1:09; ~8 s idle at start/end)
- `screenshot_reader_double_page_rtl.png`, `screenshot_reader_cover_offset_pairing_shift.png`, `screenshot_reader_wide_spread_alone.png`, `screenshot_reader_zoomed_ipad_landscape.png`, `screenshot_reader_settings_panel.png`, `screenshot_library_reading_progress.png`, `screenshot_import_errors_password_corrupt.png`, `screenshot_import_4gb_copy_progress.png`, `screenshot_offline_portrait_empty_library.png`

Same files under `/opt/cursor/artifacts/` (uploaded with this run).

## PR body to use once a repository exists

Title: `Manga/comic reader PWA v1: CBZ/CBR library and RTL reader for iPad` — base `main`, head `cursor/comic-reader-pwa-f557`, draft.

Body: the "Delivered", "Verified", "Not verified" and "Caveats" sections above, plus the media above as `<img>`/`<video>` tags pointing at `/opt/cursor/artifacts/<file>` (the PR tool rewrites them to public URLs).
