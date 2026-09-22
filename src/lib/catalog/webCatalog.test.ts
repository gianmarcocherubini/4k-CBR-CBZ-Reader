import { describe, expect, it } from 'vitest'
import { normalizeCatalogs } from './catalogs'
import { downloadFileName, normalizeCatalogUrl, parseSeriesList, parseUnitList, parseUnitPages, type SeriesSummary } from './webCatalog'

const origin = 'https://manga.example'

const home = `<!doctype html><html><body>
<header><a href="/"><img src="/logo-mark.png" alt="" width="32" height="32"/></a><a href="/dmca">DMCA</a></header>
<main>
  <a href="/one-piece" class="hero"><img src="/covers/one-piece.jpg" alt="One Piece"/><h2>One Piece</h2><p>Eiichiro Oda</p><p>1151 colored &middot; 2 partial chapters &middot; Official color throughout</p><span>Browse available editions →</span></a>
  <section>
    <a href="/one-piece"><img src="/covers/one-piece.jpg" alt=""/><h3>One Piece</h3></a>
    <a href="/naruto"><img src="/covers/naruto.jpg" alt=""/><h3>Naruto</h3><span>Masashi Kishimoto</span><span>·</span><span>72 volumes in full color</span><span>Read in full color</span></a>
    <a href="/demon-slayer/"><img src="https://manga.example/covers/demon-slayer.jpg" alt=""/><h3>Demon Slayer</h3><span>Koyoharu Gotouge</span><span>66 colored &amp; 139 B&amp;W chapters</span></a>
    <a href="https://other.example/foo"><img src="/x.jpg"/><h3>Elsewhere</h3></a>
    <a href="/one-piece/chapter/1"><img src="/covers/one-piece.jpg"/><h3>Not a series</h3></a>
    <a href="/terms">Terms</a>
  </section>
</main></body></html>`

describe('parseSeriesList', () => {
  it('keeps one card per series, with title, author, blurb and absolute cover', () => {
    const list = parseSeriesList(home, origin)
    expect(list.map((s) => s.slug)).toEqual(['one-piece', 'naruto', 'demon-slayer'])
    expect(list[0]).toEqual({
      slug: 'one-piece',
      title: 'One Piece',
      author: 'Eiichiro Oda',
      blurb: '1151 colored · 2 partial chapters · Official color throughout',
      cover: 'https://manga.example/covers/one-piece.jpg',
      url: 'https://manga.example/one-piece',
    })
    expect(list[1]).toMatchObject({ title: 'Naruto', author: 'Masashi Kishimoto', blurb: '72 volumes in full color' })
    expect(list[2]).toMatchObject({ title: 'Demon Slayer', blurb: '66 colored & 139 B&W chapters', cover: 'https://manga.example/covers/demon-slayer.jpg' })
  })
})

const series: SeriesSummary = { slug: 'one-piece', title: 'One Piece', url: `${origin}/one-piece` }
const seriesPage = `<html><body><main>
<a href="/one-piece/chapter/1">Start · <span>Chapter</span> <span>1</span> →</a>
<a href="/one-piece/chapter/1171">Latest · <span>Chapter</span> <span>1171</span></a>
<ul>
 <li><a href="/one-piece/chapter/1"><span>Chapter</span><span>1</span><span>Romance Dawn</span><span>51 pages ·</span><span>East Blue</span><span>Read →</span></a></li>
 <li><a href="/one-piece/chapter/2"><span>Chapter</span><span>2</span><span>They Call Him Strawhat Luffy</span><span>23 pages</span><span>Partial color</span></a></li>
 <li><a href="/one-piece/chapter/2.5"><span>Chapter</span><span>2.5</span><span>Omake</span><span>4 pages</span><span>B&amp;W</span></a></li>
 <li><a href="/one-piece/chapter/1171"><span>Chapter</span><span>1171</span><span>Elbaf</span><span>13 pages ·</span><span>Final Saga</span></a></li>
 <li><a href="/naruto/chapter/1">Chapter 1 of another series</a></li>
</ul></main></body></html>`

describe('parseUnitList', () => {
  it('lists chapters once, sorted, with name, pages and edition', () => {
    const units = parseUnitList(seriesPage, series)
    expect(units.map((u) => u.number)).toEqual(['1', '2', '2.5', '1171'])
    expect(units[0]).toEqual({ kind: 'chapter', number: '1', value: 1, name: 'Romance Dawn', pages: 51, edition: 'unknown', url: 'https://manga.example/one-piece/chapter/1' })
    expect(units[1]).toMatchObject({ name: 'They Call Him Strawhat Luffy', pages: 23, edition: 'partial' })
    expect(units[2]).toMatchObject({ value: 2.5, edition: 'bw' })
    expect(units[3]).toMatchObject({ name: 'Elbaf', pages: 13 })
  })

  it('recognises volumes', () => {
    const naruto: SeriesSummary = { slug: 'naruto', title: 'Naruto', url: `${origin}/naruto` }
    const html = '<main><a href="/naruto/volumes">All</a><a href="/naruto/volume/1"><span>Volume</span><span>1</span><span>Uzumaki Naruto</span><span>Full color</span></a><a href="/naruto/volume/10"><span>Volume</span><span>10</span></a></main>'
    expect(parseUnitList(html, naruto)).toEqual([
      { kind: 'volume', number: '1', value: 1, name: 'Uzumaki Naruto', pages: undefined, edition: 'color', url: 'https://manga.example/naruto/volume/1' },
      { kind: 'volume', number: '10', value: 10, name: undefined, pages: undefined, edition: 'unknown', url: 'https://manga.example/naruto/volume/10' },
    ])
  })
})

describe('parseUnitPages', () => {
  const unitUrl = `${origin}/one-piece/chapter/1`
  it('takes the large images inside <main>, in order, skipping the site’s own icons', () => {
    const html = `<html><body><header><img src="/logo-mark.png" width="32" height="32"/></header><main>
      <img src="https://cdn.example/gh/x/pages/1/001.webp" alt="page 1" width="1080" height="1755" loading="eager"/>
      <img src="https://cdn.example/gh/x/pages/1/002.webp" alt="page 2" width="1080" height="1755" loading="lazy"/>
      <img data-src="https://cdn.example/gh/x/pages/1/003.webp" width="1080" height="1755"/>
      <img src="/pages/local/004.webp"/>
      <img src="https://cdn.example/gh/x/pages/1/001.webp" width="1080" height="1755"/>
      <img src="https://cdn.example/badge.png" width="1080" height="1755"/>
      <img src="http://insecure.example/005.webp" width="1080" height="1755"/>
      <img src="data:image/png;base64,AAAA" width="1080" height="1755"/>
    </main><footer><img src="/icon-192.png"/></footer></body></html>`
    expect(parseUnitPages(html, unitUrl)).toEqual([
      'https://cdn.example/gh/x/pages/1/001.webp',
      'https://cdn.example/gh/x/pages/1/002.webp',
      'https://cdn.example/gh/x/pages/1/003.webp',
      'https://manga.example/pages/local/004.webp',
    ])
  })
  it('skips images declared small (thumbnails, UI)', () => {
    const html = '<main><img src="https://cdn.example/a.webp" width="120" height="180"/><img src="https://cdn.example/b.webp"/></main>'
    expect(parseUnitPages(html, unitUrl)).toEqual(['https://cdn.example/b.webp'])
  })
})

describe('normalizeCatalogUrl and downloadFileName', () => {
  it('accepts hosts and full URLs, returns the https origin', () => {
    expect(normalizeCatalogUrl('manga.example')).toBe('https://manga.example')
    expect(normalizeCatalogUrl(' https://Manga.Example/one-piece/chapter/1 ')).toBe('https://manga.example')
    expect(() => normalizeCatalogUrl('http://manga.example')).toThrow(/https/)
    expect(() => normalizeCatalogUrl('')).toThrow(/Inserisci/)
    expect(() => normalizeCatalogUrl('not a url')).toThrow(/non valido/)
  })
  it('names the CBZ after the series and the range, zero-padded', () => {
    const chapter = (n: string) => ({ kind: 'chapter' as const, number: n, value: Number(n), edition: 'color' as const, url: '' })
    expect(downloadFileName(series, [chapter('1'), chapter('2'), chapter('10')])).toBe('One Piece — Cap. 001-010.cbz')
    expect(downloadFileName(series, [chapter('2.5')])).toBe('One Piece — Cap. 002.5.cbz')
    expect(downloadFileName({ ...series, title: 'A/B: C?' }, [{ ...chapter('1'), kind: 'volume' }])).toBe('A B C — Vol. 001.cbz')
  })
  it('normalises the stored catalogue list', () => {
    expect(normalizeCatalogs([{ url: 'manga.example', name: ' Manga ', addedAt: 5 }, { url: 'https://manga.example/x' }, { url: 'ftp://x' }, 'junk'])).toEqual([
      { id: 'https://manga.example', name: 'Manga', url: 'https://manga.example', addedAt: 5 },
    ])
    expect(normalizeCatalogs(null)).toEqual([])
  })
})
