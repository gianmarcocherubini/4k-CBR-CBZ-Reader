import { Group, Row, Switch } from './SettingsPanel'
import type { BatchState } from './useMaxQuality'

interface MaxQualityControlsProps {
  enabled: boolean
  statusLine: string
  ready: boolean
  batch: BatchState
  pageCount: number
  onToggle: (v: boolean) => void
  onStart: () => void
  onCancel: () => void
  /** Heavy GAN model (Real-ESRGAN anime 6B): the final toggle, only while the standard SR is off. */
  gan: boolean
  ganAllowed: boolean
  onToggleGan: (v: boolean) => void
}

function formatEta(secondsPerPage: number | undefined, remaining: number): string {
  if (!secondsPerPage || remaining <= 0) return ''
  const s = Math.round(secondsPerPage * remaining)
  if (s < 90) return `≈ ${s} s`
  const m = Math.round(s / 60)
  return m < 90 ? `≈ ${m} min` : `≈ ${Math.round(m / 60)} h`
}

/** Settings block for the experimental heavy tier (waifu2x CUNet, or the GAN model) and its batch job. */
export function MaxQualityControls({
  enabled,
  statusLine,
  ready,
  batch,
  pageCount,
  onToggle,
  onStart,
  onCancel,
  gan,
  ganAllowed,
  onToggleGan,
}: MaxQualityControlsProps) {
  const p = batch.progress
  const pct = p && p.total > 0 ? Math.round(((p.done + (p.tilesTotal ? p.tilesDone / p.tilesTotal : 0)) / p.total) * 100) : 0
  const active = enabled || (gan && ganAllowed)
  return (
    <Group title="Qualità massima (lenta)" testId="mq-section" footer={<span data-testid="mq-status">{statusLine}</span>}>
      <Row
        title="Qualità massima"
        hint={
          gan && ganAllowed
            ? 'Sostituita dal modello GAN pesante qui sotto.'
            : 'Sperimentale. waifu2x CUNet: il risultato più fedele (conserva i retini), ma richiede secondi per pagina. ×2 nativo; con Fattore ×4 fa due passaggi. I risultati restano in cache per sempre.'
        }
      >
        <Switch checked={enabled} onChange={onToggle} label="Qualità massima" />
      </Row>
      {active &&
        (batch.running ? (
          <div className="row flex-col items-stretch gap-2">
            <div className="flex items-center justify-between text-subhead">
              <span>
                Pre-elaborazione: pagina {(p?.done ?? 0) + 1} di {p?.total ?? pageCount}
              </span>
              <span className="text-footnote text-label-2 tabular-nums">{formatEta(p?.secondsPerPage, (p?.total ?? pageCount) - (p?.done ?? 0))}</span>
            </div>
            <div className="h-[4px] overflow-hidden rounded-full bg-fill">
              <div className="h-full rounded-full bg-tint transition-[width]" style={{ width: `${pct}%` }} data-testid="mq-progress" />
            </div>
            {p && p.tilesTotal > 0 && (
              <p className="text-footnote text-label-2 tabular-nums">
                Tile {p.tilesDone} / {p.tilesTotal}
                {p.secondsPerPage ? ` · ${p.secondsPerPage.toFixed(1)} s per pagina` : ''}
              </p>
            )}
            <button type="button" className="btn-ghost w-full" onClick={onCancel} data-testid="mq-cancel">
              Annulla
            </button>
          </div>
        ) : (
          <div className="row flex-col items-stretch gap-2">
            <button type="button" className="btn-primary w-full" onClick={onStart} disabled={!ready} data-testid="mq-start">
              Pre-elabora questo volume
            </button>
            <p className="text-footnote text-label-2">
              {batch.finished
                ? `Completato: ${p?.done ?? pageCount} pagine in cache.`
                : batch.error
                  ? `Errore: ${batch.error}`
                  : p && p.done > 0
                    ? `Interrotto: ${p.done} di ${p.total} pagine in cache. Riprendi quando vuoi.`
                    : 'Elabora tutte le pagine del volume, anche in background; lo schermo resta acceso. Puoi interrompere e riprendere.'}
            </p>
          </div>
        ))}
      <Row
        title="Modello GAN pesante"
        hint={
          ganAllowed
            ? 'Real-ESRGAN anime 6B, ×4 nativo (×2 con Fattore ×2): aspetto “stampato”, molto nitido; tende a cancellare i retini fini. Decine di secondi per pagina sulla GPU, minuti sulla CPU: usalo con “Pre-elabora questo volume”.'
            : 'Disponibile solo con la Super risoluzione standard spenta: i due sistemi sono alternativi.'
        }
      >
        <span className={ganAllowed ? '' : 'pointer-events-none opacity-40'} aria-disabled={!ganAllowed} data-testid="gan-toggle-wrap">
          <Switch checked={gan && ganAllowed} onChange={(v) => ganAllowed && onToggleGan(v)} label="Modello GAN pesante" />
        </span>
      </Row>
    </Group>
  )
}
