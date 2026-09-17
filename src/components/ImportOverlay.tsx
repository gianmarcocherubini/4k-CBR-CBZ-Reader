import { describeError } from '../lib/archive/types'
import type { ImportStatus } from '../lib/storage/importer'
import { formatBytes } from '../lib/storage/opfs'

export interface ImportItem extends ImportStatus {
  key: string
}

interface ImportOverlayProps {
  items: ImportItem[]
  running: boolean
  onCancel: () => void
  onClose: () => void
}

const STAGE_LABEL: Record<ImportStatus['stage'], string> = {
  verifica: 'Verifica dell’archivio…',
  copia: 'Copia nell’archiviazione dell’app…',
  copertina: 'Creazione copertina…',
  completato: 'Importato',
  errore: 'Errore',
}

export function ImportOverlay({ items, running, onCancel, onClose }: ImportOverlayProps) {
  const done = items.filter((i) => i.stage === 'completato').length
  const failed = items.filter((i) => i.stage === 'errore').length
  return (
    <div className="fade-enter fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6 backdrop-blur-sm" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Importazione"
        className="material-strong w-full max-w-md overflow-hidden rounded-2xl shadow-sheet"
        data-testid="import-overlay"
      >
        <div className="px-5 pt-5 pb-3 text-center">
          <h2 className="text-headline">{running ? 'Importazione in corso' : 'Importazione completata'}</h2>
          <p className="mt-0.5 text-footnote text-label-2">
            {done} di {items.length} importati{failed > 0 ? `, ${failed} con errori` : ''}
          </p>
        </div>
        <ul className="mx-4 mb-4 max-h-[55vh] overflow-y-auto rounded-xl bg-card">
          {items.map((item, i) => {
            const pct = item.total > 0 ? Math.round((item.bytes / item.total) * 100) : 0
            const active = item.stage === 'copia' || item.stage === 'verifica' || item.stage === 'copertina'
            return (
              <li key={item.key} className={`px-4 py-3 ${i > 0 ? 'hairline-t' : ''}`}>
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-subhead font-medium" title={item.fileName}>
                    {item.fileName}
                  </span>
                  <span className="shrink-0 text-caption text-label-2 tabular-nums">
                    {item.stage === 'copia' ? `${formatBytes(item.bytes)} / ${formatBytes(item.total)}` : formatBytes(item.total)}
                  </span>
                </div>
                <div className="mt-2 h-[4px] overflow-hidden rounded-full bg-fill">
                  <div
                    className={`h-full rounded-full transition-[width] ${item.stage === 'errore' ? 'bg-red' : item.stage === 'completato' ? 'bg-green' : 'bg-tint'}`}
                    style={{ width: `${item.stage === 'completato' ? 100 : item.stage === 'copia' ? pct : active ? 8 : 0}%` }}
                  />
                </div>
                <p className={`mt-1.5 text-footnote ${item.stage === 'errore' ? 'text-red' : 'text-label-2'}`} data-testid="import-status">
                  {item.stage === 'errore' && item.error ? describeError(item.error.code, item.fileName) : STAGE_LABEL[item.stage]}
                  {item.stage === 'copia' && item.total > 0 ? ` ${pct}%` : ''}
                </p>
              </li>
            )
          })}
        </ul>
        <div className="border-t border-separator">
          {running ? (
            <button type="button" className="min-h-[44px] w-full text-body text-tint active:bg-fill" onClick={onCancel}>
              Annulla
            </button>
          ) : (
            <button type="button" className="min-h-[44px] w-full text-body font-semibold text-tint active:bg-fill" onClick={onClose} data-testid="import-close">
              Chiudi
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
