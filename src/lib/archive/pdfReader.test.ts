import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { PdfArchiveReader } from './pdfReader'

/** A minimal PDF: one FlateDecode RGB image per page, drawn to fill a page half its pixel size. */
function makePdf(pages: Array<{ w: number; h: number }>, encryptedMarker = false): Blob {
  const objects: Array<Buffer | string | null> = []
  const add = (body: Buffer | string | null) => objects.push(body)
  const catalog = add(null)
  const pagesObj = add(null)
  const kids: number[] = []
  for (const { w, h } of pages) {
    const rgb = Buffer.alloc(w * h * 3, 0x80)
    const data = deflateSync(rgb)
    const image = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]))
    const content = Buffer.from(`q ${w / 2} 0 0 ${h / 2} 0 0 cm /Im0 Do Q`)
    const contents = add(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]))
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${w / 2} ${h / 2}] /Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${contents} 0 R >>`))
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`
  const parts = [Buffer.from('%PDF-1.4\n')]
  const offsets: number[] = []
  let position = parts[0]!.length
  objects.forEach((body, i) => {
    offsets.push(position)
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body!), Buffer.from('\nendobj\n')])
    parts.push(chunk)
    position += chunk.length
  })
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('')
  const encrypt = encryptedMarker ? ' /Encrypt 99 0 R' : ''
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${encrypt} >>\nstartxref\n${position}\n%%EOF\n`))
  return new Blob(parts as unknown as BlobPart[], { type: 'application/pdf' })
}

describe('PdfArchiveReader', () => {
  it('opens a PDF read in ranges, lists one entry per page and reports page sizes in points', async () => {
    const reader = await PdfArchiveReader.open(makePdf([{ w: 80, h: 120 }, { w: 160, h: 120 }, { w: 80, h: 120 }]))
    expect(reader.format).toBe('pdf')
    expect(reader.pageCount).toBe(3)
    const entries = await reader.entries()
    expect(entries.map((e) => e.name)).toEqual(['0001.jpg', '0002.jpg', '0003.jpg'])
    expect(entries.every((e) => !e.directory && !e.encrypted)).toBe(true)
    expect(await reader.pageSize(1)).toEqual({ w: 80, h: 60 })
    await expect(reader.extract('0009.jpg')).rejects.toMatchObject({ code: 'missing' })
    await reader.close()
  })

  it('maps a broken file to a corrupt error', async () => {
    await expect(PdfArchiveReader.open(new Blob(['%PDF-1.4\nnot really a pdf']))).rejects.toMatchObject({ code: 'corrupt' })
  })
})
