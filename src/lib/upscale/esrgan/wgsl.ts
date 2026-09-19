/**
 * WGSL compute kernels of the compact Real-ESRGAN network (conv 3x3 + PReLU chain, pixel shuffle).
 *
 * Activations live in storage buffers as planes of vec4: plane `o` holds channels 4o..4o+3, pixel
 * (x, y) of a band of `bw` x `bh` pixels at index `o * bw * bh + y * bw + x`. Weights are
 * `[tap][cin][cout/4]` vec4s, so for one tap and one input channel the output quads are contiguous.
 *
 * The body kernel is register-blocked: a thread computes 4 horizontally adjacent pixels x 16
 * output channels, so each weight load feeds 4 fused multiply-adds, and the 32 threads of a
 * wavefront share the same output-channel group (their weight loads are uniform). Everything is
 * generated unrolled: no runtime-indexed local arrays.
 */

export interface KernelOptions {
  /** Use `f16` for activations, weights and arithmetic (requires the `shader-f16` feature). */
  f16: boolean
}

export const BODY_PIXELS_PER_THREAD = 4
export const BODY_BLOCK_W = 32
export const BODY_BLOCK_H = 4

const types = (o: KernelOptions) => ({
  enable: o.f16 ? 'enable f16;\n' : '',
  F: o.f16 ? 'f16' : 'f32',
  F4: o.f16 ? 'vec4<f16>' : 'vec4<f32>',
})

const BAND_STRUCT = `struct Band { bw: u32, bh: u32, pad0: u32, pad1: u32 }`

/** conv_first: 3 input channels read from the band texture, 64 outputs, PReLU. One pixel per thread. */
export function convFirstWgsl(o: KernelOptions): string {
  const { enable, F, F4 } = types(o)
  const acc = Array.from({ length: 16 }, (_, i) => `  var a${i} = bias[${i}u];`).join('\n')
  const taps = Array.from(
    { length: 16 },
    (_, i) => `      a${i} += r * weights[wb + ${i}u] + g * weights[wb + ${16 + i}u] + b * weights[wb + ${32 + i}u];`,
  ).join('\n')
  const store = Array.from(
    { length: 16 },
    (_, i) => `  dst[${i}u * plane + p] = select(a${i} * prelu[${i}u], a${i}, a${i} > ${F4}(0.0));`,
  ).join('\n')
  return `${enable}${BAND_STRUCT}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read> weights: array<${F4}>;
@group(0) @binding(2) var<storage, read> bias: array<${F4}>;
@group(0) @binding(3) var<storage, read> prelu: array<${F4}>;
@group(0) @binding(4) var<storage, read_write> dst: array<${F4}>;
@group(0) @binding(5) var<uniform> band: Band;

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
 * Body convolution: 64 input channels from a plane buffer, `cout` outputs (64 with PReLU for the
 * trunk, 48 without for conv_last). Workgroup = 32 threads per output-channel group of 16.
 */
export function convBodyWgsl(o: KernelOptions, cout: 64 | 48, prelu: boolean): string {
  const { enable, F4 } = types(o)
  const groups = cout / 16
  const cout4 = cout / 4
  const lines: string[] = []
  for (let k = 0; k < 4; k++) for (let j = 0; j < 4; j++) lines.push(`  var a${k}${j} = bias[q4 + ${j}u];`)
  const accInit = lines.join('\n')
  const comp = ['x', 'y', 'z', 'w']
  const tapBlocks: string[] = []
  for (let kx = 0; kx < 3; kx++) {
    const block: string[] = []
    block.push(`      {`)
    block.push(`        let wb = ((ky3 + ${kx}u) * 64u + ci4 * 4u) * ${cout4}u + q4;`)
    for (let c = 0; c < 4; c++) {
      block.push(`        {`)
      for (let j = 0; j < 4; j++) block.push(`          let w${j} = weights[wb + ${c * cout4 + j}u];`)
      for (let k = 0; k < 4; k++) {
        const v = `p${k + kx}.${comp[c]}`
        for (let j = 0; j < 4; j++) block.push(`          a${k}${j} += ${v} * w${j};`)
      }
      block.push(`        }`)
    }
    block.push(`      }`)
    tapBlocks.push(block.join('\n'))
  }
  const stores: string[] = []
  for (let k = 0; k < 4; k++) {
    stores.push(`  if (x0 + ${k} < bw) {`)
    stores.push(`    let idx = row + u32(x0 + ${k});`)
    for (let j = 0; j < 4; j++) {
      const value = prelu ? `select(a${k}${j} * prelu[q4 + ${j}u], a${k}${j}, a${k}${j} > ${F4}(0.0))` : `a${k}${j}`
      stores.push(`    dst[(q4 + ${j}u) * plane + idx] = ${value};`)
    }
    stores.push(`  }`)
  }
  return `${enable}${BAND_STRUCT}
@group(0) @binding(0) var<storage, read> src: array<${F4}>;
@group(0) @binding(1) var<storage, read> weights: array<${F4}>;
@group(0) @binding(2) var<storage, read> bias: array<${F4}>;
${prelu ? `@group(0) @binding(3) var<storage, read> prelu: array<${F4}>;` : ''}
@group(0) @binding(4) var<storage, read_write> dst: array<${F4}>;
@group(0) @binding(5) var<uniform> band: Band;

@compute @workgroup_size(${32 * groups})
fn main(@builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wid: vec3u) {
  let q4 = (lid / 32u) * 4u;
  let r = (lid % 32u) / 8u;
  let g = lid % 8u;
  let bw = i32(band.bw);
  let bh = i32(band.bh);
  let x0 = i32(wid.x * ${BODY_BLOCK_W}u + g * 4u);
  let y = i32(wid.y * ${BODY_BLOCK_H}u + r);
  let plane = band.bw * band.bh;
${accInit}
  let xm1 = u32(clamp(x0 - 1, 0, bw - 1));
  let xp0 = u32(clamp(x0, 0, bw - 1));
  let xp1 = u32(clamp(x0 + 1, 0, bw - 1));
  let xp2 = u32(clamp(x0 + 2, 0, bw - 1));
  let xp3 = u32(clamp(x0 + 3, 0, bw - 1));
  let xp4 = u32(clamp(x0 + 4, 0, bw - 1));
  for (var ky = 0; ky < 3; ky++) {
    let srow = u32(clamp(y + ky - 1, 0, bh - 1)) * band.bw;
    let ky3 = u32(ky) * 3u;
    for (var ci4 = 0u; ci4 < 16u; ci4++) {
      let pb = ci4 * plane + srow;
      let p0 = src[pb + xm1];
      let p1 = src[pb + xp0];
      let p2 = src[pb + xp1];
      let p3 = src[pb + xp2];
      let p4 = src[pb + xp3];
      let p5 = src[pb + xp4];
${tapBlocks.join('\n')}
    }
  }
  if (y >= bh) { return; }
  let row = u32(y) * band.bw;
${stores.join('\n')}
}
`
}

/** Uniforms of the shuffle and finalize kernels (16 x u32 = 64 bytes). */
export const SHUFFLE_PARAMS_BYTES = 64

/**
 * conv_last output (48 channels = 3 colours x 4x4 sub-pixels) → pixel shuffle, nearest-neighbour
 * residual, clamp. A thread handles one core source pixel of the band in *original* orientation;
 * the network ran on the band transformed by (swap, flipX, flipY), so activations, base colour and
 * the 4x4 sub-pixel grid are read at the transformed position. x2 output is a 2x2 box of the
 * clamped x4 pixels. Direct mode writes RGBA8 into the page; accumulate mode sums float colours
 * into the band accumulator (self-ensemble), `first` starting a fresh sum.
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

const SHUFFLE_STRUCT = `struct Shuffle {
  tw: u32, th: u32, context: u32, pageW: u32,
  bandY0: u32, coreRows: u32, outW: u32, outH: u32,
  factor: u32, swap: u32, flipX: u32, flipY: u32,
  first: u32, accW: u32, passes: u32, pad0: u32,
}`

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
