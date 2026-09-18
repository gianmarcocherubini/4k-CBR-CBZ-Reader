import { describe, expect, it } from 'vitest'
import { COPY_SLICE_BYTES, readBlobSlices, type BlobSliceSource } from './blobSlices'

describe('readBlobSlices', () => {
  it('walks an 8 GiB source with one bounded allocation at a time and exact 64-bit offsets', async () => {
    const size = 8 * 1024 * 1024 * 1024 + 123
    const reusable = new ArrayBuffer(COPY_SLICE_BYTES)
    const reads: Array<[number, number]> = []
    const source: BlobSliceSource = {
      size,
      slice(start = 0, end = size) {
        reads.push([start, end])
        const length = end - start
        return { arrayBuffer: async () => (length === reusable.byteLength ? reusable : new ArrayBuffer(length)) }
      },
    }
    let copied = 0
    let maxChunk = 0
    for await (const chunk of readBlobSlices(source)) {
      expect(chunk.offset).toBe(copied)
      copied += chunk.bytes.byteLength
      maxChunk = Math.max(maxChunk, chunk.bytes.byteLength)
    }
    expect(copied).toBe(size)
    expect(maxChunk).toBe(COPY_SLICE_BYTES)
    expect(reads).toHaveLength(Math.ceil(size / COPY_SLICE_BYTES))
    expect(reads.at(-1)).toEqual([size - 123, size])
  })

  it('rejects a short read instead of silently creating a truncated archive', async () => {
    const source: BlobSliceSource = {
      size: 1024,
      slice: () => ({ arrayBuffer: async () => new ArrayBuffer(1000) }),
    }
    await expect(async () => {
      for await (const _ of readBlobSlices(source)) void _
    }).rejects.toMatchObject({ name: 'NotReadableError' })
  })
})
