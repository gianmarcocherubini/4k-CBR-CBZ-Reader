import { describe, expect, it } from 'vitest'
import { ARCHIVE_SHELVES, buildQuery, coverUrl, downloadFileName, fileUrl, licenseLabel, parseItem, parseSearchResponse, plainDescription, rankSearchResults, searchClause, searchUrl } from './internetArchive'

describe('query building', () => {
  it('requires every word and strips Lucene specials from user text', () => {
    expect(searchClause('raggedy ann')).toBe('(raggedy AND ann)')
    expect(searchClause('  one:piece (colored) "x" ~ * ? \\ / ')).toBe('(one AND piece AND colored AND x)')
    expect(searchClause('   ')).toBeUndefined()
    expect(searchClause('!!!')).toBeUndefined()
  })

  it('always restricts to texts with a comic file, and adds the shelf or the text', () => {
    const base = 'mediatype:texts AND (format:"Comic Book ZIP" OR format:"Comic Book RAR" OR format:"Text PDF" OR format:"Image Container PDF")'
    expect(buildQuery({})).toBe(base)
    expect(buildQuery({ shelf: ARCHIVE_SHELVES[0] })).toBe(`${base} AND collection:classiccomics`)
    expect(buildQuery({ text: 'raggedy ann' })).toBe(`(raggedy AND ann) AND ${base}`)
    expect(buildQuery({ text: 'raggedy ann', shelf: ARCHIVE_SHELVES[1] })).toBe(`(raggedy AND ann) AND ${base} AND collection:webcomicuniverse`)
  })

  it('ranks title matches first, then by downloads', () => {
    const item = (identifier: string, title: string, downloads: number) => ({ identifier, title, downloads, formats: [], url: '' })
    const ranked = rankSearchResults([item('a', "Children's literature textbook", 12872), item('b', 'Raggedy Ann and Andy Comics', 12508), item('c', 'Raggedy Ann Stories', 381), item('d', 'raggedy ann and the golden ring', 3000)], 'Raggedy ANN')
    expect(ranked.map((i) => i.identifier)).toEqual(['b', 'd', 'c', 'a'])
    expect(rankSearchResults([item('x', 'X', 1)], '   ').map((i) => i.identifier)).toEqual(['x'])
  })

  it('builds the search URL with fields, paging and the sort', () => {
    const url = new URL(searchUrl('collection:classiccomics', 2, 'downloads'))
    expect(url.origin + url.pathname).toBe('https://archive.org/advancedsearch.php')
    expect(url.searchParams.get('q')).toBe('collection:classiccomics')
    expect(url.searchParams.getAll('fl[]')).toContain('downloads')
    expect(url.searchParams.get('sort[]')).toBe('downloads desc')
    expect(url.searchParams.get('rows')).toBe('40')
    expect(url.searchParams.get('page')).toBe('2')
    expect(url.searchParams.get('output')).toBe('json')
    expect(new URL(searchUrl('x', 1, 'relevance')).searchParams.has('sort[]')).toBe(false)
  })

  it('encodes item, cover and CORS file URLs', () => {
    expect(coverUrl('AllHumorComics008')).toBe('https://archive.org/services/img/AllHumorComics008')
    expect(fileUrl('raggedy-ann-and-andy-comics', 'Raggedy Ann Four Color Comics 005.cbr')).toBe('https://archive.org/cors/raggedy-ann-and-andy-comics/Raggedy%20Ann%20Four%20Color%20Comics%20005.cbr')
    expect(fileUrl('x', 'sub/dir/a b.cbz')).toBe('https://archive.org/cors/x/sub/dir/a%20b.cbz')
  })
})

describe('responses', () => {
  it('parses search docs, tolerating arrays and missing fields', () => {
    const result = parseSearchResponse(
      {
        response: {
          numFound: 2,
          docs: [
            { identifier: 'a', title: ['Title A'], creator: 'Dell', date: '1946-01-01T00:00:00Z', downloads: '12', licenseurl: 'http://creativecommons.org/publicdomain/zero/1.0/', format: ['Comic Book RAR', 'DjVuTXT', 'Text PDF'] },
            { identifier: 'b', year: 1952 },
            { title: 'no identifier' },
          ],
        },
      },
      3,
    )
    expect(result.total).toBe(2)
    expect(result.page).toBe(3)
    expect(result.items).toEqual([
      { identifier: 'a', title: 'Title A', creator: 'Dell', year: 1946, downloads: 12, licenseUrl: 'http://creativecommons.org/publicdomain/zero/1.0/', formats: ['Comic Book RAR', 'Text PDF'], url: 'https://archive.org/details/a' },
      { identifier: 'b', title: 'b', creator: undefined, year: 1952, downloads: 0, licenseUrl: undefined, formats: [], url: 'https://archive.org/details/b' },
    ])
    expect(() => parseSearchResponse({}, 1)).toThrow(/non valida/)
  })

  it('parses an item: comic files only, OCR-only PDFs dropped, originals first, natural order', () => {
    const item = parseItem({
      metadata: { identifier: 'ra', title: 'Raggedy Ann and Andy Comics', creator: 'Dell', date: '1946', description: '<p>Golden &amp; age<br>scans</p>', subject: ['Comics', 'Vintage'] },
      files: [
        { name: 'Raggedy Ann Four Color Comics 010.cbr', format: 'Comic Book RAR', source: 'original', size: '26900000' },
        { name: 'Raggedy Ann Four Color Comics 005.cbr', format: 'Comic Book RAR', source: 'original', size: '26914690' },
        { name: 'Raggedy Ann Four Color Comics 005.pdf', format: 'Text PDF', source: 'derivative', size: '2200000' },
        { name: 'Raggedy Ann Four Color Comics 005_text.pdf', format: 'Additional Text PDF', source: 'derivative', size: '500000' },
        { name: 'Raggedy_Ann_005_jp2.zip', format: 'Single Page Processed JP2 ZIP', source: 'derivative', size: '1' },
        { name: 'ra_archive.torrent', format: 'Archive BitTorrent', source: 'metadata', size: '1' },
        { name: 'book.epub', format: 'EPUB', source: 'derivative', size: '1' },
      ],
    })
    expect(item.title).toBe('Raggedy Ann and Andy Comics')
    expect(item.description).toBe('Golden & age\nscans')
    expect(item.subjects).toEqual(['Comics', 'Vintage'])
    expect(item.files.map((f) => [f.name, f.kind, f.source])).toEqual([
      ['Raggedy Ann Four Color Comics 005.cbr', 'cbr', 'original'],
      ['Raggedy Ann Four Color Comics 010.cbr', 'cbr', 'original'],
      ['Raggedy Ann Four Color Comics 005.pdf', 'pdf', 'derivative'],
    ])
    expect(item.formats).toEqual(['Comic Book RAR', 'Text PDF'])
    expect(() => parseItem({ metadata: {} })).toThrow(/non trovato/)
  })

  it('names the download after the item when it has one comic file, else after the file', () => {
    const single = parseItem({ metadata: { identifier: 'AllHumorComics008', title: 'All Humor Comics 008' }, files: [{ name: 'AllH8_52.pdf', format: 'Image Container PDF', source: 'original', size: 5 }] })
    expect(downloadFileName(single, single.files[0]!)).toBe('All Humor Comics 008.pdf')
    const multi = parseItem({ metadata: { identifier: 'x', title: 'A/B: C?' }, files: [{ name: 'dir/one.cbz', format: 'Comic Book ZIP', source: 'original', size: 1 }, { name: 'two.cbz', format: 'Comic Book ZIP', source: 'original', size: 1 }] })
    expect(downloadFileName(multi, multi.files[0]!)).toBe('one.cbz')
    const weird = parseItem({ metadata: { identifier: 'x', title: 'A/B: C?' }, files: [{ name: 'f.cbz', format: 'Comic Book ZIP', source: 'original', size: 1 }] })
    expect(downloadFileName(weird, weird.files[0]!)).toBe('A B C.cbz')
  })

  it('labels licences and flattens descriptions', () => {
    expect(licenseLabel('http://creativecommons.org/publicdomain/zero/1.0/')).toBe('CC0 · pubblico dominio')
    expect(licenseLabel('http://creativecommons.org/publicdomain/mark/1.0/')).toBe('Pubblico dominio')
    expect(licenseLabel('http://creativecommons.org/licenses/by/3.0/')).toBe('CC BY 3.0')
    expect(licenseLabel('https://creativecommons.org/licenses/by-nc-sa/4.0/')).toBe('CC BY-NC-SA 4.0')
    expect(licenseLabel('https://example.org/licence')).toBe('Licenza dichiarata')
    expect(licenseLabel(undefined)).toBeUndefined()
    expect(plainDescription(['<div>Hello <b>world</b></div><div>Second</div>'])).toBe('Hello world\nSecond')
    expect(plainDescription('x'.repeat(700), 100)!.endsWith('…')).toBe(true)
    expect(plainDescription('   ')).toBeUndefined()
  })
})
