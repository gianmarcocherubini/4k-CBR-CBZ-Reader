/**
 * WGSL compute kernels shared by the Real-ESRGAN networks (conv 3x3 chains, pixel shuffle, RGB
 * output).
 *
 * Activations live in storage buffers as planes of vec4: plane `o` holds channels 4o..4o+3, pixel
 * (x, y) of a `w` x `h` buffer at index `o * w * h + y * w + x`. Weights are `[tap][cin][cout/4]`
 * vec4s, so for one tap and one input channel the output quads are contiguous.
 *
 * The convolution kernel is register-blocked: a thread computes 4 horizontally adjacent pixels x 16
 * output channels, so each weight load feeds 4 fused multiply-adds, and the 32 threads of a
 * wavefront share the same output-channel group (their weight loads are uniform). Everything is
 * generated unrolled: no runtime-indexed local arrays in the hot loop.
 */

export interface KernelOptions {
  /** Use `f16` for activations, weights and arithmetic (requires the `shader-f16` feature). */
  f16: boolean
}

export type Activation = 'prelu' | 'lrelu' | 'none'

export interface ConvSpec {
  /** Output channels as stored (multiple of 16). */
  cout: 32 | 48 | 64
  activation: Activation
  /** 0: dst = acc · 1: dst = r1 + s1·acc · 2: dst = r1 + s1·(r2 + s2·acc). */
  residual: 0 | 1 | 2
  /** Input planes from index `splitPlane` on are read from a second source buffer (dense concat). */
  split: boolean
}

export const BODY_PIXELS_PER_THREAD = 4
export const BODY_BLOCK_W = 32
/** Rows covered by one workgroup: 4 thread rows × `rows` output rows per thread. */
export const bodyBlockH = (rows: ConvRows): number => 4 * rows

/**
 * Output rows per thread. 1: a thread computes 4 pixels of one row (16 accumulators). 2: the same
 * 4 columns of two rows (32 accumulators): every weight loaded feeds 8 multiply-adds instead of 4
 * and the three input rows of one output row are shared with the next. Same arithmetic order per
 * accumulator, so both variants produce identical results; the faster one is picked on the device.
 */
export type ConvRows = 1 | 2
export const CONV_VARIANTS: readonly ConvRows[] = [1, 2]
/** Convolution kernel in use: direct with 1 or 2 output rows per thread, or Winograd F(2x2, 3x3). */
export type ConvVariant = ConvRows | 'w'
export const KERNEL_VARIANTS: readonly ConvVariant[] = [1, 2, 'w']

const types = (o: KernelOptions) => ({
  enable: o.f16 ? 'enable f16;\n' : '',
  F: o.f16 ? 'f16' : 'f32',
  F4: o.f16 ? 'vec4<f16>' : 'vec4<f32>',
})

/** Output size of a dispatch and size of its input buffer (they differ when the input is upsampled on read). */
export const BAND_STRUCT = `struct Band { bw: u32, bh: u32, srcW: u32, srcH: u32 }`
export const BAND_PARAMS_BYTES = 16

/**
 * Per-layer constants: input planes, nearest-upsample factor applied on read (1 or 2), offset of
 * the input window inside the source buffer, first destination plane, residual scales.
 */
export const LAYER_STRUCT = `struct Layer { cin4: u32, inScale: u32, dstPlane: u32, splitPlane: u32, srcX0: u32, srcY0: u32, res1Scale: f32, res2Scale: f32 }`
export const LAYER_PARAMS_BYTES = 32

export function layerParams(p: {
  cin: number
  inScale?: 1 | 2
  dstPlane?: number
  splitPlane?: number
  srcX0?: number
  srcY0?: number
  res1Scale?: number
  res2Scale?: number
}): ArrayBuffer {
  const buffer = new ArrayBuffer(LAYER_PARAMS_BYTES)
  const u = new Uint32Array(buffer)
  const f = new Float32Array(buffer)
  u[0] = p.cin / 4
  u[1] = p.inScale ?? 1
  u[2] = p.dstPlane ?? 0
  u[3] = p.splitPlane ?? 16
  u[4] = p.srcX0 ?? 0
  u[5] = p.srcY0 ?? 0
  f[6] = p.res1Scale ?? 0
  f[7] = p.res2Scale ?? 0
  return buffer
}

/**
 * Activation epilogue. Only the most basic WGSL forms are used (scalar conversions, vector × scalar):
 * WebKit rejected the 6B kernels in f16 where Chrome accepted them, and a rejected f16 program
 * falls back to f32 at twice the cost.
 */
function activate(F: string, F4: string, activation: Activation, a: string, quad: string): string {
  switch (activation) {
    case 'prelu':
      return `select(${a} * prelu[${quad}], ${a}, ${a} > ${F4}(${F}(0.0)))`
    case 'lrelu':
      return `select(${a} * ${F}(0.2), ${a}, ${a} > ${F4}(${F}(0.0)))`
    case 'none':
      return a
  }
}

/** conv_first: 3 input channels read from the band texture, 64 outputs. One pixel per thread. */
export function convFirstWgsl(o: KernelOptions, activation: Activation): string {
  const { enable, F, F4 } = types(o)
  const acc = Array.from({ length: 16 }, (_, i) => `  var a${i} = bias[${i}u];`).join('\n')
  const taps = Array.from(
    { length: 16 },
    (_, i) => `      a${i} += r * weights[wb + ${i}u] + g * weights[wb + ${16 + i}u] + b * weights[wb + ${32 + i}u];`,
  ).join('\n')
  const store = Array.from({ length: 16 }, (_, i) => `  dst[(lp.dstPlane + ${i}u) * plane + p] = ${activate(F, F4, activation, `a${i}`, `${i}u`)};`).join('\n')
  return `${enable}${BAND_STRUCT}
${LAYER_STRUCT}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read> weights: array<${F4}>;
@group(0) @binding(2) var<storage, read> bias: array<${F4}>;
${activation === 'prelu' ? `@group(0) @binding(3) var<storage, read> prelu: array<${F4}>;` : ''}
@group(0) @binding(4) var<storage, read_write> dst: array<${F4}>;
@group(0) @binding(5) var<uniform> band: Band;
@group(0) @binding(6) var<uniform> lp: Layer;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= band.bw || gid.y >= band.bh) { return; }
  let x = i32(gid.x);
  let y = i32(gid.y);
  let maxX = i32(band.bw) - 1;
  let maxY = i32(band.bh) - 1;
${acc}
  for (var ky = 0; ky < 3; ky++) {
    let sy = clamp(y + ky - 1, 0, maxY);
    for (var kx = 0; kx < 3; kx++) {
      let sx = clamp(x + kx - 1, 0, maxX);
      let t = textureLoad(src, vec2i(sx, sy), 0).rgb;
      let r = ${F}(t.r);
      let g = ${F}(t.g);
      let b = ${F}(t.b);
      let wb = u32(ky * 3 + kx) * 48u;
${taps}
    }
  }
  let plane = band.bw * band.bh;
  let p = gid.y * band.bw + gid.x;
${store}
}
`
}

/**
 * Generic 3x3 convolution over plane buffers: `cin` input channels (any multiple of 4, from one
 * or two buffers), `cout` outputs, optional nearest upsampling of the input on read, optional
 * residual epilogue. Workgroup = 32 threads per output-channel group of 16; each thread computes
 * 4 adjacent columns of `rows` output rows.
 */
export function convWgsl(o: KernelOptions, spec: ConvSpec, rows: ConvRows = 1): string {
  const { enable, F, F4 } = types(o)
  const groups = spec.cout / 16
  const cout4 = spec.cout / 4
  const comp = ['x', 'y', 'z', 'w']
  const accInit: string[] = []
  for (let r = 0; r < rows; r++) for (let k = 0; k < 4; k++) for (let j = 0; j < 4; j++) accInit.push(`  var a${r}${k}${j} = bias[q4 + ${j}u];`)
  // Six input columns (x0-1 .. x0+4) of one input row, as p{n}_{row}: loaded per input row.
  const loadRow = (buf: string, planeExpr: string, rowVar: string, tag: string) =>
    [
      `        let pb${tag} = (${planeExpr}) * splane + ${rowVar};`,
      ...[0, 1, 2, 3, 4, 5].map((n) => `        let p${n}_${tag} = ${buf}[pb${tag} + xi${n}];`),
    ].join('\n')
  // One tap (ky, kx): 4 weight loads per input component, feeding all output rows and columns.
  const tapBlock = (ky: number, kx: number, cinExpr: string, inputTagOfRow: (r: number) => string): string => {
    const block: string[] = []
    block.push(`        {`)
    block.push(`          let wb = (${ky * 3 + kx}u * ${cinExpr} + ci4 * 4u) * ${cout4}u + q4;`)
    for (let c = 0; c < 4; c++) {
      block.push(`          {`)
      for (let j = 0; j < 4; j++) block.push(`            let w${j} = weights[wb + ${c * cout4 + j}u];`)
      for (let r = 0; r < rows; r++) {
        for (let k = 0; k < 4; k++) {
          const v = `p${k + kx}_${inputTagOfRow(r)}.${comp[c]}`
          for (let j = 0; j < 4; j++) block.push(`            a${r}${k}${j} += ${v} * w${j};`)
        }
      }
      block.push(`          }`)
    }
    block.push(`        }`)
    return block.join('\n')
  }
  const cinExpr = '(lp.cin4 * 4u)'
  // Per input quad: the `rows + 2` input rows (y-1 .. y+rows) are loaded once and each tap row
  // ky combines input row (r + ky) for output row r.
  const body = (buf: string, planeExpr: string): string => {
    const lines: string[] = []
    for (let n = 0; n < rows + 2; n++) lines.push(loadRow(buf, planeExpr, `srow${n}`, `${n}`))
    for (let ky = 0; ky < 3; ky++) for (let kx = 0; kx < 3; kx++) lines.push(tapBlock(ky, kx, cinExpr, (r) => `${r + ky}`))
    return lines.join('\n')
  }
  const loop0 = `      for (var ci4 = 0u; ci4 < ${spec.split ? 'min(lp.cin4, lp.splitPlane)' : 'lp.cin4'}; ci4++) {
${body('src', 'ci4')}
      }`
  const loop1 = spec.split
    ? `      for (var ci4 = lp.splitPlane; ci4 < lp.cin4; ci4++) {
${body('src1', 'ci4 - lp.splitPlane')}
      }`
    : ''
  const epilogue = (r: number, k: number, j: number): string => {
    const a = activate(F, F4, spec.activation, `a${r}${k}${j}`, `q4 + ${j}u`)
    if (spec.residual === 0) return a
    const r1 = `res1[(q4 + ${j}u) * plane + idx]`
    if (spec.residual === 1) return `${r1} + s1 * (${a})`
    const r2 = `res2[(q4 + ${j}u) * plane + idx]`
    return `${r1} + s1 * (${r2} + s2 * (${a}))`
  }
  const stores: string[] = []
  for (let r = 0; r < rows; r++) {
    stores.push(`  if (y + ${r} < bh) {`)
    stores.push(`    let row = u32(y + ${r}) * band.bw;`)
    for (let k = 0; k < 4; k++) {
      stores.push(`    if (x0 + ${k} < bw) {`)
      stores.push(`      let idx = row + u32(x0 + ${k});`)
      for (let j = 0; j < 4; j++) stores.push(`      dst[(lp.dstPlane + q4 + ${j}u) * plane + idx] = ${epilogue(r, k, j)};`)
      stores.push(`    }`)
    }
    stores.push(`  }`)
  }
  // Input rows y-1 .. y+rows, nearest-upsampled, offset and clamped to the source buffer.
  const srows = Array.from({ length: rows + 2 }, (_, n) => {
    const yy = n === 0 ? '(y - 1)' : `(y + ${n - 1})`
    return `  let srow${n} = u32(clamp((${yy} - ((${yy} % sc + sc) % sc)) / sc + oy, 0, sh - 1)) * band.srcW;`
  }).join('\n')
  return `${enable}${BAND_STRUCT}
${LAYER_STRUCT}
// Inputs are read-only bindings; a dense block that reads and writes the same growth buffer binds
// non-overlapping sub-ranges of it (WebGPU forbids a writable binding overlapping any other).
@group(0) @binding(0) var<storage, read> src: array<${F4}>;
@group(0) @binding(1) var<storage, read> weights: array<${F4}>;
@group(0) @binding(2) var<storage, read> bias: array<${F4}>;
${spec.activation === 'prelu' ? `@group(0) @binding(3) var<storage, read> prelu: array<${F4}>;` : ''}
@group(0) @binding(4) var<storage, read_write> dst: array<${F4}>;
@group(0) @binding(5) var<uniform> band: Band;
@group(0) @binding(6) var<uniform> lp: Layer;
${spec.split ? `@group(0) @binding(7) var<storage, read> src1: array<${F4}>;` : ''}
${spec.residual >= 1 ? `@group(0) @binding(8) var<storage, read> res1: array<${F4}>;` : ''}
${spec.residual === 2 ? `@group(0) @binding(9) var<storage, read> res2: array<${F4}>;` : ''}

@compute @workgroup_size(${32 * groups})
fn main(@builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wid: vec3u) {
  let q4 = (lid / 32u) * 4u;
  let r = (lid % 32u) / 8u;
  let g = lid % 8u;
  let bw = i32(band.bw);
  let bh = i32(band.bh);
  let sw = i32(band.srcW);
  let sh = i32(band.srcH);
  let x0 = i32(wid.x * ${BODY_BLOCK_W}u + g * 4u);
  let y = i32(wid.y * ${bodyBlockH(rows)}u + r * ${rows}u);
  let plane = band.bw * band.bh;
  let splane = band.srcW * band.srcH;
  let sc = i32(lp.inScale);
  let ox = i32(lp.srcX0);
  let oy = i32(lp.srcY0);
${spec.residual >= 1 ? `  let s1 = ${F}(lp.res1Scale);` : ''}
${spec.residual === 2 ? `  let s2 = ${F}(lp.res2Scale);` : ''}
${accInit.join('\n')}
  // Input columns of the 6 taps that cover the 4 output pixels (nearest-upsampled and clamped).
  let xi0 = u32(clamp(((x0 - 1) - ((x0 - 1) % sc + sc) % sc) / sc + ox, 0, sw - 1));
  let xi1 = u32(clamp(x0 / sc + ox, 0, sw - 1));
  let xi2 = u32(clamp((x0 + 1) / sc + ox, 0, sw - 1));
  let xi3 = u32(clamp((x0 + 2) / sc + ox, 0, sw - 1));
  let xi4 = u32(clamp((x0 + 3) / sc + ox, 0, sw - 1));
  let xi5 = u32(clamp((x0 + 4) / sc + ox, 0, sw - 1));
${srows}
${loop0}
${loop1}
${stores.join('\n')}
}
`
}

/** Uniforms of the shuffle and finalize kernels (16 x u32 = 64 bytes). */
export const SHUFFLE_PARAMS_BYTES = 64

export const SHUFFLE_STRUCT = `struct Shuffle {
  tw: u32, th: u32, context: u32, pageW: u32,
  bandY0: u32, coreRows: u32, outW: u32, outH: u32,
  factor: u32, swap: u32, flipX: u32, flipY: u32,
  first: u32, accW: u32, passes: u32, pad0: u32,
}`

/**
 * SRVGG conv_last output (48 channels = 3 colours x 4x4 sub-pixels) → pixel shuffle,
 * nearest-neighbour residual, clamp. A thread handles one core source pixel of the band in
 * *original* orientation; the network ran on the band transformed by (swap, flipX, flipY), so
 * activations, base colour and the 4x4 sub-pixel grid are read at the transformed position. x2
 * output is a 2x2 box of the clamped x4 pixels. Direct mode writes RGBA8 into the page;
 * accumulate mode sums float colours into the band accumulator (self-ensemble), `first` starting
 * a fresh sum.
 */
export function shuffleWgsl(o: KernelOptions, accumulate: boolean): string {
  const { enable, F4 } = types(o)
  const quads = Array.from({ length: 12 }, (_, i) => `  q[${i}] = act[${i}u * plane + p];`).join('\n')
  // value(colour c, original sub-pixel dy, dx) = quad[c*4 + dv].component[du], (du, dv) = T(dx, dy) on the 4x4 grid.
  const px = (c: number, dy: number, dx: number) => `clamp(f32(q[${c * 4}u + dv${dy}${dx}][du${dy}${dx}]) + base.${['r', 'g', 'b'][c]}, 0.0, 1.0)`
  const sub: string[] = []
  for (let dy = 0; dy < 4; dy++) {
    for (let dx = 0; dx < 4; dx++) {
      sub.push(`  let du0${dy}${dx} = select(${dx}u, ${dy}u, sp.swap == 1u);`)
      sub.push(`  let dv0${dy}${dx} = select(${dy}u, ${dx}u, sp.swap == 1u);`)
      sub.push(`  let du${dy}${dx} = select(du0${dy}${dx}, 3u - du0${dy}${dx}, sp.flipX == 1u);`)
      sub.push(`  let dv${dy}${dx} = select(dv0${dy}${dx}, 3u - dv0${dy}${dx}, sp.flipY == 1u);`)
    }
  }
  const store = (index: string, r: string, g: string, b: string) =>
    accumulate
      ? `    if (sp.first == 1u) { acc[${index}] = vec4f(${r}, ${g}, ${b}, 0.0); } else { acc[${index}] += vec4f(${r}, ${g}, ${b}, 0.0); }`
      : `    page[${index}] = pack4x8unorm(vec4f(${r}, ${g}, ${b}, 1.0));`
  // Direct mode indexes the whole page; accumulate mode indexes the band's own output rows.
  const row = (dy: string, f: number) => (accumulate ? `(gid.y * ${f}u + ${dy}) * sp.accW` : `(py * ${f}u + ${dy}) * sp.outW`)
  const x4: string[] = []
  for (let dy = 0; dy < 4; dy++) {
    for (let dx = 0; dx < 4; dx++) {
      x4.push(store(`${row(`${dy}u`, 4)} + px * 4u + ${dx}u`, px(0, dy, dx), px(1, dy, dx), px(2, dy, dx)))
    }
  }
  const x2: string[] = []
  for (let by = 0; by < 2; by++) {
    for (let bx = 0; bx < 2; bx++) {
      const avg = (c: number) =>
        `0.25 * (${px(c, 2 * by, 2 * bx)} + ${px(c, 2 * by, 2 * bx + 1)} + ${px(c, 2 * by + 1, 2 * bx)} + ${px(c, 2 * by + 1, 2 * bx + 1)})`
      x2.push(store(`${row(`${by}u`, 2)} + px * 2u + ${bx}u`, avg(0), avg(1), avg(2)))
    }
  }
  return `${enable}${SHUFFLE_STRUCT}
@group(0) @binding(0) var<storage, read> act: array<${F4}>;
@group(0) @binding(1) var src: texture_2d<f32>;
${accumulate ? '@group(0) @binding(2) var<storage, read_write> acc: array<vec4f>;' : '@group(0) @binding(2) var<storage, read_write> page: array<u32>;'}
@group(0) @binding(3) var<uniform> sp: Shuffle;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= sp.pageW || gid.y >= sp.coreRows) { return; }
  // Original band position of this core pixel, then where the transform put it.
  let x = gid.x + sp.context;
  let y = gid.y + sp.context;
  let u0 = select(x, y, sp.swap == 1u);
  let v0 = select(y, x, sp.swap == 1u);
  let u = select(u0, sp.tw - 1u - u0, sp.flipX == 1u);
  let v = select(v0, sp.th - 1u - v0, sp.flipY == 1u);
  let plane = sp.tw * sp.th;
  let p = v * sp.tw + u;
  let base = textureLoad(src, vec2i(i32(u), i32(v)), 0).rgb;
  var q: array<${F4}, 12>;
${quads}
${sub.join('\n')}
  let px = gid.x;
  let py = sp.bandY0 + gid.y;
  if (sp.factor == 4u) {
${x4.join('\n')}
  } else {
${x2.join('\n')}
  }
}
`
}

/** Ensemble average → RGBA8 into the page: one thread per output pixel of the band. */
export function finalizeWgsl(): string {
  return `${SHUFFLE_STRUCT}
@group(0) @binding(0) var<storage, read> acc: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> page: array<u32>;
@group(0) @binding(2) var<uniform> sp: Shuffle;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= sp.accW || gid.y >= sp.coreRows * sp.factor) { return; }
  let c = acc[gid.y * sp.accW + gid.x].rgb / f32(sp.passes);
  page[(sp.bandY0 * sp.factor + gid.y) * sp.outW + gid.x] = pack4x8unorm(vec4f(c, 1.0));
}
`
}

/**
 * Maps one pass of a self-ensemble back to the original orientation and accumulates it: a thread
 * per original core output pixel reads the transformed core buffer at the position the transform
 * sent it to (same permutation at output resolution: flips and transpositions map aligned blocks
 * to aligned blocks), `first` starting a fresh sum. `finalizeWgsl` then averages into the page.
 */
export function untransformWgsl(): string {
  return `${SHUFFLE_STRUCT}
@group(0) @binding(0) var<storage, read> tout: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> acc: array<vec4f>;
@group(0) @binding(2) var<uniform> sp: Shuffle;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let cw = sp.pageW * sp.factor;
  let ch = sp.coreRows * sp.factor;
  if (gid.x >= cw || gid.y >= ch) { return; }
  let tcw = select(cw, ch, sp.swap == 1u);
  let tch = select(ch, cw, sp.swap == 1u);
  let u0 = select(gid.x, gid.y, sp.swap == 1u);
  let v0 = select(gid.y, gid.x, sp.swap == 1u);
  let u = select(u0, tcw - 1u - u0, sp.flipX == 1u);
  let v = select(v0, tch - 1u - v0, sp.flipY == 1u);
  let c = tout[v * tcw + u];
  let i = gid.y * sp.accW + gid.x;
  if (sp.first == 1u) { acc[i] = c; } else { acc[i] += c; }
}
`
}

/** Uniforms of the RGB output kernel (RRDB conv_last), 12 x u32 = 48 bytes. */
export const RGB_OUT_PARAMS_BYTES = 48
/**
 * The network ran on a band transformed by a symmetry of the rectangle: the core (the page rows
 * of this band, without context) is a rectangle at (coreX0, coreY0) of coreW x coreH in that
 * band; all fields are in 4x (network output) pixels.
 */
export const RGB_OUT_STRUCT = `struct RgbOut {
  srcW: u32, srcH: u32, outY0: u32, coreX04: u32,
  coreY04: u32, coreW4: u32, coreH4: u32, stripY04: u32,
  bandY04: u32, outW: u32, outH: u32, factor: u32,
}`

/**
 * RRDB conv_last: 64 input channels at 4x → RGB (the 4th output channel is padding), clamped.
 * The dispatch covers one tail strip of the band (its rows in band 4x coordinates start at
 * outY0); only core pixels are written; x2 output averages 2x2. Direct mode writes RGBA8 into the
 * page (identity transform); buffer mode writes float colours into the transformed core buffer
 * for the self-ensemble (`untransformWgsl` puts them back).
 */
export function rgbOutWgsl(o: KernelOptions, toBuffer: boolean): string {
  const { enable, F4 } = types(o)
  const store = toBuffer
    ? `  tout[v * (rp.coreW4 / sub) + u] = vec4f(c, 1.0);`
    : `  let py = (rp.bandY04 + Y4 - rp.coreY04) / sub;
  if (u >= rp.outW || py >= rp.outH) { return; }
  page[py * rp.outW + u] = pack4x8unorm(vec4f(c, 1.0));`
  return `${enable}${RGB_OUT_STRUCT}
@group(0) @binding(0) var<storage, read> src: array<${F4}>;
@group(0) @binding(1) var<storage, read> weights: array<${F4}>;
@group(0) @binding(2) var<storage, read> bias: array<${F4}>;
${toBuffer ? '@group(0) @binding(3) var<storage, read_write> tout: array<vec4f>;' : '@group(0) @binding(3) var<storage, read_write> page: array<u32>;'}
@group(0) @binding(4) var<uniform> rp: RgbOut;

fn pixel(x: i32, y: i32) -> vec3f {
  let maxX = i32(rp.srcW) - 1;
  let maxY = i32(rp.srcH) - 1;
  let splane = rp.srcW * rp.srcH;
  var a = bias[0u];
  for (var ky = 0; ky < 3; ky++) {
    let sy = u32(clamp(y + ky - 1, 0, maxY)) * rp.srcW;
    for (var kx = 0; kx < 3; kx++) {
      let sx = u32(clamp(x + kx - 1, 0, maxX));
      let wb = u32(ky * 3 + kx) * 64u;
      for (var ci4 = 0u; ci4 < 16u; ci4++) {
        let v = src[ci4 * splane + sy + sx];
        let w4 = wb + ci4 * 4u;
        a += v.x * weights[w4] + v.y * weights[w4 + 1u] + v.z * weights[w4 + 2u] + v.w * weights[w4 + 3u];
      }
    }
  }
  return clamp(vec3f(f32(a.x), f32(a.y), f32(a.z)), vec3f(0.0), vec3f(1.0));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  // Output pixel at the requested factor: gid covers the strip's core at that factor.
  let f = rp.factor;
  let sub = 4u / f;
  // Band 4x coordinates of the first sub-pixel of this output pixel (the strip's own core rows).
  let X4 = rp.coreX04 + gid.x * sub;
  let Y4 = rp.stripY04 + gid.y * sub;
  if (X4 >= rp.coreX04 + rp.coreW4 || Y4 >= rp.coreY04 + rp.coreH4) { return; }
  var c = vec3f(0.0);
  for (var by = 0u; by < sub; by++) {
    for (var bx = 0u; bx < sub; bx++) {
      c += pixel(i32(X4 + bx), i32(Y4 + by) - i32(rp.outY0));
    }
  }
  c = c / f32(sub * sub);
  // Core-relative output pixel, in the transformed orientation.
  let u = (X4 - rp.coreX04) / sub;
  let v = (Y4 - rp.coreY04) / sub;
${store}
}
`
}

// ---- Winograd F(2x2, 3x3) ---------------------------------------------------------------------

/**
 * Per-dispatch parameters of the Winograd kernels (one 256-byte slot each, selected with a
 * dynamic offset): the tile chunk, the output and source geometry, and the layer's constants.
 */
export const WINO_STRUCT = `struct Wino {
  tilesW: u32, tilesChunk: u32, tileRow0: u32, bw: u32,
  bh: u32, srcW: u32, srcH: u32, cin4: u32,
  cout4: u32, inScale: u32, srcX0: u32, srcY0: u32,
  splitPlane: u32, dstPlane: u32, res1Scale: f32, res2Scale: f32,
}`
export const WINO_PARAMS_BYTES = 64
export const WINO_SLOT_BYTES = 256
/** Tiles per workgroup of the multiply kernel (32 lanes × 4 tiles), and input quads per shared-memory step. */
export const WINO_TILES_PER_GROUP = 128
export const WINO_CIN4_PER_STEP = 8
export const WINO_TRANSFORM_WG = 64

export function winoParams(p: {
  tilesW: number
  tilesChunk: number
  tileRow0: number
  bw: number
  bh: number
  srcW: number
  srcH: number
  cin: number
  cout: number
  inScale?: 1 | 2
  srcX0?: number
  srcY0?: number
  splitPlane?: number
  dstPlane?: number
  res1Scale?: number
  res2Scale?: number
}): ArrayBuffer {
  const buffer = new ArrayBuffer(WINO_PARAMS_BYTES)
  const u = new Uint32Array(buffer)
  const f = new Float32Array(buffer)
  u[0] = p.tilesW
  u[1] = p.tilesChunk
  u[2] = p.tileRow0
  u[3] = p.bw
  u[4] = p.bh
  u[5] = p.srcW
  u[6] = p.srcH
  u[7] = p.cin / 4
  u[8] = p.cout / 4
  u[9] = p.inScale ?? 1
  u[10] = p.srcX0 ?? 0
  u[11] = p.srcY0 ?? 0
  u[12] = p.splitPlane ?? 0xffff
  u[13] = p.dstPlane ?? 0
  f[14] = p.res1Scale ?? 0
  f[15] = p.res2Scale ?? 0
  return buffer
}

/**
 * Input transform: one thread per (2x2 output tile, input quad) reads the 4x4 input window
 * (nearest-upsampled, offset and clamped exactly like the direct kernel) and writes
 * V = Bᵀ d B as 16 quads into the transformed buffer, laid out [p][cin4][tile].
 */
export function winogradTransformWgsl(o: KernelOptions, split: boolean): string {
  const { enable, F4 } = types(o)
  const loads = (buf: string) => {
    const lines: string[] = []
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) lines.push(`    d${r}${c} = ${buf}[pb + ys[${r}] + xs[${c}]];`)
    return lines.join('\n')
  }
  const decls = Array.from({ length: 16 }, (_, i) => `  var d${i >> 2}${i & 3}: ${F4};`).join('\n')
  const bt: string[] = []
  for (let c = 0; c < 4; c++) {
    bt.push(`  let t0${c} = d0${c} - d2${c};`)
    bt.push(`  let t1${c} = d1${c} + d2${c};`)
    bt.push(`  let t2${c} = d2${c} - d1${c};`)
    bt.push(`  let t3${c} = d1${c} - d3${c};`)
  }
  const stores: string[] = []
  for (let r = 0; r < 4; r++) {
    const v = [`t${r}0 - t${r}2`, `t${r}1 + t${r}2`, `t${r}2 - t${r}1`, `t${r}1 - t${r}3`]
    for (let c = 0; c < 4; c++) stores.push(`  V[(${r * 4 + c}u * wp.cin4 + c4) * wp.tilesChunk + t] = ${v[c]};`)
  }
  return `${enable}${WINO_STRUCT}
@group(0) @binding(0) var<storage, read> src: array<${F4}>;
@group(0) @binding(1) var<storage, read_write> V: array<${F4}>;
@group(0) @binding(5) var<uniform> wp: Wino;
${split ? `@group(0) @binding(7) var<storage, read> src1: array<${F4}>;` : ''}

fn fdiv(a: i32, b: i32) -> i32 { return (a - ((a % b + b) % b)) / b; }

@compute @workgroup_size(${WINO_TRANSFORM_WG})
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let t = gid.x;
  if (t >= wp.tilesChunk) { return; }
  let c4 = gid.y;
  let tx = i32(t % wp.tilesW);
  let ty = i32(wp.tileRow0 + t / wp.tilesW);
  let sc = i32(wp.inScale);
  let sw = i32(wp.srcW);
  let sh = i32(wp.srcH);
  let splane = wp.srcW * wp.srcH;
  var xs: array<u32, 4>;
  var ys: array<u32, 4>;
  for (var i = 0; i < 4; i++) {
    xs[i] = u32(clamp(fdiv(2 * tx - 1 + i, sc) + i32(wp.srcX0), 0, sw - 1));
    ys[i] = u32(clamp(fdiv(2 * ty - 1 + i, sc) + i32(wp.srcY0), 0, sh - 1)) * wp.srcW;
  }
${decls}
${
  split
    ? `  if (c4 < wp.splitPlane) {
    let pb = c4 * splane;
${loads('src')}
  } else {
    let pb = (c4 - wp.splitPlane) * splane;
${loads('src1')}
  }`
    : `  {
    let pb = c4 * splane;
${loads('src')}
  }`
}
${bt.join('\n')}
${stores.join('\n')}
}
`
}

/**
 * Element-wise products summed over the input channels, one 4x4 position at a time, with the
 * output transform Y = Aᵀ M A accumulated in registers (Aᵀ has only 0 and ±1 entries): a thread
 * owns 4 tiles × 8 output channels, a wave shares its output-channel group (uniform weight
 * loads), and the workgroup shares the transformed tiles through workgroup memory so each is
 * read from the buffer once. The epilogue (bias, activation, residuals) is the direct kernel's.
 */
export function winogradGemmWgsl(o: KernelOptions, spec: ConvSpec): string {
  const { enable, F, F4 } = types(o)
  const groups = spec.cout / 8
  const cout4 = spec.cout / 4
  const wg = 32 * groups
  const yDecl: string[] = []
  for (let oIdx = 0; oIdx < 4; oIdx++) for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) yDecl.push(`  var y${oIdx}_${i}${j} = ${F4}(${F}(0.0));`)
  const a0 = [1, 1, 1, 0]
  const a1 = [0, 1, -1, -1]
  const positions: string[] = []
  for (let p = 0; p < 16; p++) {
    const r = p >> 2
    const c = p & 3
    const block: string[] = []
    for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) block.push(`  var m_${i}${j} = ${F4}(${F}(0.0));`)
    block.push(`  for (var c0 = 0u; c0 < wp.cin4; c0 += ${WINO_CIN4_PER_STEP}u) {`)
    block.push(`    let cn = min(${WINO_CIN4_PER_STEP}u, wp.cin4 - c0);`)
    block.push(`    workgroupBarrier();`)
    block.push(`    for (var i = lid; i < cn * ${WINO_TILES_PER_GROUP}u; i += ${wg}u) {`)
    block.push(`      let k = i / ${WINO_TILES_PER_GROUP}u;`)
    block.push(`      let tt = tile0 + (i % ${WINO_TILES_PER_GROUP}u);`)
    block.push(`      if (tt < wp.tilesChunk) { sh[i] = V[(${p}u * wp.cin4 + c0 + k) * wp.tilesChunk + tt]; } else { sh[i] = ${F4}(${F}(0.0)); }`)
    block.push(`    }`)
    block.push(`    workgroupBarrier();`)
    block.push(`    for (var k = 0u; k < cn; k++) {`)
    for (let i = 0; i < 4; i++) block.push(`      let v${i} = sh[k * ${WINO_TILES_PER_GROUP}u + lane + ${32 * i}u];`)
    block.push(`      let ub = (${p}u * cin + (c0 + k) * 4u) * ${cout4}u + q4;`)
    for (let ci = 0; ci < 4; ci++) for (let j = 0; j < 2; j++) block.push(`      let w${ci}${j} = U[ub + ${ci * cout4 + j}u];`)
    const comp = ['x', 'y', 'z', 'w']
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 2; j++) {
        block.push(`      m_${i}${j} += v${i}.x * w0${j} + v${i}.y * w1${j} + v${i}.z * w2${j} + v${i}.w * w3${j};`)
      }
    }
    void comp
    block.push(`    }`)
    block.push(`  }`)
    // Scatter M(r, c) into the four outputs with the Aᵀ coefficients.
    const coeff = [a0[r]! * a0[c]!, a0[r]! * a1[c]!, a1[r]! * a0[c]!, a1[r]! * a1[c]!]
    for (let oIdx = 0; oIdx < 4; oIdx++) {
      if (coeff[oIdx] === 0) continue
      const op = coeff[oIdx] === 1 ? '+=' : '-='
      for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) block.push(`  y${oIdx}_${i}${j} ${op} m_${i}${j};`)
    }
    positions.push(`  {\n${block.join('\n')}\n  }`)
  }
  const epilogue = (value: string, j: number): string => {
    const a = activate(F, F4, spec.activation, value, `q4 + ${j}u`)
    if (spec.residual === 0) return a
    const r1 = `res1[(q4 + ${j}u) * plane + idx]`
    if (spec.residual === 1) return `${r1} + s1 * (${a})`
    const r2 = `res2[(q4 + ${j}u) * plane + idx]`
    return `${r1} + s1 * (${r2} + s2 * (${a}))`
  }
  const stores: string[] = []
  for (let i = 0; i < 4; i++) {
    stores.push(`  {`)
    stores.push(`    let tt = tile0 + lane + ${32 * i}u;`)
    stores.push(`    if (tt < wp.tilesChunk) {`)
    stores.push(`      let x = (tt % wp.tilesW) * 2u;`)
    stores.push(`      let y = (wp.tileRow0 + tt / wp.tilesW) * 2u;`)
    for (let oIdx = 0; oIdx < 4; oIdx++) {
      const dx = oIdx & 1
      const dy = oIdx >> 1
      stores.push(`      if (x + ${dx}u < wp.bw && y + ${dy}u < wp.bh) {`)
      stores.push(`        let idx = (y + ${dy}u) * wp.bw + x + ${dx}u;`)
      for (let j = 0; j < 2; j++) {
        stores.push(`        dst[(wp.dstPlane + q4 + ${j}u) * plane + idx] = ${epilogue(`(y${oIdx}_${i}${j} + bias[q4 + ${j}u])`, j)};`)
      }
      stores.push(`      }`)
    }
    stores.push(`    }`)
    stores.push(`  }`)
  }
  return `${enable}${WINO_STRUCT}
@group(0) @binding(0) var<storage, read> V: array<${F4}>;
@group(0) @binding(1) var<storage, read> U: array<${F4}>;
@group(0) @binding(2) var<storage, read> bias: array<${F4}>;
${spec.activation === 'prelu' ? `@group(0) @binding(3) var<storage, read> prelu: array<${F4}>;` : ''}
@group(0) @binding(4) var<storage, read_write> dst: array<${F4}>;
@group(0) @binding(5) var<uniform> wp: Wino;
${spec.residual >= 1 ? `@group(0) @binding(8) var<storage, read> res1: array<${F4}>;` : ''}
${spec.residual === 2 ? `@group(0) @binding(9) var<storage, read> res2: array<${F4}>;` : ''}

var<workgroup> sh: array<${F4}, ${WINO_TILES_PER_GROUP * WINO_CIN4_PER_STEP}>;

@compute @workgroup_size(${wg})
fn main(@builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wid: vec3u) {
  let wave = lid / 32u;
  let lane = lid % 32u;
  let q4 = wave * 2u;
  let tile0 = wid.x * ${WINO_TILES_PER_GROUP}u;
  let cin = wp.cin4 * 4u;
  let plane = wp.bw * wp.bh;
${spec.residual >= 1 ? `  let s1 = ${F}(wp.res1Scale);` : ''}
${spec.residual === 2 ? `  let s2 = ${F}(wp.res2Scale);` : ''}
${yDecl.join('\n')}
${positions.join('\n')}
${stores.join('\n')}
}
`
}
