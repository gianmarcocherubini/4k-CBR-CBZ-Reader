import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildFragmentShader, evalSize, parseHooks } from './glslHooks'

const load = (name: string) => readFileSync(new URL(`./shaders/anime4k/${name}`, import.meta.url), 'utf8')

describe('parseHooks', () => {
  it('parses the official Anime4K M shader into passes with bindings and sizes', () => {
    const passes = parseHooks(load('Anime4K_Upscale_CNN_x2_M.glsl'))
    expect(passes.length).toBe(9)
    expect(passes[0]).toMatchObject({ hook: 'MAIN', binds: ['MAIN'], save: 'conv2d_tf', width: ['MAIN.w'], height: ['MAIN.h'], components: 4 })
    expect(passes[7]!.binds).toEqual(['conv2d_tf', 'conv2d_1_tf', 'conv2d_2_tf', 'conv2d_3_tf', 'conv2d_4_tf', 'conv2d_5_tf', 'conv2d_6_tf'])
    const last = passes[8]!
    expect(last.save).toBe('MAIN')
    expect(last.width).toEqual(['conv2d_last_tf.w', '2', '*'])
    expect(last.body).toContain('vec4 hook()')
    expect(last.body).toContain('MAIN_tex(MAIN_pos)')
  })
  it('parses VL and UL as well', () => {
    expect(parseHooks(load('Anime4K_Upscale_CNN_x2_VL.glsl')).length).toBeGreaterThan(9)
    expect(parseHooks(load('Anime4K_Upscale_CNN_x2_UL.glsl')).length).toBeGreaterThan(20)
    for (const p of parseHooks(load('Anime4K_Upscale_CNN_x2_UL.glsl'))) expect(p.body).toContain('vec4 hook()')
  })
})

describe('evalSize', () => {
  const sizes = new Map([
    ['MAIN', { w: 800, h: 288 }],
    ['conv2d_last_tf', { w: 800, h: 288 }],
  ])
  it('evaluates RPN expressions', () => {
    expect(evalSize(['MAIN.w'], sizes, 1)).toBe(800)
    expect(evalSize(['conv2d_last_tf.h', '2', '*'], sizes, 1)).toBe(576)
    expect(evalSize(['MAIN.w', '3', '/'], sizes, 1)).toBe(267)
    expect(evalSize([], sizes, 42)).toBe(42)
  })
  it('rejects unknown textures and malformed expressions', () => {
    expect(() => evalSize(['nope.w'], sizes, 1)).toThrow()
    expect(() => evalSize(['MAIN.w', '*'], sizes, 1)).toThrow()
  })
})

describe('buildFragmentShader', () => {
  it('provides the mpv texture API for every bound texture', () => {
    const pass = parseHooks(load('Anime4K_Upscale_CNN_x2_M.glsl'))[8]!
    const src = buildFragmentShader(pass)
    expect(src.startsWith('#version 300 es')).toBe(true)
    for (const n of ['MAIN', 'conv2d_last_tf']) {
      expect(src).toContain(`uniform sampler2D ${n}_raw;`)
      expect(src).toContain(`vec4 ${n}_texOff(vec2 off)`)
    }
    expect(src).toContain('void main() { fragColor = hook(); }')
  })
})
