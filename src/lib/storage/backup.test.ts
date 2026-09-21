import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Book, type Collection, type Progress } from '../../types'
import { BACKUP_FORMAT, BACKUP_VERSION, BackupError, backupFileName, blobToDataUrl, dataUrlToBlob, parseBackup, pendingRestoreKey, planRestore, serializeBackup, summarizeRestore } from './backup'

const book = (over: Partial<Book> & Pick<Book, 'id' | 'fileName'>): Book => ({
  title: over.fileName.replace(/\.\w+$/, ''),
  fileSize: 1000,
  format: 'cbz',
  storage: 'opfs',
  pageCount: 100,
  addedAt: 10,
  lastReadAt: 0,
  ...over,
})
const app = { version: '0.9.0', origin: 'https://www.manga-dana.com' }
const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], { type: 'image/jpeg' })

describe('backup serialization', () => {
  it('round-trips a data URL', async () => {
    const url = await blobToDataUrl(jpeg)
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true)
    const back = dataUrlToBlob(url)!
    expect(back.type).toBe('image/jpeg')
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(new Uint8Array(await jpeg.arrayBuffer()))
  })

  it('refuses anything that is not a small raster image', () => {
    expect(dataUrlToBlob('data:text/html;base64,PGI+')).toBeUndefined()
    expect(dataUrlToBlob('data:image/svg+xml;base64,PHN2Zz4=')).toBeUndefined()
    expect(dataUrlToBlob('javascript:alert(1)')).toBeUndefined()
    expect(dataUrlToBlob(42)).toBeUndefined()
  })

  it('writes the user data of imported books, remote covers only, and skips session books', async () => {
    const remote = book({ id: 'a', fileName: 'One_Piece_01.cbz', title: 'One Piece 1', collectionId: 'c1', cover: jpeg, coverSource: 'remote', lastReadAt: 50 })
    const archive = book({ id: 'b', fileName: 'Naruto 01.cbz', cover: jpeg, coverSource: 'archive', passwordProtected: true })
    const session = book({ id: 'session:x', fileName: 'x.cbz', storage: 'session' })
    const collections: Collection[] = [{ id: 'c1', name: 'Shonen', createdAt: 5, icon: 'flame' }]
    const progress = new Map<string, Progress>([['a', { bookId: 'a', page: 12, updatedAt: 60, blanks: [3] }]])
    const backup = await serializeBackup({ books: [remote, archive, session], collections, progress }, DEFAULT_SETTINGS, app, 1234)

    expect(backup.format).toBe(BACKUP_FORMAT)
    expect(backup.version).toBe(BACKUP_VERSION)
    expect(backup.createdAt).toBe(1234)
    expect(backup.books).toHaveLength(2)
    expect(backup.books[0]).toMatchObject({ title: 'One Piece 1', fileName: 'One_Piece_01.cbz', fileSize: 1000, collectionId: 'c1', lastReadAt: 50, progress: { page: 12, updatedAt: 60, blanks: [3] } })
    expect(backup.books[0]!.cover).toMatch(/^data:image\/jpeg;base64,/)
    expect(backup.books[1]).toMatchObject({ fileName: 'Naruto 01.cbz', passwordProtected: true })
    expect(backup.books[1]!.cover).toBeUndefined()
    expect(backup.books[1]!.progress).toBeUndefined()
    expect(backup.collections).toEqual([{ id: 'c1', name: 'Shonen', createdAt: 5, icon: 'flame' }])
    expect(backup.settings).toEqual(DEFAULT_SETTINGS)

    // The document survives JSON and comes back equal.
    expect(parseBackup(JSON.stringify(backup))).toEqual(backup)
  })

  it('names the file after the day', () => {
    expect(backupFileName(new Date('2026-09-21T22:30:00Z'))).toBe('Mangadana-backup-2026-09-21.json')
  })
})

describe('parseBackup', () => {
  it('rejects files that are not backups with a message for the user', () => {
    expect(() => parseBackup('{')).toThrow(BackupError)
    expect(() => parseBackup('{"format":"other"}')).toThrow(/non è un backup/)
    expect(() => parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 99, books: [], collections: [] }))).toThrow(/versione più recente/)
    expect(() => parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1 }))).toThrow(/incompleto/)
  })

  it('drops malformed entries, unknown collection references, duplicates and bad covers', () => {
    const parsed = parseBackup(
      JSON.stringify({
        format: BACKUP_FORMAT,
        version: 1,
        createdAt: 'no',
        collections: [{ id: 'c1', name: '  Shonen ', createdAt: 1, icon: '🔥' }, { id: 'c2' }, 'junk'],
        books: [
          { fileName: 'a.cbz', fileSize: 10, format: 'cbz', collectionId: 'missing', cover: 'data:text/html;base64,PGI+', progress: { page: -3, updatedAt: 'x', blanks: [1, -1, 'q', 2.5, 4] } },
          { fileName: 'a.cbz', fileSize: 10, format: 'cbz', title: 'duplicate' },
          { fileName: 'b.cbr', fileSize: 10.5, format: 'cbr' },
          { fileName: 'c.cbr', fileSize: 20, format: 'pdf' },
          { fileName: '', fileSize: 20, format: 'cbz' },
          { fileName: 'd.cbz', fileSize: 30, format: 'cbz', collectionId: 'c1', passwordProtected: 'yes' },
        ],
      }),
    )
    expect(parsed.createdAt).toBe(0)
    expect(parsed.collections).toEqual([{ id: 'c1', name: 'Shonen', createdAt: 1, icon: 'flame' }])
    expect(parsed.books).toEqual([
      { title: 'a', fileName: 'a.cbz', fileSize: 10, format: 'cbz', pageCount: 0, addedAt: 0, lastReadAt: 0, progress: { page: 0, updatedAt: 0, blanks: [1, 4] } },
      { title: 'd', fileName: 'd.cbz', fileSize: 30, format: 'cbz', pageCount: 0, addedAt: 0, lastReadAt: 0, collectionId: 'c1' },
    ])
  })
})

describe('planRestore', () => {
  const backup = parseBackup(
    JSON.stringify({
      format: BACKUP_FORMAT,
      version: 1,
      createdAt: 1,
      collections: [
        { id: 'c1', name: 'Shonen', createdAt: 5 },
        { id: 'c2', name: 'seinen', createdAt: 6 },
      ],
      books: [
        { fileName: 'a.cbz', fileSize: 10, format: 'cbz', title: 'Renamed A', collectionId: 'c1', lastReadAt: 100, addedAt: 1, progress: { page: 40, updatedAt: 100 } },
        { fileName: 'b.cbz', fileSize: 20, format: 'cbz', title: 'Renamed B', collectionId: 'c2', lastReadAt: 100, progress: { page: 5, updatedAt: 100 } },
        { fileName: 'c.cbz', fileSize: 30, format: 'cbz', title: 'Pending C', collectionId: 'c2', pageCount: 50, lastReadAt: 7, progress: { page: 9, updatedAt: 8 } },
      ],
    }),
  )

  it('reuses collections by id or name and creates the others', () => {
    const local: Collection[] = [{ id: 'other', name: 'SEINEN', createdAt: 1 }]
    const plan = planRestore(backup, { books: [], collections: local, progress: new Map() }, undefined, 999)
    expect(plan.collections).toEqual([{ id: 'c1', name: 'Shonen', createdAt: 5 }])
    // c2 → the local "SEINEN"; pending books point at the local id.
    expect(plan.pending.map((p) => [p.fileName, p.collectionId])).toEqual([
      ['a.cbz', 'c1'],
      ['b.cbz', 'other'],
      ['c.cbz', 'other'],
    ])
    expect(plan.pending[2]).toMatchObject({ key: pendingRestoreKey('c.cbz', 30), title: 'Pending C', pageCount: 50, lastReadAt: 7, progress: { page: 9, updatedAt: 8 }, restoredAt: 999 })
    expect(summarizeRestore(plan)).toEqual({ updated: 0, pending: 3, collectionsCreated: 1, settingsRestored: false })
  })

  it('merges into books already here: untouched ones take the backup, edited ones keep local title and collection, newest bookmark wins', () => {
    const untouched = book({ id: 'A', fileName: 'a.cbz', fileSize: 10, addedAt: 50 })
    const edited = book({ id: 'B', fileName: 'b.cbz', fileSize: 20, title: 'My B', collectionId: 'mine', lastReadAt: 500 })
    const progress = new Map<string, Progress>([
      ['A', { bookId: 'A', page: 2, updatedAt: 50 }],
      ['B', { bookId: 'B', page: 70, updatedAt: 500 }],
    ])
    const plan = planRestore(backup, { books: [untouched, edited], collections: [{ id: 'mine', name: 'Mine', createdAt: 1 }], progress }, DEFAULT_SETTINGS)
    expect(plan.books).toHaveLength(2)
    expect(plan.books[0]).toMatchObject({ id: 'A', title: 'Renamed A', collectionId: 'c1', lastReadAt: 100, addedAt: 1 })
    expect(plan.books[1]).toMatchObject({ id: 'B', title: 'My B', collectionId: 'mine', lastReadAt: 500 })
    expect(plan.progress).toEqual([{ bookId: 'A', page: 40, updatedAt: 100 }])
    expect(plan.pending.map((p) => p.fileName)).toEqual(['c.cbz'])
    expect(plan.settings).toEqual(DEFAULT_SETTINGS)
    expect(summarizeRestore(plan)).toEqual({ updated: 2, pending: 1, collectionsCreated: 2, settingsRestored: true })
  })

  it('takes a chosen cover only over a non-chosen one and never matches session books', async () => {
    const cover = await blobToDataUrl(jpeg)
    const withCover = parseBackup(
      JSON.stringify({ format: BACKUP_FORMAT, version: 1, collections: [], books: [{ fileName: 'a.cbz', fileSize: 10, format: 'cbz', cover }, { fileName: 's.cbz', fileSize: 1, format: 'cbz' }] }),
    )
    const archiveCover = book({ id: 'A', fileName: 'a.cbz', fileSize: 10, cover: new Blob([1 as unknown as string]), coverSource: 'archive' })
    const session = book({ id: 'S', fileName: 's.cbz', fileSize: 1, storage: 'session' })
    const plan = planRestore(withCover, { books: [archiveCover, session], collections: [], progress: new Map() }, undefined)
    expect(plan.books[0]!.coverSource).toBe('remote')
    expect(plan.books[0]!.cover?.type).toBe('image/jpeg')
    expect(plan.pending.map((p) => p.fileName)).toEqual(['s.cbz'])

    const remoteCover = { ...archiveCover, coverSource: 'remote' as const }
    const keep = planRestore(withCover, { books: [remoteCover], collections: [], progress: new Map() }, undefined)
    expect(keep.books[0]!.cover).toBe(remoteCover.cover)
  })
})
