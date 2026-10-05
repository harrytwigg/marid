import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { BackgroundActivityStatus } from '../background-activity-status'
import { isBackgroundActivityVisible } from '../pending-work'
import type { BackgroundActivity } from '@/lib/api'

const NOW = 1_780_000_000_000

/** Fresh-by-default fixture. The component reads real `Date.now()`, so render
 *  tests anchor to it; the pure-function tests pass `NOW` explicitly. */
function activity(overrides: Partial<BackgroundActivity> = {}): BackgroundActivity {
  return {
    activeStreams: 2,
    lastActivityAt: new Date(Date.now() - 1000).toISOString(),
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('isBackgroundActivityVisible', () => {
  it('is visible with fresh active streams', () => {
    expect(isBackgroundActivityVisible(activity(), NOW)).toBe(true)
  })

  it('is hidden when there is no activity at all', () => {
    expect(isBackgroundActivityVisible(null, NOW)).toBe(false)
  })

  it('is hidden with zero active streams', () => {
    expect(isBackgroundActivityVisible(activity({ activeStreams: 0 }), NOW)).toBe(false)
  })

  it('is visible for sub-agents or a re-run with zero active streams, stale or not', () => {
    const stale = new Date(NOW - 6 * 60 * 1000).toISOString()
    expect(isBackgroundActivityVisible(activity({ activeStreams: 0, backgroundAgents: 1, lastActivityAt: stale }), NOW)).toBe(true)
    expect(isBackgroundActivityVisible(activity({ activeStreams: 0, backgroundRerun: true, lastActivityAt: stale }), NOW)).toBe(true)
  })

  it('is visible for a monitor with zero active streams', () => {
    expect(isBackgroundActivityVisible(activity({
      activeStreams: 0,
      activeAgents: 0,
      activeMonitors: 1,
    }), NOW)).toBe(true)
  })

  it('goes stale 5 minutes after the last background call', () => {
    const fresh = activity({ lastActivityAt: new Date(NOW - 4 * 60 * 1000).toISOString() })
    const stale = activity({ lastActivityAt: new Date(NOW - 6 * 60 * 1000).toISOString() })
    expect(isBackgroundActivityVisible(fresh, NOW)).toBe(true)
    expect(isBackgroundActivityVisible(stale, NOW)).toBe(false)
  })
})

describe('BackgroundActivityStatus', () => {
  it('falls back to the active-stream count when new fields are absent', () => {
    render(<BackgroundActivityStatus activity={activity({ activeStreams: 2 })} />)
    const status = screen.getByRole('status')
    const [long, short] = Array.from(status.querySelectorAll('span')).slice(-2)
    expect(long.textContent).toBe('2 agents in background')
    // Compact <sm form: count + noun (the dot carries "working in background").
    expect(short.textContent).toBe('2 agents')
  })

  it('renders the classified agent count instead of the raw stream count', () => {
    render(<BackgroundActivityStatus activity={activity({
      activeStreams: 9,
      activeAgents: 4,
      activeMonitors: 0,
    })} />)
    const status = screen.getByRole('status')
    const [long, short] = Array.from(status.querySelectorAll('span')).slice(-2)
    expect(long.textContent).toBe('4 agents in background')
    expect(short.textContent).toBe('4 agents')
  })

  it('uses generic copy for aux-only activity instead of rendering zero agents', () => {
    render(<BackgroundActivityStatus activity={activity({
      activeStreams: 1,
      activeAgents: 0,
      activeMonitors: 0,
    })} />)
    expect(screen.getByRole('status').textContent).toContain('Background work in progress')
    expect(screen.getByRole('status').textContent).not.toContain('0 agents')
  })

  it('renders a monitor when no upstream request is active', () => {
    render(<BackgroundActivityStatus activity={activity({
      activeStreams: 0,
      activeAgents: 0,
      activeMonitors: 1,
    })} />)
    const status = screen.getByRole('status')
    const [long, short] = Array.from(status.querySelectorAll('span')).slice(-2)
    expect(long.textContent).toBe('1 monitor in background')
    expect(short.textContent).toBe('1 monitor')
  })

  it('combines sub-agents and monitors on one status line', () => {
    render(<BackgroundActivityStatus activity={activity({
      activeStreams: 9,
      activeAgents: 4,
      activeMonitors: 1,
      backgroundAgents: 2,
    })} />)
    const status = screen.getByRole('status')
    const [long, short] = Array.from(status.querySelectorAll('span')).slice(-2)
    // Counted as the answer caption counts them: launched sub-agents, not requests in flight.
    expect(long.textContent).toBe('2 sub-agents and 1 monitor in background')
    expect(short.textContent).toBe('2 sub-agents · 1 monitor')
  })

  it('shows sub-agents between their requests', () => {
    render(<BackgroundActivityStatus activity={activity({
      activeStreams: 0,
      activeAgents: 0,
      backgroundAgents: 2,
      lastActivityAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
    })} />)
    const status = screen.getByRole('status')
    const [long, short] = Array.from(status.querySelectorAll('span')).slice(-2)
    expect(long.textContent).toBe('2 sub-agents in background')
    expect(short.textContent).toBe('2 sub-agents')
  })

  it('lists sub-agents, monitors and a re-run together', () => {
    render(<BackgroundActivityStatus activity={activity({ activeMonitors: 1, backgroundAgents: 2, backgroundRerun: true })} />)
    const status = screen.getByRole('status')
    const [long, short] = Array.from(status.querySelectorAll('span')).slice(-2)
    expect(long.textContent).toBe('2 sub-agents, 1 monitor and a re-run in background')
    expect(short.textContent).toBe('2 sub-agents · 1 monitor · re-run')
  })

  it('names a background re-run', () => {
    render(<BackgroundActivityStatus activity={activity({ activeStreams: 1, backgroundRerun: true })} />)
    expect(screen.getByRole('status').textContent).toContain('Background re-run in progress')
  })

  it('uses the singular label for one agent', () => {
    render(<BackgroundActivityStatus activity={activity({ activeStreams: 1 })} />)
    const status = screen.getByRole('status')
    const [long, short] = Array.from(status.querySelectorAll('span')).slice(-2)
    expect(long.textContent).toBe('1 agent in background')
    expect(short.textContent).toBe('1 agent')
  })

  it('names the one delegated employee still working', () => {
    render(
      <BackgroundActivityStatus
        activity={null}
        delegatedActivity={{ activeSessions: 1, employees: ['platform-lead'] }}
        employeeDisplayNames={{ 'platform-lead': 'Platform Lead' }}
      />,
    )
    const status = screen.getByRole('status')
    const labels = Array.from(status.children).slice(-2)
    expect(labels[0]?.textContent).toBe('Platform Lead working')
    expect(labels[1]?.textContent).toBe('Working · Platform Lead')
    expect(status.getAttribute('title')).toBe('1 delegated task still running')
  })

  it('summarizes multiple delegated employees with stable numerals', () => {
    render(
      <BackgroundActivityStatus
        activity={null}
        delegatedActivity={{ activeSessions: 3, employees: ['researcher', 'writer'] }}
        employeeDisplayNames={{ researcher: 'Researcher', writer: 'Writer' }}
      />,
    )
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('2 employees working')
    expect(status.querySelector('[data-activity-count]')?.className).toContain('tabular-nums')
    expect(status.getAttribute('title')).toBe('3 delegated tasks still running')
  })

  it('uses a generic delegated label when no employee identity is available', () => {
    render(
      <BackgroundActivityStatus
        activity={null}
        delegatedActivity={{ activeSessions: 1, employees: [] }}
      />,
    )
    expect(screen.getByRole('status').textContent).toContain('Delegated work in progress')
  })

  it('renders nothing when idle with no background work', () => {
    render(<BackgroundActivityStatus activity={null} />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('renders nothing for stale activity', () => {
    render(
      <BackgroundActivityStatus
        activity={activity({ lastActivityAt: new Date(Date.now() - 6 * 60 * 1000).toISOString() })}
      />,
    )
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps the node mounted through the exit fade, then unmounts', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <BackgroundActivityStatus activity={activity({ activeStreams: 2 })} />,
    )
    expect(screen.getByRole('status')).toBeTruthy()

    rerender(<BackgroundActivityStatus activity={null} />)
    // Still mounted during the fade-out window (count frozen, no "0 agents" flash)…
    const exiting = screen.getByRole('status')
    expect(exiting.textContent).toContain('2 agents in background')

    // …and gone once the exit transition completes.
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(screen.queryByRole('status')).toBeNull()
  })
})
