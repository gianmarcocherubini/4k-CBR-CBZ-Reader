/**
 * Minimal parser for mpv "user shader" hook files (the format of the official Anime4K GLSL
 * shaders): a file is a sequence of passes, each introduced by `//!` directives followed by a
 * GLSL body that defines `vec4 hook()`.
 *
 * Supported directives: DESC, HOOK, BIND, SAVE, WIDTH, HEIGHT, COMPONENTS, WHEN (ignored).
 * Sizes are RPN expressions over `NAME.w` / `NAME.h`, numbers and `+ - * /`.
 */
export interface HookPass {
  desc: string
  hook: string
  binds: string[]
  /** Texture written by the pass (defaults to the hooked texture). */
  save: string
  width: string[]
  height: string[]
  components: number
  body: string
}

export function parseHooks(source: string): HookPass[] {
  const passes: HookPass[] = []
  let current: HookPass | null = null
  const body: string[] = []
  const flush = () => {
    if (current) {
      current.body = body.join('\n')
      passes.push(current)
    }
    body.length = 0
  }
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    const m = /^\/\/!(\w+)\s*(.*)$/.exec(line)
    if (m) {
      const [, key, value] = m
      if (key === 'DESC') {
        flush()
        current = { desc: value ?? '', hook: 'MAIN', binds: [], save: '', width: [], height: [], components: 4, body: '' }
        continue
      }
      if (!current) continue
      switch (key) {
        case 'HOOK':
          current.hook = value!.trim()
          break
        case 'BIND':
          current.binds.push(value!.trim())
          break
        case 'SAVE':
          current.save = value!.trim()
          break
        case 'WIDTH':
          current.width = value!.trim().split(/\s+/)
          break
        case 'HEIGHT':
          current.height = value!.trim().split(/\s+/)
          break
        case 'COMPONENTS':
          current.components = Number(value)
          break
        default:
          break // WHEN and unknown directives are ignored
      }
      continue
    }
    if (current) body.push(rawLine)
  }
  flush()
  for (const p of passes) if (!p.save) p.save = p.hook
  return passes
}

/** Evaluates an RPN size expression given the sizes of the known textures. */
export function evalSize(tokens: string[], sizes: ReadonlyMap<string, { w: number; h: number }>, fallback: number): number {
  if (tokens.length === 0) return fallback
  const stack: number[] = []
  for (const t of tokens) {
    if (t === '*' || t === '/' || t === '+' || t === '-') {
      const b = stack.pop()
      const a = stack.pop()
      if (a === undefined || b === undefined) throw new Error(`Espressione RPN non valida: ${tokens.join(' ')}`)
      stack.push(t === '*' ? a * b : t === '/' ? a / b : t === '+' ? a + b : a - b)
      continue
    }
    const ref = /^(\w+)\.(w|h)$/.exec(t)
    if (ref) {
      const s = sizes.get(ref[1]!)
      if (!s) throw new Error(`Texture sconosciuta nell'espressione: ${ref[1]}`)
      stack.push(ref[2] === 'w' ? s.w : s.h)
      continue
    }
    const n = Number(t)
    if (Number.isNaN(n)) throw new Error(`Token sconosciuto: ${t}`)
    stack.push(n)
  }
  if (stack.length !== 1) throw new Error(`Espressione RPN non valida: ${tokens.join(' ')}`)
  return Math.max(1, Math.round(stack[0]!))
}

/**
 * Wraps a pass body into a complete GLSL ES 3.00 fragment shader, providing the mpv texture
 * API for every bound texture: NAME_raw, NAME_pos, NAME_size, NAME_pt, NAME_tex, NAME_texOff.
 * All textures share the normalised coordinate of the output pixel (they cover the same image).
 */
export function buildFragmentShader(pass: HookPass): string {
  const names = [...new Set([pass.hook, ...pass.binds])]
  const prelude = names
    .map(
      (n) => `uniform sampler2D ${n}_raw;
uniform vec2 ${n}_size;
#define ${n}_pos v_uv
#define ${n}_pt (vec2(1.0) / ${n}_size)
vec4 ${n}_tex(vec2 pos) { return texture(${n}_raw, pos); }
vec4 ${n}_texOff(vec2 off) { return ${n}_tex(${n}_pos + ${n}_pt * off); }`,
    )
    .join('\n')
  const hooked = pass.hook
  const aliases = `#define HOOKED_raw ${hooked}_raw
#define HOOKED_size ${hooked}_size
#define HOOKED_pos ${hooked}_pos
#define HOOKED_pt ${hooked}_pt
#define HOOKED_tex ${hooked}_tex
#define HOOKED_texOff ${hooked}_texOff`
  return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 v_uv;
out vec4 fragColor;
${prelude}
${aliases}
${pass.body}
void main() { fragColor = hook(); }
`
}

export const VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  // Fullscreen triangle; the viewport maps it onto the pass output rectangle.
  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
  v_uv = (p + 1.0) * 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`
