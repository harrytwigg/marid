import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_ACTIVITY_STALE_MS,
  answerCaption,
  pendingWork,
  pendingWorkChangesAt,
} from '../pending-work'
import type { BackgroundActivity, DelegatedActivity } from '@/lib/api'

const NOW = 1_780_000_000_000

function activity(overrides: Partial<BackgroundActivity> = {}): BackgroundActivity {
  return {
    activeStreams: 0,
    lastActivityAt: new Date(NOW - 1000).toISOString(),
    ...overrides,
  }
}

function delegated(activeSessions: number): DelegatedActivity {
  return { activeSessions, employees: [] }
}

function caption(bg: BackgroundActivity | null, del: DelegatedActivity | null = null, outcome?: string): string {
  return answerCaption(outcome, pendingWork(bg, del, NOW))
}

describe('answerCaption', () => {
  it('reads final with nothing pending', () => {
    expect(caption(null)).toBe('Final answer')
    expect(caption(activity({ activeMonitors: 0, backgroundAgents: 0, backgroundRerun: false }), delegated(0))).toBe('Final answer')
  })

  it('reads final when only model requests are in flight', () => {
    // A turn's tail sends requests after it ends; they carry no answer.
    expect(caption(activity({ activeStreams: 2, activeAgents: 2 }))).toBe('Final answer')
  })

  it('names monitors', () => {
    expect(caption(activity({ activeMonitors: 1 }))).toBe('Waiting on 1 monitor')
    expect(caption(activity({ activeMonitors: 3 }))).toBe('Waiting on 3 monitors')
  })

  it('names sub-agents', () => {
    expect(caption(activity({ backgroundAgents: 1 }))).toBe('Waiting on 1 sub-agent')
    expect(caption(activity({ backgroundAgents: 2 }))).toBe('Waiting on 2 sub-agents')
  })

  it('names monitors and sub-agents together', () => {
    expect(caption(activity({ activeMonitors: 1, backgroundAgents: 1 }))).toBe('Waiting on 1 sub-agent and 1 monitor')
  })

  it('names a background re-run', () => {
    expect(caption(activity({ backgroundRerun: true, activeStreams: 1 }))).toBe('Waiting on a background re-run')
    expect(caption(activity({ backgroundRerun: true, backgroundAgents: 1 }))).toBe('Waiting on 1 sub-agent and a background re-run')
  })

  it('names delegated sessions, with or without runtime activity', () => {
    expect(caption(null, delegated(1))).toBe('Waiting on 1 delegated task')
    expect(caption(null, delegated(2))).toBe('Waiting on 2 delegated tasks')
    expect(caption(activity({ activeMonitors: 2, backgroundAgents: 1, backgroundRerun: true }), delegated(1)))
      .toBe('Waiting on 1 delegated task, 1 sub-agent, 2 monitors and a background re-run')
  })

  it('keeps a failed turn failed whatever is pending', () => {
    expect(caption(null, null, 'error')).toBe('Turn failed')
    expect(caption(activity({ backgroundAgents: 1 }), delegated(1), 'error')).toBe('Turn failed')
  })

  it('stops waiting on a monitor that has gone quiet', () => {
    const quiet = activity({ activeMonitors: 1, lastActivityAt: new Date(NOW - BACKGROUND_ACTIVITY_STALE_MS - 1).toISOString() })
    expect(caption(quiet)).toBe('1 monitor still running')
    // Anything else pending is still waited on, monitors included.
    expect(caption({ ...quiet, backgroundAgents: 1 })).toBe('Waiting on 1 sub-agent and 1 monitor')
    expect(caption(quiet, delegated(1))).toBe('Waiting on 1 delegated task and 1 monitor')
  })
})

describe('pendingWorkChangesAt', () => {
  it('is the end of the stale window for a fresh monitor', () => {
    const bg = activity({ activeMonitors: 1 })
    expect(pendingWorkChangesAt(bg, pendingWork(bg, null, NOW))).toBe(NOW - 1000 + BACKGROUND_ACTIVITY_STALE_MS + 1)
  })

  it('is null when nothing would change on its own', () => {
    expect(pendingWorkChangesAt(null, null)).toBeNull()
    const agents = activity({ backgroundAgents: 1 })
    expect(pendingWorkChangesAt(agents, pendingWork(agents, null, NOW))).toBeNull()
    const quiet = activity({ activeMonitors: 1, lastActivityAt: new Date(NOW - BACKGROUND_ACTIVITY_STALE_MS - 1).toISOString() })
    expect(pendingWorkChangesAt(quiet, pendingWork(quiet, null, NOW))).toBeNull()
  })
})
