import type { Direction } from '../../types'
import { HdBadge, type HdState } from './HdBadge'

interface ToolbarsProps {
  visible: boolean
  title: string
  label: string
  pageCount: number
  spreadIndex: number
  spreadCount: number
  direction: Direction
  double: boolean
  /** The current spread contains a user-inserted blank page. */
  blankHere: boolean
  /** Accessible description of the enhancement state (e.g. "SR ×4 GAN"); the badge shows an HD glyph. */
  badge?: string
  badgeState: HdState | null
  onBack: () => void
  onSettings: () => void
  onSeek: (spreadIndex: number) => void
  onToggleDouble: () => void
  onToggleBlank: () => void
  onHoverChange: (hovering: boolean) => void
}

const Icon = {
  chevron: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 5l-7 7 7 7" />
    </svg>
  ),
  settings: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  ),
}

/** Apple Books–style chrome: translucent bars, back chevron, centred title, page scrubber. */
export function Toolbars({
  visible,
  title,
  label,
  pageCount,
  spreadIndex,
  spreadCount,
  direction,
  double,
  blankHere,
  badge,
  badgeState,
  onBack,
  onSettings,
  onSeek,
  onToggleDouble,
  onToggleBlank,
  onHoverChange,
}: ToolbarsProps) {
  const cls = `absolute inset-x-0 z-20 transition-all duration-200 ${visible ? 'opacity-100' : 'pointer-events-none opacity-0'}`
  return (
    <>
      <div
        className={`${cls} material hairline-b top-0 ${visible ? 'translate-y-0' : '-translate-y-2'} pt-safe px-safe`}
        onPointerEnter={() => onHoverChange(true)}
        onPointerLeave={() => onHoverChange(false)}
        data-testid="toolbar-top"
      >
        <div className="grid h-14 grid-cols-[1fr_auto_1fr] items-center px-2">
          <div className="flex items-center">
            <button type="button" className="btn-plain gap-0.5 pr-3 pl-1 !text-label" onClick={onBack} aria-label="Torna alla libreria" data-testid="back">
              {Icon.chevron}
              <span className="hidden text-[14px] font-medium sm:inline">Libreria</span>
            </button>
          </div>
          <div className="min-w-0 max-w-[60vw] truncate text-center text-headline">{title}</div>
          <div className="flex items-center justify-end gap-2">
            {badgeState && badge && <HdBadge state={badgeState} label={badge} testId="sr-badge" />}
            <button type="button" className="btn-icon" onClick={onSettings} aria-label="Impostazioni" data-testid="settings">
              {Icon.settings}
            </button>
          </div>
        </div>
      </div>

      <div
        className={`${cls} material hairline-t bottom-0 ${visible ? 'translate-y-0' : 'translate-y-2'} pb-safe px-safe`}
        onPointerEnter={() => onHoverChange(true)}
        onPointerLeave={() => onHoverChange(false)}
        data-testid="toolbar-bottom"
      >
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-5 pt-1">
          <span className="w-8 shrink-0 text-caption text-label-3 tabular-nums" aria-hidden>
            {direction === 'rtl' ? pageCount : 1}
          </span>
          <input
            type="range"
            className="slider flex-1"
            dir={direction}
            min={0}
            max={Math.max(0, spreadCount - 1)}
            step={1}
            value={spreadIndex}
            onChange={(e) => onSeek(Number(e.currentTarget.value))}
            aria-label="Posizione nel volume"
            data-testid="slider"
          />
          <span className="w-8 shrink-0 text-right text-caption text-label-3 tabular-nums" aria-hidden>
            {direction === 'rtl' ? 1 : pageCount}
          </span>
        </div>
        <div className="-mt-1 text-center text-caption text-label-2 tabular-nums">
          Pagina <span data-testid="page-label">{label}</span> di {pageCount}
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2 px-5 pt-2.5 pb-3.5">
          <button type="button" className="btn-pill" onClick={onToggleDouble} aria-pressed={double} data-testid="toggle-double">
            Doppia pagina
          </button>
          {double && (
            <button
              type="button"
              className="btn-pill"
              onClick={onToggleBlank}
              aria-pressed={blankHere}
              title="Inserisce una pagina bianca prima di questa: le coppie successive si spostano di una pagina"
              data-testid="toggle-blank"
            >
              {blankHere ? 'Togli pagina bianca' : 'Pagina bianca qui'}
            </button>
          )}
        </div>
      </div>
    </>
  )
}
