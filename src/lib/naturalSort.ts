/**
 * Natural ("human") string comparison: digit runs compare numerically,
 * everything else compares case-insensitively. Deterministic across engines
 * (no Intl dependency) so page order is identical everywhere.
 */
const tokenRe = /(\d+)|(\D+)/g

function tokenize(s: string): string[] {
  return s.match(tokenRe) ?? []
}

export function naturalCompare(a: string, b: string): number {
  const ta = tokenize(a.toLowerCase())
  const tb = tokenize(b.toLowerCase())
  const n = Math.min(ta.length, tb.length)
  for (let i = 0; i < n; i++) {
    const x = ta[i]!
    const y = tb[i]!
    const xNum = x.charCodeAt(0) >= 48 && x.charCodeAt(0) <= 57
    const yNum = y.charCodeAt(0) >= 48 && y.charCodeAt(0) <= 57
    if (xNum && yNum) {
      // Compare numerically without overflow: strip leading zeros, then by length, then lexically.
      const xs = x.replace(/^0+(?=\d)/, '')
      const ys = y.replace(/^0+(?=\d)/, '')
      if (xs.length !== ys.length) return xs.length - ys.length
      if (xs !== ys) return xs < ys ? -1 : 1
      // Same value: fewer leading zeros first for stability.
      if (x.length !== y.length) return x.length - y.length
    } else if (xNum !== yNum) {
      // Digits sort before letters.
      return xNum ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  if (ta.length !== tb.length) return ta.length - tb.length
  // Tie-break on the original strings so the order is total.
  return a < b ? -1 : a > b ? 1 : 0
}

export function naturalSort<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => naturalCompare(key(a), key(b)))
}
