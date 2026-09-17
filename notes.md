## Reader (PWA)
- [ ] v1 built and verified on branch `cursor/comic-reader-pwa-f557`, PR blocked until GitHub access exists
- [ ] Super resolution built and verified on branch `cursor/ai-upscaling-f557` (stacked on v1), PR blocked the same way, demo in [walkthrough video](/cursor/stores/bc-e49a8089-4724-43a1-8857-0f717e022522/media/reader-v2-upscaling/super_resolution_toggle_levels_and_max_quality_batch_walkthrough.mp4)
- [ ] Test on the real iPad after deploy (SR speed and UL fit, WebGPU on Safari 26, storage quota, Files picker, pinch feel)
- [x] Smart double page (portrait paired, landscape alone, cover offset toggle) — shipped in v1, seen in [walkthrough video](/cursor/stores/bc-e49a8089-4724-43a1-8857-0f717e022522/media/reader-v1/manga_reader_import_rtl_double_page_zoom_persistence_walkthrough.mp4)
- [x] [Fattibilità AI upscaling](/cursor/stores/bc-e49a8089-4724-43a1-8857-0f717e022522/docs/ai-upscaling-feasibility.md) — Anime4K default, waifu2x CUNet experimental, Real-ESRGAN left on the PC; GPU timings are estimates until tested on the iPad

## GitHub and deploy
- [ ] Waiting on Gianmarco: give access to [4k-CBR-CBZ-Reader](https://github.com/gianmarcocherubini/4k-CBR-CBZ-Reader) (private) via GitHub App link, Cursor secret, or self-hosted PC worker; token file on his PC is unreachable from the cloud
- [ ] Hosting decision pending: Pages needs public repo or GitHub Pro, else Cloudflare Pages / Vercel
- [ ] [Reader worker](https://cursor.com/agents/bc-86e9febf-67a5-5993-99f8-ca47629cf557) idle with both branches ready, will push and open PRs once access lands

## Open with Gianmarco
- [ ] iPad model / iPadOS version still unknown (WebGPU needs iPadOS 26+)
- [ ] [Project context](/cursor/stores/bc-e49a8089-4724-43a1-8857-0f717e022522/docs/project-context.md) — constraints and decisions recorded, update as choices land
