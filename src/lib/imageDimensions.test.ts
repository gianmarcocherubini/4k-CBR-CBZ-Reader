import { describe, expect, it } from 'vitest'
import { assertSafeEncodedImage, probeEncodedImageSize } from './imageDimensions'

function pngHeader(w: number, h: number): Blob {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, w, false)
  view.setUint32(20, h, false)
  return new Blob([bytes], { type: 'image/png' })
}

describe('encoded image dimension guard', () => {
  const box = (type: string, payload: Uint8Array) => {
    const out = new Uint8Array(8 + payload.length)
    new DataView(out.buffer).setUint32(0, out.length, false)
    out.set([...type].map((char) => char.charCodeAt(0)), 4)
    out.set(payload, 8)
    return out
  }

  it('reads PNG dimensions without decoding the raster', async () => {
    await expect(probeEncodedImageSize(pngHeader(4000, 6000))).resolves.toEqual({ w: 4000, h: 6000 })
    await expect(assertSafeEncodedImage(pngHeader(4000, 6000))).resolves.toEqual({ w: 4000, h: 6000 })
  })

  it('rejects a tiny compressed header claiming a one-gigabyte RGBA raster', async () => {
    await expect(assertSafeEncodedImage(pngHeader(16_000, 16_000))).rejects.toThrow(/troppo grande/)
  })

  it('reads baseline JPEG SOF dimensions', async () => {
    const bytes = new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      0x04,
      0xb0,
      0x03,
      0x20,
      0x03,
      0x01,
      0x11,
      0x00,
      0x02,
      0x11,
      0x00,
      0x03,
      0x11,
      0x00,
    ])
    await expect(probeEncodedImageSize(new Blob([bytes], { type: 'image/jpeg' }))).resolves.toEqual({ w: 800, h: 1200 })
  })

  it('fails closed when dimensions are unknown and ignores raw BMFF ispe decoys', async () => {
    const decoy = new Uint8Array(64)
    decoy.set([0x69, 0x73, 0x70, 0x65], 4)
    new DataView(decoy.buffer).setUint32(12, 100, false)
    new DataView(decoy.buffer).setUint32(16, 100, false)
    await expect(probeEncodedImageSize(new Blob([decoy]))).resolves.toBeNull()
    await expect(assertSafeEncodedImage(new Blob([decoy]))).rejects.toThrow(/non verificabili/)
  })

  it('uses the largest structured BMFF ispe so a thumbnail cannot hide an oversized primary item', async () => {
    const ispe = (w: number, h: number) => {
      const payload = new Uint8Array(12)
      const view = new DataView(payload.buffer)
      view.setUint32(4, w, false)
      view.setUint32(8, h, false)
      return box('ispe', payload)
    }
    const ipco = box('ipco', new Uint8Array([...ispe(320, 200), ...ispe(16_000, 16_000)]))
    const iprp = box('iprp', ipco)
    const meta = box('meta', new Uint8Array([0, 0, 0, 0, ...iprp]))
    const ftyp = box('ftyp', new Uint8Array(8))
    const avif = new Blob([ftyp, meta], { type: 'image/avif' })
    await expect(probeEncodedImageSize(avif)).resolves.toEqual({ w: 16_000, h: 16_000 })
    await expect(assertSafeEncodedImage(avif)).rejects.toThrow(/troppo grande/)
  })

  it('keeps validated AVIF metadata when a large mdat extends beyond the 1 MiB probe', async () => {
    const payload = new Uint8Array(12)
    const view = new DataView(payload.buffer)
    view.setUint32(4, 2400, false)
    view.setUint32(8, 3600, false)
    const ipco = box('ipco', box('ispe', payload))
    const meta = box('meta', new Uint8Array([0, 0, 0, 0, ...box('iprp', ipco)]))
    const ftyp = box('ftyp', new Uint8Array(8))
    const mdatHeader = new Uint8Array(8)
    const mdatView = new DataView(mdatHeader.buffer)
    mdatView.setUint32(0, 3 * 1024 * 1024, false)
    mdatHeader.set([0x6d, 0x64, 0x61, 0x74], 4)
    const avif = new Blob([ftyp, meta, mdatHeader, new Uint8Array(2 * 1024 * 1024)], { type: 'image/avif' })
    await expect(assertSafeEncodedImage(avif)).resolves.toEqual({ w: 2400, h: 3600 })
  })
})
