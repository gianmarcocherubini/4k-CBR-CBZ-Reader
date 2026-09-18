import type { ReactNode } from 'react'

export const COLLECTION_GLYPHS = [
  { id: 'book-open', label: 'Libro aperto' },
  { id: 'folder', label: 'Cartella' },
  { id: 'star', label: 'Stella' },
  { id: 'flame', label: 'Fiamma' },
  { id: 'crown', label: 'Corona' },
  { id: 'compass', label: 'Bussola' },
  { id: 'skull', label: 'Teschio' },
  { id: 'swords', label: 'Spade' },
  { id: 'sparkles', label: 'Scintille' },
  { id: 'palette', label: 'Tavolozza' },
  { id: 'moon', label: 'Luna' },
  { id: 'bolt', label: 'Fulmine' },
] as const

const paths: Record<string, ReactNode> = {
  library: <><path d="M4 19.5V5a2 2 0 0 1 2-2h5v16H6a2 2 0 0 0-2 2.5"/><path d="M20 19.5V5a2 2 0 0 0-2-2h-5v16h5a2 2 0 0 1 2 2.5"/></>,
  'book-open': <><path d="M2 4.5A2.5 2.5 0 0 1 4.5 2H11v18H4.5A2.5 2.5 0 0 0 2 22.5z"/><path d="M22 4.5A2.5 2.5 0 0 0 19.5 2H13v18h6.5a2.5 2.5 0 0 1 2.5 2.5z"/></>,
  folder: <path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a3 3 0 0 1-3 3H5a2 2 0 0 1-2-2z"/>,
  star: <path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2L5.8 21 7 14.2 2 9.3l6.9-1z"/>,
  flame: <path d="M12 22c4.4 0 8-3 8-7.5 0-3-1.6-5.7-4.6-8.5.1 2.5-.7 4-2.4 4.8.2-3.8-1.3-6.7-4.5-8.8.2 4-4.5 6.3-4.5 12.5C4 19 7.6 22 12 22z"/>,
  crown: <path d="m3 6 4.5 4L12 4l4.5 6L21 6l-2 12H5z"/>,
  compass: <><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8z"/></>,
  skull: <><path d="M8 20v-2.2A7 7 0 1 1 16 18V20"/><path d="M8 20h8M10 17v3m4-3v3"/><circle cx="9" cy="11" r="1"/><circle cx="15" cy="11" r="1"/></>,
  swords: <><path d="m14.5 4.5 5-2-2 5-9 9-3 1 1-3z"/><path d="m9.5 4.5-5-2 2 5 4 4m3 3 2 2 3 1-1-3-1-1"/></>,
  sparkles: <><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2z"/><path d="m19 14 .7 2.3L22 17l-2.3.7L19 20l-.7-2.3L16 17l2.3-.7zM5 13l.6 1.8 1.9.7-1.9.6L5 18l-.6-1.9-1.9-.6 1.9-.7z"/></>,
  palette: <><path d="M12 3a9 9 0 0 0 0 18h1.5a1.5 1.5 0 0 0 0-3H12a2 2 0 0 1 0-4h3a6 6 0 0 0 0-12z"/><circle cx="7.5" cy="10" r=".7"/><circle cx="10" cy="6.8" r=".7"/><circle cx="14" cy="6.5" r=".7"/></>,
  moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5z"/>,
  bolt: <path d="m13 2-8 12h7l-1 8 8-12h-7z"/>,
}

export function CollectionGlyph({ icon, className = 'h-5 w-5' }: { icon?: string; className?: string }) {
  if (!icon || !paths[icon]) return null
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {paths[icon]}
    </svg>
  )
}
