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
export const BODY_BLOCK_H = 4

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

function activate(F4: string, activation: Activation, a: string, quad: string): string {
  switch (activation) {
    case 'prelu':
      return `select(${a} * prelu[${quad}], ${a}, ${a} > ${F4}(0.0))`
    case 'lrelu':
      return `select(${a} * ${F4}(0.2), ${a}, ${a} > ${F4}(0.0))`
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
  const store = Array.from({ length: 16 }, (_, i) => `  dst[(lp.dstPlane + ${i}u) * plane + p] = ${activate(F4, activation, `a${i}`, `${i}u`)};`).join('\n')
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
 * residual epilogue. Workgroup = 32 threads per output-channel group of 16.
 */
export function convWgsl(o: KernelOptions, spec: ConvSpec): string {
  const { enable, F4 } = types(o)
  const groups = spec.cout / 16
  const cout4 = spec.cout / 4
  const accInit: string[] = []
  for (let k = 0; k < 4; k++) for (let j = 0; j < 4; j++) accInit.push(`  var a${k}${j} = bias[q4 + ${j}u];`)
  const comp = ['x', 'y', 'z', 'w']
  // The inner block: 3 taps of one input quad, 4 weight loads per component, 16 FMAs each.
  const tapBlocks = (cinExpr: string): string => {
    const blocks: string[] = []
    for (let kx = 0; kx < 3; kx++) {
      const block: string[] = []
      block.push(`        {`)
      block.push(`          let wb = ((ky3 + ${kx}u) * ${cinExpr} + ci4 * 4u) * ${cout4}u + q4;`)
      for (let c = 0; c < 4; c++) {
        block.push(`          {`)
        for (let j = 0; j < 4; j++) block.push(`            let w${j} = weights[wb + ${c * cout4 + j}u];`)
        for (let k = 0; k < 4; k++) {
          const v = `p${k + kx}.${comp[c]}`
          for (let j = 0; j < 4; j++) block.push(`            a${k}${j} += ${v} * w${j};`)
        }
        block.push(`          }`)
      }
      block.push(`        }`)
      blocks.push(block.join('\n'))
    }
    return blocks.join('\n')
  }
  const loads = (buf: string, planeExpr: string) =>
    [
      `        let pb = (${planeExpr}) * splane + srow;`,
      `        let p0 = ${buf}[pb + xm1];`,
      `        let p1 = ${buf}[pb + xp0];`,
      `        let p2 = ${buf}[pb + xp1];`,
      `        let p3 = ${buf}[pb + xp2];`,
      `        let p4 = ${buf}[pb + xp3];`,
      `        let p5 = ${buf}[pb + xp4];`,
    ].join('\n')
  const cinExpr = '(lp.cin4 * 4u)'
  const loop0 = `      for (var ci4 = 0u; ci4 < ${spec.split ? 'min(lp.cin4, lp.splitPlane)' : 'lp.cin4'}; ci4++) {
${loads('src', 'ci4')}
${tapBlocks(cinExpr)}
      }`
  const loop1 = spec.split
    ? `      for (var ci4 = lp.splitPlane; ci4 < lp.cin4; ci4++) {
${loads('src1', 'ci4 - lp.splitPlane')}
${tapBlocks(cinExpr)}
      }`
    : ''
  const epilogue = (k: number, j: number): string => {
    const a = activate(F4, spec.activation, `a${k}${j}`, `q4 + ${j}u`)
    if (spec.residual === 0) return a
    const r1 = `res1[(q4 + ${j}u) * plane + idx]`
    if (spec.residual === 1) return `${r1} + ${F4}(lp.res1Scale) * (${a})`
    const r2 = `res2[(q4 + ${j}u) * plane + idx]`
    return `${r1} + ${F4}(lp.res1Scale) * (${r2} + ${F4}(lp.res2Scale) * (${a}))`
  }
  const stores: string[] = []
  for (let k = 0; k < 4; k++) {
    stores.push(`  if (x0 + ${k} < bw) {`)
    stores.push(`    let idx = row + u32(x0 + ${k});`)
    for (let j = 0; j < 4; j++) stores.push(`    dst[(lp.dstPlane + q4 + ${j}u) * plane + idx] = ${epilogue(k, j)};`)
    stores.push(`  }`)
  }
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
  let y = i32(wid.y * ${BODY_BLOCK_H}u + r);
  let plane = band.bw * band.bh;
  let splane = band.srcW * band.srcH;
  let sc = i32(lp.inScale);
  let ox = i32(lp.srcX0);
  let oy = i32(lp.srcY0);
${accInit.join('\n')}
  // Input columns of the 6 taps that cover the 4 output pixels (nearest-upsampled and clamped).
  let xm1 = u32(clamp(((x0 - 1) - ((x0 - 1) % sc + sc) % sc) / sc + ox, 0, sw - 1));
  let xp0 = u32(clamp(x0 / sc + ox, 0, sw - 1));
  let xp1 = u32(clamp((x0 + 1) / sc + ox, 0, sw - 1));
  let xp2 = u32(clamp((x0 + 2) / sc + ox, 0, sw - 1));
  let xp3 = u32(clamp((x0 + 3) / sc + ox, 0, sw - 1));
  let xp4 = u32(clamp((x0 + 4) / sc + ox, 0, sw - 1));
  for (var ky = 0; ky < 3; ky++) {
    let yy = y + ky - 1;
    let sy = (yy - ((yy % sc + sc) % sc)) / sc + oy;
    let srow = u32(clamp(sy, 0, sh - 1)) * band.srcW;
    let ky3 = u32(ky) * 3u;
${loop0}
${loop1}
  }
  if (y >= bh) { return; }
  let row = u32(y) * band.bw;
${stores.join('\n')}
}
`
}

/** Uniforms of the shuffle and finalize kernels (16 x u32 = 64 bytes). */
export const SHUFFLE_PARAMS_BYTES = 64

const SHUFFLE_STRUCT = `struct Shuffle {
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

/** Uniforms of the RGB output kernel (RRDB conv_last), 12 x u32 = 48 bytes. */
export const RGB_OUT_PARAMS_BYTES = 48
export const RGB_OUT_STRUCT = `struct RgbOut {
  srcW: u32, srcH: u32, outY0: u32, context4: u32,
  pageW4: u32, coreRows4: u32, bandY04: u32, outW: u32,
  outH: u32, factor: u32, coreY0: u32, pad0: u32,
}`

/**
 * RRDB conv_last: 64 input channels at 4x → RGB (the 4th output channel is padding), clamped and
 * written as RGBA8 into the page. The dispatch covers one tail strip of the band (in band 4x
 * coordinates starting at outY0); only core pixels are written. x2 output averages 2x2.
 */
export function rgbOutWgsl(o: KernelOptions): string {
  const { enable, F4 } = types(o)
  return `${enable}${RGB_OUT_STRUCT}
@group(0) @binding(0) var<storage, read> src: array<${F4}>;
@group(0) @binding(1) var<storage, read> weights: array<${F4}>;
@group(0) @binding(2) var<storage, read> bias: array<${F4}>;
@group(0) @binding(3) var<storage, read_write> page: array<u32>;
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
  return clamp(vec3f(a.xyz), vec3f(0.0), vec3f(1.0));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  // Output pixel of the page at the requested factor: gid covers the strip's core at that factor.
  let f = rp.factor;
  let sub = 4u / f;
  // Band 4x coordinates of the first sub-pixel of this output pixel (the strip's own core rows).
  let X4 = rp.context4 + gid.x * sub;
  let Y4 = rp.coreY0 + gid.y * sub;
  if (X4 >= rp.context4 + rp.pageW4 || Y4 >= rp.context4 + rp.coreRows4) { return; }
  var c = vec3f(0.0);
  for (var by = 0u; by < sub; by++) {
    for (var bx = 0u; bx < sub; bx++) {
      c += pixel(i32(X4 + bx), i32(Y4 + by) - i32(rp.outY0));
    }
  }
  c = c / f32(sub * sub);
  let px = (X4 - rp.context4) / sub;
  let py = (rp.bandY04 + Y4 - rp.context4) / sub;
  if (px >= rp.outW || py >= rp.outH) { return; }
  page[py * rp.outW + px] = pack4x8unorm(vec4f(c, 1.0));
}
`
}
