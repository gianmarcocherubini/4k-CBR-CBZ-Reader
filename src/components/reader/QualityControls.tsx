import type { ReaderSettings, Rendering, Resolution } from '../../types'
import { Group, Row, Segmented, Switch, TechnicalDetails } from './SettingsPanel'

interface QualityControlsProps {
  resolution: Resolution
  rendering: Rendering
  antiSpoiler: boolean
  /** One plain sentence on the state of the HD tier (ready, estimate, unavailable). */
  hdSummary: string
  /** One plain sentence on the state of the 4K tier. */
  fourKSummary: string
  /** Technical status line of the HD tier (backend, level, factor, cost), under "Dettagli tecnici". */
  hdStatus: string
  /** Technical status line of the 4K tier (model, precision, kernel, estimate). */
  fourKStatus: string
  onChange: (patch: Partial<ReaderSettings>) => void
}

/** Speeds ordered by quality: what the reader gets, in seconds, without the machinery behind it. */
const RENDERING: Array<{ value: Rendering; label: string; detail: string }> = [
  { value: 'fast', label: 'Fast', detail: 'Fast: circa un secondo per pagina, già molto più nitido di HD.' },
  { value: 'medium', label: 'Medium', detail: 'Medium: bordi e linee più puliti, circa quattro secondi per pagina.' },
  { value: 'slow', label: 'Slow', detail: 'Slow: il massimo dettaglio possibile, circa sette secondi per pagina.' },
]

/**
 * The one quality choice of the reader. HD is fully automatic; 4K trades time for detail and its
 * speeds are ordered by quality: Slow is the best-looking, Fast the quickest.
 */
export function QualityControls({ resolution, rendering, antiSpoiler, hdSummary, fourKSummary, hdStatus, fourKStatus, onChange }: QualityControlsProps) {
  const fourK = resolution === '4k'
  const chosen = RENDERING.find((r) => r.value === rendering)!
  return (
    <Group
      title="Risoluzione"
      testId="sr-section"
      footer={
        <>
          <span data-testid={fourK ? 'mq-summary' : 'sr-summary'}>{fourK ? fourKSummary : hdSummary}</span>
          <TechnicalDetails>
            <span data-testid={fourK ? 'mq-status' : 'sr-status'}>{fourK ? fourKStatus : hdStatus}</span>
          </TechnicalDetails>
        </>
      }
    >
      <Row
        title="Risoluzione"
        hint={
          fourK
            ? 'Le pagine sullo schermo vengono ricostruite a quattro volte la risoluzione originale: linee nette, testo leggibile, niente artefatti. Richiede qualche secondo per pagina; quando non è possibile, la pagina resta in HD.'
            : 'HD migliora ogni pagina all’istante, senza nulla da regolare. 4K è molto più nitido, ma richiede qualche secondo per pagina.'
        }
        stacked
      >
        <Segmented<Resolution>
          label="Risoluzione"
          idPrefix="res"
          value={resolution}
          onChange={(v) => onChange({ resolution: v })}
          options={[
            { value: 'hd', label: 'HD' },
            { value: '4k', label: '4K · Sperimentale' },
          ]}
        />
      </Row>
      {fourK && (
        <>
          <Row title="Rendering" hint={`Più tempo, più dettaglio: Slow è la qualità massima. ${chosen.detail}`} stacked>
            <Segmented<Rendering>
              label="Rendering"
              idPrefix="rend"
              value={rendering}
              onChange={(v) => onChange({ rendering: v })}
              options={RENDERING.map((r) => ({ value: r.value, label: r.value === 'slow' ? 'Slow · massima' : r.label }))}
            />
          </Row>
          <Row title="Sfocatura anti-spoiler" hint="Finché la versione 4K non è pronta, la pagina resta sfocata: niente anticipazioni mentre aspetti.">
            <Switch checked={antiSpoiler} onChange={(v) => onChange({ antiSpoiler: v })} label="Sfocatura anti-spoiler" />
          </Row>
        </>
      )}
    </Group>
  )
}
