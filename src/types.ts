/** Archive container detected from magic bytes. */
export type ContainerKind = 'zip' | 'rar4' | 'rar5' | 'tar' | '7z' | 'pdf' | 'unknown'

/** Formats the reader can open: ZIP and RAR comic archives, tar (CBT), PDF, fixed-layout EPUB. */
export type BookFormat = 'cbz' | 'cbr' | 'cbt' | 'pdf' | 'epub'

/** Where the archive bytes live. */
export type StorageKind = 'opfs' | 'idb' | 'session'

export interface PageSize {
  w: number
  h: number
}

export interface Book {
  id: string
  title: string
  fileName: string
  fileSize: number
  format: BookFormat
  storage: StorageKind
  pageCount: number
  addedAt: number
  lastReadAt: number
  /** Thumbnail of the first page (JPEG/WebP blob), if it could be decoded. */
  cover?: Blob
  /** Archive thumbnails are removed for protected books; user-selected remote covers are safe to keep. */
  coverSource?: 'archive' | 'remote'
  /** The ZIP is encrypted; its password is intentionally kept in memory only. */
  passwordProtected?: boolean
  /** Missing means the built-in default collection. */
  collectionId?: string
}

export interface Collection {
  id: string
  name: string
  createdAt: number
  /** Built-in emoji fallback. */
  icon?: string
  /** Optional user-selected PNG stored locally. */
  iconImage?: Blob
}

export interface Progress {
  bookId: string
  /** 0-based index of the first page of the last displayed spread. */
  page: number
  updatedAt: number
  /** Legacy per-book pairing override; pairing is now fixed (cover alone, then pairs) and blanks re-align. */
  coverOffset?: boolean
  /** Pages preceded by a user-inserted blank page (re-aligns the following pairs). */
  blanks?: number[]
}

/**
 * A volume restored from a backup before its file is back in the library: everything the user
 * had given it (title, collection, chosen cover, bookmark), applied when a file with the same name
 * and size is imported.
 */
export interface PendingRestore {
  /** `${fileSize}:${fileName}`, the importer's duplicate key. */
  key: string
  fileName: string
  fileSize: number
  title: string
  pageCount: number
  addedAt: number
  lastReadAt: number
  collectionId?: string
  /** Only user-chosen (remote) covers travel in a backup; archive thumbnails are rebuilt on import. */
  cover?: Blob
  progress?: Omit<Progress, 'bookId'>
  /** When the backup was restored. */
  restoredAt: number
}

export type Direction = 'rtl' | 'ltr'
export type PageMode = 'single' | 'double' | 'auto'
/** Appearance: follow the system, or force light/dark like Apple Books' themes. */
export type Theme = 'system' | 'light' | 'dark'
/** Gap between the two pages of a spread, as a fraction of the page height. */
export type Gutter = 'none' | 's' | 'm' | 'l'
export const GUTTER_FRACTION: Record<Gutter, number> = { none: 0, s: 0.015, m: 0.03, l: 0.06 }
export type GutterColor = 'white' | 'paper' | 'dark'
/** Reader background behind the pages: default = follows the appearance (light grey / black). */
export type StageBackground = 'default' | 'black' | 'white'
/** Page-turn animation. */
export type PageTransition = 'none' | 'fade' | 'slide'
/** screen = whole spread visible (contain); height/width = fill that axis; original = 1:1 device pixels. */
export type FitMode = 'screen' | 'height' | 'width' | 'original'
export type SrLevel = 'auto' | 'M' | 'VL' | 'UL'
/**
 * Upscale factor relative to the source page (the view then fits the result into its box):
 * auto = x4 when memory and GPU allow (heavy models: their native factor), else x2.
 */
export type SrScale = 'auto' | 'x2' | 'x4'
/** Real-ESRGAN network of the 4K tier: the compact anime video v3 or the 6-block RRDB (about 9x the work). */
export type MaxQualityModel = 'v3' | '6b'
/**
 * What the pages are enhanced with. HD: Anime4K on the GPU, everything automatic, well under a
 * second. 4K (experimental): Real-ESRGAN for the pages on screen, seconds per page, HD as fallback.
 */
export type Resolution = 'hd' | '4k'
/**
 * Speed/quality of the 4K tier, slowest = best: fast = Anime v3 in one pass (~1 s on an iPad M),
 * medium = Anime v3 with a four-pass self-ensemble (~4 s), slow = Anime 6B (~7 s).
 */
export type Rendering = 'fast' | 'medium' | 'slow'

export interface ReaderSettings {
  direction: Direction
  pageMode: PageMode
  fit: FitMode
  resolution: Resolution
  rendering: Rendering
  /** 4K: blur the plain page while its HD version is being computed (anti-spoiler), then reveal. */
  antiSpoiler: boolean
  /**
   * Anime4K parameters. Not exposed: HD is fully automatic. Kept as stored fields so tests can pin
   * a level or factor through localStorage.
   */
  srLevel: SrLevel
  srScale: SrScale
  srRestore: boolean
  srClean: boolean
  theme: Theme
  stageBackground: StageBackground
  /** Centre margin between the two pages in double-page mode. */
  gutter: Gutter
  gutterColor: GutterColor
  transition: PageTransition
  /** Request full screen while reading (hides the iPad status bar). */
  fullscreenReading: boolean
  /** Tiny corner indicator showing when the enhancement is actually applied. */
  srIndicator: boolean
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  direction: 'rtl',
  pageMode: 'auto',
  fit: 'screen',
  resolution: 'hd',
  rendering: 'fast',
  antiSpoiler: true,
  srLevel: 'auto',
  srScale: 'auto',
  srRestore: false,
  srClean: false,
  theme: 'system',
  stageBackground: 'default',
  gutter: 'm',
  gutterColor: 'white',
  transition: 'slide',
  fullscreenReading: true,
  srIndicator: true,
}
