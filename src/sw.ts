/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core'
import { cleanupOutdatedCaches, createHandlerBoundToURL, type PrecacheEntry, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<PrecacheEntry | string> }

self.skipWaiting()
clientsClaim()

cleanupOutdatedCaches()
// App shell, Anime4K shaders and the Real-ESRGAN weights: everything the reader needs offline.
precacheAndRoute(self.__WB_MANIFEST)

// App shell for deep links (#/read/... is a hash route, so only index.html is ever navigated to).
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')))

// Optional model weights (the 9 MB Real-ESRGAN 6B) are not precached: cached the first time they are used.
registerRoute(({ url, sameOrigin }) => sameOrigin && url.pathname.endsWith('.bin'), new CacheFirst({ cacheName: 'model-weights-v1' }))

// Earlier versions kept the ONNX runtime and its models in a runtime cache: drop it.
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.delete('ai-assets-v1').catch(() => false))
})
