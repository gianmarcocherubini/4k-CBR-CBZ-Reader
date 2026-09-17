import type { PageSize } from '../../types'

export type Anime4KLevel = 'M' | 'VL' | 'UL'

/** Relative cost of each upscale level (MACs per input pixel: M 2.1k, VL 8.0k, UL 17.8k). */
export const LEVEL_COST: Record<Anime4KLevel, number> = { M: 0.26, VL: 1, UL: 2.25 }
/** Cost of the Restore (Soft) pass run before the upscale: Soft M for M, Soft VL otherwise. */
export const RESTORE_COST: Record<Anime4KLevel, number> = { M: 0.26, VL: 1, UL: 1 }

export const STRIP_ROWS = 288
export const OVERLAP = 24
export const CORE = STRIP_ROWS - 2 * OVERLAP
/** Safari caps canvas/bitmap area around 16.7 MP. */
export const MAX_OUTPUT_PIXELS = 16 * 1024 * 1024

/**
 * Memory a cache of enhanced bitmaps may hold. Results are kept at their full factor (a x4 page
 * of 800x1200 is 61 MB), so the bound is in bytes; Safari does not expose deviceMemory, so the
 * middle value is what an iPad gets.
 */
export function cacheBudgetBytes(): number {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  if (mem !== undefined && mem <= 2) return 96 * 1024 * 1024
  if (mem !== undefined && mem <= 4) return 192 * 1024 * 1024
  if (mem !== undefined && mem >= 8) return 512 * 1024 * 1024
  return 256 * 1024 * 1024
}

export interface Size {
  w: number
  h: number
}

export interface UpscaleResult {
  data: Uint8ClampedArray<ArrayBuffer>
  width: number
  height: number
}

/** One 2x run of the network over a page. */
export interface UpscaleOptions {
  level: Anime4KLevel
  /** Anime4K Restore_CNN_Soft pass before the upscale (sharper lines, less ringing than "hard"). */
  restore: boolean
  /** Scan clean-up in the composite: paper white/black levels and a light bilateral smoothing. */
  clean: boolean
  /**
   * Output size in pixels. At most 2x the source; smaller targets are produced by 2x2
   * supersampled resampling of the network output (no browser bilinear blur afterwards).
   */
  target: Size
}

export interface BackendInfo {
  adapter: string
  maxTextureDimension: number
}

/** A 2x Anime4K upscaler on some GPU API. Implementations process the page in strips. */
export interface UpscaleBackend {
  readonly kind: 'webgpu' | 'webgl2'
  readonly info: BackendInfo
  readonly isLost: boolean
  onLost: (() => void) | null
  /** Whether a page of this width can go through the strip pipeline (2x width within texture limits). */
  canUpscale(size: PageSize): boolean
  /** Builds pipelines/programs for (level, restore, width) if needed. Resolves true when it had to build. */
  prepare(level: Anime4KLevel, restore: boolean, width: number): Promise<boolean>
  upscale(source: ImageBitmap, opts: UpscaleOptions): Promise<UpscaleResult>
  dispose(): void
}

export function fitsLimits(size: PageSize, maxTextureDimension: number): boolean {
  return size.w * 2 <= maxTextureDimension && size.h * 2 <= maxTextureDimension
}

/**
 * Replicate-padded copy of the page: OVERLAP rows above, and enough rows below to complete the
 * last strip, so every strip is exactly STRIP_ROWS tall and edge pixels see real neighbours.
 */
export function padForStrips(source: ImageBitmap): { canvas: OffscreenCanvas; strips: number } {
  const W = source.width
  const H = source.height
  const strips = Math.ceil(H / CORE)
  const paddedH = strips * CORE + 2 * OVERLAP
  const canvas = new OffscreenCanvas(W, paddedH)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(source, 0, 0, W, 1, 0, 0, W, OVERLAP)
  ctx.drawImage(source, 0, OVERLAP)
  ctx.drawImage(source, 0, H - 1, W, 1, 0, OVERLAP + H, W, paddedH - OVERLAP - H)
  return { canvas, strips }
}

/** Composite parameters shared by the WebGPU and WebGL2 backends (same maths, same look). */
export interface CompositeParams {
  /** Output pixels per source pixel (target.w / W). */
  scale: number
  /** First padded source row of the strip (y0 - OVERLAP). */
  stripY0: number
  /** Strip output texture size (2W x 2*STRIP_ROWS). */
  texW: number
  texH: number
  /** 1 when target == 2x source: plain texel copy, no resampling. */
  exact: boolean
  clean: boolean
}

/** Output rows [start, end) written by strip k for a page of height H at `scale`. */
export function stripOutputRows(k: number, H: number, scale: number, outH: number): { start: number; end: number } {
  const y0 = k * CORE
  const start = Math.min(outH, Math.round(y0 * scale))
  const end = Math.min(outH, Math.round(Math.min(H, y0 + CORE) * scale))
  return { start, end }
}

/**
 * Body of the composite fragment shader in GLSL ES 3.00 and WGSL. Both read the 2x strip texture
 * `up` (bilinear sampler) and write one output pixel at `pos` (pixel centre coordinates).
 *
 * exact: out(x, y) = up(x, y - 2*stripY0)
 * scaled: mean of 4 bilinear taps at (x ± 1/4, y ± 1/4) in output space, mapped to strip space by
 *         s -> s / scale * 2, then y -> y - 2*stripY0. Clean adds a 3x3 bilateral and paper levels.
 */
export const COMPOSITE_GLSL = /* glsl */ `
uniform sampler2D up;
uniform vec4 u_params;   // scale, stripY0, exact, clean
uniform vec2 u_texSize;  // strip texture size
vec3 tapAt(vec2 outPx) {
  vec2 sp = outPx / u_params.x * 2.0;
  sp.y -= 2.0 * u_params.y;
  return texture(up, sp / u_texSize).rgb;
}
vec3 sample4(vec2 outPx) {
  return 0.25 * (tapAt(outPx + vec2(-0.25, -0.25)) + tapAt(outPx + vec2(0.25, -0.25)) + tapAt(outPx + vec2(-0.25, 0.25)) + tapAt(outPx + vec2(0.25, 0.25)));
}
vec3 composite(vec2 fragPx) {
  vec3 c;
  if (u_params.z > 0.5) {
    c = texelFetch(up, ivec2(int(fragPx.x), int(fragPx.y) - int(2.0 * u_params.y)), 0).rgb;
  } else {
    c = sample4(fragPx);
  }
  if (u_params.w > 0.5) {
    // Light bilateral smoothing (JPEG noise on flat areas), then paper levels.
    vec3 acc = c;
    float wsum = 1.0;
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0) continue;
        vec3 n = u_params.z > 0.5 ? texelFetch(up, ivec2(int(fragPx.x) + dx, int(fragPx.y) + dy - int(2.0 * u_params.y)), 0).rgb : tapAt(fragPx + vec2(float(dx), float(dy)));
        float d = length(n - c);
        float w = exp(-d * d / (2.0 * 0.06 * 0.06));
        acc += n * w;
        wsum += w;
      }
    }
    c = acc / wsum;
    c = clamp((c - 0.06) / (0.93 - 0.06), 0.0, 1.0);
  }
  return clamp(c, 0.0, 1.0);
}
`

export const COMPOSITE_WGSL = /* wgsl */ `
struct Params { scale: f32, stripY0: f32, exact: f32, clean: f32, texW: f32, texH: f32, pad0: f32, pad1: f32 }
@group(0) @binding(0) var up: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> params: Params;

fn tapAt(outPx: vec2f) -> vec3f {
  var sp = outPx / params.scale * 2.0;
  sp.y -= 2.0 * params.stripY0;
  return textureSampleLevel(up, samp, sp / vec2f(params.texW, params.texH), 0.0).rgb;
}
fn fetchAt(px: vec2i) -> vec3f {
  let p = vec2i(px.x, px.y - i32(2.0 * params.stripY0));
  return textureLoad(up, clamp(p, vec2i(0), vec2i(i32(params.texW) - 1, i32(params.texH) - 1)), 0).rgb;
}
fn sample4(outPx: vec2f) -> vec3f {
  return 0.25 * (tapAt(outPx + vec2f(-0.25, -0.25)) + tapAt(outPx + vec2f(0.25, -0.25)) + tapAt(outPx + vec2f(-0.25, 0.25)) + tapAt(outPx + vec2f(0.25, 0.25)));
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let exact = params.exact > 0.5;
  var c: vec3f;
  if (exact) {
    c = fetchAt(vec2i(i32(pos.x), i32(pos.y)));
  } else {
    c = sample4(pos.xy);
  }
  if (params.clean > 0.5) {
    var acc = c;
    var wsum = 1.0;
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        if (dx == 0 && dy == 0) { continue; }
        var n: vec3f;
        if (exact) {
          n = fetchAt(vec2i(i32(pos.x) + dx, i32(pos.y) + dy));
        } else {
          n = tapAt(pos.xy + vec2f(f32(dx), f32(dy)));
        }
        let d = length(n - c);
        let w = exp(-d * d / (2.0 * 0.06 * 0.06));
        acc += n * w;
        wsum += w;
      }
    }
    c = acc / wsum;
    c = clamp((c - vec3f(0.06)) / (0.93 - 0.06), vec3f(0.0), vec3f(1.0));
  }
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}
`
