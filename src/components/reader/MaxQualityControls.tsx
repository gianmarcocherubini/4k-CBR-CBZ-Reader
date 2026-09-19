import type { MaxQualityBudget, MaxQualityModel } from '../../types'
import { Group, Row, Segmented, Switch } from './SettingsPanel'

interface MaxQualityControlsProps {
  enabled: boolean
  budget: MaxQualityBudget
  model: MaxQualityModel
  statusLine: string
  onToggle: (v: boolean) => void
  onBudget: (v: MaxQualityBudget) => void
  onModel: (v: MaxQualityModel) => void
}

/** Settings block of the Real-ESRGAN tier: switch, network, time budget, and a status line. */
export function MaxQualityControls({ enabled, budget, model, statusLine, onToggle, onBudget, onModel }: MaxQualityControlsProps) {
  return (
    <Group title="Qualità massima" testId="mq-section" footer={<span data-testid="mq-status">{statusLine}</span>}>
      <Row
        title="Qualità massima"
        hint="Real-ESRGAN ×4 sulla GPU, solo per le pagine sullo schermo: nessuna pre-elaborazione, nessuna coda. Sostituisce la Super risoluzione quando sta nel tempo massimo."
      >
        <Switch checked={enabled} onChange={onToggle} label="Qualità massima" />
      </Row>
      <Row
        title="Modello"
        hint="Anime v3: compatto, circa 1 s per pagina su un iPad M, con self-ensemble. 6B: la rete grande di Real-ESRGAN (9× il lavoro, ~10 s per pagina sullo stesso iPad, pesi da 9 MB scaricati alla prima attivazione); richiede un’attesa massima di 10 s o «Sempre»."
        stacked
      >
        <Segmented<MaxQualityModel>
          label="Modello"
          idPrefix="mq-model"
          value={model}
          onChange={onModel}
          options={[
            { value: 'v3', label: 'Anime v3 (veloce)' },
            { value: '6b', label: 'Anime 6B (lento)' },
          ]}
        />
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
