import { useState } from 'react'

interface PasswordDialogProps {
  fileName: string
  invalid: boolean
  onSubmit: (password: string) => void
  onCancel: () => void
}

/** Modal password request used while an import/session-open promise is paused. */
export function PasswordDialog({ fileName, invalid, onSubmit, onCancel }: PasswordDialogProps) {
  const [password, setPassword] = useState('')
  return (
    <div
      className="fade-enter fixed inset-0 z-[60] flex items-center justify-center bg-black/35 p-6 backdrop-blur-sm"
      role="presentation"
      onClick={onCancel}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="password-title"
        className="material-strong w-full max-w-sm overflow-hidden rounded-2xl shadow-sheet"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          const value = password
          setPassword('')
          onSubmit(value)
        }}
        data-testid="password-dialog"
      >
        <div className="px-5 pt-5 pb-4 text-center">
          <h2 id="password-title" className="text-headline">
            {invalid ? 'Password non corretta' : 'Archivio protetto'}
          </h2>
          <p className="mt-1 text-footnote text-label-2">
            Inserisci la password per <span className="font-medium text-label">“{fileName}”</span>.
          </p>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
            autoFocus
            autoComplete="off"
            maxLength={1024}
            aria-label="Password dell’archivio"
            className="mt-4 min-h-[44px] w-full rounded-xl border border-separator bg-card px-3 text-body text-label outline-none focus:border-tint"
            data-testid="archive-password"
          />
          {invalid && <p className="mt-2 text-footnote text-red">Riprova: la password precedente non ha decifrato il file.</p>}
        </div>
        <div className="grid grid-cols-2 border-t border-separator">
          <button type="button" className="min-h-[44px] border-r border-separator text-body text-tint active:bg-fill" onClick={onCancel}>
            Annulla
          </button>
          <button type="submit" className="min-h-[44px] text-body font-semibold text-tint active:bg-fill">
            Sblocca
          </button>
        </div>
      </form>
    </div>
  )
}
