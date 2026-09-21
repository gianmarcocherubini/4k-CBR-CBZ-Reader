import type { ReaderSettings, Rendering, Resolution } from '../../types'
import { Group, Row, Segmented, Switch } from './SettingsPanel'

interface QualityControlsProps {
  resolution: Resolution
  rendering: Rendering
  antiSpoiler: boolean
  /** Status line of the HD tier (Anime4K). */
  hdStatus: string
  /** Status line of the 4K tier (Real-ESRGAN). */
  fourKStatus: string
  onChange: (patch: Partial<ReaderSettings>) => void
}

const RENDERING: Array<{ value: Rendering; label: string; detail: string }> = [
  { value: 'fast', label: 'Fast', detail: 'Anime v3, un passaggio: circa 1 s per pagina su un iPad M.' },
  { value: 'medium', label: 'Medium', detail: 'Anime v3, quattro passaggi su copie riflesse mediati (bordi più puliti): circa 4 s.' },
  { value: 'slow', label: 'Slow', detail: 'Anime 6B, la rete grande: la qualità più alta, circa 7 s per pagina.' },
]

/**
 * The one quality choice of the reader. HD is fully automatic; 4K trades time for detail and its
 * speeds are ordered by quality: Slow is the best-looking, Fast the quickest.
 */
export function QualityControls({ resolution, rendering, antiSpoiler, hdStatus, fourKStatus, onChange }: QualityControlsProps) {
  const fourK = resolution === '4k'
  const chosen = RENDERING.find((r) => r.value === rendering)!
  return (
    <Group
      title="Risoluzione"
      testId="sr-section"
      footer={
        <span data-testid={fourK ? 'mq-status' : 'sr-status'}>{fourK ? fourKStatus : hdStatus}</span>
      }
    >
      <Row
        title="Risoluzione"
        hint={
          fourK
            ? 'Real-ESRGAN sulla GPU per le pagine sullo schermo, ×4 rispetto all’originale. Sperimentale: qualche secondo per pagina; HD resta il ripiego.'
            : 'HD: Anime4K sulla GPU, tutto automatico, pronta in meno di un secondo. 4K: reti Real-ESRGAN, più nitide ma lente.'
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
          <Row title="Rendering" hint={`Da veloce a lento cresce la qualità: Slow è la massima. ${chosen.detail}`} stacked>
            <Segmented<Rendering>
              label="Rendering"
              idPrefix="rend"
              value={rendering}
              onChange={(v) => onChange({ rendering: v })}
              options={RENDERING.map((r) => ({ value: r.value, label: r.value === 'slow' ? 'Slow · massima' : r.label }))}
            />
          </Row>
          <Row title="Sfocatura anti-spoiler" hint="Mentre la versione 4K viene calcolata, la pagina resta sfocata e si rivela solo quando è pronta.">
            <Switch checked={antiSpoiler} onChange={(v) => onChange({ antiSpoiler: v })} label="Sfocatura anti-spoiler" />
          </Row>
        </>
      )}
    </Group>
  )
}
