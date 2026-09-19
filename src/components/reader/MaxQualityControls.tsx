import type { MaxQualityBudget } from '../../types'
import { Group, Row, Segmented, Switch } from './SettingsPanel'

interface MaxQualityControlsProps {
  enabled: boolean
  budget: MaxQualityBudget
  statusLine: string
  onToggle: (v: boolean) => void
  onBudget: (v: MaxQualityBudget) => void
}

/** Settings block of the Real-ESRGAN tier: one switch, the time budget, and a status line. */
export function MaxQualityControls({ enabled, budget, statusLine, onToggle, onBudget }: MaxQualityControlsProps) {
  return (
    <Group title="Qualità massima" testId="mq-section" footer={<span data-testid="mq-status">{statusLine}</span>}>
      <Row
        title="Qualità massima"
        hint="Real-ESRGAN (anime) ×4 sulla GPU, solo per le pagine sullo schermo: nessuna pre-elaborazione, nessuna coda. Sostituisce la Super risoluzione quando sta nel tempo massimo."
      >
        <Switch checked={enabled} onChange={onToggle} label="Qualità massima" />
      </Row>
      <Row
        title="Attesa massima"
        hint="Se la GPU prevede di impiegare di più per le pagine sullo schermo, quelle pagine usano la Super risoluzione (Anime4K). Il tempo che avanza va in qualità: fino a 8 passaggi su copie riflesse e ruotate della pagina, mediati (self-ensemble)."
        stacked
      >
        <Segmented<`${MaxQualityBudget}`>
          label="Attesa massima"
          idPrefix="mq-budget"
          value={`${budget}`}
          onChange={(v) => onBudget(Number(v) as MaxQualityBudget)}
          options={[
            { value: '3', label: '3 s' },
            { value: '5', label: '5 s' },
            { value: '10', label: '10 s' },
            { value: '0', label: 'Sempre' },
          ]}
        />
      </Row>
    </Group>
  )
}
