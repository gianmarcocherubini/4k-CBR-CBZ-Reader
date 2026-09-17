import type { ReactNode } from 'react'
import type { Direction, FitMode, Gutter, GutterColor, PageMode, ReaderSettings, SrLevel, StageBackground, Theme } from '../../types'

interface SettingsPanelProps {
  settings: ReaderSettings
  coverOffset: boolean
  /** Number of user-inserted blank pages in this volume. */
  blankCount: number
  onClearBlanks: () => void
  onChange: (patch: Partial<ReaderSettings>) => void
  onCoverOffset: (value: boolean) => void
  onClose: () => void
  /** Status line of the Anime4K tier. */
  extra?: ReactNode
  /** The "Qualità massima" section. */
  maxQuality?: ReactNode
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className = '',
  idPrefix = 'opt',
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (v: T) => void
  label: string
  className?: string
  /** Prefix of the data-testid of each option (default "opt"). */
  idPrefix?: string
}) {
  return (
    <div className={`segmented ${className}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="flex-1 whitespace-nowrap"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          data-testid={`${idPrefix}-${o.value}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)}>
      <span />
    </button>
  )
}

/** One line of a grouped inset list. */
export function Row({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="row">
      <div className="min-w-0">
        <div className="text-body">{title}</div>
        {hint && <div className="mt-0.5 text-footnote text-label-2">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

/** Grouped inset section: uppercase header, white card, optional footer note. */
export function Group({ title, footer, children, testId }: { title?: string; footer?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section data-testid={testId}>
      {title && <h3 className="group-header">{title}</h3>}
      <div className="group-card">{children}</div>
      {footer && <div className="group-footer">{footer}</div>}
    </section>
  )
}

export function SettingsPanel({
  settings,
  coverOffset,
  blankCount,
  onClearBlanks,
  onChange,
  onCoverOffset,
  onClose,
  extra,
  maxQuality,
}: SettingsPanelProps) {
  return (
    <div className="absolute inset-0 z-30 flex justify-end bg-black/10" role="presentation" onClick={onClose}>
      <aside
        role="dialog"
        aria-label="Impostazioni di lettura"
        className="sheet-enter h-full w-full max-w-sm overflow-y-auto bg-grouped pt-safe pb-safe shadow-sheet"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        data-testid="settings-panel"
      >
        <div className="material hairline-b sticky top-0 z-10 flex h-[52px] items-center justify-between px-4">
          <h2 className="text-headline">Impostazioni</h2>
          <button type="button" className="btn-plain -mr-2 font-semibold" onClick={onClose} aria-label="Chiudi impostazioni">
            Fine
          </button>
        </div>
        <div className="space-y-7 px-4 pt-5 pb-10">
          <Group title="Aspetto" footer="Sfondo di lettura: Default segue l’aspetto (grigio chiaro o nero); Nero e Bianco lo fissano.">
            <div className="row">
              <Segmented<Theme>
                className="w-full"
                label="Aspetto"
                idPrefix="theme"
                value={settings.theme}
                onChange={(theme) => onChange({ theme })}
                options={[
                  { value: 'system', label: 'Sistema' },
                  { value: 'light', label: 'Chiaro' },
                  { value: 'dark', label: 'Scuro' },
                ]}
              />
            </div>
            <Row title="Sfondo di lettura">
              <Segmented<StageBackground>
                label="Sfondo di lettura"
                idPrefix="bg"
                value={settings.stageBackground}
                onChange={(stageBackground) => onChange({ stageBackground })}
                options={[
                  { value: 'default', label: 'Default' },
                  { value: 'black', label: 'Nero' },
                  { value: 'white', label: 'Bianco' },
                ]}
              />
            </Row>
          </Group>

          <Group title="Direzione di lettura">
            <div className="row">
              <Segmented<Direction>
                className="w-full"
                label="Direzione di lettura"
                idPrefix="dir"
                value={settings.direction}
                onChange={(direction) => onChange({ direction })}
                options={[
                  { value: 'rtl', label: 'Destra → sinistra' },
                  { value: 'ltr', label: 'Sinistra → destra' },
                ]}
              />
            </div>
          </Group>

          <Group
            title="Pagine"
            footer="Automatica: doppia pagina con lo schermo in orizzontale, singola in verticale. Le tavole doppie (pagine orizzontali) sono sempre mostrate da sole."
          >
            <div className="row">
              <Segmented<PageMode>
                className="w-full"
                label="Modalità pagine"
                value={settings.pageMode}
                onChange={(pageMode) => onChange({ pageMode })}
                options={[
                  { value: 'single', label: 'Singola' },
                  { value: 'double', label: 'Doppia' },
                  { value: 'auto', label: 'Automatica' },
                ]}
              />
            </div>
            <Row title="Sfasa coppie" hint="Copertina da sola, poi coppie 2-3, 4-5… Vale per questo volume.">
              <Switch checked={coverOffset} onChange={onCoverOffset} label="Sfasa coppie" />
            </Row>
            <Row
              title="Pagine bianche inserite"
              hint={
                blankCount > 0
                  ? `${blankCount} in questo volume. Se una tavola doppia non combacia, usa “Pagina bianca qui” nella barra in basso.`
                  : 'Se una tavola doppia non combacia, usa “Pagina bianca qui” nella barra in basso: le coppie seguenti si spostano di una pagina.'
              }
            >
              {blankCount > 0 && (
                <button type="button" className="btn-plain shrink-0" onClick={onClearBlanks} data-testid="clear-blanks">
                  Rimuovi
                </button>
              )}
            </Row>
          </Group>

          <Group title="Spazio centrale (doppia pagina)" footer="Il margine tra le due pagine, bianco di default come la piega di un libro." testId="gutter-section">
            <div className="row">
              <Segmented<Gutter>
                className="w-full"
                label="Spazio centrale"
                idPrefix="gutter"
                value={settings.gutter}
                onChange={(gutter) => onChange({ gutter })}
                options={[
                  { value: 'none', label: 'Nessuno' },
                  { value: 's', label: 'Stretto' },
                  { value: 'm', label: 'Medio' },
                  { value: 'l', label: 'Largo' },
                ]}
              />
            </div>
            <Row title="Colore">
              <Segmented<GutterColor>
                label="Colore dello spazio centrale"
                idPrefix="gc"
                value={settings.gutterColor}
                onChange={(gutterColor) => onChange({ gutterColor })}
                options={[
                  { value: 'white', label: 'Bianco' },
                  { value: 'paper', label: 'Carta' },
                  { value: 'dark', label: 'Sfondo' },
                ]}
              />
            </Row>
          </Group>

          <Group title="Adattamento" footer="Pizzica per ingrandire, doppio tocco al centro per lo zoom rapido. 1:1 = un pixel dell’immagine per pixel dello schermo.">
            <div className="row">
              <Segmented<FitMode>
                className="w-full"
                label="Adattamento"
                idPrefix="fit"
                value={settings.fit}
                onChange={(fit) => onChange({ fit })}
                options={[
                  { value: 'screen', label: 'Schermo' },
                  { value: 'height', label: 'Altezza' },
                  { value: 'width', label: 'Larghezza' },
                  { value: 'original', label: '1:1' },
                ]}
              />
            </div>
          </Group>

          <Group title="Super risoluzione" footer={extra} testId="sr-section">
            <Row title="Super risoluzione" hint="Anime4K ×2 sulla GPU: linee e lettering più nitidi quando la pagina è mostrata più grande dei suoi pixel.">
              <Switch checked={settings.superResolution} onChange={(v) => onChange({ superResolution: v })} label="Super risoluzione" />
            </Row>
            <Row title="Livello">
              <Segmented<SrLevel>
                label="Livello"
                idPrefix="sr"
                value={settings.srLevel}
                onChange={(srLevel) => onChange({ srLevel })}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'M', label: 'M' },
                  { value: 'VL', label: 'VL' },
                  { value: 'UL', label: 'UL' },
                ]}
              />
            </Row>
          </Group>

          {maxQuality}
        </div>
      </aside>
    </div>
  )
}
