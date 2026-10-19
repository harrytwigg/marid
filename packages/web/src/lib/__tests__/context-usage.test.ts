import { describe, it, expect } from 'vitest'
import { fmtK, formatContextUsage } from '../context-usage'

describe('fmtK', () => {
  it('rounds thousands to a compact k string', () => {
    expect(fmtK(23148)).toBe('23k')
    expect(fmtK(258400)).toBe('258k')
    expect(fmtK(200000)).toBe('200k')
  })
  it('leaves sub-1000 counts as plain numbers', () => {
    expect(fmtK(980)).toBe('980')
    expect(fmtK(0)).toBe('0')
  })
  it('writes a million-token window as M', () => {
    expect(fmtK(1_000_000)).toBe('1M')
    expect(fmtK(1_048_576)).toBe('1M')
    expect(fmtK(1_500_000)).toBe('1.5M')
    expect(fmtK(999_400)).toBe('999k')
    expect(fmtK(999_499)).toBe('999k')
    expect(fmtK(999_500)).toBe('1M')
    expect(fmtK(999_999)).toBe('1M')
  })
})

describe('formatContextUsage', () => {
  it('returns null when the context window is unknown', () => {
    expect(formatContextUsage(50000, undefined)).toBeNull()
    expect(formatContextUsage(50000, 0)).toBeNull()
  })

  it('formats tokens / window with a spaced compact label', () => {
    const u = formatContextUsage(50000, 258400)!
    expect(u.label).toBe('50k / 258k')
    expect(u.over).toBe(false)
    expect(u.color).toBeUndefined()
    expect(u.pct).toBeCloseTo(50000 / 258400, 5)
  })

  it('treats a fresh chat (null / 0 tokens) as empty, not an error', () => {
    const a = formatContextUsage(null, 200000)!
    expect(a.tokens).toBe(0)
    expect(a.pct).toBe(0)
    expect(a.over).toBe(false)
    const b = formatContextUsage(0, 200000)!
    expect(b.tokens).toBe(0)
    expect(b.pct).toBe(0)
  })

  it('flags the orange threshold at >=75% full', () => {
    const u = formatContextUsage(200000, 258400)! // ~77%
    expect(u.color).toBe('var(--system-orange)')
  })

  it('flags the red threshold at >=90% full', () => {
    const u = formatContextUsage(240000, 258400)! // ~93%
    expect(u.color).toBe('var(--system-red)')
  })

  it('caps an over-window context and marks it over', () => {
    const u = formatContextUsage(494290, 258400)!
    expect(u.over).toBe(true)
    expect(u.pct).toBe(1)
    expect(u.label).toBe('>258k / 258k')
    expect(u.color).toBe('var(--system-red)')
  })

  it('warns amber at 90% of an enabled auto-compact budget while the window has room', () => {
    expect(formatContextUsage(135_000, 1_000_000, 150_000)!.color).toBe('var(--system-orange)')
    expect(formatContextUsage(134_000, 1_000_000, 150_000)!.color).toBeUndefined()
  })

  it('ignores a missing or zero budget', () => {
    expect(formatContextUsage(135_000, 1_000_000, null)!.color).toBeUndefined()
    expect(formatContextUsage(135_000, 1_000_000, 0)!.color).toBeUndefined()
  })

  it('stays red past 90% of the window even with a budget', () => {
    expect(formatContextUsage(950_000, 1_000_000, 150_000)!.color).toBe('var(--system-red)')
  })
})
