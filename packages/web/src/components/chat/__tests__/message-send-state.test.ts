import { describe, expect, it } from 'vitest'
import type { Message } from '@/lib/conversations'
import { beginSendMessages, clearPendingSend, markSendFailed } from '../message-send-state'

const T0 = 1_780_000_000_000

function user(id: string, content: string, extra: Partial<Message> = {}): Message {
  return { id, role: 'user', content, timestamp: T0, ...extra }
}

describe('beginSendMessages', () => {
  it('appends the user message as pending', () => {
    const next = beginSendMessages([], user('u1', 'hello'))
    expect(next).toHaveLength(1)
    expect(next[0].sendState).toBe('pending')
  })

  it('drops the failed attempt the retry replaces, leaving one bubble for that text', () => {
    const failed = user('u1', 'hello', { sendState: 'failed', sendError: 'offline' })
    const next = beginSendMessages([failed], user('u2', 'hello'))
    expect(next.map((m) => m.id)).toEqual(['u2'])
    expect(next[0].sendState).toBe('pending')
  })

  it('keeps a failed message whose text a later send does not repeat', () => {
    const failed = user('u1', 'hello', { sendState: 'failed' })
    const next = beginSendMessages([failed], user('u2', 'something else'))
    expect(next.map((m) => m.id)).toEqual(['u1', 'u2'])
  })

  it('keeps a settled message with the same text', () => {
    const next = beginSendMessages([user('u1', 'hello')], user('u2', 'hello'))
    expect(next.map((m) => m.id)).toEqual(['u1', 'u2'])
  })
})

describe('markSendFailed', () => {
  it('marks the message that failed and carries the reason', () => {
    const next = markSendFailed([user('u1', 'hi', { sendState: 'pending' })], 'u1', 'Failed to fetch')
    expect(next[0].sendState).toBe('failed')
    expect(next[0].sendError).toBe('Failed to fetch')
  })

  it('appends nothing — the failure belongs to the message that failed', () => {
    const next = markSendFailed([user('u1', 'hi', { sendState: 'pending' })], 'u1', 'nope')
    expect(next).toHaveLength(1)
    expect(next.every((m) => m.role === 'user')).toBe(true)
  })

  it('is a no-op with no pending id', () => {
    const current = [user('u1', 'hi')]
    expect(markSendFailed(current, undefined, 'nope')).toBe(current)
  })
})

describe('clearPendingSend', () => {
  it('settles the pending message', () => {
    const next = clearPendingSend([user('u1', 'hi', { sendState: 'pending' })])
    expect(next[0].sendState).toBeUndefined()
  })

  it('settles every pending message at once: one turn can answer several', () => {
    const next = clearPendingSend([user('u1', 'one', { sendState: 'pending' }), user('u2', 'two'), user('u3', 'now', { sendState: 'pending' })])
    expect(next.map((m) => m.sendState)).toEqual([undefined, undefined, undefined])
  })

  it('returns the identical array when nothing is pending, so a per-token call cannot re-render', () => {
    const current = [user('u1', 'hi'), user('u2', 'ho', { sendState: 'failed' })]
    expect(clearPendingSend(current)).toBe(current)
  })

  it('leaves a failed message failed', () => {
    const current = [user('u1', 'hi', { sendState: 'failed' })]
    expect(clearPendingSend(current)[0].sendState).toBe('failed')
  })
})
