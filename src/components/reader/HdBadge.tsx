export type HdState = 'applied' | 'pending' | 'na'

interface HdBadgeProps {
  state: HdState
  /** Full description, used as the accessible label and tooltip (e.g. "SR ×4 GAN"). */
  label: string
  testId: string
  /** Adds a soft shadow so it stays legible floating over a page. */
  floating?: boolean
}

/**
 * The familiar "HD" glyph. Filled (tint) when the enhancement is actually applied to the page,
 * dimmed while it is being computed, and struck through ("non HD") when it is not available.
 */
export function HdBadge({ state, label, testId, floating = false }: HdBadgeProps) {
  const tone =
    state === 'applied'
      ? 'bg-tint text-white'
      : state === 'pending'
        ? 'bg-fill text-label-2 hd-pulse'
        : 'bg-fill text-label-3 line-through decoration-2'
  return (
    <span
      data-testid={testId}
      data-sr-state={state}
      aria-label={`Super risoluzione: ${label}`}
      title={label}
      className={`inline-flex h-[15px] items-center justify-center rounded-[5px] px-[3px] text-[10px] leading-none font-bold tracking-tight ${tone} ${floating ? 'shadow-cover' : ''}`}
    >
      HD
    </span>
  )
}
