import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Base path: GitHub Pages serves project sites under /<repo>/. Override with VITE_BASE.
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1]
const base = process.env.VITE_BASE ?? (repo ? `/${repo}/` : '/')

export default defineConfig({
  base,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icons/*.png', 'icons/*.svg'],
      manifest: {
        id: './',
        name: '4K CBR/CBZ Reader',
        short_name: 'Reader',
        description: 'Lettore di fumetti e manga (CBZ/CBR) ad alta risoluzione per iPad',
        lang: 'it',
        dir: 'ltr',
        start_url: './',
        scope: './',
        // Fullscreen where the platform honours it (Android/desktop); iOS treats it as standalone
        // and relies on apple-mobile-web-app-status-bar-style=black-translucent for the full height.
        display: 'fullscreen',
        display_override: ['fullscreen', 'standalone'],
        orientation: 'any',
        background_color: '#ffffff',
        theme_color: '#f2f2f7',
        categories: ['books', 'entertainment'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        // .bin: the 1.2 MB Real-ESRGAN weights, so "Qualità massima" works offline too.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm,bin,woff2}'],
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
