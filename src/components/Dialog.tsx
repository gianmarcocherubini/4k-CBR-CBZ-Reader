import type { ReactNode } from 'react'

interface DialogProps {
  title: string
  children: ReactNode
  actions?: ReactNode
  onClose?: () => void
}

/** Modal card on a dimmed backdrop: title, quiet body, actions aligned to the right. Tap outside or Esc to close. */
export function Dialog({ title, children, actions, onClose }: DialogProps) {
  return (
    <div
      className="fade-enter fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 backdrop-blur-sm"
      role="presentation"
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose?.()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-sm overflow-hidden rounded-[16px] bg-card shadow-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-6 pb-1">
          <h2 className="text-title2">{title}</h2>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-6 pb-5 text-subhead text-label-2">{children}</div>
        {actions && <div className="flex flex-wrap items-center justify-end gap-2 px-6 pb-6">{actions}</div>}
      </div>
    </div>
  )
}

/** Dialog action: primary (ink on bone), destructive (red text), or quiet outline. */
export function DialogAction({
  children,
  onClick,
  destructive,
  primary,
  testId,
}: {
  children: ReactNode
  onClick: () => void
  destructive?: boolean
  primary?: boolean
  testId?: string
}) {
  const cls = primary ? 'btn-primary' : destructive ? 'btn-ghost !text-red' : 'btn-ghost'
  return (
    <button type="button" onClick={onClick} data-testid={testId} className={`${cls} !min-h-[36px] !px-3.5 !text-[13px]`}>
      {children}
    </button>
  )
}
