import type { ArchiveEntry } from '../../entries'
import type { SerializedError } from '../types'

export type RarRequest =
  | { id: number; type: 'open'; blob: Blob; password?: string }
  | { id: number; type: 'extract'; name: string }
  | { id: number; type: 'close' }

/** Omit that distributes over union members (plain Omit collapses a union to its common keys). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type RarResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: SerializedError }

export interface RarOpenResult {
  entries: ArchiveEntry[]
}
