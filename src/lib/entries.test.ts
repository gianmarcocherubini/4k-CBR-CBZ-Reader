import { describe, expect, it } from 'vitest'
import { type ArchiveEntry, isImageEntry, mimeForName, pageEntries } from './entries'

const e = (name: string, directory = false): ArchiveEntry => ({ name, size: 1, directory, encrypted: false })

describe('isImageEntry', () => {
  it('accepts common image extensions', () => {
    for (const n of ['a.jpg', 'b.JPEG', 'c.png', 'd.webp', 'e.gif', 'f.avif', 'g.heic', 'h.bmp']) {
      expect(isImageEntry(e(n))).toBe(true)
    }
  })
  it('rejects directories, hidden files, macOS junk and non-images', () => {
    expect(isImageEntry(e('dir/', true))).toBe(false)
    expect(isImageEntry(e('__MACOSX/vol/001.jpg'))).toBe(false)
    expect(isImageEntry(e('vol/._001.jpg'))).toBe(false)
    expect(isImageEntry(e('.DS_Store'))).toBe(false)
    expect(isImageEntry(e('Thumbs.db'))).toBe(false)
    expect(isImageEntry(e('ComicInfo.xml'))).toBe(false)
    expect(isImageEntry(e('readme'))).toBe(false)
  })
})

describe('pageEntries', () => {
  it('filters and sorts naturally, folder-aware', () => {
    const list = [
      e('ComicInfo.xml'),
      e('vol/10.jpg'),
      e('vol/2.jpg'),
      e('vol\\1.jpg'),
      e('__MACOSX/vol/1.jpg'),
      e('vol/', true),
    ]
    expect(pageEntries(list).map((x) => x.name)).toEqual(['vol\\1.jpg', 'vol/2.jpg', 'vol/10.jpg'])
  })
})

describe('mimeForName', () => {
  it('maps extensions', () => {
    expect(mimeForName('x.JPG')).toBe('image/jpeg')
    expect(mimeForName('x.webp')).toBe('image/webp')
    expect(mimeForName('x.bin')).toBe('application/octet-stream')
  })
})
