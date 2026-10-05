import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { ChatMessages } from '../chat-messages'
import { BACKGROUND_ACTIVITY_STALE_MS } from '../pending-work'
import type { Message } from '@/lib/conversations'
import type { BackgroundActivity } from '@/lib/api'
vi.mock('@/lib/api', () => ({ api: { getSession: vi.fn().mockResolvedValue({ messages: [] }) } }))

const T0 = 1_780_000_000_000

const messages: Message[] = [
  { id: 'ask-1', role: 'user', content: 'First question.', timestamp: T0 },
  { id: 'answer-1', role: 'assistant', content: 'First answer.', timestamp: T0 + 1_000, meta: { assistantPhase: 'final', turnOutcome: 'complete' } },
  { id: 'ask-2', role: 'user', content: 'Second question.', timestamp: T0 + 2_000 },
  { id: 'answer-2', role: 'assistant', content: 'Second answer.', timestamp: T0 + 3_000, meta: { assistantPhase: 'final', turnOutcome: 'complete' } },
]

function activity(overrides: Partial<BackgroundActivity> = {}): BackgroundActivity {
  return { activeStreams: 0, lastActivityAt: new Date(Date.now() - 1000).toISOString(), ...overrides }
}

function captionOf(id: string): string | null {
  return document.querySelector(`[data-message-id="${id}"] [data-answer-caption]`)?.textContent ?? null
}

/** The answers that carry the Copy / Retry action row. */
function actionRowOwners(): string[] {
  return Array.from(document.querySelectorAll('[aria-label="Copy message"]'))
    .map((button) => button.closest('[data-message-id]')?.getAttribute('data-message-id') ?? '')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('answer caption', () => {
  it('flips from waiting to final live as background work ends', () => {
    const { rerender } = render(<ChatMessages messages={messages} loading={false} backgroundActivity={activity({ backgroundAgents: 2 })} />)
    expect(captionOf('answer-2')).toBe('Waiting on 2 sub-agents')
    // An earlier turn's answer is final: its work ended or carried on.
    expect(captionOf('answer-1')).toBe('Final answer')
    const owners = actionRowOwners()
    expect(owners).toEqual(['answer-1', 'answer-2'])

    rerender(<ChatMessages messages={messages} loading={false} backgroundActivity={activity({ backgroundAgents: 1, activeMonitors: 1 })} />)
    expect(captionOf('answer-2')).toBe('Waiting on 1 sub-agent and 1 monitor')

    rerender(<ChatMessages messages={messages} loading={false} backgroundActivity={null} delegatedActivity={{ activeSessions: 1, employees: ['junior-developer'] }} />)
    expect(captionOf('answer-2')).toBe('Waiting on 1 delegated task')

    rerender(<ChatMessages messages={messages} loading={false} backgroundActivity={null} delegatedActivity={null} />)
    expect(captionOf('answer-2')).toBe('Final answer')
    // Who carries the action row does not depend on pending work.
    expect(actionRowOwners()).toEqual(owners)
  })

  it('stops waiting on a monitor once it has gone quiet, with no new report', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(T0 + 10_000)
    render(<ChatMessages messages={messages} loading={false} backgroundActivity={activity({ activeMonitors: 1 })} />)
    expect(captionOf('answer-2')).toBe('Waiting on 1 monitor')
    act(() => { vi.advanceTimersByTime(BACKGROUND_ACTIVITY_STALE_MS) })
    expect(captionOf('answer-2')).toBe('1 monitor still running')
  })

  it('keeps a failed turn failed', () => {
    const failed: Message[] = [...messages.slice(0, 3), { ...messages[3], meta: { assistantPhase: 'final', turnOutcome: 'error' } }]
    render(<ChatMessages messages={failed} loading={false} backgroundActivity={activity({ backgroundAgents: 1 })} />)
    expect(captionOf('answer-2')).toBe('Turn failed')
  })

  it('reads final while a turn runs with no user row of its own', () => {
    // A callback-started turn adds no user row, and delegated activity is not
    // suppressed while it runs: its answer is not written yet, so nothing waits.
    const answered = messages.slice(0, 2)
    render(<ChatMessages messages={answered} loading turnPending delegatedActivity={{ activeSessions: 1, employees: [] }} />)
    expect(captionOf('answer-1')).toBe('Final answer')
  })

  it('shows no wait under an answer with no text to caption', () => {
    const mediaOnly: Message[] = [...messages.slice(0, 3), { ...messages[3], content: '', media: [{ type: 'file', url: '/api/files/report', name: 'report.md' }] }]
    render(<ChatMessages messages={mediaOnly} loading={false} backgroundActivity={activity({ backgroundAgents: 1 })} />)
    expect(captionOf('answer-1')).toBe('Final answer')
  })

  it('does not move the wait to an earlier answer while a turn runs or has none', () => {
    const asked: Message[] = [...messages, { id: 'ask-3', role: 'user', content: 'Third question.', timestamp: T0 + 4_000 }]
    render(<ChatMessages messages={asked} loading={false} turnPending={false} backgroundActivity={activity({ backgroundAgents: 1 })} />)
    expect(captionOf('answer-2')).toBe('Final answer')
  })
})
