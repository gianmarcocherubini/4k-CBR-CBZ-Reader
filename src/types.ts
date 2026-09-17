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
/** Model of the heavy "Qualità massima" tier. */
export type HeavyModel = 'cunet' | 'esrgan6b'

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
  /** "Qualità massima (lenta)": waifu2x CUNet, experimental, off by default. */
  maxQuality: boolean
  /** Heavy GAN model (Real-ESRGAN anime 6B) for the max-quality tier; only when superResolution is off. */
  ganModel: boolean
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
  ganModel: false,
  theme: 'system',
  stageBackground: 'default',
  gutter: 'm',
  gutterColor: 'white',
  transition: 'slide',
  fullscreenReading: true,
  srIndicator: true,
}
