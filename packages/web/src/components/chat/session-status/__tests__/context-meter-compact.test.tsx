import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent, waitFor, act } from '@testing-library/react'
import { usageFixture } from './fixtures'
import { api, openPopover, renderMeter, serve, useMeterTestEnvironment } from './meter-harness'
import { UNCONFIRMED_MESSAGE } from '../use-compact-flow'

vi.mock('@/lib/api-context-usage', () => ({
  contextUsageApi: { getContextUsage: vi.fn(), compactSession: vi.fn() },
}))

useMeterTestEnvironment()

describe('ContextMeter compact flow', () => {
  it('posts, shows progress until the session is idle again, then the confirmation', async () => {
    serve(usageFixture({ contextTokens: 182_000, contextWindow: 1_000_000 }))
    api.compactSession.mockResolvedValue({ status: 'queued', sessionId: 'sess-1', engine: 'claude' })
    const { update } = renderMeter()
    await openPopover()
    fireEvent.click(screen.getByRole('button', { name: 'Compact now' }))

    expect(((await screen.findByRole('button', { name: /Compacting…/ })) as HTMLButtonElement).disabled).toBe(true)
    expect(api.compactSession).toHaveBeenCalledWith('sess-1')
    expect((screen.getByTestId('context-meter')).getAttribute('data-compacting')).toBe('true')

    // The compaction turn starts, then ends with a new, smaller size.
    update({ loading: true, status: 'running' })
    serve(usageFixture({ contextTokens: 31_000, contextWindow: 1_000_000 }))
    expect(((screen.getByRole('button', { name: /Compacting…/ })) as HTMLButtonElement).disabled).toBe(true)
    update({ loading: false, status: 'idle', lastContextTokens: 31_000 })

    expect((await screen.findByTestId('compact-outcome')).textContent).toContain('Compacted: 182k → 31k')
    expect(((screen.getByRole('button', { name: 'Compact now' })) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText(/Compacting…/)).toBeNull()
  })

  it('says the size updates after the next turn when no new figure exists', async () => {
    serve(usageFixture({ contextTokens: 182_000 }))
    api.compactSession.mockResolvedValue({ status: 'queued', sessionId: 'sess-1', engine: 'claude' })
    const { update } = renderMeter()
    await openPopover()
    fireEvent.click(screen.getByRole('button', { name: 'Compact now' }))
    await screen.findByRole('button', { name: /Compacting…/ })

    update({ loading: true, status: 'running' })
    serve(usageFixture({ contextTokens: null }))
    update({ loading: false, status: 'idle' })

    expect((await screen.findByTestId('compact-outcome')).textContent).toContain(
      'Compacted; the size updates after the next turn',
    )
  })

  it('does not claim a compaction when the size did not change', async () => {
    serve(usageFixture({ contextTokens: 182_000 }))
    api.compactSession.mockResolvedValue({ status: 'queued', sessionId: 'sess-1', engine: 'claude' })
    const { update } = renderMeter()
    await openPopover()
    fireEvent.click(screen.getByRole('button', { name: 'Compact now' }))
    await screen.findByRole('button', { name: /Compacting…/ })
    update({ loading: true })
    update({ loading: false })
    const outcome = await screen.findByTestId('compact-outcome')
    expect(outcome.textContent).toBe(UNCONFIRMED_MESSAGE)
    expect(outcome.textContent).not.toContain('Compacted')
    expect(screen.queryByTestId('compact-error')).toBeNull()
  })

  it('does not claim a compaction when the size grew', async () => {
    serve(usageFixture({ contextTokens: 100_000 }))
    api.compactSession.mockResolvedValue({ status: 'queued', sessionId: 'sess-1', engine: 'claude' })
    const { update } = renderMeter()
    await openPopover()
    fireEvent.click(screen.getByRole('button', { name: 'Compact now' }))
    await screen.findByRole('button', { name: /Compacting…/ })
    update({ loading: true })
    serve(usageFixture({ contextTokens: 120_000 }))
    update({ loading: false })
    expect((await screen.findByTestId('compact-outcome')).textContent).toBe(UNCONFIRMED_MESSAGE)
  })

  it('drops the ring to n/a after a compaction with no new size, even with a stale live figure', async () => {
    serve(usageFixture({ contextTokens: 182_000 }))
    api.compactSession.mockResolvedValue({ status: 'queued', sessionId: 'sess-1', engine: 'claude' })
    // The pane still holds the last streamed figure from the turn before the compaction.
    const { update } = renderMeter({ liveContextTokens: 182_000 })
    await openPopover()
    fireEvent.click(screen.getByRole('button', { name: 'Compact now' }))
    await screen.findByRole('button', { name: /Compacting…/ })
    update({ loading: true })
    serve(usageFixture({ contextTokens: null }))
    update({ loading: false })
    expect((await screen.findByTestId('compact-outcome')).textContent).toBe('Compacted; the size updates after the next turn')
    expect(screen.getByTestId('context-meter-text').textContent).toBe('n/a')
    expect(screen.getByTestId('context-meter-ring').getAttribute('data-unknown')).toBe('true')
  })

  it('shows the new size on the ring after a compaction, with a stale live figure present', async () => {
    serve(usageFixture({ contextTokens: 182_000 }))
    api.compactSession.mockResolvedValue({ status: 'queued', sessionId: 'sess-1', engine: 'claude' })
    const { update } = renderMeter({ liveContextTokens: 182_000 })
    await openPopover()
    fireEvent.click(screen.getByRole('button', { name: 'Compact now' }))
    await screen.findByRole('button', { name: /Compacting…/ })
    update({ loading: true })
    serve(usageFixture({ contextTokens: 31_000 }))
    update({ loading: false })
    expect((await screen.findByTestId('compact-outcome')).textContent).toBe('Compacted: 182k → 31k')
    expect(screen.getByTestId('context-meter-text').textContent).toBe('16%')
  })

  it('settles from polling when no running turn is ever seen', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      serve(usageFixture({ contextTokens: 182_000 }))
      api.compactSession.mockResolvedValue({ status: 'queued', sessionId: 'sess-1', engine: 'claude' })
      renderMeter()
      await openPopover()
      fireEvent.click(screen.getByRole('button', { name: 'Compact now' }))
      await screen.findByRole('button', { name: /Compacting…/ })
      serve(usageFixture({ contextTokens: 31_000 }))
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(screen.queryByTestId('compact-outcome')).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
      expect((await screen.findByTestId('compact-outcome')).textContent).toContain('Compacted: 182k → 31k')
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts a running status as having seen the session busy', async () => {
    serve(usageFixture({ contextTokens: 182_000 }))
    api.compactSession.mockResolvedValue({ status: 'queued', sessionId: 'sess-1', engine: 'claude' })
    const { update } = renderMeter({ status: 'idle' })
    await openPopover()
    fireEvent.click(screen.getByRole('button', { name: 'Compact now' }))
    await screen.findByRole('button', { name: /Compacting…/ })
    update({ status: 'running' })
    serve(usageFixture({ contextTokens: 31_000 }))
    update({ status: 'idle' })
    expect((await screen.findByTestId('compact-outcome')).textContent).toBe('Compacted: 182k → 31k')
  })

  it('keeps waiting while the gateway reports the compaction as queued, and when that clears before the turn starts', async () => {
    serve(usageFixture({ contextTokens: 182_000 }))
    api.compactSession.mockResolvedValue({ status: 'queued', sessionId: 'sess-1', engine: 'claude' })
    const { update } = renderMeter()
    await openPopover()
    fireEvent.click(screen.getByRole('button', { name: 'Compact now' }))
    await screen.findByRole('button', { name: /Compacting…/ })

    // Queued: the gateway's own pending /compact, which is not a finished compaction.
    serve(usageFixture({
      contextTokens: 182_000,
      compact: { available: false, reason: { code: 'queued', message: 'A message is already queued.' } },
    }))
    update({ status: 'idle', lastContextTokens: 1 })
    await waitFor(() => expect(api.getContextUsage.mock.calls.length).toBeGreaterThan(1))
    // The queued reason clears a beat before the session reports running.
    serve(usageFixture({ contextTokens: 182_000 }))
    update({ status: 'idle', lastContextTokens: 2 })
    await waitFor(() => expect(api.getContextUsage.mock.calls.length).toBeGreaterThan(2))
    expect(screen.queryByTestId('compact-outcome')).toBeNull()
    expect(screen.getByRole('button', { name: /Compacting…/ }).hasAttribute('disabled')).toBe(true)

    update({ loading: true, status: 'running' })
    serve(usageFixture({ contextTokens: 31_000 }))
    update({ loading: false, status: 'idle', lastContextTokens: 31_000 })
    expect((await screen.findByTestId('compact-outcome')).textContent).toContain('Compacted: 182k → 31k')
  })

  it('stays neutral about a compaction that ended with the session in error and the cooldown held', async () => {
    serve(usageFixture({ contextTokens: 182_000 }))
    api.compactSession.mockResolvedValue({ status: 'queued', sessionId: 'sess-1', engine: 'claude' })
    const { update } = renderMeter()
    await openPopover()
    fireEvent.click(screen.getByRole('button', { name: 'Compact now' }))
    await screen.findByRole('button', { name: /Compacting…/ })
    update({ loading: true, status: 'running' })
    serve(usageFixture({
      contextTokens: 182_000,
      compact: { available: false, reason: { code: 'cooldown', message: 'Compacted a moment ago.' }, retryAt: '2026-10-15T14:32:00.000Z' },
    }))
    update({ loading: false, status: 'error' })
    expect((await screen.findByTestId('compact-outcome')).textContent).toBe(UNCONFIRMED_MESSAGE)
    expect(screen.queryByTestId('compact-error')).toBeNull()
  })

  it('shows the server message when the POST is refused', async () => {
    serve(usageFixture())
    api.compactSession.mockRejectedValue(new Error('The session is busy; compact when the turn has finished.'))
    renderMeter()
    await openPopover()
    fireEvent.click(screen.getByRole('button', { name: 'Compact now' }))
    expect((await screen.findByTestId('compact-error')).textContent).toContain('The session is busy; compact when the turn has finished.')
    expect(screen.queryByText(/Compacting…/)).toBeNull()
    expect(((screen.getByRole('button', { name: 'Compact now' })) as HTMLButtonElement).disabled).toBe(false)
  })

  it('clears the outcome once the popover is closed', async () => {
    serve(usageFixture({ contextTokens: 182_000 }))
    api.compactSession.mockResolvedValue({ status: 'queued', sessionId: 'sess-1', engine: 'claude' })
    const { update } = renderMeter()
    await openPopover()
    fireEvent.click(screen.getByRole('button', { name: 'Compact now' }))
    await screen.findByRole('button', { name: /Compacting…/ })
    update({ loading: true })
    serve(usageFixture({ contextTokens: 31_000 }))
    update({ loading: false })
    await screen.findByTestId('compact-outcome')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await openPopover()
    expect(screen.queryByTestId('compact-outcome')).toBeNull()
  })
})
