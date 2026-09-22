import type { ReactNode } from 'react'
import type { Direction, FitMode, Gutter, GutterColor, PageMode, PageTransition, ReaderSettings, ReadingMode, ScrollGap, ScrollWidth, StageBackground, Theme } from '../../types'
import { fullscreenSupported, isStandalone } from '../../lib/fullscreen'

/** Pictograms of the two reading modes, drawn in the current colour: an open book, a strip. */
const ModeArt = {
  pages: (
    <svg viewBox="0 0 64 40" width="64" height="40" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="8" y="4" width="22" height="32" rx="2" fill="currentColor" fillOpacity="0.12" />
      <rect x="34" y="4" width="22" height="32" rx="2" fill="currentColor" fillOpacity="0.12" />
      <path d="M14 12h10M14 17h8M40 12h10M40 17h6" strokeOpacity="0.55" />
      <path d="M5.5 16.5 2 20l3.5 3.5M58.5 16.5 62 20l-3.5 3.5" />
    </svg>
  ),
  scroll: (
    <svg viewBox="0 0 64 40" width="64" height="40" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="20" y="-8" width="24" height="18" rx="2" fill="currentColor" fillOpacity="0.12" />
      <rect x="20" y="12" width="24" height="18" rx="2" fill="currentColor" fillOpacity="0.12" />
      <rect x="20" y="32" width="24" height="18" rx="2" fill="currentColor" fillOpacity="0.12" />
      <path d="M26 18h12M26 23h8" strokeOpacity="0.55" />
      <path d="M54 10v20" />
      <path d="M50.5 26.5 54 30l3.5-3.5" />
    </svg>
  ),
}

/**
 * The one choice that changes how a volume is read, as two illustrated cards: turning pages
 * (one or two at a time) or one vertical strip. Selected = ink on bone, like every other control.
 */
function ReadingModePicker({ value, onChange }: { value: ReadingMode; onChange: (mode: ReadingMode) => void }) {
  const options: Array<{ value: ReadingMode; title: string; detail: string }> = [
    { value: 'pages', title: 'Pagine', detail: 'Si sfoglia a destra e sinistra, una o due pagine per volta, come un libro.' },
    { value: 'scroll', title: 'Scorrimento', detail: 'Le pagine scorrono in verticale, una dopo l’altra: per webtoon e lettura continua.' },
  ]
  return (
    <div className="grid grid-cols-2 gap-2" role="group" aria-label="Modalità di lettura">
      {options.map((option) => {
        const selected = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={`flex flex-col items-start gap-2 rounded-[12px] p-3 text-left transition-colors ${
              selected ? 'bg-invert text-invert-fg' : 'bg-fill text-label hover:bg-fill-2'
            }`}
            data-testid={`mode-${option.value}`}
          >
            <div className="h-10 w-16 overflow-hidden">{ModeArt[option.value]}</div>
            <div className="text-[14px] leading-[18px] font-semibold">{option.title}</div>
            <div className={`text-caption ${selected ? 'opacity-70' : 'text-label-2'}`}>{option.detail}</div>
          </button>
        )
      })}
    </div>
  )
}

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

/**
 * Collapsed disclosure for the diagnostics a reader never needs (backend, kernels, measured
 * geometry) but that make a support question answerable: "cosa dice Dettagli tecnici?".
 */
export function TechnicalDetails({ children }: { children: ReactNode }) {
  return (
    <details className="group mt-2">
      <summary className="inline-flex cursor-pointer select-none items-center gap-1 text-caption text-label-3 marker:content-none hover:text-label-2 [&::-webkit-details-marker]:hidden">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="transition-transform group-open:rotate-90" aria-hidden>
          <path d="m9 6 6 6-6 6" />
        </svg>
        Dettagli tecnici
      </summary>
      <div className="mt-1.5 font-mono text-[11px] leading-[15px] text-label-3 break-words">{children}</div>
    </details>
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
  const scroll = settings.readingMode === 'scroll'
  const diagnostics = viewportInfo ? (
    <TechnicalDetails>
      <span data-testid="viewport-info">{viewportInfo}</span>
    </TechnicalDetails>
  ) : null
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

          <Group
            title="Lettura"
            footer={
              scroll ? (
                <>
                  Tocca la parte alta o bassa dello schermo per scorrere di una schermata, il centro per le barre. Larghezza Intera riempie lo
                  schermo; Media e Stretta sono comode con l’iPad in orizzontale. Spazio Nessuno per i webtoon disegnati come un’unica striscia.
                  {diagnostics}
                </>
              ) : (
                'Automatica: due pagine affiancate con l’iPad in orizzontale, una sola in verticale. La copertina e le tavole doppie stanno sempre da sole.'
              )
            }
          >
            <Row title="Modalità" stacked>
              <ReadingModePicker value={settings.readingMode} onChange={(readingMode) => onChange({ readingMode })} />
            </Row>
            {scroll ? (
              <>
                <Row title="Larghezza" stacked>
                  <Segmented<ScrollWidth>
                    label="Larghezza della striscia"
                    idPrefix="sw"
                    value={settings.scrollWidth}
                    onChange={(scrollWidth) => onChange({ scrollWidth })}
                    options={[
                      { value: 'full', label: 'Intera' },
                      { value: 'medium', label: 'Media' },
                      { value: 'narrow', label: 'Stretta' },
                    ]}
                  />
                </Row>
                <Row title="Spazio tra le pagine" stacked>
                  <Segmented<ScrollGap>
                    label="Spazio tra le pagine"
                    idPrefix="sg"
                    value={settings.scrollGap}
                    onChange={(scrollGap) => onChange({ scrollGap })}
                    options={[
                      { value: 'none', label: 'Nessuno' },
                      { value: 's', label: 'Piccolo' },
                      { value: 'm', label: 'Medio' },
                    ]}
                  />
                </Row>
              </>
            ) : (
              <>
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
                      ? `${blankCount} in questo volume. Se due pagine affiancate non combaciano, usa “Pagina bianca qui” nella barra in basso.`
                      : 'Se due pagine affiancate non combaciano, usa “Pagina bianca qui” nella barra in basso: da lì in avanti le coppie si spostano di una pagina.'
                  }
                >
                  {blankCount > 0 && (
                    <button type="button" className="btn-pill shrink-0" onClick={onClearBlanks} data-testid="clear-blanks">
                      Rimuovi
                    </button>
                  )}
                </Row>
              </>
            )}
          </Group>

          {!scroll && (
            <Group
              title="Adattamento"
              footer={
                <>
                  Pizzica per ingrandire, doppio tocco al centro per lo zoom rapido. 1:1 mostra la pagina alla sua dimensione reale.
                  {diagnostics}
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
              <Row title="Spazio centrale" hint="Il margine tra le due pagine affiancate, come la piega di un libro." stacked>
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
          )}

          <Group title="Aspetto" footer="Sfondo di lettura: Default segue il tema (grigio caldo di giorno, nero di notte); Nero e Bianco lo fissano.">
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
                  ? 'Nell’app installata la barra di stato (ora, batteria) resta visibile: è iPadOS a volerlo. La pagina usa comunque tutto lo spazio sotto di essa.'
                  : fullscreenSupported()
                    ? 'Nasconde la barra di stato (ora, Wi-Fi, batteria) e l’indicatore Home mentre leggi.'
                    : 'Non disponibile in questo browser.'
              }
            >
              <Switch checked={settings.fullscreenReading} onChange={(v) => onChange({ fullscreenReading: v })} label="Schermo intero durante la lettura" />
            </Row>
            <Row title="Indicatore HD / 4K" hint="Piccola etichetta in alto a destra: accesa quando la pagina è stata migliorata, attenuata mentre ci lavora, barrata quando non è possibile.">
              <Switch checked={settings.srIndicator} onChange={(v) => onChange({ srIndicator: v })} label="Indicatore HD" />
            </Row>
          </Group>
        </div>
      </aside>
    </div>
  )
}
