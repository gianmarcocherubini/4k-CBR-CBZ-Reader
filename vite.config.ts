import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Base path: GitHub Pages serves project sites under /<repo>/. Override with VITE_BASE.
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1]
const base = process.env.VITE_BASE ?? (repo ? `/${repo}/` : '/')

// Cross-origin isolation (needed for SharedArrayBuffer / WASM threads). In production the
// service worker injects the same headers on static hosts that cannot set them.
const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

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
        display: 'standalone',
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
        globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm,woff2}'],
        // The ONNX runtime (14–26 MB) and the model are runtime-cached on first use, never precached.
        // onnxruntime-web also makes Vite emit hashed copies of its wasm into assets/: ignore those too.
        globIgnores: ['**/ort/**', '**/models/**', '**/assets/ort-wasm-*'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: 4877,
    strictPort: true,
    headers: coiHeaders,
    // Playwright writes traces while tests run against this server: never reload for them.
    // The large AI binaries never change at runtime (and Windows locks them while they are copied).
    watch: { ignored: ['**/test-results/**', '**/playwright-report/**', '**/e2e/**', '**/public/ort/**', '**/public/models/**'] },
  },
  preview: { host: '127.0.0.1', port: 4878, strictPort: true, headers: coiHeaders },
  worker: { format: 'es' },
  // The Anime4K shader library is a 3.4 MB chunk loaded on demand (and precached for offline use).
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
})
