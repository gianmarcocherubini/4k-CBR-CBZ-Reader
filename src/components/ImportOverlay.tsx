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
        className="w-full max-w-md overflow-hidden rounded-[16px] bg-card shadow-sheet"
        data-testid="import-overlay"
      >
        <div className="px-6 pt-6 pb-4">
          <h2 className="text-title2">{running ? 'Importazione in corso' : 'Importazione completata'}</h2>
          <p className="mt-1 text-footnote text-label-2">
            {done} di {items.length} importati{failed > 0 ? `, ${failed} con errori` : ''}
          </p>
        </div>
        <ul className="mx-6 max-h-[55vh] overflow-y-auto rounded-[12px] bg-bg shadow-[inset_0_0_0_1px_var(--line)]">
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
                <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-fill-2">
                  <div
                    className={`h-full rounded-full transition-[width] ${item.stage === 'errore' ? 'bg-red' : item.stage === 'completato' ? 'bg-green' : 'bg-invert'}`}
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
        <div className="flex justify-end px-6 py-5">
          {running ? (
            <button type="button" className="btn-ghost !min-h-[36px] !px-3.5 !text-[13px]" onClick={onCancel}>
              Annulla
            </button>
          ) : (
            <button type="button" className="btn-primary !min-h-[36px] !px-3.5 !text-[13px]" onClick={onClose} data-testid="import-close">
              Chiudi
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
