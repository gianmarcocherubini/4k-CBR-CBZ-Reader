import { describe, expect, it } from 'vitest'
import { adapterName } from './backend'

describe('adapterName', () => {
  it('joins vendor, architecture and description, each word once', () => {
    expect(adapterName({ vendor: 'apple', architecture: 'apple', description: 'apple' })).toBe('apple')
    expect(adapterName({ vendor: 'apple', architecture: 'metal-3', description: 'Apple M2' })).toBe('apple metal-3 M2')
    expect(adapterName({ vendor: 'google', architecture: 'swiftshader', description: '' })).toBe('google swiftshader')
    expect(adapterName({ vendor: 'nvidia', architecture: 'ampere', description: 'NVIDIA GeForce RTX 3080' })).toBe('nvidia ampere GeForce RTX 3080')
  })

  it('falls back when nothing is reported', () => {
    expect(adapterName(undefined)).toBe('WebGPU')
    expect(adapterName({ vendor: '', architecture: '', description: '' })).toBe('WebGPU')
    expect(adapterName({ vendor: '', architecture: '', description: '' }, 'GPU')).toBe('GPU')
  })
})
