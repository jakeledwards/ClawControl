import { describe, it, expect } from 'vitest'
import { resolveModel } from './utils'

describe('resolveModel', () => {
  it('passes strings through', () => {
    expect(resolveModel('openai/gpt-5')).toBe('openai/gpt-5')
  })
  it('uses primary from {primary, fallbacks} (#23)', () => {
    expect(resolveModel({ primary: 'openai-codex/gpt-5.4', fallbacks: ['x'] })).toBe('openai-codex/gpt-5.4')
  })
  it('returns undefined for empty or malformed values', () => {
    expect(resolveModel('')).toBeUndefined()
    expect(resolveModel(null)).toBeUndefined()
    expect(resolveModel({ fallbacks: ['x'] })).toBeUndefined()
    expect(resolveModel({ primary: { nested: true } })).toBeUndefined()
  })
})
