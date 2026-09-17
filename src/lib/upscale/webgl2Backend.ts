import type { PageSize } from '../../types'
import {
  type Anime4KLevel,
  type BackendInfo,
  COMPOSITE_GLSL,
  CORE,
  fitsLimits,
  OVERLAP,
  padForStrips,
  STRIP_ROWS,
  stripOutputRows,
  type UpscaleBackend,
  type UpscaleOptions,
  type UpscaleResult,
} from './backend'
import { buildFragmentShader, evalSize, type HookPass, parseHooks, VERTEX_SHADER } from './glslHooks'

interface Program {
  pass: HookPass
  program: WebGLProgram
  samplers: Map<string, WebGLUniformLocation>
  sizes: Map<string, WebGLUniformLocation>
}

interface Tex {
  texture: WebGLTexture
  w: number
  h: number
}

const UPSCALE_FILES: Record<Anime4KLevel, () => Promise<string>> = {
  M: () => import('./shaders/anime4k/Anime4K_Upscale_CNN_x2_M.glsl?raw').then((m) => m.default),
  VL: () => import('./shaders/anime4k/Anime4K_Upscale_CNN_x2_VL.glsl?raw').then((m) => m.default),
  UL: () => import('./shaders/anime4k/Anime4K_Upscale_CNN_x2_UL.glsl?raw').then((m) => m.default),
}
/** Restore Soft: M for the M level, VL otherwise (no Soft UL exists). */
const RESTORE_FILES: Record<Anime4KLevel, () => Promise<string>> = {
  M: () => import('./shaders/anime4k/Anime4K_Restore_CNN_Soft_M.glsl?raw').then((m) => m.default),
  VL: () => import('./shaders/anime4k/Anime4K_Restore_CNN_Soft_VL.glsl?raw').then((m) => m.default),
  UL: () => import('./shaders/anime4k/Anime4K_Restore_CNN_Soft_VL.glsl?raw').then((m) => m.default),
}

const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 v_uv;
out vec4 fragColor;
${COMPOSITE_GLSL}
void main() { fragColor = vec4(composite(gl_FragCoord.xy), 1.0); }
`

/**
 * Runs the official Anime4K GLSL hook shaders on WebGL2 (iPadOS 17/18 have no WebGPU).
 * Same strip scheme as the WebGPU backend: rgba16f intermediates sized for one strip, the 2x
 * strip composited into one full-size rgba8 output at the target size, a single readback.
 */
export class WebGL2Backend implements UpscaleBackend {
  readonly kind = 'webgl2' as const
  readonly info: BackendInfo
  onLost: (() => void) | null = null
  private readonly gl: WebGL2RenderingContext
  private readonly programs = new Map<string, Program[]>()
  private readonly sources = new Map<string, string>()
  private readonly textures = new Map<string, Tex>()
  private readonly fbo: WebGLFramebuffer
  private readonly stripCanvas: OffscreenCanvas
  private readonly composite: { program: WebGLProgram; up: WebGLUniformLocation; params: WebGLUniformLocation; texSize: WebGLUniformLocation }
  private lost = false

  private constructor(canvas: OffscreenCanvas, gl: WebGL2RenderingContext, info: BackendInfo) {
    this.gl = gl
    this.info = info
    this.fbo = gl.createFramebuffer()!
    this.stripCanvas = new OffscreenCanvas(1, STRIP_ROWS)
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.lost = true
      this.onLost?.()
    })
    const vs = this.compile(gl.VERTEX_SHADER, VERTEX_SHADER)
    const fs = this.compile(gl.FRAGMENT_SHADER, COMPOSITE_FRAGMENT)
    const program = gl.createProgram()!
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Link fallito (composite): ${gl.getProgramInfoLog(program)}`)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    this.composite = {
      program,
      up: gl.getUniformLocation(program, 'up')!,
      params: gl.getUniformLocation(program, 'u_params')!,
      texSize: gl.getUniformLocation(program, 'u_texSize')!,
    }
  }

  /**
   * @param allowSoftware run even on software renderers (SwiftShader, llvmpipe). Off by default:
   * a CPU-emulated GL blocks the main thread for seconds per page in `readPixels`, which is
   * worse than plain browser scaling.
   */
  static async create(allowSoftware = false): Promise<WebGL2Backend | null> {
    if (typeof OffscreenCanvas === 'undefined') return null
    try {
      const canvas = new OffscreenCanvas(4, 4)
      const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, premultipliedAlpha: false })
      if (!gl) return null
      // Float render targets are required for the rgba16f intermediates.
      if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return null
      const dbg = gl.getExtension('WEBGL_debug_renderer_info')
      const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER))
      if (!allowSoftware && /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer)) {
        gl.getExtension('WEBGL_lose_context')?.loseContext()
        return null
      }
      const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
      // Load the M shader up front to fail early on machines that cannot compile it.
      const backend = new WebGL2Backend(canvas, gl, { adapter: renderer.replace(/^ANGLE \(|\)$/g, ''), maxTextureDimension: Math.min(maxTex, 16384) })
      await backend.prepare('M', false, 0)
      return backend
    } catch {
      return null
    }
  }

  get isLost(): boolean {
    return this.lost
  }

  canUpscale(size: PageSize): boolean {
    return fitsLimits(size, this.info.maxTextureDimension)
  }

  private async load(key: string, loader: () => Promise<string>): Promise<string> {
    let s = this.sources.get(key)
    if (!s) {
      s = await loader()
      this.sources.set(key, s)
    }
    return s
  }

  /** Programs are size-independent in GLSL (sizes are uniforms), so `width` is unused here. */
  async prepare(level: Anime4KLevel, restore: boolean, _width: number): Promise<boolean> {
    const key = `${level}:${restore ? 'r' : '-'}`
    if (this.programs.has(key)) return false
    const upscale = await this.load(`up:${level}`, UPSCALE_FILES[level])
    const restoreSrc = restore ? await this.load(`restore:${level}`, RESTORE_FILES[level]) : ''
    if (this.programs.has(key)) return false
    const passes = [...(restore ? parseHooks(restoreSrc) : []), ...parseHooks(upscale)]
    this.programs.set(key, this.build(passes))
    return true
  }

  private build(passes: HookPass[]): Program[] {
    const gl = this.gl
    const vs = this.compile(gl.VERTEX_SHADER, VERTEX_SHADER)
    const built: Program[] = []
    for (const pass of passes) {
      const fs = this.compile(gl.FRAGMENT_SHADER, buildFragmentShader(pass))
      const program = gl.createProgram()!
      gl.attachShader(program, vs)
      gl.attachShader(program, fs)
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`Link fallito (${pass.desc}): ${gl.getProgramInfoLog(program)}`)
      }
      gl.deleteShader(fs)
      const samplers = new Map<string, WebGLUniformLocation>()
      const sizes = new Map<string, WebGLUniformLocation>()
      for (const n of new Set([pass.hook, ...pass.binds])) {
        const s = gl.getUniformLocation(program, `${n}_raw`)
        const z = gl.getUniformLocation(program, `${n}_size`)
        if (s) samplers.set(n, s)
        if (z) sizes.set(n, z)
      }
      built.push({ pass, program, samplers, sizes })
    }
    gl.deleteShader(vs)
    return built
  }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, src)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader)
      gl.deleteShader(shader)
      throw new Error(`Compilazione shader fallita: ${log}`)
    }
    return shader
  }

  /** Texture of the given size/format, reused across strips and pages. */
  private texture(key: string, w: number, h: number, float: boolean): Tex {
    const gl = this.gl
    const hit = this.textures.get(key)
    if (hit && hit.w === w && hit.h === h) return hit
    if (hit) gl.deleteTexture(hit.texture)
    const texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    if (float) gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h)
    else gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h)
    const t = { texture, w, h }
    this.textures.set(key, t)
    return t
  }

  async upscale(source: ImageBitmap, opts: UpscaleOptions): Promise<UpscaleResult> {
    if (this.lost) throw new Error('Contesto WebGL perso')
    await this.prepare(opts.level, opts.restore, source.width)
    const programs = this.programs.get(`${opts.level}:${opts.restore ? 'r' : '-'}`)!
    const gl = this.gl
    const W = source.width
    const H = source.height
    const outW = Math.max(1, Math.round(opts.target.w))
    const outH = Math.max(1, Math.round(opts.target.h))
    const scale = outW / W
    const exact = outW === W * 2 && outH === H * 2
    const { canvas: padded, strips } = padForStrips(source)

    // Strip input (MAIN), the 2x strip (UP) and the full-size output.
    const main = this.texture('MAIN', W, STRIP_ROWS, false)
    const up = this.texture('UP', W * 2, STRIP_ROWS * 2, true)
    const output = this.texture('OUTPUT', outW, outH, false)
    if (this.stripCanvas.width !== W) this.stripCanvas.width = W
    const stripCtx = this.stripCanvas.getContext('2d')!

    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)

    for (let k = 0; k < strips; k++) {
      const y0 = k * CORE
      const rows = stripOutputRows(k, H, scale, outH)
      if (rows.end <= rows.start) continue
      // Upload the strip (rows y0 .. y0+STRIP_ROWS of the padded page) into MAIN.
      stripCtx.drawImage(padded, 0, y0, W, STRIP_ROWS, 0, 0, W, STRIP_ROWS)
      gl.bindTexture(gl.TEXTURE_2D, main.texture)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, STRIP_ROWS, gl.RGBA, gl.UNSIGNED_BYTE, this.stripCanvas)

      // Named textures visible to the passes; MAIN is re-pointed when a pass saves to it.
      const bound = new Map<string, Tex>([['MAIN', main]])
      const sizes = new Map<string, { w: number; h: number }>([['MAIN', { w: W, h: STRIP_ROWS }]])
      gl.disable(gl.SCISSOR_TEST)

      for (let p = 0; p < programs.length; p++) {
        const { pass, program, samplers, sizes: sizeLocs } = programs[p]!
        const w = evalSize(pass.width, sizes, W)
        const h = evalSize(pass.height, sizes, STRIP_ROWS)
        const isFinal = p === programs.length - 1
        const target: Tex = isFinal ? up : this.texture(`pass:${pass.save}:${p}`, w, h, true)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0)
        gl.useProgram(program)
        let unit = 0
        for (const [name, loc] of samplers) {
          const tex = bound.get(name)
          if (!tex) throw new Error(`Texture ${name} non disponibile per ${pass.desc}`)
          gl.activeTexture(gl.TEXTURE0 + unit)
          gl.bindTexture(gl.TEXTURE_2D, tex.texture)
          gl.uniform1i(loc, unit)
          const sz = sizeLocs.get(name)
          if (sz) gl.uniform2f(sz, tex.w, tex.h)
          unit++
        }
        gl.viewport(0, 0, isFinal ? up.w : w, isFinal ? up.h : h)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        if (!isFinal) {
          bound.set(pass.save, target)
          sizes.set(pass.save, { w, h })
        }
      }

      // Composite the 2x strip into the output at the target scale (only its core rows).
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, output.texture, 0)
      gl.useProgram(this.composite.program)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, up.texture)
      gl.uniform1i(this.composite.up, 0)
      gl.uniform4f(this.composite.params, scale, y0 - OVERLAP, exact ? 1 : 0, opts.clean ? 1 : 0)
      gl.uniform2f(this.composite.texSize, up.w, up.h)
      gl.viewport(0, 0, outW, outH)
      gl.enable(gl.SCISSOR_TEST)
      gl.scissor(0, rows.start, outW, rows.end - rows.start)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    gl.disable(gl.SCISSOR_TEST)

    // Read the composited output back. Row 0 of the framebuffer is row 0 of the image because
    // uploads and reads both use WebGL's bottom-up convention consistently.
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, output.texture, 0)
    const data = new Uint8ClampedArray(new ArrayBuffer(outW * outH * 4))
    gl.readPixels(0, 0, outW, outH, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(data.buffer))
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const err = gl.getError()
    if (err !== gl.NO_ERROR) throw new Error(`Errore WebGL ${err}`)
    return { data, width: outW, height: outH }
  }

  dispose(): void {
    const gl = this.gl
    for (const t of this.textures.values()) gl.deleteTexture(t.texture)
    this.textures.clear()
    for (const list of this.programs.values()) for (const p of list) gl.deleteProgram(p.program)
    this.programs.clear()
    gl.deleteProgram(this.composite.program)
    gl.deleteFramebuffer(this.fbo)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
