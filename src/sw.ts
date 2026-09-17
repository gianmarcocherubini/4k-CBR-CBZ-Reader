/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core'
import { addPlugins, cleanupOutdatedCaches, createHandlerBoundToURL, type PrecacheEntry, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<PrecacheEntry | string> }

self.skipWaiting()
clientsClaim()

/**
 * Cross-origin isolation headers. Static hosts (GitHub Pages) cannot set them, but a service
 * worker can add them to every same-origin response, which unlocks SharedArrayBuffer / WASM
 * threads after the first reload. All resources are same-origin, so require-corp is safe.
 */
function withCoi(response: Response): Response {
  if (!response || response.status === 0 || response.type === 'opaque' || response.type === 'opaqueredirect') return response
  const headers = new Headers(response.headers)
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Resource-Policy', 'same-origin')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

const coiPlugin = {
  handlerWillRespond: async ({ response }: { response: Response }) => withCoi(response),
}

addPlugins([coiPlugin])
cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// App shell for deep links (#/read/... is a hash route, so only index.html is ever navigated to).
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')))

// Large AI runtime assets (ONNX models, onnxruntime wasm) are never precached: cache on first use.
registerRoute(
  ({ url, sameOrigin }) => sameOrigin && (url.pathname.endsWith('.onnx') || /\/ort\/[^/]+\.(wasm|mjs)$/.test(url.pathname)),
  new CacheFirst({ cacheName: 'ai-assets-v1', plugins: [coiPlugin] }),
)

// Anything else same-origin that is not precached (e.g. fixtures in dev/preview) passes through with COI headers.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return
  // Let workbox routes handle what they match; this listener only sees requests no route claimed.
})
