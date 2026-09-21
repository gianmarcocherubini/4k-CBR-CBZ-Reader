import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import splashDevices from './scripts/splash-devices.json' with { type: 'json' }

// Base path. The deploy workflow passes VITE_BASE from the Pages configuration: "/<repo>/" for the
// github.io project site, "/" once the custom domain is active. Without it, GitHub Pages' default.
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1]
const base = process.env.VITE_BASE ?? (repo ? `/${repo}/` : '/')

/** Canonical home of the app: Open Graph tags, and where an install on another host is pointed to. */
const SITE_URL = 'https://www.manga-dana.com'
const DESCRIPTION = 'Mangadana: lettore di fumetti e manga (CBZ/CBR) ad alta risoluzione per iPad'

/**
 * Head tags that depend on the base path or on the device table: iOS startup images (one <link>
 * per iPad size, orientation and appearance; PNGs from scripts/make-brand-assets.mjs) and the
 * Open Graph / Twitter card, which need absolute URLs.
 */
function brandHeadTags(): Plugin {
  const startupImages = splashDevices.flatMap((device) =>
    (['portrait', 'landscape'] as const).flatMap((orientation) =>
      (['light', 'dark'] as const).map((scheme) => {
        const [w, h] = orientation === 'portrait' ? [device.width, device.height] : [device.height, device.width]
        return {
          tag: 'link',
          attrs: {
            rel: 'apple-touch-startup-image',
            media: `screen and (prefers-color-scheme: ${scheme}) and (device-width: ${device.width}px) and (device-height: ${device.height}px) and (-webkit-device-pixel-ratio: ${device.scale}) and (orientation: ${orientation})`,
            href: `${base}splash/${w * device.scale}x${h * device.scale}-${scheme}.png`,
          },
          injectTo: 'head' as const,
        }
      }),
    ),
  )
  const meta = (attrs: Record<string, string>) => ({ tag: 'meta', attrs, injectTo: 'head' as const })
  const social = [
    meta({ property: 'og:type', content: 'website' }),
    meta({ property: 'og:site_name', content: 'Mangadana' }),
    meta({ property: 'og:title', content: 'Mangadana' }),
    meta({ property: 'og:description', content: DESCRIPTION }),
    meta({ property: 'og:url', content: `${SITE_URL}/` }),
    meta({ property: 'og:image', content: `${SITE_URL}/brand/social-preview.png` }),
    meta({ property: 'og:image:width', content: '1280' }),
    meta({ property: 'og:image:height', content: '640' }),
    meta({ property: 'og:image:alt', content: 'La corona di Mangadana su fondo scuro' }),
    meta({ property: 'og:locale', content: 'it_IT' }),
    meta({ name: 'twitter:card', content: 'summary_large_image' }),
    { tag: 'link', attrs: { rel: 'canonical', href: `${SITE_URL}/` }, injectTo: 'head' as const },
  ]
  return { name: 'mangadana:brand-head-tags', transformIndexHtml: () => [...social, ...startupImages] }
}

// Shown in the library footer, so an installed (and possibly stale) app can be told apart.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
function commitHash(): string {
  const sha = process.env.GITHUB_SHA
  if (sha) return sha.slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'dev'
  }
}
const build = `${commitHash()} · ${new Date().toISOString().slice(0, 10)}`

export default defineConfig({
  base,
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_BUILD__: JSON.stringify(build),
    __SITE_URL__: JSON.stringify(SITE_URL),
  },
  plugins: [
    react(),
    tailwindcss(),
    brandHeadTags(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        id: './',
        name: 'Mangadana',
        short_name: 'Mangadana',
        description: DESCRIPTION,
        lang: 'it',
        dir: 'ltr',
        start_url: './',
        scope: './',
        // Fullscreen where the platform honours it (Android/desktop); iOS treats it as standalone
        // and relies on apple-mobile-web-app-status-bar-style=black-translucent for the full height.
        display: 'fullscreen',
        display_override: ['fullscreen', 'standalone'],
        orientation: 'any',
        background_color: '#f7f7f4',
        theme_color: '#f7f7f4',
        categories: ['books', 'entertainment'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        // .bin: the 1.2 MB Real-ESRGAN anime v3 weights, so "Qualità massima" works offline too. The
        // 9 MB 6B weights are optional: fetched (and runtime-cached) the first time that model is chosen.
        // Startup images are read by iOS when the app is added to the Home screen, the brand images
        // by link previews and the README: neither belongs in the app's offline cache.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm,bin,woff2}'],
        globIgnores: ['**/realesrgan-x4plus-anime-6b*', '**/splash/**', '**/brand/**'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: 4877,
    strictPort: true,
    // Playwright writes traces while tests run against this server: never reload for them.
    watch: { ignored: ['**/test-results/**', '**/playwright-report/**', '**/e2e/**'] },
  },
  preview: { host: '127.0.0.1', port: 4878, strictPort: true },
  worker: { format: 'es' },
  // The Anime4K shader library is a 3.4 MB chunk loaded on demand (and precached for offline use).
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
})
