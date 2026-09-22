import type { ContainerKind } from '../types'

const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04]
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06]
const ZIP_SPANNED = [0x50, 0x4b, 0x07, 0x08]
const RAR4 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]
const RAR5 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]
const SEVEN_ZIP = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]
const PDF = [0x25, 0x50, 0x44, 0x46]
/** POSIX ustar magic at offset 257 (GNU tar writes "ustar  \0", also matched). */
const TAR_MAGIC_OFFSET = 257
const TAR_MAGIC = [0x75, 0x73, 0x74, 0x61, 0x72]
/** Bytes needed to tell every container apart. */
export const DETECT_BYTES = 512

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false
  return true
}

/** Detects the container from the first bytes of the file (512 to recognise tar, 8 for the others). */
export function detectContainer(head: Uint8Array): ContainerKind {
  if (startsWith(head, RAR5)) return 'rar5'
  if (startsWith(head, RAR4)) return 'rar4'
  if (startsWith(head, ZIP_LOCAL) || startsWith(head, ZIP_EMPTY) || startsWith(head, ZIP_SPANNED)) return 'zip'
  if (startsWith(head, SEVEN_ZIP)) return '7z'
  if (startsWith(head, PDF)) return 'pdf'
  if (head.length >= TAR_MAGIC_OFFSET + TAR_MAGIC.length && startsWith(head.subarray(TAR_MAGIC_OFFSET), TAR_MAGIC)) return 'tar'
  return 'unknown'
}

/** Reads the first bytes of a Blob and detects the container. */
export async function detectBlob(blob: Blob): Promise<ContainerKind> {
  const head = new Uint8Array(await blob.slice(0, DETECT_BYTES).arrayBuffer())
  return detectContainer(head)
}

/** Extension-based guess, used only for messages (e.g. "file .cbr non valido"). */
export function extensionOf(fileName: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(fileName)
  return m?.[1]?.toLowerCase() ?? ''
}

export function titleFromFileName(fileName: string): string {
  return fileName.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim() || fileName
}
