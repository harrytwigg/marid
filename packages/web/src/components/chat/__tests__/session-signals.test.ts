import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatStallAge, getStatusDot, getTurnStall, hasBackgroundActivity, isArchivedSession, isRecentError, TURN_STALL_VISIBLE_MS, useStallClock } from '../session-signals'

afterEach(() => {
  vi.useRealTimers()
})

describe('chat sidebar archive state', () => {
  it('recognizes a search result retained in the archive', () => {
    expect(isArchivedSession({ archivedAt: '2026-07-14T10:00:00.000Z' })).toBe(true)
  })

  it('treats null and absent archive timestamps as normal chats', () => {
    expect(isArchivedSession({ archivedAt: null })).toBe(false)
    expect(isArchivedSession({})).toBe(false)
  })
})

describe('chat sidebar background activity', () => {
  it('ignores stale cached background activity', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-10T10:10:00Z'))

    expect(
      hasBackgroundActivity({
        status: 'idle',
        backgroundActivity: {
          activeStreams: 1,
          lastActivityAt: '2026-06-10T10:00:00Z',
        },
      }),
    ).toBe(false)
  })

  it('keeps fresh idle background activity visible', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-10T10:01:00Z'))

    expect(
      hasBackgroundActivity({
        status: 'idle',
        backgroundActivity: {
          activeStreams: 1,
          lastActivityAt: '2026-06-10T10:00:00Z',
        },
      }),
    ).toBe(true)
  })

  it('keeps an idle parent visible while a descendant employee is active', () => {
    expect(
      hasBackgroundActivity({
        status: 'idle',
        backgroundActivity: null,
        delegatedActivity: { activeSessions: 2, employees: ['researcher', 'writer'] },
      }),
    ).toBe(true)
  })

  it('lets foreground running state take precedence over delegated activity', () => {
    expect(
      hasBackgroundActivity({
        status: 'running',
        backgroundActivity: null,
        delegatedActivity: { activeSessions: 1, employees: ['researcher'] },
      }),
    ).toBe(false)
  })
})

describe('chat sidebar recent-error dot gating', () => {
  // Fixed "now"; the helper takes nowMs so we never read Date.now() at module load.
  const now = new Date('2026-06-15T12:00:00Z').getTime()
  const HOUR = 60 * 60 * 1000

  it('flags an error whose last activity is within the 24h window (→ red)', () => {
    const oneHourAgo = new Date(now - HOUR).toISOString()
    expect(isRecentError('error', oneHourAgo, now)).toBe(true)
  })

  it('does NOT flag an error whose last activity is older than 24h (→ not red)', () => {
    const twoDaysAgo = new Date(now - 48 * HOUR).toISOString()
    expect(isRecentError('error', twoDaysAgo, now)).toBe(false)
  })

  it('never flags a non-error status, even when recent', () => {
    const oneHourAgo = new Date(now - HOUR).toISOString()
    expect(isRecentError('idle', oneHourAgo, now)).toBe(false)
    expect(isRecentError('running', oneHourAgo, now)).toBe(false)
    expect(isRecentError(undefined, oneHourAgo, now)).toBe(false)
  })

  it('treats a missing or unparseable timestamp as not-recent (→ not red)', () => {
    expect(isRecentError('error', '', now)).toBe(false)
    expect(isRecentError('error', 'not-a-date', now)).toBe(false)
  })

  it('treats the 24h boundary as stale (strictly inside the window is red)', () => {
    const exactly24h = new Date(now - 24 * HOUR).toISOString()
    expect(isRecentError('error', exactly24h, now)).toBe(false)
    const justInside = new Date(now - 24 * HOUR + 1000).toISOString()
    expect(isRecentError('error', justInside, now)).toBe(true)
  })
})

describe('formatStallAge', () => {
  it('reads coarsely — the operator needs "too long", not a stopwatch', () => {
    expect(formatStallAge(30_000)).toBe('under a minute')
    expect(formatStallAge(60_000)).toBe('1m')
    expect(formatStallAge(51 * 60_000)).toBe('51m')
    expect(formatStallAge(60 * 60_000)).toBe('1h')
    expect(formatStallAge(64 * 60_000)).toBe('1h 4m')
  })
})

describe('getTurnStall', () => {
  const NOW = 1_000_000_000

  it('derives the age from the reported instant', () => {
    expect(getTurnStall({ id: 's', turnProgress: { lastProgressAt: NOW - 90_000, awaitingSubmit: false } }, NOW)).toEqual({
      stalledForMs: 90_000,
      awaitingSubmit: false,
    })
    expect(getTurnStall({ id: 's', turnProgress: { lastProgressAt: NOW - 10 * 60_000, awaitingSubmit: true } }, NOW)).toEqual({
      stalledForMs: 10 * 60_000,
      awaitingSubmit: true,
    })
  })

  it('applies the staleness threshold itself, so a healthy live turn is not amber', () => {
    // The server reports the instant for ANY live turn and passes no verdict —
    // a stalled session emits no events, so a server-side verdict would never be
    // delivered. The threshold therefore has to live here.
    const fresh = { id: 's', turnProgress: { lastProgressAt: NOW - 5_000, awaitingSubmit: false } }
    expect(getTurnStall(fresh, NOW)).toBeNull()
    expect(getTurnStall(fresh, NOW + TURN_STALL_VISIBLE_MS)).not.toBeNull()
  })

  it('crosses the threshold on its own clock, with no new payload', () => {
    // The case the whole design exists for: one serialize at turn start, then the
    // session goes silent and never emits again. Nothing refetches; the row must
    // still turn amber.
    const atTurnStart = { id: 's', turnProgress: { lastProgressAt: NOW, awaitingSubmit: false } }
    expect(getTurnStall(atTurnStart, NOW + 30_000)).toBeNull()
    expect(getTurnStall(atTurnStart, NOW + 2 * 60_000)?.stalledForMs).toBe(2 * 60_000)
    expect(getTurnStall(atTurnStart, NOW + 60 * 60_000)?.stalledForMs).toBe(60 * 60_000)
  })

  it('keeps advancing as time passes without a refetch', () => {
    // The whole reason the server sends an instant rather than a duration: a
    // server-computed elapsed time freezes at the last serialize, so the label
    // would read "2m" forever while an hour went by.
    const session = { id: 's', turnProgress: { lastProgressAt: NOW, awaitingSubmit: false } }
    expect(getTurnStall(session, NOW + 2 * 60_000)?.stalledForMs).toBe(2 * 60_000)
    expect(getTurnStall(session, NOW + 60 * 60_000)?.stalledForMs).toBe(60 * 60_000)
  })

  it('tolerates gateways that predate the field, and rejects junk', () => {
    expect(getTurnStall({ id: 's' }, NOW)).toBeNull()
    expect(getTurnStall({ id: 's', turnProgress: null }, NOW)).toBeNull()
    // Nothing elapsed yet, or a clock skewed into the future.
    expect(getTurnStall({ id: 's', turnProgress: { lastProgressAt: NOW, awaitingSubmit: false } }, NOW)).toBeNull()
    expect(getTurnStall({ id: 's', turnProgress: { lastProgressAt: NOW + 5_000, awaitingSubmit: false } }, NOW)).toBeNull()
    expect(getTurnStall({ id: 's', turnProgress: { lastProgressAt: 0, awaitingSubmit: false } }, NOW)).toBeNull()
    expect(getTurnStall({ id: 's', turnProgress: { lastProgressAt: NaN, awaitingSubmit: false } }, NOW)).toBeNull()
    expect(getTurnStall({ id: 's', turnProgress: { awaitingSubmit: true } as never }, NOW)).toBeNull()
  })
})

describe('useStallClock', () => {
  it('advances on its own, so the amber row appears without any server traffic', () => {
    vi.useFakeTimers()
    try {
      const { result, rerender, unmount } = renderHook(() => useStallClock())
      const first = result.current
      expect(typeof first).toBe('number')

      // No tick yet: the value is stable, so React does not re-render in a loop.
      rerender()
      expect(result.current).toBe(first)

      act(() => {
        vi.advanceTimersByTime(TURN_STALL_VISIBLE_MS)
      })
      expect(result.current - first).toBeGreaterThanOrEqual(TURN_STALL_VISIBLE_MS)

      // The interval is torn down with the last listener rather than left running.
      unmount()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not tick for rows with nothing in flight', () => {
    // Every visible row calls this hook. A row that cannot stall must not subscribe,
    // or a quiet list would re-render itself every 15s forever.
    vi.useFakeTimers()
    try {
      const { unmount } = renderHook(() => useStallClock(false))
      expect(vi.getTimerCount()).toBe(0)
      unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('getStatusDot: a stalled turn must not look like a working one', () => {
  const read = new Set(['s1'])

  it('counts the sub-agents of a session running on its background work', () => {
    const background = { activeStreams: 0, backgroundAgents: 2, lastActivityAt: '2026-10-01T20:00:00.000Z' }
    expect(getStatusDot({ id: 's1', status: 'running', backgroundActivity: background }, read)?.label).toBe('running · 2 sub-agents')
    expect(getStatusDot({ id: 's1', status: 'running', backgroundActivity: { ...background, backgroundAgents: 0, backgroundRerun: true } }, read)?.label).toBe('running')
  })

  it('paints a working turn blue and pulsing', () => {
    expect(getStatusDot({ id: 's1', status: 'running' }, read)).toEqual({
      color: 'var(--system-blue)',
      label: 'running',
      pulse: true,
    })
  })

  it('paints a stalled turn amber and STILL, with the elapsed time in the label', () => {
    const dot = getStatusDot(
      { id: 's1', status: 'running', turnProgress: { lastProgressAt: Date.now() - 51 * 60_000, awaitingSubmit: false } },
      read,
    )
    expect(dot).toEqual({ color: 'var(--system-orange)', label: 'no output for 51m', pulse: false })
  })

  it('names the unaccepted-prompt case specifically — it has a different fix', () => {
    const dot = getStatusDot(
      { id: 's1', status: 'running', turnProgress: { lastProgressAt: Date.now() - 120_000, awaitingSubmit: true } },
      read,
    )
    expect(dot?.color).toBe('var(--system-orange)')
    expect(dot?.label).toMatch(/prompt not accepted by the engine/)
    expect(dot?.pulse).toBe(false)
  })

  it('ignores stall state on a session that is not running', () => {
    const dot = getStatusDot(
      { id: 's1', status: 'idle', turnProgress: { lastProgressAt: Date.now() - 999_000, awaitingSubmit: true } },
      read,
    )
    expect(dot).toBeNull()
  })
})

describe('a message waiting behind a turn typed in the terminal', () => {
  const NOW = Date.parse('2026-09-26T12:00:00Z')
  const waiting = {
    id: 's',
    status: 'running',
    turnProgress: { lastProgressAt: NOW - 3 * 60 * 60_000, awaitingSubmit: false, waitingForTerminalTurn: true },
  }

  it('is never reported as stalled, however long it waits', () => {
    expect(getTurnStall(waiting, NOW)).toBeNull()
  })

  it('gets its own sidebar dot label, not "running" or "no output"', () => {
    expect(getStatusDot(waiting, new Set(['s']), false, NOW)).toEqual({
      color: 'var(--system-blue)',
      label: 'waiting for the turn typed in the terminal',
      pulse: false,
    })
  })
})
