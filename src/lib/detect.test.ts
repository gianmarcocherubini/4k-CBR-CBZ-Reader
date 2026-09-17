import { describe, expect, it } from 'vitest'
import { detectContainer, extensionOf, titleFromFileName } from './detect'

const bytes = (...b: number[]) => new Uint8Array(b)

describe('detectContainer', () => {
  it('detects zip local header, empty zip and spanned zip', () => {
    expect(detectContainer(bytes(0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0))).toBe('zip')
    expect(detectContainer(bytes(0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0))).toBe('zip')
    expect(detectContainer(bytes(0x50, 0x4b, 0x07, 0x08, 0, 0, 0, 0))).toBe('zip')
  })
  it('detects RAR 4 and RAR 5', () => {
    expect(detectContainer(bytes(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 0xcf))).toBe('rar4')
    expect(detectContainer(bytes(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00))).toBe('rar5')
  })
  it('names unsupported containers', () => {
    expect(detectContainer(bytes(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0))).toBe('7z')
    expect(detectContainer(bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34))).toBe('pdf')
  })
  it('returns unknown for anything else, including short input', () => {
    expect(detectContainer(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0))).toBe('unknown')
    expect(detectContainer(bytes(0x50, 0x4b))).toBe('unknown')
    expect(detectContainer(bytes())).toBe('unknown')
  })
})

describe('file names', () => {
  it('extracts extensions case-insensitively', () => {
    expect(extensionOf('Vol 01.CBZ')).toBe('cbz')
    expect(extensionOf('archive.tar.gz')).toBe('gz')
    expect(extensionOf('noext')).toBe('')
  })
  it('derives a title', () => {
    expect(titleFromFileName('One_Piece_v001.cbz')).toBe('One Piece v001')
    expect(titleFromFileName('.cbz')).toBe('.cbz')
  })
})
