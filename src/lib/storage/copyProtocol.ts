export type CopyRequest =
  | { type: 'copy'; bookId: string; file: File; dir: string }
  | { type: 'abort' }

export type CopyResponse =
  | { type: 'progress'; bytes: number; total: number }
  | { type: 'done'; bytes: number }
  | { type: 'unsupported'; reason: string }
  | { type: 'error'; code: 'quota' | 'read' | 'aborted'; message: string }
