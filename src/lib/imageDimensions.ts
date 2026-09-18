import type { PageSize } from '../types'

/** 32 MP = 128 MiB RGBA, already a very large comic page on an iPad. */
export const MAX_DECODED_PIXELS = 32 * 1024 * 1024
export const MAX_IMAGE_DIMENSION = 16_384
const PROBE_BYTES = 1024 * 1024

export function assertSafeImageSize(size: PageSize): void {
  if (
    !Number.isSafeInteger(size.w) ||
    !Number.isSafeInteger(size.h) ||
    size.w <= 0 ||
    size.h <= 0 ||
    size.w > MAX_IMAGE_DIMENSION ||
    size.h > MAX_IMAGE_DIMENSION ||
    size.w * size.h > MAX_DECODED_PIXELS
  ) {
    throw new Error(`Immagine troppo grande: ${size.w}×${size.h}`)
  }
}

const u16be = (d: Uint8Array, p: number) => (d[p]! << 8) | d[p + 1]!
const u16le = (d: Uint8Array, p: number) => d[p]! | (d[p + 1]! << 8)
const u24le = (d: Uint8Array, p: number) => d[p]! | (d[p + 1]! << 8) | (d[p + 2]! << 16)
const u32be = (d: Uint8Array, p: number) => new DataView(d.buffer, d.byteOffset + p, 4).getUint32(0, false)
const ascii = (d: Uint8Array, p: number, n: number) => String.fromCharCode(...d.subarray(p, p + n))

function jpegSize(data: Uint8Array): PageSize | null {
  if (data[0] !== 0xff || data[1] !== 0xd8) return null
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  for (let p = 2; p + 9 < data.length; ) {
    if (data[p] !== 0xff) {
      p++
      continue
    }
    while (p < data.length && data[p] === 0xff) p++
    const marker = data[p++]!
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (p + 2 > data.length) break
    const length = u16be(data, p)
    if (length < 2 || p + length > data.length) break
    if (sof.has(marker) && length >= 7) return { w: u16be(data, p + 5), h: u16be(data, p + 3) }
    p += length
  }
  return null
}

function webpSize(data: Uint8Array): PageSize | null {
  if (data.length < 30 || String.fromCharCode(...data.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...data.subarray(8, 12)) !== 'WEBP') return null
  const chunk = String.fromCharCode(...data.subarray(12, 16))
  if (chunk === 'VP8X') return { w: 1 + u24le(data, 24), h: 1 + u24le(data, 27) }
  if (chunk === 'VP8L' && data[20] === 0x2f) {
    return {
      w: 1 + (data[21]! | ((data[22]! & 0x3f) << 8)),
      h: 1 + ((data[22]! >>> 6) | (data[23]! << 2) | ((data[24]! & 0x0f) << 10)),
    }
  }
  if (chunk === 'VP8 ' && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
    return { w: u16le(data, 26) & 0x3fff, h: u16le(data, 28) & 0x3fff }
  }
  return null
}

function bmffSize(data: Uint8Array, start = 0, end = data.length, depth = 0): PageSize | null {
  if (depth > 8) return null
  const containers = new Set(['meta', 'iprp', 'ipco', 'moov', 'trak', 'mdia', 'minf', 'stbl'])
  let largest: PageSize | null = null
  const keepLargest = (size: PageSize) => {
    if (!largest || size.w * size.h > largest.w * largest.h) largest = size
  }
  for (let p = start; p + 8 <= end; ) {
    let size = u32be(data, p)
    const type = ascii(data, p + 4, 4)
    let header = 8
    if (size === 1) {
      if (p + 16 > end) return null
      const big = new DataView(data.buffer, data.byteOffset + p + 8, 8).getBigUint64(0, false)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null
      size = Number(big)
      header = 16
    } else if (size === 0) {
      size = end - p
    }
    if (size < header) return null
    // Typical AVIF/HEIC files keep `meta` before a multi-megabyte `mdat`. Its payload is irrelevant
    // to dimensions and intentionally not in the 1 MiB probe; retain the validated metadata.
    if (p + size > end) return type === 'mdat' ? largest : null
    const payload = p + header
    if (type === 'ispe' && size >= header + 12) {
      const w = u32be(data, payload + 4)
      const h = u32be(data, payload + 8)
      if (w > 0 && h > 0) keepLargest({ w, h })
    }
    if (containers.has(type)) {
      const nested = bmffSize(data, payload + (type === 'meta' ? 4 : 0), p + size, depth + 1)
      if (nested) keepLargest(nested)
    }
    p += size
  }
  return largest
}

/** Reads encoded headers only; null means dimensions could not be established safely. */
export async function probeEncodedImageSize(blob: Blob): Promise<PageSize | null> {
  const data = new Uint8Array(await blob.slice(0, Math.min(blob.size, PROBE_BYTES)).arrayBuffer())
  if (
    data.length >= 24 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return { w: u32be(data, 16), h: u32be(data, 20) }
  }
  if (data.length >= 10 && ascii(data, 0, 3) === 'GIF') return { w: u16le(data, 6), h: u16le(data, 8) }
  if (data.length >= 26 && data[0] === 0x42 && data[1] === 0x4d) {
    return { w: Math.abs(new DataView(data.buffer, data.byteOffset + 18, 4).getInt32(0, true)), h: Math.abs(new DataView(data.buffer, data.byteOffset + 22, 4).getInt32(0, true)) }
  }
  const jpeg = jpegSize(data)
  if (jpeg) return jpeg
  const webp = webpSize(data)
  if (webp) return webp
  return data.length >= 12 && ascii(data, 4, 4) === 'ftyp' ? bmffSize(data) : null
}

export async function assertSafeEncodedImage(blob: Blob): Promise<PageSize> {
  const size = await probeEncodedImageSize(blob)
  if (!size) throw new Error('Dimensioni dell’immagine non verificabili in sicurezza')
  assertSafeImageSize(size)
  return size
}
