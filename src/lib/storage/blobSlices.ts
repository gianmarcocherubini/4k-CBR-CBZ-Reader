/** Small enough for iPad memory, large enough to keep OPFS throughput high. */
export const COPY_SLICE_BYTES = 4 * 1024 * 1024

export interface BlobSliceSource {
  readonly size: number
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> }
}

/**
 * Reads a Blob/File in explicit, serial slices. Unlike WebKit's Blob.stream(), this has hard
 * backpressure: the next allocation cannot start until the consumer has finished with the current
 * one. Offsets stay as JS numbers (exact far beyond the 10 GB target).
 */
export async function* readBlobSlices(
  source: BlobSliceSource,
  chunkSize = COPY_SLICE_BYTES,
): AsyncGenerator<{ offset: number; bytes: Uint8Array }> {
  if (!Number.isSafeInteger(source.size) || source.size < 0) throw new DOMException('Dimensione del file non valida', 'NotReadableError')
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new RangeError('chunkSize deve essere positivo')
  for (let offset = 0; offset < source.size; ) {
    const end = Math.min(source.size, offset + chunkSize)
    const bytes = new Uint8Array(await source.slice(offset, end).arrayBuffer())
    if (bytes.byteLength !== end - offset) {
      throw new DOMException(`Letti ${bytes.byteLength} byte, attesi ${end - offset}`, 'NotReadableError')
    }
    yield { offset, bytes }
    offset = end
  }
}
