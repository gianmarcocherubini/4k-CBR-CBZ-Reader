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
        className="w-full max-w-sm overflow-hidden rounded-[16px] bg-card shadow-sheet"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          const value = password
          setPassword('')
          onSubmit(value)
        }}
        data-testid="password-dialog"
      >
        <div className="px-6 pt-6 pb-2">
          <h2 id="password-title" className="text-title2">
            {invalid ? 'Password non corretta' : 'Archivio protetto'}
          </h2>
          <p className="mt-2 text-subhead text-label-2">
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
            className="field mt-4"
            data-testid="archive-password"
          />
          {invalid && <p className="mt-2 text-footnote text-red">Riprova: la password precedente non ha decifrato il file.</p>}
        </div>
        <div className="flex justify-end gap-2 px-6 pt-4 pb-6">
          <button type="button" className="btn-ghost !min-h-[36px] !px-3.5 !text-[13px]" onClick={onCancel}>
            Annulla
          </button>
          <button type="submit" className="btn-primary !min-h-[36px] !px-3.5 !text-[13px]">
            Sblocca
          </button>
        </div>
      </form>
    </div>
  )
}
