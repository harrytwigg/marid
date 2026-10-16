import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor, act } from '@testing-library/react'
import type { ContextUsageWire } from '@/lib/api-context-usage'
import { usageFixture } from './fixtures'
import { api, openPopover, renderMeter, serve, useMeterTestEnvironment } from './meter-harness'

vi.mock('@/lib/api-context-usage', () => ({
  contextUsageApi: { getContextUsage: vi.fn(), compactSession: vi.fn() },
}))

useMeterTestEnvironment()

describe('ContextMeter ring', () => {
  it('shows the ring, the percentage and the tooltip for a known size', async () => {
    serve(usageFixture())
    renderMeter()
    const button = await screen.findByTestId('context-meter')
    expect((button).getAttribute('title')).toBe('100k / 200k tokens · Opus 5.5')
    expect((button).getAttribute('aria-label')).toBe('Context usage: 100k / 200k tokens · Opus 5.5')
    expect((screen.getByTestId('context-meter-text')).textContent).toContain('50%')
    expect((screen.getByTestId('context-meter-ring')).hasAttribute('data-unknown')).toBe(false)
    expect((screen.getByTestId('context-meter-arc')).getAttribute('stroke')).toBe('var(--text-tertiary)')
  })

  it('keeps the ring and drops only the percentage on a narrow composer', async () => {
    serve(usageFixture())
    renderMeter()
    await screen.findByTestId('context-meter')
    expect(screen.getByTestId('context-meter-text').className).toContain('@max-[380px]/composer:hidden')
    expect(screen.getByTestId('context-meter-ring').getAttribute('class')).not.toContain('hidden')
  })

  it.each([
    [150_000, 'var(--system-orange)'],
    [185_000, 'var(--system-red)'],
  ])('colours the arc at %i tokens', async (tokens, color) => {
    serve(usageFixture({ contextTokens: tokens }))
    renderMeter()
    await screen.findByTestId('context-meter')
    expect(screen.getByTestId('context-meter-arc').getAttribute('stroke')).toBe(color)
    expect(screen.getByTestId('context-meter-text').getAttribute('style')).toContain(color)
  })

  it('draws the dashed n/a ring for an unknown window', async () => {
    serve(usageFixture({ contextWindow: null }))
    renderMeter()
    await screen.findByTestId('context-meter')
    expect((screen.getByTestId('context-meter-ring')).getAttribute('data-unknown')).toBe('true')
    expect(screen.queryByTestId('context-meter-arc')).toBeNull()
    expect((screen.getByTestId('context-meter-text')).textContent).toContain('n/a')
  })

  it('draws the n/a ring for unknown tokens', async () => {
    serve(usageFixture({ contextTokens: null }))
    renderMeter()
    await screen.findByTestId('context-meter')
    expect((screen.getByTestId('context-meter-text')).textContent).toContain('n/a')
  })

  it('renders nothing when the size is unknown and the engine cannot compact', async () => {
    serve(usageFixture({
      contextTokens: null,
      compact: { available: false, reason: { code: 'unsupported', message: 'No native compaction.' } },
    }))
    renderMeter()
    await waitFor(() => expect(api.getContextUsage).toHaveBeenCalled())
    expect(screen.queryByTestId('context-meter')).toBeNull()
    expect((screen.getByTestId('session-status-cluster')).childElementCount).toBe(0)
  })

  it('renders nothing while the first answer is pending or when it fails', async () => {
    api.getContextUsage.mockRejectedValue(new Error('unknown session'))
    renderMeter()
    expect(screen.queryByTestId('context-meter')).toBeNull()
    await waitFor(() => expect(api.getContextUsage).toHaveBeenCalled())
    expect(screen.queryByTestId('context-meter')).toBeNull()
  })

  it('overlays the live token figure on the fetched one while a turn runs', async () => {
    serve(usageFixture({ contextTokens: 10_000 }))
    renderMeter({ loading: true, liveContextTokens: 160_000 })
    expect((await screen.findByTestId('context-meter-text')).textContent).toContain('80%')
  })

  it('shows the fetched figure, not a stale live one, once the turn has settled', async () => {
    serve(usageFixture({ contextTokens: 10_000 }))
    renderMeter({ loading: false, liveContextTokens: 160_000 })
    expect((await screen.findByTestId('context-meter-text')).textContent).toContain('5%')
  })

  it('keeps the streamed figure when a turn ends until the post-turn refetch lands', async () => {
    serve(usageFixture({ contextTokens: 10_000 }))
    const { update } = renderMeter({ loading: true, status: 'running', liveContextTokens: 160_000 })
    expect((await screen.findByTestId('context-meter-text')).textContent).toContain('80%')
    let land: (data: ContextUsageWire) => void = () => {}
    api.getContextUsage.mockImplementation(() => new Promise<ContextUsageWire>((resolve) => { land = resolve }))
    // The pane clears its streamed figure in the same render that ends the turn.
    update({ loading: false, status: 'idle', lastContextTokens: 162_000, liveContextTokens: null })
    // The fetched answer is still the pre-turn 10k: the ring must not fall back to 5% in between.
    expect(screen.getByTestId('context-meter-text').textContent).toContain('80%')
    await waitFor(() => expect(api.getContextUsage).toHaveBeenCalled())
    await act(async () => { land(usageFixture({ contextTokens: 162_000 })) })
    await waitFor(() => expect(screen.getByTestId('context-meter-text').textContent).toContain('81%'))
  })

  it('refetches when the session status or last size changes', async () => {
    serve(usageFixture())
    const { update } = renderMeter({ status: 'running', lastContextTokens: 1 })
    await screen.findByTestId('context-meter')
    const calls = api.getContextUsage.mock.calls.length
    update({ status: 'idle', lastContextTokens: 1 })
    await waitFor(() => expect(api.getContextUsage.mock.calls.length).toBe(calls + 1))
    update({ status: 'idle', lastContextTokens: 2 })
    await waitFor(() => expect(api.getContextUsage.mock.calls.length).toBe(calls + 2))
  })
})

describe('ContextMeter popover', () => {
  it('shows the figures, the model and the auto-compact budget', async () => {
    serve(usageFixture({ autoCompact: { enabled: true, budgetTokens: 150_000 } }))
    renderMeter()
    const dialog = await openPopover()
    expect((dialog).textContent).toContain('100k / 200k')
    expect((dialog).textContent).toContain('Opus 5.5')
    expect((dialog).textContent).toContain('Auto-compact')
    expect((dialog).textContent).toContain('at 150k')
    expect(((screen.getByRole('button', { name: 'Compact now' })) as HTMLButtonElement).disabled).toBe(false)
  })

  it('leaves the auto-compact row out when it is off', async () => {
    serve(usageFixture())
    renderMeter()
    expect((await openPopover()).textContent).not.toContain('Auto-compact')
  })

  it('disables Compact now with the gateway reason', async () => {
    serve(usageFixture({
      compact: { available: false, reason: { code: 'no-conversation', message: 'There is nothing to compact yet.' } },
    }))
    renderMeter()
    await openPopover()
    expect(((screen.getByRole('button', { name: 'Compact now' })) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('compact-reason')).textContent).toContain('There is nothing to compact yet.')
  })

  it('says busy and disables the button while the pane runs a turn', async () => {
    serve(usageFixture())
    renderMeter({ loading: true })
    await openPopover()
    expect(((screen.getByRole('button', { name: 'Compact now' })) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('compact-reason')).textContent).toMatch(/busy/)
  })

  it('shows the local retry time for a cooldown', async () => {
    serve(usageFixture({
      compact: {
        available: false,
        reason: { code: 'cooldown', message: 'Compacted a few minutes ago.' },
        retryAt: '2026-10-15T14:32:00.000Z',
      },
    }))
    renderMeter()
    await openPopover()
    expect(((screen.getByRole('button', { name: 'Compact now' })) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('compact-reason').textContent).toMatch(/Compacted a few minutes ago\. Available again at .*\d.*\./)
  })
})
