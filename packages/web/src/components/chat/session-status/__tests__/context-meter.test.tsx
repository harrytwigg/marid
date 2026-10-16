import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ContextUsageWire } from '@/lib/api-context-usage'
import { usageFixture } from './fixtures'

const api = vi.hoisted(() => ({
  getContextUsage: vi.fn(),
  compactSession: vi.fn(),
}))
vi.mock('@/lib/api-context-usage', () => ({ contextUsageApi: api }))

import type { ContextMeterProps } from '../context-meter'
import { SessionStatusCluster } from '../session-status-cluster'

beforeAll(() => {
  const g = globalThis as unknown as { ResizeObserver?: unknown }
  g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.scrollIntoView ??= () => {}
  proto.hasPointerCapture ??= () => false
  proto.setPointerCapture ??= () => {}
  proto.releasePointerCapture ??= () => {}
})

const BASE: ContextMeterProps = { sessionId: 'sess-1', loading: false }

function renderMeter(props: Partial<ContextMeterProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (p: Partial<ContextMeterProps>) => (
    <QueryClientProvider client={client}>
      <SessionStatusCluster {...BASE} {...p} />
    </QueryClientProvider>
  )
  const view = render(tree(props))
  return { ...view, update: (p: Partial<ContextMeterProps>) => view.rerender(tree({ ...props, ...p })), client }
}

function serve(data: ContextUsageWire) {
  api.getContextUsage.mockResolvedValue(data)
}

async function openPopover() {
  fireEvent.click(await screen.findByTestId('context-meter'))
  return screen.findByRole('dialog')
}

beforeEach(() => {
  api.getContextUsage.mockReset()
  api.compactSession.mockReset()
})

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

  it('overlays the live token figure on the fetched one', async () => {
    serve(usageFixture({ contextTokens: 10_000 }))
    renderMeter({ liveContextTokens: 160_000 })
    expect((await screen.findByTestId('context-meter-text')).textContent).toContain('80%')
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

  it('treats an unchanged size as not yet known', async () => {
    serve(usageFixture({ contextTokens: 182_000 }))
    api.compactSession.mockResolvedValue({ status: 'queued', sessionId: 'sess-1', engine: 'claude' })
    const { update } = renderMeter()
    await openPopover()
    fireEvent.click(screen.getByRole('button', { name: 'Compact now' }))
    await screen.findByRole('button', { name: /Compacting…/ })
    update({ loading: true })
    update({ loading: false })
    expect((await screen.findByTestId('compact-outcome')).textContent).toContain('the size updates after the next turn')
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
      await act(async () => { await vi.advanceTimersByTimeAsync(21_000) })
      expect((await screen.findByTestId('compact-outcome')).textContent).toContain('Compacted: 182k → 31k')
    } finally {
      vi.useRealTimers()
    }
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

  it('reports a compaction that ended with the session in error as failed, not compacted', async () => {
    serve(usageFixture({ contextTokens: 182_000 }))
    api.compactSession.mockResolvedValue({ status: 'queued', sessionId: 'sess-1', engine: 'claude' })
    const { update } = renderMeter()
    await openPopover()
    fireEvent.click(screen.getByRole('button', { name: 'Compact now' }))
    await screen.findByRole('button', { name: /Compacting…/ })
    update({ loading: true, status: 'running' })
    // A failed compaction still holds the cooldown.
    serve(usageFixture({
      contextTokens: 182_000,
      compact: { available: false, reason: { code: 'cooldown', message: 'Compacted a moment ago.' }, retryAt: '2026-10-15T14:32:00.000Z' },
    }))
    update({ loading: false, status: 'error' })
    const error = await screen.findByTestId('compact-error')
    expect(error.textContent).toContain('did not complete')
    expect(screen.queryByTestId('compact-outcome')).toBeNull()
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
