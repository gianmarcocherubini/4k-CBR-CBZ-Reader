import { describe, expect, it } from 'vitest'
import { TarArchiveReader } from './tarReader'

const encoder = new TextEncoder()

function header(name: string, size: number, type = '0', prefix = ''): Uint8Array {
  const block = new Uint8Array(512)
  block.set(encoder.encode(name).subarray(0, 100), 0)
  block.set(encoder.encode('0000644\0'), 100)
  block.set(encoder.encode('0001750\0'), 108)
  block.set(encoder.encode('0001750\0'), 116)
  block.set(encoder.encode(size.toString(8).padStart(11, '0') + '\0'), 124)
  block.set(encoder.encode('00000000000\0'), 136)
  block.set(encoder.encode('        '), 148)
  block[156] = type.charCodeAt(0)
  block.set(encoder.encode('ustar\0'), 257)
  block.set(encoder.encode('00'), 263)
  if (prefix) block.set(encoder.encode(prefix).subarray(0, 155), 345)
  let sum = 0
  for (const b of block) sum += b
  block.set(encoder.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148)
  return block
}

function file(name: string, data: Uint8Array, type = '0', prefix = ''): Uint8Array[] {
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512)
  padded.set(data)
  return [header(name, data.length, type, prefix), padded]
}

function tar(parts: Uint8Array[]): Blob {
  return new Blob([...parts, new Uint8Array(1024)], { type: 'application/x-tar' })
}

const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n, n, n])

describe('TarArchiveReader', () => {
  it('lists files and directories, reads a page as a slice of the archive', async () => {
    const blob = tar([
      ...file('Vol 1/', new Uint8Array(0), '5'),
      ...file('Vol 1/002.png', png(2)),
      ...file('Vol 1/001.png', png(1)),
      ...file('Vol 1/notes.txt', encoder.encode('hello')),
    ])
    const reader = new TarArchiveReader(blob)
    const entries = await reader.entries()
    expect(entries.map((e) => [e.name, e.size, e.directory])).toEqual([
      ['Vol 1', 0, true],
      ['Vol 1/002.png', 7, false],
      ['Vol 1/001.png', 7, false],
      ['Vol 1/notes.txt', 5, false],
    ])
    const page = await reader.extract('Vol 1/001.png')
    expect(page.type).toBe('image/png')
    expect(new Uint8Array(await page.arrayBuffer())).toEqual(png(1))
    await expect(reader.extract('Vol 1')).rejects.toMatchObject({ code: 'missing' })
    await reader.close()
  })

  it('joins ustar prefixes and honours GNU long names and pax paths', async () => {
    const longName = `${'directory-with-a-very-long-name/'.repeat(5)}page.png`
    const longBytes = encoder.encode(longName + '\0')
    const paxRecord = `${('x path=deep/pax-name.png\n'.length + 2).toString()} path=deep/pax-name.png\n`
    const blob = tar([
      ...file('001.png', png(1), '0', 'some/prefix'),
      ...file('././@LongLink', longBytes, 'L'),
      ...file('truncated-name.png', png(2)),
      ...file('PaxHeader/x', encoder.encode(paxRecord), 'x'),
      ...file('ignored.png', png(3)),
    ])
    const entries = await new TarArchiveReader(blob).entries()
    expect(entries.map((e) => e.name)).toEqual(['some/prefix/001.png', longName, 'deep/pax-name.png'])
  })

  it('refuses an entry that claims more data than the file holds', async () => {
    const bad = header('big.png', 10_000)
    await expect(new TarArchiveReader(new Blob([bad, new Uint8Array(512)])).entries()).rejects.toMatchObject({ code: 'corrupt' })
  })
})
