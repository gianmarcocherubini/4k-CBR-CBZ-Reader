/**
 * Weight file of the compact Real-ESRGAN network (SRVGGNetCompact, "realesr-animevideov3"),
 * produced by scripts/convert-realesr-weights.py:
 *
 *   "SRVG" | u32 header length | JSON header | zero padding to 8 bytes | f16 tensor data
 *
 * Convolution weights are laid out [ky][kx][cin][cout]: for one input tap and one input channel
 * all output channels are contiguous, which is how the shaders read them.
 */

export interface TensorRef {
  /** Offset in elements from the start of the data section. */
  offset: number
  count: number
}

export interface LayerHeader {
  name: string
  cin: number
  /** Output channels as stored (padded to a multiple of 4). */
  cout: number
  /** Output channels of the original layer when `cout` is padded (RRDB conv_last: 3). */
  realCout?: number
  weight: TensorRef
  bias: TensorRef
  /** PReLU slopes (one per output channel); absent for the last convolution. */
  prelu?: TensorRef
}

export type ModelArch = 'srvgg' | 'rrdb'

export interface WeightsHeader {
  arch: ModelArch
  model: string
  numFeat: number
  /** SRVGG: body convolutions. */
  numConv?: number
  /** RRDB: residual-in-residual dense blocks and growth channels. */
  numBlock?: number
  numGrowCh?: number
  upscale: number
  dtype: 'f16'
  layers: LayerHeader[]
}

export interface Layer {
  name: string
  cin: number
  cout: number
  realCout: number
  /** [ky][kx][cin][cout], f16 bits. */
  weight: Uint16Array
  bias: Uint16Array
  prelu: Uint16Array | null
}

export interface SrvggWeights {
  header: WeightsHeader
  layers: Layer[]
  /** Layers by name (RRDB programs address them by name). */
  byName: Map<string, Layer>
}

/** Same file format for both architectures. */
export type ModelWeights = SrvggWeights

const MAGIC = 0x47565253 // "SRVG" little endian

export function parseWeights(buffer: ArrayBuffer): SrvggWeights {
  const view = new DataView(buffer)
  if (buffer.byteLength < 8 || view.getUint32(0, true) !== MAGIC) throw new Error('File dei pesi non valido')
  const headerLength = view.getUint32(4, true)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerLength))) as WeightsHeader
  if ((header.arch !== 'srvgg' && header.arch !== 'rrdb') || header.dtype !== 'f16') throw new Error(`Pesi non supportati (${header.arch}, ${header.dtype})`)
  const dataStart = Math.ceil((8 + headerLength) / 8) * 8
  const data = new Uint16Array(buffer, dataStart, (buffer.byteLength - dataStart) >> 1)
  const slice = (ref: TensorRef) => {
    if (ref.offset + ref.count > data.length) throw new Error('File dei pesi troncato')
    return data.subarray(ref.offset, ref.offset + ref.count)
  }
  const layers: Layer[] = header.layers.map((l) => {
    if (l.weight.count !== 9 * l.cin * l.cout || l.bias.count !== l.cout || (l.prelu && l.prelu.count !== l.cout) || l.cout % 4 !== 0) {
      throw new Error(`Livello ${l.name}: dimensioni incoerenti`)
    }
    return {
      name: l.name,
      cin: l.cin,
      cout: l.cout,
      realCout: l.realCout ?? l.cout,
      weight: slice(l.weight),
      bias: slice(l.bias),
      prelu: l.prelu ? slice(l.prelu) : null,
    }
  })
  const expectedLayers = header.arch === 'srvgg' ? (header.numConv ?? 0) + 2 : (header.numBlock ?? 0) * 15 + 6
  if (layers.length !== expectedLayers) throw new Error(`Attesi ${expectedLayers} livelli, trovati ${layers.length}`)
  return { header, layers, byName: new Map(layers.map((l) => [l.name, l])) }
}

/** IEEE 754 binary16 → number (handles subnormals, infinities and NaN). */
export function f16ToF32(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exp = (h >> 10) & 0x1f
  const frac = h & 0x3ff
  if (exp === 0) return sign * frac * 2 ** -24
  if (exp === 0x1f) return frac ? Number.NaN : sign * Number.POSITIVE_INFINITY
  return sign * (1 + frac / 1024) * 2 ** (exp - 15)
}

export function f16ArrayToF32(src: Uint16Array): Float32Array {
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i++) out[i] = f16ToF32(src[i]!)
  return out
}

/** SRVGG: radius of the receptive field, 18 convolutions of 3x3, one source pixel each. */
export const RECEPTIVE_FIELD = 18
/**
 * Source pixels of context on each side of a tile. For SRVGG (≥ RECEPTIVE_FIELD) core pixels never
 * see a tile edge and seams are exact. RRDB's theoretical field is far larger (≈ 100 px) but its
 * effective one decays within a few pixels: the official implementation tiles with 10 px, this
 * one with the same 24 px, so seams are not bit-exact but invisible.
 */
export const CONTEXT = 24
