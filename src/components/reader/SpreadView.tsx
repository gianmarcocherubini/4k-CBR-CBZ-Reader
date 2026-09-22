import type { RefObject } from 'react'
import type { SpreadLayout } from '../../lib/reader/layout'
import { isBlank } from '../../lib/spread'
import type { SrResult } from '../../lib/upscale/srEngine'
import type { GutterColor, StageBackground } from '../../types'
import { PageContent, type PageState } from './PageContent'
import { transformFor, type ViewState } from './useGestures'

export type { PageState } from './PageContent'

/** A snapshot of the spread that is leaving the screen, animated out during a page turn. */
export interface SpreadGhost {
  id: number
  layout: SpreadLayout
  view: ViewState
  pages: ReadonlyMap<number, PageState>
  enhanced?: ReadonlyMap<number, SrResult>
  /** CSS animation class of the exit. */
  exitClass: string
}

interface SpreadViewProps {
  stageRef: RefObject<HTMLDivElement | null>
  canvasRef: RefObject<HTMLDivElement | null>
  layout: SpreadLayout
  view: ViewState
  pages: ReadonlyMap<number, PageState>
  enhanced?: ReadonlyMap<number, SrResult>
  gutterColor: GutterColor
  background: StageBackground
  /** Key of the current spread: a new key re-mounts the layer so its enter animation plays. */
  spreadKey: string
  enterClass?: string
  ghost?: SpreadGhost | null
  onRetry: (index: number) => void
  /** Pages whose plain image is blurred while their HD version is being computed (anti-spoiler). */
  blurred?: ReadonlySet<number>
  /** Pages whose HD version just arrived: the enhanced canvas animates from blurred to sharp. */
  revealing?: ReadonlySet<number>
}

const GUTTER_BG: Record<GutterColor, string> = {
  white: '#ffffff',
  paper: 'var(--paper)',
  dark: 'transparent',
}

/** Explicit reader backgrounds; "default" leaves the appearance token (light grey / black). */
export const STAGE_BG: Record<StageBackground, string | undefined> = {
  default: undefined,
  black: '#000000',
  white: '#ffffff',
}

interface SpreadCanvasProps {
  canvasRef?: RefObject<HTMLDivElement | null>
  layout: SpreadLayout
  view: ViewState
  pages: ReadonlyMap<number, PageState>
  enhanced?: ReadonlyMap<number, SrResult>
  gutterColor: GutterColor
  onRetry?: (index: number) => void
  testId: string
  blurred?: ReadonlySet<number>
  revealing?: ReadonlySet<number>
}

function SpreadCanvas({ canvasRef, layout, view, pages, enhanced, gutterColor, onRetry, testId, blurred, revealing }: SpreadCanvasProps) {
  const z = view.zoom
  return (
    <div
      ref={canvasRef}
      className={`absolute top-0 left-0 will-change-transform ${layout.w > 0 ? 'shadow-spread' : ''}`}
      style={{ width: layout.w * z, height: layout.h * z, transform: transformFor(view), transformOrigin: '0 0' }}
      data-testid={testId}
      data-zoom={z.toFixed(3)}
    >
      {layout.gutter && (
        <div
          className="absolute top-0"
          style={{ left: layout.gutter.x * z, width: layout.gutter.w * z, height: layout.h * z, background: GUTTER_BG[gutterColor] }}
          data-testid={testId === 'canvas' ? 'gutter' : undefined}
          aria-hidden
        />
      )}
      {layout.pages.map((box) => {
        const style = { left: box.x * z, top: box.y * z, width: box.w * z, height: box.h * z }
        if (isBlank(box.index)) {
          return (
            <div key={box.index} className="absolute" style={style} data-testid={testId === 'canvas' ? 'blank-page' : undefined}>
              <div className="page-paper h-full w-full" aria-label="Pagina bianca inserita" />
            </div>
          )
        }
        const state = pages.get(box.index)
        const sr = enhanced?.get(box.index)
        const isBlurred = !sr && blurred?.has(box.index) === true
        const isRevealing = !!sr && revealing?.has(box.index) === true
        return (
          <div
            key={box.index}
            className={`absolute ${isBlurred ? 'overflow-hidden' : ''} ${isRevealing ? 'hd-reveal' : ''}`}
            style={style}
            data-testid={testId === 'canvas' ? 'page' : undefined}
            data-page={box.index + 1}
            data-sr={sr ? sr.level : undefined}
            data-blurred={isBlurred || undefined}
          >
            <PageContent index={box.index} state={state} sr={sr} width={box.w * z} height={box.h * z} blurred={isBlurred} onRetry={onRetry} />
          </div>
        )
      })}
    </div>
  )
}

export function SpreadView({
  stageRef,
  canvasRef,
  layout,
  view,
  pages,
  enhanced,
  gutterColor,
  background,
  spreadKey,
  enterClass,
  ghost,
  onRetry,
  blurred,
  revealing,
}: SpreadViewProps) {
  return (
    <div
      ref={stageRef}
      className="reader-stage absolute inset-0 overflow-hidden bg-stage select-none"
      style={{ touchAction: 'none', background: STAGE_BG[background] }}
      data-testid="stage"
      data-background={background}
    >
      {ghost && (
        <div key={`ghost-${ghost.id}`} className={`spread-anim pointer-events-none absolute inset-0 ${ghost.exitClass}`} data-testid="spread-ghost" aria-hidden>
          <SpreadCanvas layout={ghost.layout} view={ghost.view} pages={ghost.pages} enhanced={ghost.enhanced} gutterColor={gutterColor} testId="ghost-canvas" />
        </div>
      )}
      <div key={spreadKey} className={`absolute inset-0 ${enterClass ? `spread-anim ${enterClass}` : ''}`}>
        <SpreadCanvas
          canvasRef={canvasRef}
          layout={layout}
          view={view}
          pages={pages}
          enhanced={enhanced}
          gutterColor={gutterColor}
          onRetry={onRetry}
          testId="canvas"
          blurred={blurred}
          revealing={revealing}
        />
      </div>
    </div>
  )
}
