/// <reference types="vite/client" />

/** package.json version, injected at build time (vite.config.ts). */
declare const __APP_VERSION__: string
/** Short commit hash and build date, injected at build time (vite.config.ts). */
declare const __APP_BUILD__: string
/** Canonical origin of the app (https://www.manga-dana.com), injected at build time (vite.config.ts). */
declare const __SITE_URL__: string
