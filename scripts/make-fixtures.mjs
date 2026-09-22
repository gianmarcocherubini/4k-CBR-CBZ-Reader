// Generates CBZ test fixtures into e2e/fixtures (git-ignored). No image tooling needed:
// pages are drawn into RGB buffers and encoded as PNG with zlib.
//   node scripts/make-fixtures.mjs
import { BlobWriter, TextReader, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'e2e', 'fixtures')
mkdirSync(outDir, { recursive: true })

// ---- PNG encoder -----------------------------------------------------------------------------
const crcTable = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c
}
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function encodePng(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- drawing ---------------------------------------------------------------------------------
const FONT = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
}

class Page {
  constructor(w, h, bg = [0xf6, 0xf3, 0xee]) {
    this.w = w
    this.h = h
    this.buf = Buffer.alloc(w * h * 3)
    for (let i = 0; i < w * h; i++) this.buf.set(bg, i * 3)
  }
  rect(x, y, w, h, rgb) {
    for (let yy = Math.max(0, y); yy < Math.min(this.h, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.w, x + w); xx++) this.buf.set(rgb, (yy * this.w + xx) * 3)
    }
  }
  frame(x, y, w, h, t, rgb) {
    this.rect(x, y, w, t, rgb)
    this.rect(x, y + h - t, w, t, rgb)
    this.rect(x, y, t, h, rgb)
    this.rect(x + w - t, y, t, h, rgb)
  }
  text(str, cx, cy, scale, rgb) {
    const glyphW = 5 * scale
    const gap = scale
    const total = str.length * glyphW + (str.length - 1) * gap
    let x = Math.round(cx - total / 2)
    const y = Math.round(cy - (7 * scale) / 2)
    for (const ch of str) {
      const g = FONT[ch]
      if (g) {
        for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (g[r][c] === '1') this.rect(x + c * scale, y + r * scale, scale, scale, rgb)
      }
      x += glyphW + gap
    }
  }
  // Pseudo screentone: dot grid, to give the upscaler something to chew on.
  tone(x, y, w, h, pitch, r, rgb) {
    for (let yy = y; yy < y + h; yy += pitch) for (let xx = x; xx < x + w; xx += pitch) this.rect(xx, yy, r, r, rgb)
  }
}

function hue(i) {
  const h = (i * 47) % 360
  const f = (n) => {
    const k = (n + h / 30) % 12
    return Math.round(255 * (0.55 + 0.35 * Math.max(-1, Math.min(1, Math.min(k - 3, 9 - k)))))
  }
  return [f(0), f(8), f(4)]
}

function drawPage(index, label, w, h) {
  return encodePng(w, h, paintPage(index, label, w, h).buf)
}

/** The RGB buffer of a page, for containers that embed raw samples (the PDF fixture). */
function paintPage(index, label, w, h) {
  const p = new Page(w, h)
  const ink = [0x14, 0x14, 0x1a]
  p.frame(24, 24, w - 48, h - 48, 6, ink)
  // panels
  const cols = w > h ? 3 : 2
  const rows = w > h ? 2 : 3
  const pw = (w - 96) / cols
  const ph = (h - 96) / rows
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = 48 + c * pw
      const y = 48 + r * ph
      p.frame(Math.round(x), Math.round(y), Math.round(pw - 12), Math.round(ph - 12), 4, ink)
      if ((r + c + index) % 3 === 0) p.tone(Math.round(x + 16), Math.round(y + 16), Math.round(pw - 44), Math.round(ph - 44), 9, 3, [0x55, 0x55, 0x60])
    }
  }
  // colour band + number
  p.rect(0, Math.round(h / 2 - 110), w, 220, hue(index))
  p.text(label, w / 2, h / 2, w > h ? 22 : 18, ink)
  // small "reading direction" marks: black bar at the left edge (RTL: left = next)
  p.rect(0, 0, 14, h, [0x30, 0x30, 0x38])
  return p
}

async function writeZip(name, entries, opts = {}) {
  const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false, ...opts })
  for (const e of entries) {
    if (typeof e.data === 'string') await writer.add(e.name, new TextReader(e.data))
    else await writer.add(e.name, new Uint8ArrayReader(e.data), { level: e.level ?? 0 })
  }
  const blob = await writer.close()
  writeFileSync(join(outDir, name), Buffer.from(await blob.arrayBuffer()))
  console.log('wrote', name, blob.size, 'bytes')
}

// ---- minimal RAR 4 writer (stored entries only) ------------------------------------------------
// Enough for unrar to list and extract: MARK_HEAD, MAIN_HEAD, one FILE_HEAD (method "storing",
// version 2.0) per entry followed by its bytes, and an ENDARC block. Header CRCs are the low 16 bits
// of CRC32 over the header bytes after the CRC field.
function rar4(entries) {
  const parts = [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])]
  const block = (type, flags, body) => {
    const head = Buffer.alloc(5)
    head[0] = type
    head.writeUInt16LE(flags, 1)
    head.writeUInt16LE(7 + body.length, 3)
    const crc = Buffer.alloc(2)
    crc.writeUInt16LE(crc32(Buffer.concat([head, body])) & 0xffff)
    return Buffer.concat([crc, head, body])
  }
  parts.push(block(0x73, 0x0000, Buffer.alloc(6))) // MAIN_HEAD: reserved1(2) + reserved2(4)
  for (const e of entries) {
    const name = Buffer.from(e.name, 'latin1')
    const body = Buffer.alloc(25 + name.length)
    body.writeUInt32LE(e.data.length, 0) // PACK_SIZE
    body.writeUInt32LE(e.data.length, 4) // UNP_SIZE
    body[8] = 2 // HOST_OS = Win32
    body.writeUInt32LE(crc32(e.data), 9) // FILE_CRC
    body.writeUInt32LE(0x4a8c0000, 13) // FTIME (DOS): 2017-04-12 00:00
    body[17] = 20 // UNP_VER 2.0
    body[18] = 0x30 // METHOD = storing
    body.writeUInt16LE(name.length, 19)
    body.writeUInt32LE(0x20, 21) // ATTR = archive
    name.copy(body, 25)
    // 0x8000 = LONG_BLOCK (data follows the header)
    parts.push(block(0x74, 0x8000, body), Buffer.from(e.data))
  }
  parts.push(block(0x7b, 0x4000, Buffer.alloc(0))) // ENDARC
  return Buffer.concat(parts)
}

// 19 pages; page 12 (index 11) is a wide spread 1600x1200 labelled "12-13" so labels after it read counter+1.
const manga = []
for (let i = 0; i < 19; i++) {
  const wide = i === 11
  const label = wide ? '12-13' : String(i < 11 ? i + 1 : i + 2)
  manga.push({ name: `Manga Vol 01/${String(i + 1).padStart(3, '0')}.png`, data: drawPage(i, label, wide ? 1600 : 800, 1200) })
}
manga.push({ name: 'Manga Vol 01/ComicInfo.xml', data: '<ComicInfo><Series>Manga</Series><Number>1</Number></ComicInfo>' })
manga.push({ name: '__MACOSX/Manga Vol 01/._001.png', data: new Uint8Array([0, 5, 22, 7, 0, 2, 0, 0]) })
await writeZip('manga-vol-01.cbz', manga)

const shortBook = []
for (let i = 0; i < 6; i++) shortBook.push({ name: `p${i + 1}.png`, data: drawPage(i + 30, String(i + 1), 1000, 1500) })
await writeZip('short-book.cbz', shortBook)

// Tiny book for the slow CUNet tests (2 pages, a few tiles each).
const tiny = []
for (let i = 0; i < 2; i++) tiny.push({ name: `t${i + 1}.png`, data: drawPage(i + 70, String(i + 1), 300, 450) })
await writeZip('tiny-book.cbz', tiny)
const tinyQueue = []
for (let i = 0; i < 6; i++) tinyQueue.push({ name: `q${i + 1}.png`, data: drawPage(i + 80, String(i + 1), 300, 450) })
await writeZip('tiny-queue.cbz', tinyQueue)

// ZIP64 archive with a handful of pages (forces the 64-bit records).
const z64 = []
for (let i = 0; i < 4; i++) z64.push({ name: `z${i + 1}.png`, data: drawPage(i + 60, String(i + 1), 800, 1200) })
await writeZip('zip64-book.cbz', z64, { zip64: true })

// CBR with 5 stored PNG pages (page 3 wide) plus a text entry to be ignored.
const cbr = []
for (let i = 0; i < 5; i++) {
  const wide = i === 2
  cbr.push({ name: `rar/${String(i + 1).padStart(3, '0')}.png`, data: drawPage(i + 40, String(i + 1), wide ? 1600 : 800, 1200) })
}
cbr.push({ name: 'rar/info.txt', data: Buffer.from('non una pagina') })
writeFileSync(join(outDir, 'stored-book.cbr'), rar4(cbr))
console.log('wrote stored-book.cbr')

// Small RAR archives from node-unrar-js (MIT) for the error paths of the worker.
const rarFixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'archive', 'rar', '__fixtures__')
for (const f of ['FolderTest.rar', 'HeaderEnc1234.rar']) copyFileSync(join(rarFixtures, f), join(outDir, f.replace('.rar', '.cbr')))
console.log('copied RAR error fixtures')

await writeZip('protected.cbz', [{ name: 'p1.png', data: drawPage(90, '1', 400, 600) }], { password: 'segreto' })
await writeZip('protected.zip', [{ name: 'p1.png', data: drawPage(91, '1', 400, 600) }], { password: 'segreto' })
writeFileSync(join(outDir, 'cover.png'), drawPage(92, 'C', 400, 600))
await writeZip('no-images.cbz', [{ name: 'readme.txt', data: 'niente immagini qui' }])

const corrupt = Buffer.alloc(64 * 1024)
corrupt.set([0x50, 0x4b, 0x03, 0x04])
for (let i = 4; i < corrupt.length; i++) corrupt[i] = (i * 2654435761) >>> 24
writeFileSync(join(outDir, 'corrupt.cbz'), corrupt)
console.log('wrote corrupt.cbz')

const sevenZip = Buffer.alloc(4096)
sevenZip.set([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
writeFileSync(join(outDir, 'archive.7z'), sevenZip)
console.log('wrote archive.7z')
// ---- PDF: one FlateDecode RGB image per page, drawn to fill a page of half its pixel size --------
// (so the reader must render at the image's own resolution, not at the page's 72 dpi).
function pdf(pages) {
  const objects = []
  const add = (body) => {
    objects.push(body)
    return objects.length
  }
  const catalog = add(null)
  const pagesObj = add(null)
  const kids = []
  for (const { w, h, rgb } of pages) {
    const data = deflateSync(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength), { level: 6 })
    const image = add(Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`),
      data,
      Buffer.from('\nendstream'),
    ]))
    const pw = w / 2
    const ph = h / 2
    const content = Buffer.from(`q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`)
    const contents = add(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]))
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${contents} 0 R >>`))
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offsets = []
  let position = parts[0].length
  objects.forEach((body, i) => {
    offsets.push(position)
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from('\nendobj\n')])
    parts.push(chunk)
    position += chunk.length
  })
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('')
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${position}\n%%EOF\n`))
  return Buffer.concat(parts)
}
const pdfPages = [0, 1, 2, 3].map((i) => {
  const wide = i === 2
  const w = wide ? 1600 : 800
  const h = 1200
  return { w, h, rgb: paintPage(i + 100, String(i + 1), w, h).buf }
})
writeFileSync(join(outDir, 'manga-pdf.pdf'), pdf(pdfPages))
console.log('wrote manga-pdf.pdf')

// ---- CBT: ustar with a directory, three pages (one wide) and a text entry -----------------------
function tarHeader(name, size, type) {
  const block = Buffer.alloc(512)
  block.write(name.slice(0, 100), 0, 'utf8')
  block.write('0000644\0', 100)
  block.write('0001750\0', 108)
  block.write('0001750\0', 116)
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  block.write('00000000000\0', 136)
  block.write('        ', 148)
  block.write(type, 156)
  block.write('ustar\0', 257)
  block.write('00', 263)
  let sum = 0
  for (const b of block) sum += b
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return block
}
function tar(entries) {
  const parts = []
  for (const e of entries) {
    const data = e.directory ? Buffer.alloc(0) : typeof e.data === 'string' ? Buffer.from(e.data) : Buffer.from(e.data)
    parts.push(tarHeader(e.name, data.length, e.directory ? '5' : '0'))
    if (!e.directory) {
      parts.push(data)
      const pad = (512 - (data.length % 512)) % 512
      if (pad) parts.push(Buffer.alloc(pad))
    }
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}
writeFileSync(
  join(outDir, 'manga-cbt.cbt'),
  tar([
    { name: 'Tar Book/', directory: true },
    { name: 'Tar Book/003.png', data: drawPage(112, '3', 800, 1200) },
    { name: 'Tar Book/001.png', data: drawPage(110, '1', 800, 1200) },
    { name: 'Tar Book/002.png', data: drawPage(111, '2', 1600, 1200) },
    { name: 'Tar Book/notes.txt', data: 'non una pagina' },
  ]),
)
console.log('wrote manga-cbt.cbt')

// ---- EPUB (fixed layout): spine order differs from the natural order of the file names ----------
const epubImages = { 'OEBPS/image/img-a.png': drawPage(120, 'A', 800, 1200), 'OEBPS/image/img-b.png': drawPage(121, 'B', 1600, 1200), 'OEBPS/image/img-c.png': drawPage(122, 'C', 800, 1200) }
const xhtml = (img) => `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><meta name="viewport" content="width=800, height=1200"/></head><body><div><img src="../image/${img}" alt=""/></div></body></html>`
await writeZip('manga-epub.epub', [
  { name: 'mimetype', data: Buffer.from('application/epub+zip'), level: 0 },
  { name: 'META-INF/container.xml', data: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
  {
    name: 'OEBPS/content.opf',
    data: `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:test</dc:identifier><dc:title>Epub Book</dc:title><meta property="rendition:layout">pre-paginated</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="pb" href="xhtml/p-b.xhtml" media-type="application/xhtml+xml"/><item id="pc" href="xhtml/p-c.xhtml" media-type="application/xhtml+xml"/><item id="pa" href="xhtml/p-a.xhtml" media-type="application/xhtml+xml"/><item id="ptext" href="xhtml/colophon.xhtml" media-type="application/xhtml+xml"/><item id="ia" href="image/img-a.png" media-type="image/png"/><item id="ib" href="image/img-b.png" media-type="image/png"/><item id="ic" href="image/img-c.png" media-type="image/png"/></manifest><spine page-progression-direction="rtl"><itemref idref="pb"/><itemref idref="pc"/><itemref idref="pa"/><itemref idref="ptext"/></spine></package>`,
  },
  { name: 'OEBPS/nav.xhtml', data: '<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="xhtml/p-b.xhtml">Start</a></li></ol></nav></body></html>' },
  { name: 'OEBPS/xhtml/p-b.xhtml', data: xhtml('img-b.png') },
  { name: 'OEBPS/xhtml/p-c.xhtml', data: xhtml('img-c.png') },
  { name: 'OEBPS/xhtml/p-a.xhtml', data: xhtml('img-a.png') },
  { name: 'OEBPS/xhtml/colophon.xhtml', data: '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Solo testo</p></body></html>' },
  ...Object.entries(epubImages).map(([name, data]) => ({ name, data })),
])
