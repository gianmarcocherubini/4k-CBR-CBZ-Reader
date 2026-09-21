import type { MaxQualityBudget, MaxQualityModel } from '../../types'
import { Group, Row, Segmented, Switch } from './SettingsPanel'

interface MaxQualityControlsProps {
  enabled: boolean
  budget: MaxQualityBudget
  model: MaxQualityModel
  ensemble: boolean
  blur: boolean
  statusLine: string
  onToggle: (v: boolean) => void
  onBudget: (v: MaxQualityBudget) => void
  onModel: (v: MaxQualityModel) => void
  onEnsemble: (v: boolean) => void
  onBlur: (v: boolean) => void
}

/** Settings block of the Real-ESRGAN tier: switch, network, time budget, ensemble, anti-spoiler blur, status line. */
export function MaxQualityControls({ enabled, budget, model, ensemble, blur, statusLine, onToggle, onBudget, onModel, onEnsemble, onBlur }: MaxQualityControlsProps) {
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
        hint="Anime v3: compatto, circa 1 s per pagina su un iPad M. 6B: la rete grande di Real-ESRGAN, nove volte il lavoro, decine di secondi per pagina (pesi da 9 MB scaricati alla prima attivazione); richiede «Sempre» o un’attesa massima adeguata."
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
        hint="Se la GPU prevede di impiegare di più per le pagine sullo schermo, quelle pagine usano la Super risoluzione (Anime4K)."
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
      <Row
        title="Self-ensemble"
        hint="Solo Anime v3. Spento: un passaggio (circa 1 s per pagina). Acceso: più passaggi su copie riflesse e ruotate della pagina, mediati (bordi più puliti), al costo di altrettanto tempo: quanti ne stanno nell’attesa massima (2, 4 o 8), quattro con «Sempre». Non accelera nulla; sul 6B, che costa secondi a passaggio, non viene applicato."
      >
        <Switch checked={ensemble} onChange={onEnsemble} label="Self-ensemble" />
      </Row>
      <Row
        title="Sfocatura anti-spoiler"
        hint="Mentre la versione HD viene calcolata, la pagina resta sfocata e si rivela solo quando è pronta."
      >
        <Switch checked={blur} onChange={onBlur} label="Sfocatura anti-spoiler" />
      </Row>
    </Group>
  )
}
