import { describe, expect, it } from 'vitest'
import type { ChatTab } from '@/hooks/use-chat-tabs'
import { fileBackPlan } from '../file-back'

const chat = (sessionId: string): ChatTab => ({ kind: 'session', sessionId, label: sessionId, status: 'idle', unread: false })
const file = (path: string): ChatTab => ({ kind: 'file', path, sessionId: 'a', label: path, pinned: true })

describe('fileBackPlan', () => {
  it('closes the file tab and returns to the chat it was opened from', () => {
    expect(fileBackPlan([chat('a'), file('x.md')], 1, 'a')).toEqual({ close: 1, switchTo: 0 })
    // The chat sits after the file: its index shifts down once the file closes.
    expect(fileBackPlan([file('x.md'), chat('b'), chat('a')], 0, 'a')).toEqual({ close: 0, switchTo: 1 })
  })

  it('leaves the list (and so the route) alone when there is no chat to return to', () => {
    expect(fileBackPlan([chat('b'), file('x.md')], 1, 'a')).toBeNull()
    expect(fileBackPlan([chat('b'), file('x.md')], 1, null)).toBeNull()
    expect(fileBackPlan([file('x.md')], 0, null)).toBeNull()
  })

  it('switches without closing when the active tab is not a file', () => {
    expect(fileBackPlan([chat('a'), chat('b')], 1, 'a')).toEqual({ close: null, switchTo: 0 })
  })
})
