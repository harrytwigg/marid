import { describe, expect, it } from 'vitest'
import { subagentMessages } from '../subagent-messages'
import { subagentIsLive, subagentRefetchMs, type SubagentEntry, type SubagentTranscriptResponse } from '../subagent-transcript'

const prompt: SubagentEntry = { kind: 'prompt', text: 'Count the lines.', at: '2026-10-16T10:00:00.000Z' }
const call = (result: string | null): SubagentEntry => ({ kind: 'tool', id: 't1', name: 'Bash', input: 'wc -l a', result, isError: false, at: '2026-10-16T10:00:01.000Z' })
const said: SubagentEntry = { kind: 'text', text: 'One line.', at: null }

describe('subagentMessages', () => {
  it('turns the prompt into the user’s message and what it said into the assistant’s', () => {
    const [ask, answer] = subagentMessages('ag', [prompt, said], 1_000_000)
    expect(ask).toMatchObject({ id: 'subagent:ag:0', role: 'user', content: 'Count the lines.', timestamp: Date.parse('2026-10-16T10:00:00.000Z') })
    expect(answer).toMatchObject({ id: 'subagent:ag:1', role: 'assistant', content: 'One line.' })
  })

  it('reads a call as running until its result is in, then as used, as a live chat does', () => {
    expect(subagentMessages('ag', [call(null)], 0)[0]).toMatchObject({ role: 'assistant', content: 'Using Bash', toolCall: 'Bash', toolId: 't1' })
    expect(subagentMessages('ag', [call('1 a')], 0)[0]).toMatchObject({ content: 'Used Bash', toolCall: 'Bash', toolId: 't1' })
  })

  it('keeps a row’s id as the file grows, and orders rows with no time after the one before', () => {
    const first = subagentMessages('ag', [prompt, call(null)], 5_000)
    const later = subagentMessages('ag', [prompt, call('1 a'), said], 5_000)
    expect(later.slice(0, 2).map((m) => m.id)).toEqual(first.map((m) => m.id))
    expect(later[2].timestamp).toBeGreaterThan(later[1].timestamp)
  })

  it('is empty for an empty transcript', () => {
    expect(subagentMessages('ag', [], 0)).toEqual([])
  })
})

describe('subagentIsLive', () => {
  const NOW = Date.parse('2026-10-16T10:10:00.000Z')
  const at = (agoMs: number) => new Date(NOW - agoMs).toISOString()
  const file = (entries: SubagentEntry[], agoMs: number): SubagentTranscriptResponse =>
    ({ sessionId: 's', agentId: 'ag', available: true, entries, truncated: false, updatedAt: at(agoMs) })

  it('is live while it writes, even its own words, and not for a missing transcript', () => {
    expect(subagentIsLive(file([prompt, call(null)], 1_000), NOW)).toBe(true)
    expect(subagentIsLive(file([prompt, said], 1_000), NOW)).toBe(true)
    expect(subagentIsLive({ sessionId: 's', agentId: 'ag', available: false, reason: 'not-found' }, NOW)).toBe(false)
    expect(subagentIsLive(undefined, NOW)).toBe(false)
  })

  it('is done once its last line is its own words and nothing came after them for a while', () => {
    // Composing the next call after some commentary can take a few seconds: that is not done.
    expect(subagentIsLive(file([prompt, said], 6_000), NOW)).toBe(true)
    expect(subagentIsLive(file([prompt, said], 9_000), NOW)).toBe(false)
  })

  it('is quiet after a long silence, a running call or not', () => {
    expect(subagentIsLive(file([prompt, call(null)], 25_000), NOW)).toBe(false)
    expect(subagentIsLive(file([prompt, call(null)], 10_000), NOW)).toBe(true)
  })
})

describe('subagentRefetchMs', () => {
  const NOW = Date.parse('2026-10-16T10:10:00.000Z')
  const gone = (reason: 'not-found' | 'unreadable' | 'no-conversation'): SubagentTranscriptResponse => ({ sessionId: 's', agentId: 'ag', available: false, reason })

  it('reads quickly while the file changes, and while one just launched may still appear', () => {
    expect(subagentRefetchMs(undefined, NOW)).toBe(2_000)
    expect(subagentRefetchMs(gone('not-found'), NOW)).toBe(2_000)
    expect(subagentRefetchMs({ sessionId: 's', agentId: 'ag', available: true, entries: [], truncated: false, updatedAt: new Date(NOW - 5_000).toISOString() }, NOW)).toBe(2_000)
  })

  it('backs off for a quiet file and for a transcript that no wait will bring', () => {
    expect(subagentRefetchMs({ sessionId: 's', agentId: 'ag', available: true, entries: [], truncated: false, updatedAt: new Date(NOW - 200_000).toISOString() }, NOW)).toBe(10_000)
    expect(subagentRefetchMs(gone('no-conversation'), NOW)).toBe(10_000)
    expect(subagentRefetchMs(gone('unreadable'), NOW)).toBe(10_000)
  })
})
