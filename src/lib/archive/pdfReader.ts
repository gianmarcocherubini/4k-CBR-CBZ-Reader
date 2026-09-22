import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { ArchiveEntry } from '../entries'
import { MAX_IMAGE_DIMENSION } from '../imageDimensions'
import { ArchiveError, type ArchiveReader } from './types'

/**
 * PDF through pdf.js. A comic PDF is one raster image per page: each page is rendered to a
 * bitmap at the resolution of the largest image it draws (so nothing is lost or invented) and
 * handed to the reader as a JPEG, like a page extracted from a CBZ. The file is read in ranges
 * from the Blob (a PDFDataRangeTransport over Blob.slice): a multi-hundred-megabyte volume never
 * has to be in memory whole. pdf.js is loaded on first use and parses in its own worker.
 */

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
type WorkerFactory = new () => Worker

const RANGE_CHUNK_BYTES = 1024 * 1024
/** Pages with no raster image (text, vectors) are rendered at this scale: 144 dpi. */
const VECTOR_SCALE = 2
/** Safari caps canvases at 16 megapixels. */
const MAX_RENDER_PIXELS = 16 * 1024 * 1024
const JPEG_QUALITY = 0.92

let pdfjsPromise: Promise<{ pdfjs: PdfJs; workerFactory: WorkerFactory | null }> | null = null

async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // The "legacy" build carries the polyfills pdf.js 6 needs (Promise.try, Uint8Array.toHex):
      // iPadOS 17/18 read HD-only, and must still open a PDF. Each document gets its own parser
      // worker (pdf.js allows one document per port), bundled by Vite; under Node (unit tests)
      // pdf.js runs it in-process.
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
      const workerFactory = typeof Worker !== 'undefined' ? (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker')).default : null
      return { pdfjs, workerFactory }
    })()
  }
  return pdfjsPromise
}

function mapPdfError(pdfjs: PdfJs, e: unknown): ArchiveError {
  if (e instanceof ArchiveError) return e
  const name = (e as { name?: string })?.name
  const message = e instanceof Error ? e.message : String(e)
  if (name === 'PasswordException') {
    const code = (e as { code?: number }).code
    return new ArchiveError(code === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? 'invalid-password' : 'encrypted', message)
  }
  if (name === 'AbortException') return new ArchiveError('aborted', message)
  return new ArchiveError('corrupt', message)
}

const pageName = (index: number) => `${String(index + 1).padStart(4, '0')}.jpg`

export class PdfArchiveReader implements ArchiveReader {
  readonly format = 'pdf' as const
  private readonly renders = new Map<number, Promise<Blob>>()
  private readonly pdfjs: PdfJs
  private readonly doc: PDFDocumentProxy
  private readonly port: Worker | null

  private constructor(pdfjs: PdfJs, doc: PDFDocumentProxy, port: Worker | null) {
    this.pdfjs = pdfjs
    this.doc = doc
    this.port = port
  }

  static async open(blob: Blob, password?: string, signal?: AbortSignal): Promise<PdfArchiveReader> {
    const { pdfjs, workerFactory } = await loadPdfjs()
    if (signal?.aborted) throw new ArchiveError('aborted')
    const port = workerFactory ? new workerFactory() : null
    const initial = new Uint8Array(await blob.slice(0, Math.min(blob.size, RANGE_CHUNK_BYTES)).arrayBuffer())
    class BlobRangeTransport extends pdfjs.PDFDataRangeTransport {
      override requestDataRange(begin: number, end: number): void {
        void blob
          .slice(begin, end)
          .arrayBuffer()
          .then(
            (buffer) => this.onDataRange(begin, new Uint8Array(buffer)),
            () => this.onDataRange(begin, null),
          )
      }
      override abort(): void {}
    }
    const task = pdfjs.getDocument({
      range: new BlobRangeTransport(blob.size, initial),
      rangeChunkSize: RANGE_CHUNK_BYTES,
      disableAutoFetch: true,
      disableStream: true,
      password,
      useSystemFonts: false,
      ...(port ? { worker: pdfjs.PDFWorker.create({ port }) } : {}),
    })
    const onAbort = () => void task.destroy()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const doc = await task.promise
      if (doc.numPages === 0) throw new ArchiveError('empty')
      return new PdfArchiveReader(pdfjs, doc, port)
    } catch (e) {
      await task.destroy().catch(() => undefined)
      port?.terminate()
      throw mapPdfError(pdfjs, e)
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  get pageCount(): number {
    return this.doc.numPages
  }

  entries(): Promise<ArchiveEntry[]> {
    return Promise.resolve(Array.from({ length: this.doc.numPages }, (_, i) => ({ name: pageName(i), size: 0, directory: false, encrypted: false })))
  }

  /** Width and height of the page in points, for the layout before any page is rendered. */
  async pageSize(index: number): Promise<{ w: number; h: number }> {
    const page = await this.doc.getPage(index + 1)
    const { width, height } = page.getViewport({ scale: 1 })
    return { w: width, h: height }
  }

  extract(name: string, signal?: AbortSignal): Promise<Blob> {
    const index = Number(name.replace(/\.jpg$/, '')) - 1
    if (!Number.isInteger(index) || index < 0 || index >= this.doc.numPages) return Promise.reject(new ArchiveError('missing', name))
    // The same page asked twice while it renders (preload and display) renders once.
    let pending = this.renders.get(index)
    if (!pending) {
      pending = this.render(index, signal).finally(() => this.renders.delete(index))
      this.renders.set(index, pending)
    }
    return pending
  }

  /** Pixel size of the largest raster image the page draws, if any. */
  private async largestImage(page: PDFPageProxy): Promise<{ w: number; h: number } | null> {
    const { OPS } = this.pdfjs
    const ops = await page.getOperatorList()
    let best: { w: number; h: number } | null = null
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i]
      if (fn !== OPS.paintImageXObject && fn !== OPS.paintImageXObjectRepeat) continue
      const objId = (ops.argsArray[i] as [string])[0]
      // Images shared between pages live in commonObjs (ids prefixed "g_"), the others per page.
      const store = objId.startsWith('g_') ? page.commonObjs : page.objs
      const image = (await new Promise<unknown>((resolve) => {
        if (store.has(objId)) resolve(store.get(objId))
        else store.get(objId, resolve)
      })) as { width?: number; height?: number } | null
      if (image?.width && image.height && (!best || image.width * image.height > best.w * best.h)) best = { w: image.width, h: image.height }
    }
    return best
  }

  private async render(index: number, signal?: AbortSignal): Promise<Blob> {
    let page: PDFPageProxy
    try {
      page = await this.doc.getPage(index + 1)
    } catch (e) {
      throw mapPdfError(this.pdfjs, e)
    }
    try {
      if (signal?.aborted) throw new ArchiveError('aborted')
      const base = page.getViewport({ scale: 1 })
      const image = await this.largestImage(page).catch(() => null)
      let scale = image ? Math.max(1, image.w / base.width) : VECTOR_SCALE
      const pixelCap = Math.sqrt(MAX_RENDER_PIXELS / (base.width * base.height))
      scale = Math.min(scale, pixelCap, MAX_IMAGE_DIMENSION / base.width, MAX_IMAGE_DIMENSION / base.height)
      const viewport = page.getViewport({ scale })
      const width = Math.max(1, Math.round(viewport.width))
      const height = Math.max(1, Math.round(viewport.height))
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height })
      const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
      if (!context) throw new ArchiveError('read', 'Canvas 2D non disponibile')
      const task = page.render({ canvasContext: context as CanvasRenderingContext2D, canvas: null, viewport })
      const onAbort = () => task.cancel()
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        await task.promise
      } catch (e) {
        if ((e as { name?: string })?.name === 'RenderingCancelledException' || signal?.aborted) throw new ArchiveError('aborted')
        throw mapPdfError(this.pdfjs, e)
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
      const blob =
        'convertToBlob' in canvas
          ? await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
          : await new Promise<Blob>((resolve, reject) => (canvas as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new ArchiveError('read', 'toBlob fallito'))), 'image/jpeg', JPEG_QUALITY))
      return blob
    } finally {
      page.cleanup()
    }
  }

  async close(): Promise<void> {
    await this.doc.loadingTask.destroy().catch(() => undefined)
    this.port?.terminate()
  }
}
