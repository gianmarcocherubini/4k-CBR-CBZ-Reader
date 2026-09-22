import { describe, expect, it } from 'vitest'
import type { ArchiveEntry } from '../entries'
import { epubPages, isEpub, pageImages, parseContainer, parseOpf, resolveZipPath } from './epub'
import type { ArchiveReader } from './types'

const container = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<manifest>
  <item id="cover" href="xhtml/cover.xhtml" media-type="application/xhtml+xml"/>
  <item id="p1" href="xhtml/p-001.xhtml" media-type="application/xhtml+xml"/>
  <item id="p2" href="xhtml/p-002.xhtml" media-type="application/xhtml+xml"/>
  <item id="colophon" href="xhtml/colophon.xhtml" media-type="application/xhtml+xml"/>
  <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  <item id="i0" href="image/cover.jpg" media-type="image/jpeg"/>
  <item id="i1" href="image/i-001.jpg" media-type="image/jpeg"/>
  <item id="i2" href="image/i-002.jpg" media-type="image/jpeg"/>
</manifest>
<spine page-progression-direction="rtl">
  <itemref idref="cover"/>
  <itemref idref="p2"/>
  <itemref idref="p1"/>
  <itemref idref="nav" linear="no"/>
  <itemref idref="colophon"/>
</spine></package>`
const files: Record<string, string> = {
  mimetype: 'application/epub+zip',
  'META-INF/container.xml': container,
  'OEBPS/content.opf': opf,
  'OEBPS/xhtml/cover.xhtml': '<html><body><svg xmlns:xlink="http://www.w3.org/1999/xlink"><image width="1600" height="2400" xlink:href="../image/cover.jpg"/></svg></body></html>',
  'OEBPS/xhtml/p-001.xhtml': '<html><body><div><img src="../image/i-001.jpg" alt=""/></div></body></html>',
  'OEBPS/xhtml/p-002.xhtml': '<html><body><img src="../image/i-002.jpg"/></body></html>',
  'OEBPS/xhtml/colophon.xhtml': '<html><body><p>Testo senza immagini</p></body></html>',
  'OEBPS/nav.xhtml': '<html><body><nav><a href="xhtml/p-001.xhtml">1</a></nav></body></html>',
  'OEBPS/image/cover.jpg': 'JPEG0',
  'OEBPS/image/i-001.jpg': 'JPEG1',
  'OEBPS/image/i-002.jpg': 'JPEG2',
  'OEBPS/image/unused.jpg': 'JPEG9',
}
const entries: ArchiveEntry[] = Object.entries(files).map(([name, data]) => ({ name, size: data.length, directory: false, encrypted: false }))
const reader: ArchiveReader = {
  format: 'cbz',
  entries: async () => entries,
  extract: async (name) => new Blob([files[name]!]),
  close: async () => undefined,
}

describe('epub', () => {
  it('recognises the container and resolves paths', () => {
    expect(isEpub(entries)).toBe(true)
    expect(isEpub(entries.filter((e) => e.name !== 'mimetype'))).toBe(false)
    expect(parseContainer(container)).toBe('OEBPS/content.opf')
    expect(resolveZipPath('OEBPS/xhtml/p-001.xhtml', '../image/i-001.jpg')).toBe('OEBPS/image/i-001.jpg')
    expect(resolveZipPath('OEBPS/content.opf', 'image/a%20b.jpg#x')).toBe('OEBPS/image/a b.jpg')
    expect(resolveZipPath('a.xhtml', '/abs/b.jpg')).toBe('abs/b.jpg')
  })

  it('reads manifest and spine, skipping non-linear items', () => {
    const { spine } = parseOpf(opf, 'OEBPS/content.opf')
    expect(spine.map((s) => s.path)).toEqual(['OEBPS/xhtml/cover.xhtml', 'OEBPS/xhtml/p-002.xhtml', 'OEBPS/xhtml/p-001.xhtml', 'OEBPS/xhtml/colophon.xhtml'])
  })

  it('finds <img> and SVG <image> references', () => {
    expect(pageImages(files['OEBPS/xhtml/cover.xhtml']!, 'OEBPS/xhtml/cover.xhtml')).toEqual(['OEBPS/image/cover.jpg'])
    expect(pageImages('<img src="data:image/png;base64,AAA"/><img src="x.png"/>', 'p/q.xhtml')).toEqual(['p/x.png'])
  })

  it('lists the pages in spine order, without text pages or unreferenced images', async () => {
    const pages = await epubPages(reader, entries)
    expect(pages.map((p) => p.name)).toEqual(['OEBPS/image/cover.jpg', 'OEBPS/image/i-002.jpg', 'OEBPS/image/i-001.jpg'])
  })

  it('falls back to natural order when the package is unreadable', async () => {
    const broken: ArchiveReader = { ...reader, extract: async () => new Blob(['<not xml']) }
    const pages = await epubPages(broken, entries)
    expect(pages.map((p) => p.name)).toEqual(['OEBPS/image/cover.jpg', 'OEBPS/image/i-001.jpg', 'OEBPS/image/i-002.jpg', 'OEBPS/image/unused.jpg'])
  })
})
