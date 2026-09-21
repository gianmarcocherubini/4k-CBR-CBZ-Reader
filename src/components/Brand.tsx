import crown from './crown.json'

/** Name of the app, as shown in the wordmark, the manifest and the window title. */
export const APP_NAME = 'Mangadana'
/** Where the app lives (vite.config.ts): the footer links to it, an install elsewhere is pointed to it. */
export const SITE_URL = __SITE_URL__

/**
 * The mark: the crown from the "Extras" face of Sprite Graffiti (Fontfabric, free-font commercial
 * EULA: logos and static images are permitted; the font itself is not embedded), as an outline in
 * a 100×100 box, drawn in the current text colour. The path lives in crown.json so the asset
 * script (scripts/make-brand-assets.mjs: icons, startup images, social preview) draws the same one.
 */
export function CrownMark({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg className={className} viewBox={crown.viewBox} fill="currentColor" aria-hidden>
      <path d={crown.d} />
    </svg>
  )
}

/** Mark + name, ink on the surface it sits on. */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 text-label ${className}`}>
      <CrownMark className="h-[22px] w-[22px] shrink-0" />
      <span className="text-[15px] font-semibold tracking-tight">{APP_NAME}</span>
    </span>
  )
}
