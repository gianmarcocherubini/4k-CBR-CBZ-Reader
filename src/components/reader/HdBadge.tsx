export type HdState = 'applied' | 'pending' | 'na'

interface HdBadgeProps {
  state: HdState
  /** Full description, used as the accessible label and tooltip (e.g. "4K ×4 v3"). */
  label: string
  testId: string
  /** Adds a soft shadow so it stays legible floating over a page. */
  floating?: boolean
}

/**
 * Resolution indicator: "HD" or "4K" (the tier in the label). Filled (accent) when the
 * enhancement is on the page, dimmed while it is being computed, struck through when unavailable.
 */
export function HdBadge({ state, label, testId, floating = false }: HdBadgeProps) {
  const glyph = label.startsWith('4K') ? '4K' : 'HD'
  const tone =
    state === 'applied'
      ? 'bg-tint text-white'
      : state === 'pending'
        ? 'bg-fill-2 text-label-2 hd-pulse'
        : 'bg-fill-2 text-label-3 line-through decoration-2'
  return (
    <span
      data-testid={testId}
      data-sr-state={state}
      aria-label={`Risoluzione: ${label}`}
      title={label}
      className={`inline-flex h-[16px] items-center justify-center rounded-[4px] px-[4px] text-[10px] leading-none font-bold tracking-tight ${tone} ${floating ? 'shadow-cover' : ''}`}
    >
      {glyph}
    </span>
  )
}
