import type { ReactNode } from 'react'
import type { Direction, FitMode, Gutter, GutterColor, PageMode, PageTransition, ReaderSettings, StageBackground, Theme } from '../../types'
import { fullscreenSupported, isStandalone } from '../../lib/fullscreen'

interface SettingsPanelProps {
  settings: ReaderSettings
  /** Number of user-inserted blank pages in this volume. */
  blankCount: number
  onClearBlanks: () => void
  onChange: (patch: Partial<ReaderSettings>) => void
  onClose: () => void
  /** The "Risoluzione" section (HD / 4K). */
  quality?: ReactNode
  /** Measured reading area, window, screen and safe areas (diagnostics under "Adattamento"). */
  viewportInfo?: string
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

/** One line of a grouped list; `stacked` puts the control full-width under the title. */
export function Row({ title, hint, stacked = false, children }: { title: string; hint?: string; stacked?: boolean; children?: ReactNode }) {
  return (
    <div className={stacked ? 'row flex-col !items-stretch gap-3' : 'row'}>
      <div className="min-w-0">
        <div className="text-body">{title}</div>
        {hint && <div className="mt-0.5 text-footnote text-label-2">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

/** Section: eyebrow header, hairline card, optional footer note. */
export function Group({ title, footer, children, testId }: { title?: string; footer?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section data-testid={testId}>
      {title && <h3 className="group-header">{title}</h3>}
      <div className="group-card">{children}</div>
      {footer && <div className="group-footer">{footer}</div>}
    </section>
  )
}

export function SettingsPanel({ settings, blankCount, onClearBlanks, onChange, onClose, quality, viewportInfo }: SettingsPanelProps) {
  return (
    <div className="absolute inset-0 z-30 flex justify-end bg-black/20" role="presentation" onClick={onClose}>
      <aside
        role="dialog"
        aria-label="Impostazioni di lettura"
        className="sheet-enter h-full w-full max-w-sm overflow-y-auto border-l border-separator bg-bg pt-safe pb-safe"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        data-testid="settings-panel"
      >
        <div className="material hairline-b sticky top-0 z-10 flex h-14 items-center justify-between px-5">
          <h2 className="text-headline">Impostazioni</h2>
          <button type="button" className="btn-pill" onClick={onClose} aria-label="Chiudi impostazioni">
            Fine
          </button>
        </div>
        <div className="space-y-8 px-5 pt-6 pb-12">
          {quality}

          <Group title="Lettura" footer="Automatica: doppia pagina con lo schermo in orizzontale, singola in verticale. Le tavole doppie (pagine orizzontali) sono sempre mostrate da sole; la copertina sta da sola e le coppie partono da 2-3.">
            <Row title="Direzione" stacked>
              <Segmented<Direction>
                label="Direzione di lettura"
                idPrefix="dir"
                value={settings.direction}
                onChange={(direction) => onChange({ direction })}
                options={[
                  { value: 'rtl', label: 'Destra → sinistra' },
                  { value: 'ltr', label: 'Sinistra → destra' },
                ]}
              />
            </Row>
            <Row title="Pagine" stacked>
              <Segmented<PageMode>
                label="Modalità pagine"
                value={settings.pageMode}
                onChange={(pageMode) => onChange({ pageMode })}
                options={[
                  { value: 'single', label: 'Singola' },
                  { value: 'double', label: 'Doppia' },
                  { value: 'auto', label: 'Automatica' },
                ]}
              />
            </Row>
            <Row title="Transizione" stacked>
              <Segmented<PageTransition>
                label="Transizione tra le pagine"
                idPrefix="tr"
                value={settings.transition}
                onChange={(transition) => onChange({ transition })}
                options={[
                  { value: 'none', label: 'Nessuna' },
                  { value: 'fade', label: 'Dissolvenza' },
                  { value: 'slide', label: 'Scorrimento' },
                ]}
              />
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
                <button type="button" className="btn-pill shrink-0" onClick={onClearBlanks} data-testid="clear-blanks">
                  Rimuovi
                </button>
              )}
            </Row>
          </Group>

          <Group
            title="Adattamento"
            footer={
              <>
                Pizzica per ingrandire, doppio tocco al centro per lo zoom rapido. 1:1 = un pixel dell’immagine per pixel dello schermo.
                {viewportInfo && (
                  <>
                    <br />
                    <span data-testid="viewport-info">Misure: {viewportInfo}.</span>
                  </>
                )}
              </>
            }
          >
            <Row title="Adattamento" stacked>
              <Segmented<FitMode>
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
            </Row>
            <Row title="Spazio centrale" hint="Il margine tra le due pagine in doppia pagina, come la piega di un libro." stacked>
              <Segmented<Gutter>
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
            </Row>
            <Row title="Colore dello spazio">
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

          <Group title="Aspetto" footer="Sfondo di lettura: Default segue l’aspetto (grigio caldo o nero); Nero e Bianco lo fissano.">
            <Row title="Tema" stacked>
              <Segmented<Theme>
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
            </Row>
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
            <Row
              title="Schermo intero"
              hint={
                isStandalone()
                  ? 'Nell’app installata iOS non consente di nascondere la barra di stato: l’app usa tutto lo schermo sotto di essa, fino al bordo inferiore. In Safari va davvero a schermo intero.'
                  : fullscreenSupported()
                    ? 'A schermo intero nasconde la barra di stato (ora, Wi-Fi, batteria) e l’indicatore Home mentre leggi.'
                    : 'Non disponibile in questo browser.'
              }
            >
              <Switch checked={settings.fullscreenReading} onChange={(v) => onChange({ fullscreenReading: v })} label="Schermo intero durante la lettura" />
            </Row>
            <Row title="Indicatore HD / 4K" hint="Piccola etichetta in alto a destra: accesa quando la risoluzione scelta è applicata alla pagina, barrata quando non lo è.">
              <Switch checked={settings.srIndicator} onChange={(v) => onChange({ srIndicator: v })} label="Indicatore HD" />
            </Row>
          </Group>
        </div>
      </aside>
    </div>
  )
}
