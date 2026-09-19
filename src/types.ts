/** Archive container detected from magic bytes. */
export type ContainerKind = 'zip' | 'rar4' | 'rar5' | '7z' | 'pdf' | 'unknown'

/** Formats the reader can open. */
export type BookFormat = 'cbz' | 'cbr'

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
  /** Per-book override of the pairing offset ("Sfasa coppie"). */
  coverOffset?: boolean
  /** Pages preceded by a user-inserted blank page (re-aligns the following pairs). */
  blanks?: number[]
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
/** Longest wait accepted for Real-ESRGAN on the visible spread, seconds (0 = no limit). */
export type MaxQualityBudget = 3 | 5 | 10 | 0
/** Real-ESRGAN network of "Qualità massima": the compact anime video v3 or the 6-block RRDB (about 9x the work). */
export type MaxQualityModel = 'v3' | '6b'

export interface ReaderSettings {
  direction: Direction
  pageMode: PageMode
  fit: FitMode
  /** Default pairing offset for new books: cover alone, then pairs. */
  coverOffset: boolean
  /** Super resolution (Anime4K) enabled. */
  superResolution: boolean
  srLevel: SrLevel
  srScale: SrScale
  /** Anime4K Restore pass before the upscale ("Linee nitide"). */
  srRestore: boolean
  /** Scan clean-up: paper levels + light denoise ("Pulizia scansione"). */
  srClean: boolean
  /** "Qualità massima": Real-ESRGAN (anime video v3) at x4 on WebGPU for the pages on screen. */
  maxQuality: boolean
  /**
   * Time budget for the visible spread: when the measured GPU throughput predicts a longer wait,
   * the spread uses the standard super resolution instead.
   */
  maxQualityBudget: MaxQualityBudget
  maxQualityModel: MaxQualityModel
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
  coverOffset: true,
  superResolution: true,
  srLevel: 'auto',
  srScale: 'auto',
  srRestore: false,
  srClean: false,
  maxQuality: false,
  maxQualityBudget: 5,
  maxQualityModel: 'v3',
  theme: 'system',
  stageBackground: 'default',
  gutter: 'm',
  gutterColor: 'white',
  transition: 'slide',
  fullscreenReading: true,
  srIndicator: true,
}
