import type { ReactNode } from 'react'

interface DialogProps {
  title: string
  children: ReactNode
  actions?: ReactNode
  onClose?: () => void
}

/** iOS-style alert card: centred, rounded, on a dimmed blurred backdrop. Tap outside or Esc to close. */
export function Dialog({ title, children, actions, onClose }: DialogProps) {
  return (
    <div
      className="fade-enter fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6 backdrop-blur-sm"
      role="presentation"
      onClick={onClose}
      onKeyDown={(e) => e.key === 'Escape' && onClose?.()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="material-strong w-full max-w-sm overflow-hidden rounded-2xl shadow-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-5 pb-1 text-center">
          <h2 className="text-headline">{title}</h2>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-5 pb-4 text-center text-footnote text-label-2">{children}</div>
        {actions && <div className="flex flex-col divide-y divide-separator border-t border-separator">{actions}</div>}
      </div>
    </div>
  )
}

/** Full-width alert action, iOS style. */
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
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={`min-h-[44px] w-full text-body transition-colors active:bg-fill ${destructive ? 'text-red' : 'text-tint'} ${primary ? 'font-semibold' : ''}`}
    >
      {children}
    </button>
  )
}
