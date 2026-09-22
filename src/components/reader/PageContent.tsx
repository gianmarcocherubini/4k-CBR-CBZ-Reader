import type { LoadedPage } from '../../lib/reader/pageCache'
import type { SrResult } from '../../lib/upscale/srEngine'
import { EnhancedCanvas } from './EnhancedCanvas'

export type PageState =
  | { status: 'loading' }
  | { status: 'ready'; page: LoadedPage }
  | { status: 'error'; message: string }

interface PageContentProps {
  index: number
  state: PageState | undefined
  /** The enhanced version, when the engine has produced one: replaces the plain image. */
  sr: SrResult | undefined
  /** Displayed size, CSS px. */
  width: number
  height: number
  /** Blur the plain image while its HD version is being computed (anti-spoiler). */
  blurred?: boolean
  onRetry?: (index: number) => void
}

/** What a page box shows: the HD canvas, the plain image, an error with retry, or a spinner. */
export function PageContent({ index, state, sr, width, height, blurred = false, onRetry }: PageContentProps) {
  if (state?.status === 'ready' && sr) return <EnhancedCanvas bitmap={sr.bitmap} width={width} height={height} alt={`Pagina ${index + 1}`} />
  if (state?.status === 'ready') {
    return (
      <img
        src={state.page.url}
        alt={`Pagina ${index + 1}`}
        width={Math.round(width)}
        height={Math.round(height)}
        className={`block h-full w-full ${blurred ? 'antispoiler' : ''}`}
        decoding="async"
        draggable={false}
      />
    )
  }
  if (state?.status === 'error') {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-card p-4 text-center shadow-[inset_0_0_0_1px_var(--line)]">
        <p className="text-footnote text-label-2">
          Pagina {index + 1}: {state.message}
        </p>
        {onRetry && (
          <button type="button" className="btn-ghost pointer-events-auto !min-h-[36px] !text-[13px]" onPointerDown={(e) => e.stopPropagation()} onClick={() => onRetry(index)}>
            Riprova
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="flex h-full w-full items-center justify-center bg-card/70">
      <div className="spinner" aria-label="Caricamento pagina" />
    </div>
  )
}
