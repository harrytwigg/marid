import { describe, it, expect } from 'vitest'
import {
  BUSY_MESSAGE,
  compactDisabledReason,
  contextMeterModel,
  localRetryTime,
  shownTokens,
} from '../context-meter-model'
import { usageFixture } from './fixtures'

describe('contextMeterModel', () => {
  it('is hidden until the first answer arrives', () => {
    expect(contextMeterModel(undefined, null)).toEqual({ kind: 'hidden' })
  })

  it('describes a known size with a percentage and the tooltip', () => {
    const m = contextMeterModel(usageFixture(), null)
    expect(m.kind).toBe('known')
    if (m.kind !== 'known') return
    expect(m.percent).toBe('50%')
    expect(m.tooltip).toBe('100k / 200k tokens · Opus 5.5')
    expect(m.usage.color).toBeUndefined()
  })

  it('falls back to the model id, then the engine, when there is no label', () => {
    const noLabel = contextMeterModel(usageFixture({ modelLabel: null }), null)
    expect(noLabel.kind === 'known' && noLabel.tooltip).toBe('100k / 200k tokens · opus')
    const bare = contextMeterModel(usageFixture({ modelLabel: null, model: null }), null)
    expect(bare.kind === 'known' && bare.tooltip).toBe('100k / 200k tokens · claude')
  })

  it.each([
    [149_999, undefined],
    [150_000, 'var(--system-orange)'],
    [179_999, 'var(--system-orange)'],
    [180_000, 'var(--system-red)'],
  ])('colours %i of 200k tokens %s', (tokens, color) => {
    const m = contextMeterModel(usageFixture({ contextTokens: tokens }), null)
    expect(m.kind === 'known' && m.usage.color).toBe(color)
  })

  it('goes amber at 90% of an enabled budget, not of a disabled one', () => {
    const budget = { enabled: true, budgetTokens: 100_000 }
    const on = contextMeterModel(usageFixture({ contextTokens: 90_000, autoCompact: budget }), null)
    expect(on.kind === 'known' && on.usage.color).toBe('var(--system-orange)')
    const off = contextMeterModel(
      usageFixture({ contextTokens: 90_000, autoCompact: { ...budget, enabled: false } }),
      null,
    )
    expect(off.kind === 'known' && off.usage.color).toBeUndefined()
  })

  it('draws the n/a ring when the window is unknown', () => {
    const m = contextMeterModel(usageFixture({ contextWindow: null }), null)
    expect(m).toEqual({ kind: 'unknown', tooltip: '100k tokens · Opus 5.5' })
  })

  it('draws the n/a ring when the tokens are unknown', () => {
    const m = contextMeterModel(usageFixture({ contextTokens: null }), null)
    expect(m).toEqual({ kind: 'unknown', tooltip: 'Context size unknown · Opus 5.5' })
  })

  it('hides when the size is unknown and the engine cannot compact', () => {
    const unsupported = { available: false, reason: { code: 'unsupported' as const, message: 'no' } }
    expect(contextMeterModel(usageFixture({ contextTokens: null, compact: unsupported }), null)).toEqual({ kind: 'hidden' })
  })

  it('keeps an unsupported engine visible while its size is known', () => {
    const unsupported = { available: false, reason: { code: 'unsupported' as const, message: 'no' } }
    expect(contextMeterModel(usageFixture({ compact: unsupported }), null).kind).toBe('known')
  })

  it('overlays the live figure on the fetched one', () => {
    const m = contextMeterModel(usageFixture({ contextTokens: 10_000 }), 160_000)
    expect(m.kind === 'known' && m.usage.color).toBe('var(--system-orange)')
    expect(shownTokens(usageFixture({ contextTokens: 10_000 }), 160_000)).toBe(160_000)
    expect(shownTokens(usageFixture({ contextTokens: 10_000 }), null)).toBe(10_000)
    expect(shownTokens(usageFixture({ contextTokens: null }), null)).toBeNull()
  })

  it('lets a live figure stand in for an unknown fetched one', () => {
    expect(contextMeterModel(usageFixture({ contextTokens: null }), 50_000).kind).toBe('known')
  })
})

describe('compactDisabledReason', () => {
  it('is null when compaction is available', () => {
    expect(compactDisabledReason(usageFixture(), false)).toBeNull()
  })

  it('says busy while the pane runs a turn, even when the gateway says available', () => {
    expect(compactDisabledReason(usageFixture(), true)).toBe(BUSY_MESSAGE)
    expect(BUSY_MESSAGE).toMatch(/busy/)
  })

  it('carries the gateway message when unavailable', () => {
    const data = usageFixture({
      compact: { available: false, reason: { code: 'unsupported', message: 'This engine has no native compaction.' } },
    })
    expect(compactDisabledReason(data, false)).toBe('This engine has no native compaction.')
  })

  it('adds the local retry time for a cooldown', () => {
    const retryAt = '2026-10-15T14:32:00.000Z'
    const data = usageFixture({
      compact: { available: false, reason: { code: 'cooldown', message: 'Compacted recently.' }, retryAt },
    })
    const clock = localRetryTime(retryAt)!
    expect(clock).toMatch(/\d/)
    expect(compactDisabledReason(data, false)).toBe(`Compacted recently. Available again at ${clock}.`)
  })

  it('keeps the plain message when a cooldown has no usable retry time', () => {
    const data = usageFixture({
      compact: { available: false, reason: { code: 'cooldown', message: 'Compacted recently.' }, retryAt: 'garbage' },
    })
    expect(compactDisabledReason(data, false)).toBe('Compacted recently.')
  })
})
